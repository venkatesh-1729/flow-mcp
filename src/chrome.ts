import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// Which Chrome the tool drives, set by FLOW_MCP_BROWSER or once in ~/.flow-mcp/config.json ({"browser": ...}), which
// every flow-mcp process (the MCP server an app starts, the Studio panel, scripts) reads alike:
// - "own" (default): a dedicated profile this tool launches, signed in once by hand.
// - "extension": the user's everyday Chrome, already signed in, through Microsoft's Playwright Extension and the token on
//   its status page (~/.flow-mcp/extension-token). No prompt ever: the token approves each connection. The extension
//   only reaches tabs the tool opens, and Chrome shows its "started debugging this browser" bar while connected.
// - "attach": the everyday Chrome through Chrome 144+'s "Allow remote debugging for this browser instance"
//   (chrome://inspect/#remote-debugging), which asks the user to Allow every new connection.
// In the user's Chrome the tool works in a window of its own and never touches the user's other tabs.
const CONFIG = (() => {
  try {
    return JSON.parse(readFileSync(join(HOME_DIR, "config.json"), "utf8")) as { browser?: string; chrome_profile?: string };
  } catch {
    return {};
  }
})();
const MODE = process.env.FLOW_MCP_BROWSER ?? CONFIG.browser ?? "own";
export const ATTACH = MODE === "attach";
export const EXTENSION = MODE === "extension";
const EXTENSION_TOKEN = join(HOME_DIR, "extension-token");
const EXTENSION_STEPS =
  "Install Microsoft's Playwright Extension in your everyday Chrome (https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm), copy the token on its status page, and save it with: pbpaste > ~/.flow-mcp/extension-token";
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

type CoreTools = {
  createBrowserWithInfo(config: object, client: { clientName: string }, options: object): Promise<{ browser: Browser }>;
};

// Joins the user's running Chrome through Microsoft's Playwright Extension, with Playwright's own relay for it (the one
// Playwright MCP's --extension uses, inside playwright-core; pinned in package.json since it is not public API). The
// token from the extension's status page approves the connection, so nothing is asked of the user. The relay opens the
// extension's connect page in the profile that has the extension (Default unless config.json says "chrome_profile").
async function viaExtension(): Promise<Browser> {
  let token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (!token) {
    try {
      // The status page's copy button copies the whole line, "PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token>": keep the value.
      token = readFileSync(EXTENSION_TOKEN, "utf8")
        .trim()
        .replace(/^(export\s+)?PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, "")
        .replace(/^["']|["']$/g, "");
    } catch {
      // checked below
    }
  }
  if (!token) throw new Error(`No Playwright Extension token in ${EXTENSION_TOKEN}. ${EXTENSION_STEPS}`);
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
  process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME ??= CONFIG.chrome_profile ?? "Default";
  const { tools } = createRequire(import.meta.url)("playwright-core/lib/coreBundle") as { tools: CoreTools };
  try {
    const { browser: joined } = await tools.createBrowserWithInfo({ browser: {}, extension: true }, { clientName: "flow-mcp" }, {});
    // Between jobs nothing else crosses the connection, and Chrome stops an idle extension worker after about 30 s,
    // which would drop it: a tiny command every 20 s keeps it open for as long as this process runs.
    const beat = setInterval(() => {
      const page = joined.contexts()[0]?.pages()[0];
      void page?.evaluate("1").catch(() => {});
    }, 20_000);
    beat.unref();
    joined.on("disconnected", () => clearInterval(beat));
    // On the way out, close the tool's Flow window and the connect tab, so the user's Chrome doesn't collect a pair
    // for every run (a new connection opens fresh ones). Never more than 3 s.
    const tidy = () =>
      void Promise.race([
        Promise.allSettled(joined.contexts()[0]?.pages().map((p) => p.close()) ?? []),
        new Promise((r) => setTimeout(r, 3000)),
      ]).finally(() => process.exit(0));
    process.once("SIGINT", tidy);
    process.once("SIGTERM", tidy);
    return joined;
  } catch (err) {
    throw new Error(`Could not connect through the Playwright Extension (${err instanceof Error ? err.message.split("\n")[0] : err}). ${EXTENSION_STEPS}`);
  }
}

// Where the user's Chrome saves downloads: its own setting, else ~/Downloads. In extension mode Flow's files land here.
export function usersDownloadDir(): string {
  try {
    const prefs = JSON.parse(readFileSync(join(CHROME_DATA_DIR, CONFIG.chrome_profile ?? "Default", "Preferences"), "utf8")) as {
      download?: { default_directory?: string };
    };
    if (prefs.download?.default_directory) return prefs.download.default_directory;
  } catch {
    // the usual place below
  }
  return join(homedir(), "Downloads");
}

async function connect(): Promise<Browser> {
  if (EXTENSION) return viaExtension();
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

// Through the extension the tool starts on the extension's connect page, a tab in the user's own window. Flow gets a
// window of its own, opened from that page as a popup (the extension hands a connected tab's popups to the tool), so
// the user's tabs are never switched and the tab the tool drives is the only one in its window. The connect page stays
// open: it keeps the extension's side of the connection alive. If Chrome refuses the popup, the connect tab itself
// becomes the Flow tab.
async function extensionFlowTab(b: Browser): Promise<Page> {
  if (ownTab && !ownTab.isClosed()) return ownTab;
  const context = b.contexts()[0];
  if (!context) throw new Error("The Playwright Extension connected but shows no tab to work in.");
  for (const p of context.pages()) {
    if (FLOW_HOSTS.test(p.url()) && (await p.evaluate(() => window.name).catch(() => "")) === OWN_TAB) return (ownTab = p);
  }
  const opener = context.pages()[0];
  if (!opener) throw new Error("The Playwright Extension connected but shows no tab to work in.");
  const opened = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await opener.mouse.click(4, 4).catch(() => {}); // a real click, so the page may open a window
  const popped = await opener
    .evaluate(
      ([url, name]) =>
        Boolean(window.open(url, name, `popup,width=${Math.min(1440, screen.availWidth)},height=${Math.min(900, screen.availHeight)}`)),
      [FLOW_URL, OWN_TAB],
    )
    .catch(() => false);
  let tab = popped ? await opened : null;
  if (!tab) {
    tab = opener;
    await tab.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  }
  await tab.waitForLoadState("domcontentloaded");
  // Chrome clears window.name when the popup moves on to another site (from the extension page to Flow): mark it now.
  await tab.evaluate((mark) => {
    window.name = mark;
  }, OWN_TAB);
  return (ownTab = tab);
}

export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  if (EXTENSION) return extensionFlowTab(b);
  if (ATTACH) return ownFlowTab(b);
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  return page;
}
