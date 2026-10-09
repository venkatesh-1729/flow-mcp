import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { IS_MAC, IS_WIN, listenerCommandLine } from "./platform.js";

export const FLOW_URL = "https://flow.google.com/";
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
// Every download lands here, never in ~/Downloads, so a file that arrives here can only be ours.
export const DOWNLOAD_DIR = join(HOME_DIR, "downloads");
// 9333 is a common pick for other automation Chromes (the Jev pilot uses it), so this tool keeps to a port of its own.
export const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9339);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

// FLOW_MCP_BROWSER=attach drives the user's own running Chrome, already signed in to Flow, instead of a profile this
// tool launches. Chrome 144+ allows it once "Allow remote debugging for this browser instance" is on
// (chrome://inspect/#remote-debugging); Chrome then writes DevToolsActivePort into its data folder and asks the user to
// Allow each new connection. The tool works in a window of its own there and never touches the user's other tabs.
// Every flow-mcp process (the MCP server an app starts, the Studio panel, scripts) must agree on this, so it can also be
// set once in ~/.flow-mcp/config.json ({"browser": "attach"}) instead of in each launcher's environment.
const CONFIG = (() => {
  try {
    return JSON.parse(readFileSync(join(HOME_DIR, "config.json"), "utf8")) as { browser?: string };
  } catch {
    return {};
  }
})();
export const ATTACH = (process.env.FLOW_MCP_BROWSER ?? CONFIG.browser) === "attach";
const CHROME_DATA_DIR =
  process.env.FLOW_MCP_CHROME_DATA ??
  (IS_MAC
    ? join(homedir(), "Library", "Application Support", "Google", "Chrome")
    : IS_WIN
      ? join(process.env.LOCALAPPDATA ?? homedir(), "Google", "Chrome", "User Data")
      : join(homedir(), ".config", "google-chrome"));
const ATTACH_STEPS =
  "In your everyday Chrome open chrome://inspect/#remote-debugging and turn on 'Allow remote debugging for this browser instance', then click Allow when Chrome asks whether to allow the connection.";
// The tool's own tab is marked through window.name, so a restarted tool finds it again instead of opening another.
const OWN_TAB = "flow-mcp";

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// The Chrome on the port must be the one running this tool's own signed-in profile, not another automation Chrome that
// happens to hold the same port - which this tool would otherwise start driving. (Chrome 154 no longer writes
// DevToolsActivePort for a fixed port, so the listening process's own command line is checked.) When the owner cannot
// be looked up at all, the port is trusted as before rather than refusing to work.
function ownsPort(): boolean {
  const command = listenerCommandLine(CDP_PORT);
  return command === undefined || command.includes(`--user-data-dir=${PROFILE_DIR}`);
}

// The profile's own download folder points at DOWNLOAD_DIR too, so even when a CDP client resets the download
// behaviour, Chrome still saves into a folder only this tool uses. Written only while this Chrome is closed.
function setDownloadPrefs(): void {
  const file = join(PROFILE_DIR, "Default", "Preferences");
  mkdirSync(join(PROFILE_DIR, "Default"), { recursive: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // First launch: Chrome fills in everything else.
  }
  const download = (prefs.download ?? {}) as Record<string, unknown>;
  if (download.default_directory === DOWNLOAD_DIR && download.prompt_for_download === false) return;
  prefs.download = { ...download, default_directory: DOWNLOAD_DIR, prompt_for_download: false };
  writeFileSync(file, JSON.stringify(prefs));
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
async function launchChrome(): Promise<void> {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  setDownloadPrefs();
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      FLOW_URL,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Chrome started but CDP port ${CDP_PORT} never came up. If the Flow Chrome window is already open without it, quit that window (Cmd+Q) and try again.`,
  );
}

// Joins the user's running Chrome through the address it publishes in DevToolsActivePort. noDefaults keeps Playwright
// from imposing its own settings on that browser - above all its download folder, which would otherwise swallow every
// file the user downloads while the tool is connected.
async function attachToUsersChrome(): Promise<Browser> {
  let endpoint: string;
  try {
    const [port, path] = readFileSync(join(CHROME_DATA_DIR, "DevToolsActivePort"), "utf8").split(/\r?\n/);
    if (!Number(port) || !path?.startsWith("/devtools/browser/")) throw new Error("unexpected contents");
    endpoint = `ws://127.0.0.1:${Number(port)}${path}`;
  } catch {
    throw new Error(`Chrome is not accepting remote debugging (no DevToolsActivePort in ${CHROME_DATA_DIR}). ${ATTACH_STEPS}`);
  }
  try {
    // Chrome holds the connection until the user answers its prompt, so this waits up to five minutes.
    return await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 300_000 });
  } catch (err) {
    throw new Error(`Could not attach to your Chrome (${err instanceof Error ? err.message.split("\n")[0] : err}). ${ATTACH_STEPS}`);
  }
}

async function connect(): Promise<Browser> {
  if (ATTACH) return attachToUsersChrome();
  if (!(await cdpUp())) await launchChrome();
  if (!ownsPort()) {
    throw new Error(
      `Port ${CDP_PORT} is held by a Chrome that is not flow-mcp's own profile (${PROFILE_DIR}). Close that Chrome, or set FLOW_MCP_CDP_PORT to a free port everywhere this tool is started.`,
    );
  }
  return chromium.connectOverCDP(CDP_URL);
}

// Calls that arrive while a connection is still being made share it. In the user's own Chrome each new connection
// raises its own Allow prompt, so two overlapping calls used to ask the user twice.
let connecting: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  connecting ??= connect().finally(() => {
    connecting = null;
  });
  browser = await connecting;
  return browser;
}

let ownTab: Page | null = null;

// In the user's own Chrome the tool never borrows a Flow tab the user has open: it works in a window of its own, so the
// user keeps theirs, and the tab it drives is the active one in its window (Chrome throttles background tabs).
async function ownFlowTab(b: Browser): Promise<Page> {
  if (ownTab && !ownTab.isClosed()) return ownTab;
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome shows no browser context to work in.");
  for (const p of context.pages()) {
    if (FLOW_HOSTS.test(p.url()) && (await p.evaluate(() => window.name).catch(() => "")) === OWN_TAB) return (ownTab = p);
  }
  const session = await b.newBrowserCDPSession();
  let tab: Page;
  try {
    const opened = context.waitForEvent("page", { timeout: 30_000 });
    await session.send("Target.createTarget", { url: FLOW_URL, newWindow: true });
    tab = await opened;
  } finally {
    await session.detach().catch(() => {});
  }
  await tab.waitForLoadState("domcontentloaded");
  await tab.evaluate((mark) => {
    window.name = mark;
  }, OWN_TAB);
  return (ownTab = tab);
}

export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  if (ATTACH) return ownFlowTab(b);
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  return page;
}
