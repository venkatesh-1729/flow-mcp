import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { ATTACH, DOWNLOAD_DIR, EXTENSION, FLOW_URL, HOME_DIR, getFlowPage, usersDownloadDir } from "./chrome.js";
import type { Job } from "./queue.js";
import { activateApp, extractZip, idleSeconds, screenLocked } from "./platform.js";

export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  onScreen: boolean;
  project?: string;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const FAILURE_TEXT = /failed|couldn.t|unable/i;
const OFF_SCREEN =
  "Flow's window is not on screen: the screen is locked or asleep, or the window is minimised or fully covered. Chrome paints nothing there, so nothing can be clicked. Unlock the screen and leave the Flow window at least partly visible. Nothing was spent.";
// The same, met half-way through a job, when something may already have been spent.
const NOT_PAINTED = "Flow's window went off screen (locked or sleeping screen, or the window minimised or covered), so nothing in it could be clicked";
// A job that finds Flow's window covered waits for the user to pause this long before bringing Chrome forward, and gives
// up after WAIT_FOR_PAUSE_MS of the user working without a pause.
const PAUSE_BEFORE_RAISE_S = 6;
const WAIT_FOR_PAUSE_MS = 15 * 60_000;

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const addNote = (job: Job, text: string) => void (job.note = [job.note, text].filter(Boolean).join(" · "));
const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

// Chrome paints nothing for a window that is minimised, fully covered, or on a locked or sleeping screen, and then no
// click lands: Playwright waits for an animation frame that never comes (2026-10-09, a locked laptop). A covered window
// is raised inside Chrome first. In the user's own Chrome, on a laptop screen where their own app covers it, a job
// (`patient`) then waits for the user to pause for a few seconds and brings Chrome forward for the minute it needs -
// never while they are typing. A locked screen, or no pause within WAIT_FOR_PAUSE_MS, stops the job before anything is
// spent.
async function onScreen(page: Page, patient = false): Promise<boolean> {
  const painting = () =>
    page
      .evaluate(
        () =>
          new Promise<boolean>((ok) => {
            const late = setTimeout(() => ok(false), 1000);
            requestAnimationFrame(() => {
              clearTimeout(late);
              ok(true);
            });
          }),
      )
      .catch(() => false);
  if (await painting()) return true;
  await page.bringToFront().catch(() => {});
  await pause(page, 1000);
  if (await painting()) return true;
  if (!patient || !(ATTACH || EXTENSION)) return false;
  const deadline = Date.now() + WAIT_FOR_PAUSE_MS;
  while (Date.now() < deadline && !screenLocked()) {
    const idle = idleSeconds();
    if (idle === undefined) return false;
    if (idle >= PAUSE_BEFORE_RAISE_S) {
      activateApp("Google Chrome");
      await page.bringToFront().catch(() => {});
      await pause(page, 1500);
      if (await painting()) return true;
    }
    await pause(page, 2000);
  }
  return false;
}

let lastState: (FlowState & { as_of: string }) | undefined;
// The page as last read, for a status check that finds a job or another call driving it.
export const lastFlowState = () => lastState;

// `detailed` opens the account panel to read the balance, so it must not run while a generation is driving the page.
// `patient` (every job) waits for a pause in the user's own work to bring Flow's window forward; a status check never does.
export async function getFlowState(detailed = false, patient = false): Promise<FlowState> {
  const page = await getFlowPage();
  const url = page.url();
  // Signed-out visitors are bounced to the marketing page or Google's sign-in.
  const signedIn = !/\/about|accounts\.google\.com/.test(url);
  const inProject = /\/project\//.test(url);
  const state: FlowState = { url, signedIn, inProject, onScreen: await onScreen(page, patient) };
  if (inProject) state.project = await projectTitle(page).inputValue({ timeout: 5000 }).catch(() => undefined);
  if (!signedIn) {
    state.hint = ATTACH || EXTENSION
      ? "Not signed in. Sign in to Flow in your own Chrome (the window flow-mcp opened), then call flow_status again."
      : "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.";
  } else if (!state.onScreen) state.hint = OFF_SCREEN;
  else if (!inProject) state.hint = "Signed in, but no project is open. Open or create one with flow_project.";
  else if (detailed) {
    state.plan = await page.getByRole("button", { name: "Account details" }).innerText().then((t) => t.trim().split("\n")[0], () => undefined);
    state.credits_remaining = await readCredits(page).catch(() => undefined);
    state.composer = await settingsTrigger(page).innerText().then((t) => t.replace(/\s+/g, " ").trim(), () => undefined);
  }
  lastState = { ...state, as_of: new Date().toISOString() };
  return state;
}

// Inside a project the title sits in the top bar as an editable text box (mapped 2026-10-09).
const projectTitle = (page: Page) => page.getByRole("textbox", { name: "Editable text" }).first();

export interface FlowProject {
  title: string;
  url: string;
}

// The project cards on Flow's home page: an "Open project" link beside the title text and its "Edit project title"
// button (mapped 2026-10-09). The title is the card's own text node, not innerText, which also holds icon ligatures.
async function homeProjects(page: Page): Promise<FlowProject[]> {
  await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New project" }).waitFor({ state: "visible", timeout: 30_000 });
  await pause(page, 1500);
  return page.evaluate(() =>
    [...document.querySelectorAll('a[aria-label="Open project"][href*="/project/"]')].map((a) => {
      const edit = a.parentElement?.querySelector('button[aria-label="Edit project title"]');
      const title = edit ? [...(edit.parentElement?.childNodes ?? [])].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("").trim() : "";
      return { title, url: new URL(a.getAttribute("href") ?? "", location.origin).toString() };
    }),
  );
}

// Lists the projects, or opens the one with this exact title - creating it (free) when asked. A new project starts
// with a date for a name ("Oct 09 - 16:00"), so it is renamed in the top bar straight away.
export async function openProject(title?: string, create = false): Promise<{ project?: FlowProject; created?: boolean; projects: FlowProject[] }> {
  const page = await getFlowPage();
  if (!(await onScreen(page, true))) throw new Error(OFF_SCREEN);
  const was = page.url();
  const projects = await homeProjects(page);
  if (!title) {
    // Listing passes through the home page; put back the project that was open, so the next job still has one.
    if (/\/project\//.test(was)) await page.goto(was, { waitUntil: "domcontentloaded" });
    return { projects };
  }
  const same = projects.filter((p) => p.title === title);
  if (same.length > 1) throw new Error(`${same.length} projects are called "${title}", so it isn't clear which to open. Rename one in Flow first.`);
  if (same.length) {
    await page.goto(same[0].url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Project navigation" }).waitFor({ state: "visible", timeout: 30_000 });
    return { project: same[0], created: false, projects };
  }
  if (!create) throw new Error(`No project is called "${title}". Pass create: true to make it, or pick one of: ${projects.map((p) => p.title).join(", ")}.`);
  await page.getByRole("button", { name: "New project" }).click();
  await page.waitForURL(/\/project\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const box = projectTitle(page);
  await box.waitFor({ state: "visible", timeout: 20_000 });
  await box.click();
  await selectAll(box);
  await page.keyboard.type(title, { delay: 20 });
  await page.keyboard.press("Enter");
  await pause(page, 2000);
  const named = await box.inputValue();
  if (named !== title) throw new Error(`Created a project at ${page.url()}, but Flow kept the title "${named}". Rename it there.`);
  const project = { title, url: page.url() };
  return { project, created: true, projects: [project, ...projects] };
}

// Menus close on Escape; the account panel does not and needs its own close button.
async function dismissOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const closePanel = page.getByRole("button", { name: "Close account panel" });
  if (await closePanel.isVisible().catch(() => false)) await closePanel.click({ timeout: 5000 }).catch(() => {});
}

// The balance only shows inside the account panel. That panel also holds "Sign out": never touch anything else in it.
async function readCredits(page: Page): Promise<number | undefined> {
  await dismissOverlays(page);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Account details" }).click({ timeout: 5000 });
  const link = page.getByRole("link", { name: /Google Flow credits/ });
  try {
    await link.waitFor({ state: "visible", timeout: 5000 });
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    return Number.isNaN(n) ? undefined : n;
  } finally {
    await dismissOverlays(page);
    await pause(page, 300);
  }
}

const settingsTrigger = (page: Page) => page.getByRole("button", { name: "Settings trigger" });

// Every finished tile carries its media id in data-media-id; some thumbnails also have it in the URL, but Flow
// serves signed /asb/ links with no uuid, so the attribute comes first and the URL is only a fallback.
// Video tiles at rest expose neither, and their signed thumbnail URL is re-signed over time - using it as a handle
// made old tiles look new. Titles are stable, so an id-less tile is identified by its title instead.
const TILE_ID_JS = `(tile) => {
  const media = tile.querySelector("img[data-media-id], video[data-media-id], img[src], video[src]");
  const id = media && (media.getAttribute("data-media-id") || media.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]);
  if (id) return id;
  const title = tile.getAttribute("aria-label");
  return title ? "title:" + title : undefined;
}`;

export async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (js) => [...document.querySelectorAll("flow-grid-tile-container")].map(eval(js)).filter(Boolean) as string[],
    TILE_ID_JS,
  );
}

// The grid is virtualised and the top bar hides once it is scrolled, so every step starts from the top,
// where new tiles appear.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0)));
  await pause(page, 400);
}

// Titles survive re-scans; the signed thumbnail URL used as a fallback handle does not (Flow re-signs it), so
// anything that has to find the same tile again should go through here.
const tileOf = (page: Page, asset: FlowAsset) =>
  asset.name
    ? page.locator(`flow-grid-tile-container[aria-label="${asset.name.replace(/"/g, '\\"')}"]`).first()
    : mediaTile(page, asset.id!);

const mediaTile = (page: Page, id: string) =>
  page
    .locator(
      id.startsWith("title:")
        ? `flow-grid-tile-container[aria-label="${id.slice(6).replace(/"/g, '\\"')}"]`
        : `flow-grid-tile-container:has([data-media-id="${id}"]), flow-grid-tile-container:has([src*="${id}"])`,
    )
    .first();

// A failed generation becomes a <flow-error-tile> ("Failed ... You have not been charged") with Flow's own Retry
// button. Old failures can sit anywhere in the grid, so only error tiles above the first already-known tile count.
export async function newErrorTiles(page: Page, known: Iterable<string>): Promise<number> {
  return page.evaluate(([ids, js]: [string[], string]) => {
    const seen = new Set(ids);
    let errors = 0;
    for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
      const id = (eval(js) as (t: Element) => string | undefined)(tile);
      if (id && seen.has(id)) break;
      if (tile.querySelector("flow-error-tile")) errors++;
    }
    return errors;
  }, [[...known], TILE_ID_JS] as [string[], string]);
}

// Flow's Retry replaces the failed tile with a fresh render of the same prompt and settings, free of charge.
// Tiles produced by Agent mode only offer Delete, so the button may not be there at all.
async function retryErrorTile(page: Page, tile: Locator): Promise<boolean> {
  await hoverTile(page, tile);
  const retry = tile.getByRole("button", { name: "Retry" });
  if (!(await retry.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await retry.click({ timeout: 10_000 });
  await pause(page, 1500);
  await scrollToTop(page);
  return true;
}

// Big batches put more new tiles in the grid than Flow renders at once, so this walks down from the top, pressing
// Retry on every failed tile it meets, until it reaches a tile that existed before the job (or the end of the grid).
// Agent-mode failures offer no Retry button; the walk then stops and reports what it counted.
export async function retryNewErrorTiles(
  page: Page,
  known: Iterable<string>,
  dryRun = false,
): Promise<{ errors: number; reachedKnown: boolean; retried: number }> {
  const ids = [...known];
  let errors = 0;
  let retried = 0;
  let reachedKnown = false;
  let retryable = true;
  for (let pass = 0; pass < 80; pass++) {
    await scrollToTop(page);
    let found = false;
    for (let step = 0; step < 60 && !found && !reachedKnown; step++) {
      const state = await page.evaluate(([known, js]: [string[], string]) => {
        const seen = new Set(known);
        for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
          const id = (eval(js) as (t: Element) => string | undefined)(tile);
          const name = tile.getAttribute("aria-label");
          if ((id && seen.has(id)) || (name && seen.has(name))) return "known";
          if (tile.querySelector("flow-error-tile")) return "error";
        }
        return "none";
      }, [ids, TILE_ID_JS] as [string[], string]);
      if (state === "known") reachedKnown = true;
      else if (state === "error") {
        found = true;
        errors++;
        if (dryRun) break;
        retryable = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
        if (!retryable) break;
        retried++;
      } else {
        const moved = await page.evaluate(() => {
          const el = document.querySelector(".page-container");
          if (!el) return false;
          const top = el.scrollTop;
          el.scrollTop = top + el.clientHeight * 0.8;
          return el.scrollTop > top;
        });
        if (!moved) reachedKnown = true;
        await pause(page, 400);
      }
    }
    // A successful Retry reshuffles the grid (the new render jumps to the top), so the walk starts again.
    if (!found || dryRun || !retryable) break;
  }
  await scrollToTop(page);
  return { errors, reachedKnown, retried };
}

async function waitForNewMedia(page: Page, before: string[], count: number, timeoutMs: number, job?: Job): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let retriesLeft = job?.params.retries ?? 1;
  let failures = 0;
  while (Date.now() < deadline) {
    await pause(page, 2000);
    const tiles = await page.evaluate(
      (js) =>
        [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
          id: (eval(js) as (t: Element) => string | undefined)(t),
          busy: /\d+%/.test((t as HTMLElement).innerText),
        })),
      TILE_ID_JS,
    );
    const newTiles = tiles.filter((t) => t.id && !before.includes(t.id));
    // Flow titles a clip while it is still rendering ("Camera pushing in on deity 19%", 2026-10-09), and a title is
    // enough to identify a tile, so a new tile only counts once its progress is gone - otherwise the download starts on a
    // half-made clip. New tiles are listed first, so anything beyond the requested count is not ours.
    const fresh = [...new Set(newTiles.filter((t) => !t.busy).map((t) => t.id!))];
    if (fresh.length >= count && !newTiles.some((t) => t.busy)) return fresh.slice(0, count);
    const progress = await page.evaluate(() =>
      [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map((t) => (t as HTMLElement).innerText.match(/\d+%/)?.[0]).filter(Boolean),
    );
    if (job) job.progress = progress.join(", ") || undefined;
    const errors = progress.length ? 0 : await newErrorTiles(page, before);
    if (!errors) continue;
    failures += errors;
    if (retriesLeft > 0) {
      retriesLeft--;
      if (job) job.progress = "Flow failed, retrying";
      const retried = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
      if (retried) continue;
    }
    if (fresh.length) return fresh;
    throw new Error(`Flow failed this generation ${failures} time(s) ("Sorry, this image/video failed to generate"). Nothing was charged. Try again later or reword the prompt.`);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish.`);
}

async function openSettings(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: "Image", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe.isVisible().catch(() => false)) return;
    await settingsTrigger(page).click();
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Could not open Flow's generation settings popover.");
}

async function pickRadio(page: Page, name: string | RegExp): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: typeof name === "string" }).first();
  if (!(await radio.isVisible().catch(() => false))) {
    throw new Error(`Flow has no "${name}" option for the current mode/model.`);
  }
  if (!(await radio.isChecked())) {
    await radio.click();
    await pause(page, 500);
  }
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  if ((await button.innerText()).toLowerCase().includes(model.toLowerCase())) return;
  await button.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const index = names.findIndex((n) => n.toLowerCase().includes(model.toLowerCase()));
  if (index < 0) {
    await page.keyboard.press("Escape");
    throw new Error(`Model "${model}" not found. Available here: ${names.join(", ")}`);
  }
  await items.nth(index).click();
  await pause(page, 700);
}

// Applies the scene settings and returns the credit cost Flow quotes for them.
async function applySettings(page: Page, job: Job): Promise<number> {
  const s = job.params;
  const framesMode = Boolean(s.first_frame || s.last_frame);
  await openSettings(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video");
  if (s.type === "video") await pickRadio(page, framesMode ? "Frames" : "Ingredients");
  if (s.aspect_ratio) await pickRadio(page, s.aspect_ratio);
  if (s.model) await pickModel(page, s.model);
  if (s.type === "video" && s.resolution) await pickRadio(page, new RegExp(`^${s.resolution}`));
  if (s.type === "video" && s.duration) await pickRadio(page, `${s.duration}s`);
  await pickRadio(page, `x${s.variants ?? 1}`);
  await pause(page, 600);
  const costText = await page.getByRole("link", { name: /credits?$/ }).innerText();
  const cost = Number(costText.match(/\d+/)?.[0] ?? NaN);
  await page.keyboard.press("Escape");
  await pause(page, 400);
  if (Number.isNaN(cost)) throw new Error(`Could not read the credit cost from Flow ("${costText}").`);
  return cost;
}

const ASSET_PREFIX = "asset:";

// Uploads under a unique filename so the asset can be picked unambiguously afterwards.
// "asset:<name>" refers to something already in the Flow project (image, video, character) and skips the upload.
export async function uploadAsset(page: Page, job: Job, file: string, label: string): Promise<string> {
  if (file.startsWith(ASSET_PREFIX)) return file.slice(ASSET_PREFIX.length).trim();
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const name = `fm-${job.id}-${label}${extname(file).toLowerCase()}`;
  const staged = join(mkdtempSync(join(tmpdir(), "flow-mcp-")), name);
  copyFileSync(file, staged);
  await scrollToTop(page);
  const before = await mediaIds(page);
  await page.getByRole("button", { name: "Add media menu" }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles(staged);
  await waitForNewMedia(page, before, 1, 90_000);
  // The grid shows the upload at once as a local preview known only by its title, but the pickers offer it only once
  // Flow has stored it and the tile carries a media id: attaching straight away timed out on 2026-10-09.
  await page
    .locator(`flow-grid-tile-container[aria-label="${name}"] [data-media-id]`)
    .first()
    .waitFor({ state: "attached", timeout: 120_000 })
    .catch(() => {
      throw new Error(`Flow did not finish storing the upload ${name} within 2 minutes; nothing was generated.`);
    });
  return name;
}

// The media id of a tile in the grid, by its exact title, when the tile is mounted (an upload just made always is).
const tileMediaId = (page: Page, title: string) =>
  page
    .locator(`flow-grid-tile-container[aria-label="${title.replace(/"/g, '\\"')}"] [data-media-id]`)
    .first()
    .getAttribute("data-media-id", { timeout: 3000 })
    .then((id) => id ?? undefined, () => undefined);

export interface FrameWanted {
  slot: "start" | "end";
  name: string;
  id?: string;
}

// What the Frames composer's Start and End slots hold (mapped 2026-10-09): an empty slot is a button.empty-chip
// reading "Start" or "End"; a filled one turns into button.chip-container[aria-label="Image ingredient"] around an
// img whose src names the picture's media id (flow-content.google/image/<uuid>). They sit either side of "Swap first
// and last frames". Per slot: null when empty, the media id when filled ("" if none shows), undefined when unreadable.
export async function frameSlots(page: Page): Promise<{ start?: string | null; end?: string | null } | undefined> {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const swap = buttons.findIndex((b) => b.getAttribute("aria-label") === "Swap first and last frames");
    if (swap < 0) return undefined;
    const held = (b?: Element) => {
      if (b?.classList.contains("empty-chip")) return null;
      if (b?.getAttribute("aria-label") !== "Image ingredient") return undefined;
      return b.querySelector("img")?.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0] ?? "";
    };
    return { start: held(buttons[swap - 1]), end: held(buttons[swap + 1]) };
  });
}

// The frames a scene asked for must be in their slots when Generate is pressed. Flow once made a paid clip with the
// Start slot empty (k2-brahma, 2026-10-09): the picker took the click but kept no frame, and the clip came out as plain
// text-to-video, 10 credits for nothing. So the slots are read right before Generate, and anything but this scene's
// own pictures stops the job with nothing spent (queue.ts retries that once by itself, matching this wording).
const FRAME_NOT_HELD = "Flow's composer did not hold this scene's";
export async function checkFrames(page: Page, wanted: FrameWanted[]): Promise<void> {
  if (!wanted.length) return;
  // A chip can show its picture's id a moment after the picker closes, so the slots get a few seconds to settle.
  let held = await frameSlots(page);
  const settled = () => wanted.every((f) => held?.[f.slot] && (!f.id || held[f.slot] === f.id));
  for (let i = 0; i < 10 && !settled(); i++) {
    await pause(page, 500);
    held = await frameSlots(page);
  }
  for (const f of wanted) {
    const has = held?.[f.slot];
    if (has && (!f.id || has === f.id)) continue;
    const seen = !held ? "Flow showed no Start/End slots" : has === null ? "it was empty" : has === undefined ? "it could not be read" : `it held another picture (${has || "no id"})`;
    throw new Error(
      `${FRAME_NOT_HELD} ${f.slot === "start" ? "first" : "last"} frame (${f.name}) when Generate was due: ${seen}. Nothing was generated or spent.`,
    );
  }
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Options read "<name>", "<name> Image|Video|Avatar" or "<voice> <description>", so match on the leading name.
const optionByName = (list: Locator, name: string) =>
  list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`, "i") }).first();

// The frame pickers attach on click; the ingredients picker only previews and needs "Add to prompt".
// Option names are "<asset name>" or "<asset name> Image|Video", so match on the prefix.
export async function attachAsset(page: Page, opener: Locator, assetName: string): Promise<void> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  // A picker keeps the list it opened with, so an asset stored a moment ago can be missing: close it and look again.
  for (let attempt = 0; ; attempt++) {
    await opener.click();
    await list.waitFor({ state: "visible", timeout: 10_000 });
    let option = optionByName(list, assetName);
    // Voices, characters and avatars live behind their own tabs, so look there when "All" does not have it.
    if (!(await option.isVisible().catch(() => false))) {
      for (const tab of ["Voices", "Characters", "Avatars", "Uploads"]) {
        const t = page.getByRole("tab", { name: tab, exact: true });
        if (!(await t.isVisible().catch(() => false))) continue;
        await t.click();
        await pause(page, 1200);
        option = optionByName(list, assetName);
        if (await option.isVisible().catch(() => false)) break;
      }
    }
    if (await option.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
      await option.click();
      break;
    }
    await page.keyboard.press("Escape");
    if (attempt >= 4) throw new Error(`Flow's picker never offered "${assetName}"; nothing was generated.`);
    await pause(page, 3000);
  }
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  if (await add.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) await add.click().catch(() => {});
  await list.waitFor({ state: "hidden", timeout: 10_000 });
  await pause(page, 500);
}

// Cmd+A only selects on a Mac when Playwright sends it with Chrome's "selectAll" editing command, which it does only for
// a browser it knows to be a Mac. The Playwright Extension's relay names no platform (its user agent is
// "CDP-Bridge-Server/1.0.0"), so there Cmd+A selected nothing and typing went in at the caret: tiles came out as
// "Women tossing blossoms in gardenk4-spring" and projects as "Oct 09 -TS · Manidweepam 21:08" (2026-10-09). The page
// selects the field's text itself instead, which works in every mode.
async function selectAll(field: Locator): Promise<void> {
  await field.evaluate((el) => {
    (el as HTMLElement).focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    else document.execCommand("selectAll");
  });
}

// The prompt as the box shows it, for comparing: one line, plain quotes and dashes (an editor may curl them).
const plainText = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

async function typePrompt(page: Page, prompt: string): Promise<void> {
  const box = page.locator(".ProseMirror");
  // Enter submits in Flow, so the prompt goes in as a single line.
  const wanted = prompt.replace(/\s*\n+\s*/g, " ").trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    await box.click();
    await selectAll(box);
    await page.keyboard.press("Delete");
    await page.keyboard.type(wanted, { delay: 8 });
    await pause(page, 500);
    // In the user's own Chrome the window may have been brought forward while they work, and anything they type then
    // lands in the box and would be paid for. Go on only when the box holds exactly this prompt.
    if (plainText(await box.innerText().catch(() => "")) === plainText(wanted)) return;
  }
  throw new Error("Flow's prompt box did not hold the prompt as typed (were keys typed into the Flow window?). Nothing was generated.");
}

export type DownloadQuality = "original" | "upscaled";

export async function downloadMedia(page: Page, mediaId: string, targetStem: string, quality: DownloadQuality = "original"): Promise<string[]> {
  // A tile that has just finished rendering is still settling and the grid re-renders around it, so give it a moment.
  await scrollToTop(page);
  await pause(page, 2500);
  const tile = mediaTile(page, mediaId);
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  // Grab the title NOW, while the id still resolves, so the download can re-find this exact tile later even if the
  // virtualised grid unmounts and remounts it between steps.
  const title = (await tile.getAttribute("aria-label").catch(() => null)) ?? undefined;
  return downloadTile(page, tileByIdOrTitle(page, mediaId, title), targetStem, quality);
}

type TileResolver = () => Promise<Locator>;

// Re-finds the tile on every attempt instead of trusting one handle that may have been unmounted by the virtual grid:
// by id first, then by title. NOT a confirmed root cause for the post-generation download failures - the failure has
// never reproduced on a settled tile - but it removes one whole class of staleness, and the menu dump below is what
// will actually explain the next one. An empty "Untitled Scene" placeholder holds no media and its menu has no
// Download, so :has([src]) makes sure we never grab one by title.
function tileByIdOrTitle(page: Page, id: string, title?: string): TileResolver {
  return async () => {
    const byId = mediaTile(page, id);
    if (await byId.count()) return byId;
    if (title) {
      const byTitle = page.locator(`flow-grid-tile-container[aria-label="${title.replace(/"/g, '\\"')}"]:has([src])`).first();
      if (await byTitle.count()) return byTitle;
    }
    throw new Error(
      `The finished tile is no longer in the grid${title ? ` ("${title}")` : ""}. The media is still in Flow: flow_download fetches it without spending credits again.`,
    );
  };
}

// Playwright keeps a download in a per-connection temp file it can delete from under us; pointing Chrome itself at a
// directory we own makes the bytes ours the moment they land.
async function useOwnDownloadDir(page: Page): Promise<void> {
  // Setting this once per process was not enough: another CDP client attaching resets it browser-wide. It is
  // re-asserted before every single download, and the profile's own download folder (chrome.ts) is this same folder,
  // so a reset still lands the file here.
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_DIR, eventsEnabled: true }).catch(() => {});
}

// Everything already sitting in our download folder, so a new arrival can be told apart from what was there before.
// ~/Downloads is deliberately never watched: anything the user's own browsers saved there in the meantime would have
// been taken for Flow's file and moved into a film folder.
function downloadsNow(): Set<string> {
  const seen = new Set<string>();
  if (existsSync(DOWNLOAD_DIR)) for (const f of readdirSync(DOWNLOAD_DIR)) seen.add(join(DOWNLOAD_DIR, f));
  return seen;
}

// Waits for a file to finish arriving in our download directory and returns it.
async function waitForDownloadedFile(page: Page, before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stable: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await pause(page, 1000);
    const candidates = existsSync(DOWNLOAD_DIR)
      ? readdirSync(DOWNLOAD_DIR)
          .filter((f) => !before.has(join(DOWNLOAD_DIR, f)) && !f.endsWith(".crdownload") && !f.startsWith("."))
          .map((f) => join(DOWNLOAD_DIR, f))
      : [];
    for (const path of candidates) {
      const size = statSync(path).size;
      if (stable?.path === path && stable.size === size && size > 0) return path;
      stable = { path, size };
    }
  }
  throw new Error(`Flow started the download but no file arrived in ${DOWNLOAD_DIR}. The media is still in Flow: flow_download fetches it again for free.`);
}

// A download of the user's own that got caught in the borrowed folder goes on to ~/Downloads under its own name.
function handBack(guid: string, name: string): void {
  const from = join(DOWNLOAD_DIR, guid);
  if (!existsSync(from)) return;
  const home = join(homedir(), "Downloads");
  const ext = extname(name);
  let to = join(home, name);
  for (let i = 1; existsSync(to); i++) to = join(home, `${name.slice(0, name.length - ext.length)} (${i})${ext}`);
  renameSync(from, to);
}

// Runs `start` (the click that makes Flow download) and returns the saved file. In the tool's own Chrome every download
// goes to DOWNLOAD_DIR, which is watched for the new arrival. In the user's own Chrome (ATTACH) that folder is borrowed
// for this one download only and the browser's normal behaviour is restored straight after; the file is picked out by
// Chrome's own download events for the tool's tab, and anything the user downloads meanwhile is handed back.
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Through the Playwright Extension Chrome saves Flow's file into the user's own Downloads folder (the extension cannot
// redirect downloads), under Flow's name for it: the item's title, often followed by the size and a timestamp. Only a
// file that is new and whose name starts with that title is taken, so nothing else the user downloads meanwhile can be
// mistaken for it.
async function fromUsersDownloads(page: Page, title: string | undefined, start: () => Promise<void>, timeoutMs: number): Promise<string> {
  if (!title) throw new Error("This item has no title to find its download by; nothing was taken from your Downloads folder.");
  const dir = usersDownloadDir();
  const key = slug(title);
  const ours = (file: string) => {
    const name = slug(file.replace(/\.[^.]+$/, ""));
    return name === key || name.startsWith(`${key}_`);
  };
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  await start();
  const deadline = Date.now() + timeoutMs;
  let stable: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await pause(page, 1000);
    const arrived = readdirSync(dir).filter((f) => !before.has(f) && !f.endsWith(".crdownload") && !f.startsWith(".") && ours(f));
    for (const f of arrived) {
      const path = join(dir, f);
      const size = statSync(path).size;
      if (stable?.path === path && stable.size === size && size > 0) return path;
      stable = { path, size };
    }
  }
  throw new Error(`Flow's download of "${title}" did not arrive in ${dir}. The media is still in Flow: flow_download fetches it again for free.`);
}

async function captureDownload(page: Page, start: () => Promise<void>, timeoutMs: number, title?: string): Promise<string> {
  if (EXTENSION) return fromUsersDownloads(page, title, start, timeoutMs);
  if (!ATTACH) {
    await useOwnDownloadDir(page);
    const before = downloadsNow();
    await start();
    return waitForDownloadedFile(page, before, timeoutMs);
  }
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const pageSession = await page.context().newCDPSession(page);
  const frame = (await pageSession.send("Page.getFrameTree")).frameTree.frame.id;
  await pageSession.detach().catch(() => {});
  const session = await page.context().browser()!.newBrowserCDPSession();
  const names = new Map<string, string>();
  const finished = new Set<string>();
  let ours: string | undefined;
  let canceled = false;
  session.on("Browser.downloadWillBegin", (e) => {
    names.set(e.guid, e.suggestedFilename);
    if (!ours && e.frameId === frame) ours = e.guid;
  });
  session.on("Browser.downloadProgress", (e) => {
    if (e.state === "completed") {
      finished.add(e.guid);
      if (e.guid !== ours && names.has(e.guid)) handBack(e.guid, names.get(e.guid)!);
    }
    if (e.state === "canceled" && e.guid === ours) canceled = true;
  });
  await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_DIR, eventsEnabled: true });
  try {
    await start();
    const deadline = Date.now() + timeoutMs;
    while (!ours || !finished.has(ours)) {
      if (canceled) throw new Error("Chrome cancelled Flow's download.");
      if (Date.now() > deadline) {
        throw new Error(`Flow's download did not finish within ${Math.round(timeoutMs / 1000)}s. The media is still in Flow: flow_download fetches it again for free.`);
      }
      await pause(page, 500);
    }
    return join(DOWNLOAD_DIR, ours);
  } finally {
    await session.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    // Downloads of the user's that started in the borrowed folder finish there; keep listening a while to hand them back.
    const pending = [...names.keys()].filter((g) => g !== ours && !finished.has(g));
    if (pending.length) setTimeout(() => void session.detach().catch(() => {}), 10 * 60_000);
    else await session.detach().catch(() => {});
  }
}

// Where a tile sits once it holds still: the grid lays itself out again while renders finish. A tile that keeps moving
// for 3 s is taken where it is now; its centre is still on it, and what the pointer then finds inside it is checked.
async function steadyBox(page: Page, tile: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let before = await tile.boundingBox({ timeout: 5000 });
  for (let i = 0; i < 12; i++) {
    await pause(page, 250);
    const box = await tile.boundingBox({ timeout: 5000 });
    if (box && before && box.width > 0 && box.x === before.x && box.y === before.y && box.width === before.width && box.height === before.height) return box;
    before = box;
  }
  if (!before?.width) throw new Error("The tile is not visible in Flow's grid.");
  return before;
}

// Flow reveals a tile's controls on a genuine pointer move, so the mouse is driven to the tile itself. Playwright's
// scroll first waits for the tile to hold still, which it can only see while Chrome paints the window (a covered or
// minimised window paints nothing). It gave up after 30 s on three clips that were already made and paid for (k3-banyan,
// k2-brahma, k3-light, 2026-10-09). So every try first brings Flow back on screen (waiting for a pause in the user's
// work, as a job's start does), and a few short tries replace one long wait; the later ones scroll through the page
// itself, in case the tile never holds still for Playwright.
async function hoverTile(page: Page, tile: Locator): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await onScreen(page, true))) throw new Error(NOT_PAINTED);
    try {
      if (attempt < 2) await tile.scrollIntoViewIfNeeded({ timeout: 8000 });
      else await tile.evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 8000 });
      const box = await steadyBox(page, tile);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await pause(page, 900);
      return;
    } catch (err) {
      last = err;
      await pause(page, 1500 * (attempt + 1));
    }
  }
  throw last;
}

// Chrome's "allowAndName" writes each download under a bare id with NO extension, so there is nothing to copy from
// the filename and everything was landing as .mp4 - including stills, which arrived as clip-01.mp4. Read the first
// bytes instead and name the file after what it actually is.
function extensionOf(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return ".png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return ".mp4";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  // Flow hands back a ZIP when one tile holds several takes (a generation made at x2-x4): the takes come bundled.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  // Anything else is unknown. Naming it .mp4 (the old fallback) made two ZIPs look like broken videos and broke a cut.
  return ".bin";
}

// Unpacks a multi-take ZIP into <stem>.mp4, <stem>-v2.mp4, ... - the same names a multi-variant generation gets - so
// every take is usable instead of one unplayable archive. The ZIP is kept beside them, renamed, in case it is wanted.
function unpackTakes(zip: string, targetStem: string): string[] {
  const work = mkdtempSync(join(tmpdir(), "flow-takes-"));
  const takes = extractZip(zip, work).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  for (const [i, path] of takes.entries()) {
    const dest = `${targetStem}${i ? `-v${i + 1}` : ""}${extensionOf(path)}`;
    renameSync(path, dest);
    out.push(dest);
  }
  renameSync(zip, `${targetStem}-takes.zip`);
  if (!out.length) throw new Error("Flow sent a ZIP with nothing usable inside it.");
  return out;
}

// A finished tile shows no progress ("NN%") and holds its picture or clip. Flow titles a clip while it is still
// rendering, so a title alone proves nothing.
async function tileFinished(page: Page, tile: Locator, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const finished = () =>
    tile
      .evaluate((t) => !/\d+%/.test((t as HTMLElement).innerText) && Boolean(t.querySelector("img[src], video[src], [data-media-id]")), undefined, { timeout: 5000 })
      .catch(() => false);
  while (!(await finished())) {
    if (Date.now() > deadline) throw new Error("The tile never finished rendering.");
    await pause(page, 1500);
  }
}

// The box a tile's Rename opens (mapped 2026-10-09): an <input> labelled "Editable text" like the project title in the
// top bar, but marked "editing", outside the tile itself, beside Done and Cancel buttons. It opens holding the old
// title with the caret at its end, which is why a select-all that did nothing appended the new name. Escape cancels it.
const renameBox = (page: Page) => page.locator('input[aria-label="Editable text"].editing').last();

// Flow titles clips itself and happily reuses a title: two takes of the same scene both came back as "Woman climbing
// granite wall", which makes a clip impossible to identify by name and cost real time tonight. Renaming each finished
// tile to our own scene name fixes it at the source - the user's suggestion, and the right one. The old title is
// selected in the page and replaced, the box is checked before Enter, and a rename only counts once the tile shows it.
// Never throws: by now the clip is made and paid for, and a failed rename must not fail the job. Returns the tile's
// handle afterwards (a tile known only by its title is found by the new one).
export async function renameTile(page: Page, id: string, title: string): Promise<{ id: string; renamed: boolean; was?: string; why?: string }> {
  const tile = mediaTile(page, id);
  const renamed = id.startsWith("title:") ? `title:${title}` : id;
  const was = (await tile.getAttribute("aria-label", { timeout: 5000 }).catch(() => null)) ?? undefined;
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await tileFinished(page, tile);
      await hoverTile(page, tile);
      await tile.getByRole("button", { name: "More options" }).click({ timeout: 5000 });
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click({ timeout: 5000 });
      const box = renameBox(page);
      await box.waitFor({ state: "attached", timeout: 5000 });
      await selectAll(box);
      await page.keyboard.type(title, { delay: 8 });
      const typed = await box.inputValue({ timeout: 3000 });
      if (typed !== title) throw new Error(`the name box held "${typed}"`);
      await page.keyboard.press("Enter");
      await pause(page, 1500);
      const now = await mediaTile(page, renamed).getAttribute("aria-label", { timeout: 5000 }).catch(() => null);
      if (now === title) return { id: renamed, renamed: true, was };
      why = now === null ? "the tile could not be found again afterwards" : `the tile reads "${now}"`;
    } catch (err) {
      why = firstLine(err);
      await page.keyboard.press("Escape").catch(() => {});
      if (why === NOT_PAINTED) break;
    }
    await pause(page, 2000 * (attempt + 1));
  }
  return { id, renamed: false, was, why };
}

// Once Flow has finished making something the credits are spent, and a job that then ends "failed" invites a second,
// paid run: k3-banyan and k2-brahma were made and paid for, then failed at the hover (2026-10-09). From that point on a
// problem becomes a note on a "done" job, naming the tile that flow_download fetches for free.
async function saveFinished(page: Page, job: Job, id: string, stem: string): Promise<string[]> {
  try {
    return await downloadMedia(page, id, stem, job.params.download_quality);
  } catch (err) {
    const title = await mediaTile(page, id).getAttribute("aria-label", { timeout: 3000 }).catch(() => null);
    addNote(job, `made in Flow${title ? ` as "${title}"` : ""} and paid for, but not downloaded (${firstLine(err)}). Fetch it with flow_download, free; never generate it again`);
    return [];
  }
}

async function downloadTile(page: Page, target: Locator | TileResolver, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  const resolve: TileResolver = typeof target === "function" ? target : async () => target;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tile = await resolve();
      // Upscales are rendered on demand, so they can take minutes to appear.
      const file = await captureDownload(
        page,
        async () => {
          // Flow only shows a tile's toolbar for a real pointer move over it - Playwright's hover() does not trigger it.
          // The toolbar's "More options" beats a right-click, which can land on the <video> and raise Chrome's own menu.
          await hoverTile(page, tile);
          const more = tile.getByRole("button", { name: "More options" });
          if (await more.isVisible({ timeout: 3000 }).catch(() => false)) await more.click();
          else await tile.click({ button: "right" });
          const download = page.getByRole("menuitem", { name: "Download", exact: true });
          if (!(await download.isVisible({ timeout: 8000 }).catch(() => false))) {
            // Saying what Flow actually offered turns "locator timed out" into something that explains itself next time.
            const items = await page.locator('[role="menuitem"]').evaluateAll((ms) => ms.map((m) => (m.textContent ?? "").replace(/\s+/g, " ").trim()));
            throw new Error(items.length ? `Flow's tile menu has no Download item. It offered: ${items.join(" | ")}` : "Flow's tile menu did not open.");
          }
          await download.click({ timeout: 10_000 });
          // Size submenu: "720p Original size" / "1K Original size", then the upscales. "upscaled" means the free one -
          // 1080p for a clip, 2K for a still - and never 4K, which costs credits on a clip (50 on Ultra).
          const original = page.getByRole("menuitem", { name: /original/i }).first();
          if (await original.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
            const upscaled = page
              .locator('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])')
              .filter({ hasText: /\b(1080p|2K)\b/i })
              .filter({ hasNotText: /4K|credit/i })
              .first();
            const wanted = quality === "upscaled" && (await upscaled.isVisible().catch(() => false)) ? upscaled : original;
            await wanted.click();
          }
        },
        quality === "upscaled" ? 600_000 : 180_000,
        (await tile.getAttribute("aria-label").catch(() => null)) ?? undefined,
      );
      const kind = extensionOf(file);
      let saved: string[];
      if (kind === ".zip") saved = unpackTakes(file, targetStem);
      else {
        const target = `${targetStem}${kind}`;
        renameSync(file, target);
        saved = [target];
      }
      await page.keyboard.press("Escape");
      await scrollToTop(page);
      return saved;
    } catch (err) {
      lastError = err;
      // hoverTile has already waited for the window to come back; another try would only wait again.
      if (err instanceof Error && err.message === NOT_PAINTED) break;
      await page.keyboard.press("Escape").catch(() => {});
      await pause(page, 2000);
    }
  }
  throw lastError;
}

async function ensureProjectGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  if (root && page.url() !== root) {
    await page.goto(root, { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  await pause(page, 800);
  await scrollToTop(page);
}

// Drives one generation in the Flow tab and returns the downloaded file paths.
export async function runGeneration(job: Job): Promise<string[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;

  await ensureProjectGrid(page);
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  if ((await agent.getAttribute("aria-pressed")) === "true") await agent.click();
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();

  job.credits = await applySettings(page, job);
  if (job.credits > s.max_credits) {
    throw new Error(
      `Flow quotes ${job.credits} credits for this scene, above max_credits=${s.max_credits}. Nothing was generated. Raise max_credits or pick a cheaper model/duration/variants.`,
    );
  }

  // Each frame is remembered with its media id, so the slots can be checked right before Generate (checkFrames).
  const frames: FrameWanted[] = [];
  for (const [slot, file] of [["start", s.first_frame], ["end", s.last_frame]] as const) {
    if (!file) continue;
    const name = await uploadAsset(page, job, file, slot);
    await attachAsset(page, page.getByRole("button", { name: slot === "start" ? "Start" : "End", exact: true }), name);
    frames.push({ slot, name, id: await tileMediaId(page, name) });
  }
  // Flow's composer offers Frames OR Ingredients, never both: a clip with first/last frames cannot also carry
  // reference images. The frames already pin the look, so the references are dropped and the job says so.
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  if (framesMode && s.reference_images?.length) {
    job.note = [job.note, `first/last frames were set, so ${s.reference_images.length} reference image(s) were skipped — Flow allows one or the other.`]
      .filter(Boolean)
      .join(" · ");
    s.reference_images = [];
  }
  for (const [i, ref] of (s.reference_images ?? []).entries()) {
    const name = await uploadAsset(page, job, ref, `ref${i + 1}`);
    await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
  }
  const wanted = (s.reference_images ?? []).length;
  if (wanted) {
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < wanted) throw new Error(`Only ${attached} of ${wanted} reference image(s) attached in Flow; nothing was generated.`);
  }

  await typePrompt(page, s.prompt);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or inputs were not accepted.");
  await scrollToTop(page);
  const before = await mediaIds(page);
  await checkFrames(page, frames);
  await start.click();

  const variants = s.variants ?? 1;
  const fresh = await waitForNewMedia(page, before, variants, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, job);
  job.progress = undefined;

  // Made, and paid for: nothing from here on may fail the job (saveFinished).
  mkdirSync(s.output_dir, { recursive: true });
  const files: string[] = [];
  for (const [i, made] of fresh.entries()) {
    const label = fresh.length > 1 ? `${s.file_stem}-v${i + 1}` : s.file_stem;
    // Flow names clips itself and reuses those names, so two takes of one scene come back identically titled and
    // neither can be found by name afterwards. Renaming each finished tile to the scene's own file stem makes every
    // later lookup - download, continue, assemble - unambiguous. A rename that does not take is a note.
    const title = s.named ? label : `${basename(s.output_dir)}-${label}`;
    const { id, renamed, was, why } = await renameTile(page, made, title);
    addNote(job, renamed ? `renamed in Flow to ${title}` : `not renamed: Flow's title stays "${was ?? "?"}" (${why})`);
    await pause(page, 800);
    files.push(...(await saveFinished(page, job, id, join(s.output_dir, label))));
    await pause(page, 1500);
  }
  return files;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  id?: string;
}

// Walks the virtualised grid from the top and collects every tile it passes. Recycled tiles sometimes have no
// media id yet, so entries are keyed by title and the id is filled in from whichever pass saw it.
async function scanGrid(page: Page, stopAt?: (assets: FlowAsset[]) => boolean): Promise<FlowAsset[]> {
  await dismissOverlays(page);
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  await pause(page, 600);
  await scrollToTop(page);
  const seen = new Map<string, FlowAsset>();
  for (let step = 0; step < 200; step++) {
    const batch = await page.evaluate(
      (js) =>
        [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
          name: t.getAttribute("aria-label") ?? "",
          // A scene (several clips on one timeline) is its own tile type; lumping it in with images made it look
          // like a still in the Library and download as a ZIP of loose clips.
          kind: t.querySelector("flow-scene-tile") ? ("scene" as const) : t.querySelector("flow-video-tile") ? ("video" as const) : ("image" as const),
          id: (eval(js) as (t: Element) => string | undefined)(t),
        })),
      TILE_ID_JS,
    );
    for (const a of batch) {
      if (!a.name) continue;
      const known = seen.get(a.name);
      if (!known) seen.set(a.name, a);
      else if (!known.id && a.id) known.id = a.id;
    }
    if (stopAt?.([...seen.values()])) break;
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 700);
  }
  return [...seen.values()];
}

// Characters live in their own left-nav section. With none yet, Flow shows a template chooser instead, so only
// entries that actually carry a character thumbnail count.
export async function listCharacters(): Promise<string[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  await dismissOverlays(page);
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("Characters", { exact: true }).click();
  await pause(page, 2500);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll("flow-character-tile")].map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
  );
  await ensureProjectGrid(page).catch(() => {});
  // Strip Material icon ligatures Flow renders as text ("accessibility_new", "person") and its own avatar.
  return [...new Set(names.map((n) => n.replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "").replace(/\s+/g, " ").trim()))].filter(
    (n) => n && n !== "Me",
  );
}

// A run that stopped half-way leaves Flow inside a character's editor, where the project navigation is gone. Done keeps
// whatever is on screen - leaving any other way could drop a finished edit - and then the grid is put back.
async function leaveCharacterEditor(page: Page): Promise<void> {
  if (/\/character(\/|$)/.test(new URL(page.url()).pathname)) {
    await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 10_000 }).catch(() => {});
  }
  await ensureProjectGrid(page).catch(() => {});
}

// The portrait's own toolbar (Download image, Delete image) sits invisible with pointer events off until a real pointer
// moves over the picture - the same rule as grid tiles - so a plain click lands on the image and times out. That, plus
// Playwright's download event, is why an edit that worked never reached disk (2026-10-02). Point at the picture, then
// download through the same watched folders as every other file.
async function savePortrait(page: Page, name: string): Promise<string> {
  const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
  mkdirSync(dir, { recursive: true });
  const picture = page.getByRole("img", { name: "Generated character image" }).first();
  const button = page.getByRole("button", { name: "Download image", exact: true });
  const file = await captureDownload(
    page,
    async () => {
      let pressed = false;
      for (let attempt = 0; attempt < 3 && !pressed; attempt++) {
        await hoverTile(page, picture);
        pressed = await button.click({ timeout: 4000 }).then(
          () => true,
          () => false,
        );
      }
      if (!pressed) throw new Error("Flow never showed the portrait's Download image button");
    },
    90_000,
    name,
  );
  const portrait = join(dir, `${name.replace(/[^\w.-]+/g, "_")}${extensionOf(file)}`);
  renameSync(file, portrait);
  return portrait;
}

// Opens an existing character and restyles its portrait in place (Nano Banana, free) instead of making a new one.
// Without a change it only saves the character's current portrait: for a look changed by hand in Flow, or an edit whose
// portrait never reached disk.
export async function editCharacter(name: string, change?: string, job?: Job): Promise<{ name: string; portrait?: string; note?: string }> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  await leaveCharacterEditor(page);
  await dismissOverlays(page);
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("Characters", { exact: true }).click();
  await pause(page, 2500);

  const card = page.locator("flow-character-tile").filter({ hasText: name }).first();
  if (!(await card.isVisible().catch(() => false))) throw new Error(`No character called "${name}". Use flow_characters to list them.`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await pause(page, 2000);

  if (change) {
    const portraitImg = page.getByRole("img", { name: "Generated character image" }).first();
    const before = await portraitImg.getAttribute("src").catch(() => null);

    const box = page.locator(".ProseMirror").last();
    await box.click();
    await selectAll(box);
    // Delete leaves a full selection standing in this editor; Backspace clears it (mapped 2026-10-02).
    await page.keyboard.press("Backspace");
    // The character editor always draws a wide 16:9 picture (1376x768), whatever shape the portrait was. Told only "make
    // his coat red", it filled the frame with three Pips side by side (2026-10-02), so every edit pins a single figure.
    const told = `${change.replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".")} Exactly one ${name} in the picture: never add copies of ${name} or extra poses side by side.`;
    await page.keyboard.type(told, { delay: 8 });
    await pause(page, 600);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow did not accept the change (Start generation stayed disabled).");
    await start.click();

    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      await pause(page, 3000);
      const now = await portraitImg.getAttribute("src").catch(() => null);
      const pct = (await page.locator("main").first().innerText()).match(/\d+%/)?.[0];
      if (job) job.progress = pct;
      if (now && now !== before && !pct) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to redraw the character.");
    }
    if (job) job.progress = undefined;
  }

  // From here on the edit is done in Flow. A failed download must never throw that away, so it becomes a note instead.
  let portrait: string | undefined;
  let note: string | undefined;
  try {
    portrait = await savePortrait(page, name);
  } catch (err) {
    note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${err instanceof Error ? err.message : String(err)}). Call flow_character_edit with just the name to save it.`;
  }

  await leaveCharacterEditor(page);
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  return { name, portrait, note };
}

export async function listAssets(): Promise<FlowAsset[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  const assets = await scanGrid(page);
  await scrollToTop(page);
  return assets;
}

// Downloads media that already exists in the project, matched by (the start of) its title.
export async function downloadAsset(name: string, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  const matches = (a: FlowAsset) => a.name.toLowerCase().startsWith(name.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No asset whose title starts with "${name}". Use flow_assets to list titles.`);
  if (found.kind === "scene") return downloadScene(page, found, targetStem);
  return downloadTile(page, tileOf(page, found), targetStem, quality);
}

// Moves one item in the open project to Flow's Trash. Flow keeps it there with Restore and Delete permanently, so this
// is recoverable - and it never deletes permanently. Flow asks NO confirmation (mapped 2026-10-01: the tile menu's
// "Move to trash" removes the tile at once), so whoever calls this must confirm with the user first. Matching is by
// EXACT title, and an ambiguous title is refused: Flow reuses titles, and trashing the wrong one is the worst outcome.
export async function trashAsset(name: string): Promise<{ trashed: string }> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const same = (await scanGrid(page)).filter((a) => a.name === name);
  if (!same.length) throw new Error(`Nothing in the open project is called "${name}".`);
  if (same.length > 1) throw new Error(`${same.length} items are called "${name}", so it isn't clear which one to trash. Rename one in Flow first.`);
  // Scan again, stopping on the tile so it stays mounted in the virtual grid (no scrollToTop before acting on it).
  await scanGrid(page, (seen) => seen.some((a) => a.name === name));
  const tile = tileOf(page, same[0]);
  await hoverTile(page, tile);
  await tile.getByRole("button", { name: "More options" }).click();
  // US English says "Move to trash"; a UK English browser says "Move to bin" (seen 2026-10-09).
  await page.getByRole("menuitem", { name: /^Move to (trash|bin)$/i }).click();
  await pause(page, 2000);
  if (await tile.count()) throw new Error(`"${name}" is still in the project - Flow did not move it to Trash.`);
  await scrollToTop(page);
  return { trashed: name };
}

// A scene's tile menu downloads a ZIP of its loose clips, which is not what anyone wants. The whole scene comes out as
// ONE stitched file from inside the scene view: open the scene, press "Download scene", and Flow shows "Exporting your
// scene..." before the file arrives (a 29 s scene took a few seconds). The user showed this route; verified 2026-10-01.
// Nothing may be pressed while it exports - an Escape here cancelled an earlier attempt.
async function downloadScene(page: Page, scene: FlowAsset, targetStem: string): Promise<string[]> {
  const tile = tileOf(page, scene);
  await hoverTile(page, tile);
  const box = await tile.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.click();
  await page.waitForURL(/\/scene\//, { timeout: 30_000 });
  await pause(page, 3000);
  const file = await captureDownload(page, () => page.getByRole("button", { name: "Download scene", exact: true }).click(), 600_000, scene.name);
  const target = `${targetStem}${extensionOf(file)}`;
  renameSync(file, target);
  await page.getByRole("button", { name: "Back button to go to previous page" }).click().catch(() => {});
  await pause(page, 2000);
  await ensureProjectGrid(page).catch(() => {});
  return [target];
}

export interface CharacterParams {
  name: string;
  image?: string;
  describe?: string;
  aspect_ratio?: string;
  personality?: string;
  voice?: string;
}

// Creates a reusable Flow character from an image (local file, or "asset:<title>" already in the project).
// Afterwards it can be attached to any scene as reference "asset:<character name>".
// What each character looks like, so scenes can hold Flow to the same design instead of letting it redraw.
// Kept on disk so a restarted server still knows the cast.
const LOOKS_FILE = join(HOME_DIR, "characters.json");
const loadLooks = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(LOOKS_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
};
export const characterLook = (name: string): string | undefined => loadLooks()[name.toLowerCase()];
export function rememberCharacter(name: string, look: string): void {
  const all = { ...loadLooks(), [name.toLowerCase()]: look.trim() };
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(LOOKS_FILE, JSON.stringify(all, null, 2));
}

export async function createCharacter(c: CharacterParams, job?: Job): Promise<{ name: string; url: string; portrait?: string }> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  // A description generates the portrait first (free image), then the character is built from that picture.
  let portrait: string | undefined;
  if (!c.image) {
    if (!c.describe) throw new Error("Pass either an image or a description for the character.");
    if (job) job.progress = "drawing the character";
    const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
    const drawing = {
      ...(job ?? ({ id: "char", status: "running", files: [], attempts: 1, createdAt: "" } as unknown as Job)),
      files: [],
      params: {
        prompt: c.describe,
        type: "image",
        max_credits: 0,
        aspect_ratio: (c.aspect_ratio as "3:4") ?? "3:4",
        output_dir: dir,
        file_stem: c.name.replace(/[^\w.-]+/g, "_"),
      },
    } as Job;
    portrait = (await runGeneration(drawing))[0];
    // runGeneration keeps a finished image even when its download fails, and says so in a note instead.
    if (!portrait) throw new Error(`Flow drew ${c.name}'s portrait, but it could not be saved, so no character was made: ${drawing.note ?? "no file arrived"}.`);
    c = { ...c, image: portrait };
  }
  const image = c.image!;
  const projectUrl = page.url();
  await dismissOverlays(page);
  await scrollToTop(page);

  await page.getByRole("navigation", { name: "Project navigation" }).getByText("Characters", { exact: true }).click();
  await pause(page, 1500);
  // With no characters yet Flow jumps straight to the creation page.
  const create = page.getByRole("button", { name: "New character" });
  if (await create.isVisible().catch(() => false)) await create.click();
  await page.waitForURL(/\/character$/, { timeout: 15_000 });

  if (image.startsWith(ASSET_PREFIX)) {
    const title = image.slice(ASSET_PREFIX.length).trim();
    await page.getByRole("button", { name: "Add from project", exact: true }).click();
    const list = page.getByRole("listbox", { name: "Asset list" });
    await list.waitFor({ state: "visible", timeout: 10_000 });
    let option = optionByName(list, title);
    if (!(await option.isVisible().catch(() => false))) {
      await page.getByRole("tab", { name: "Uploads" }).click();
      await pause(page, 1000);
      option = optionByName(list, title);
    }
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape");
      throw new Error(`No image titled "${title}" in the Flow project. Use flow_assets to list titles.`);
    }
    await option.click();
    await page.getByRole("button", { name: "Add media", exact: true }).click();
  } else {
    if (!existsSync(image)) throw new Error(`File not found: ${image}`);
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await (await chooser).setFiles(image);
  }
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const url = page.url();

  const name = page.getByRole("textbox", { name: "Character name" });
  await name.waitFor({ state: "visible", timeout: 15_000 });
  await name.fill(c.name);
  await name.press("Enter");
  if (c.personality) await page.getByRole("textbox", { name: "Character personality" }).fill(c.personality);

  if (c.voice) {
    await page.getByRole("button", { name: "Select a voice" }).click();
    const voices = page.getByRole("listbox", { name: "Asset list" });
    await voices.waitFor({ state: "visible", timeout: 10_000 });
    const option = optionByName(voices, c.voice);
    if (!(await option.isVisible().catch(() => false))) {
      const available = (await voices.getByRole("option").allInnerTexts()).map((t) => t.split("\n").filter((l) => l && l !== "voice_selection").join(" - "));
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      throw new Error(`Voice "${c.voice}" not found. Character was created without a voice. Available: ${available.join("; ")}`);
    }
    await option.click();
    // "Customize performance" would turn this into generating a new voice (preview + save); stock voices only.
    await page.getByRole("button", { name: "Add to character", exact: true }).click();
    await pause(page, 1000);
  }

  // Flow labels this "Done editing" or just "Done" depending on the panel state.
  await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click();
  await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 15_000 }).catch(() => page.goto(projectUrl));
  await pause(page, 1000);
  // Flow drops the new character into the composer; leave the composer empty for the next job.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await page.getByRole("navigation", { name: "Project navigation" }).getByText("All media", { exact: true }).click().catch(() => {});
  if (c.describe) rememberCharacter(c.name, c.describe);
  return { name: c.name, url, portrait };
}

const EDIT_TIMEOUT_MS = 10 * 60_000;

// Video-to-video edit in Flow's edit view ("make it sunset", "remove the cup"). Flow shows no quote here, so the
// cost is measured from the balance instead (a 4 s Omni clip cost 20 credits). The result is a new tile.
export async function runEdit(job: Job): Promise<string[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const title = s.edit_asset!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);
  // New tiles always appear at the top, so the "before" snapshot is taken there, ahead of the search: scrolling
  // back to the top after the scan would unmount the tile we are about to click (the grid is virtualised).
  const before = await mediaIds(page);
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(title.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No video whose title starts with "${title}". Use flow_assets to list titles.`);

  const tile = tileOf(page, found);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 20_000 });
  await pause(page, 2500);

  const box = page.locator(".ProseMirror").last();
  await box.click();
  await selectAll(box);
  await page.keyboard.press("Delete");
  const prompt = s.prompt.replace(/\s*\n+\s*/g, " ").trim();
  await page.keyboard.type(prompt, { delay: 8 });
  await pause(page, 600);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow did not accept the edit prompt (Start generation stayed disabled).");
  await start.click();

  // Progress shows as "NN% <prompt>" inside the edit view and disappears when the edit is ready.
  const deadline = Date.now() + EDIT_TIMEOUT_MS;
  let seenProgress = false;
  for (;;) {
    await pause(page, 3000);
    const text = await page.locator("main").first().innerText();
    const pct = text.match(/(\d+)%/)?.[0];
    job.progress = pct;
    if (pct) seenProgress = true;
    else if (seenProgress) break;
    const failure = text.split("\n").find((l) => FAILURE_TEXT.test(l) && !l.includes(prompt));
    if (!pct && failure && Date.now() > deadline - EDIT_TIMEOUT_MS + 15_000) throw new Error(`Flow reported a failed edit: ${failure.slice(0, 300)}`);
    if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to finish the edit.");
  }
  job.progress = undefined;

  // The edit is made and paid for: from here on a problem is a note, never a failure (saveFinished).
  let saved: string[] = [];
  try {
    await page.getByRole("button", { name: "Back button to go to previous page" }).click();
    await pause(page, 2500);
    await ensureProjectGrid(page);
    const fresh = await waitForNewMedia(page, before, 1, 90_000);
    mkdirSync(s.output_dir, { recursive: true });
    saved = await saveFinished(page, job, fresh[0], join(s.output_dir, s.file_stem));
  } catch (err) {
    addNote(job, `the edit was made in Flow and paid for, but its new clip was not found in the grid (${firstLine(err)}). It is titled like "${found.name}": fetch it with flow_download, free; never run the edit again`);
  }
  const after = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  return saved;
}

// The agent session panel hides the composer, so a toggle attempted underneath it does nothing at all. Leaving agent
// mode on then breaks the NEXT job, which expects the plain composer - a free character build failed that way. So this
// confirms the toggle actually landed rather than assuming the click worked.
async function setAgentMode(page: Page, on: boolean): Promise<void> {
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") === on) return;
    await agent.click({ timeout: 8000 }).catch(() => {});
    await pause(page, 1500);
  }
  if (((await agent.getAttribute("aria-pressed").catch(() => null)) === "true") !== on) {
    throw new Error(`Could not switch Agent mode ${on ? "on" : "off"}; the composer may be covered by the agent session panel.`);
  }
}

// "Never" lets the agent generate without asking; it is switched back to "Always" as soon as the batch ends.
async function setAgentSettings(page: Page, confirm: "Always" | "Never", imageAspect?: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
  await page.getByRole("radio", { name: new RegExp(`^${confirm}`) }).click();
  if (imageAspect) {
    await page.getByRole("radio", { name: imageAspect, exact: true }).first().click();
    await page.getByRole("radio", { name: "x1", exact: true }).first().click();
  }
  await pause(page, 300);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await pause(page, 1200);
}

// "Reuse prompt" on an agent-made tile opens the agent's session panel, which hides the normal composer.
async function closeAgentSession(page: Page): Promise<void> {
  const panel = page.getByRole("button", { name: "Start new session" });
  if (await panel.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await pause(page, 1000);
  }
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  else {
    const box = page.locator(".ProseMirror").first();
    await box.click();
    await selectAll(box);
    await page.keyboard.press("Delete");
  }
  await pause(page, 400);
}

const STOP_WORDS = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// Returns, per scene, the indexes of the tiles that belong to it (best match first). A tile counts when at least
// half of the scene's meaningful words appear in the prompt Flow stored for that tile.
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  const sceneWords = scenes.map(words);
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  // First give every scene its single best tile, then hand leftover tiles to their best scene as extra takes.
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      if (score < 0.5 || usedTiles.has(tile) || (firstPass && out[scene].length)) continue;
      out[scene].push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

interface RoundOutcome {
  produced: number;
  timedOut: boolean;
  failedTiles: number;
}

// One pass through Flow's agent for the given scene numbers: ask, wait, match the new tiles back to those scenes
// and download them. Returns how many scenes it actually delivered.
async function agentRound(
  page: Page,
  job: Job,
  scenes: string[],
  indexes: number[],
  retry: boolean,
  files: string[],
  done: Set<number>,
): Promise<RoundOutcome> {
  const s = job.params;
  const aspect = s.aspect_ratio ?? "16:9";
  await ensureProjectGrid(page);
  const seenBefore = await scanGrid(page);
  // Ids are unique per generation; titles are not (the agent reuses wording), so only id-less tiles fall back to a name.
  const before = new Set<string>(seenBefore.map((a) => a.id).filter((v): v is string => Boolean(v)));
  const beforeNames = new Set<string>(seenBefore.filter((a) => !a.id).map((a) => a.name));
  await scrollToTop(page);

  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  const script = indexes.map((i) => `Scene ${i + 1}: ${scenes[i].replace(/\s*\n+\s*/g, " ").trim()}`).join(" ");
  const lead = retry
    ? `${indexes.length} image(s) from the last batch failed to generate. Generate them again now, one image per scene`
    : `Generate exactly ${indexes.length} separate images, one image per scene, in scene order`;
  const ask = `${lead}. Images only, never video. ${aspect} aspect ratio. Do not ask questions, generate them now. ${script}`;
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.insertText(ask);
  await pause(page, 800);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's agent did not accept the script (Start generation stayed disabled).");
  await start.click();

  // The agent shows a Stop button while it works and "NN%" on every tile it is rendering.
  const deadline = Date.now() + (3 * 60_000 + indexes.length * 30_000);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  let idleSince = 0;
  let timedOut = false;
  for (;;) {
    await pause(page, 3000);
    const main = await page.locator("main").first().innerText();
    const pending = main.match(/\d+%/g) ?? [];
    const working = pending.length > 0 || (await stop.isVisible().catch(() => false));
    job.progress = working ? `${pending.length} rendering` : undefined;
    if (working) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > 8000) break;
    if (Date.now() > deadline) {
      // A tile that hangs must not sink the batch: stop the agent and keep whatever finished.
      timedOut = true;
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
      await pause(page, 2000);
      break;
    }
  }

  const failedTiles = await retryNewErrorTiles(page, before, true)
    .then((r) => r.errors)
    .catch(() => 0);
  const fresh = (await scanGrid(page)).filter((t) => t.id && !before.has(t.id) && !beforeNames.has(t.name) && t.kind === "image");

  // Tiles finish in any order and the agent rewords prompts, so each image is matched back to its scene by the
  // prompt Flow stored for it ("Reuse prompt" puts that text in the composer).
  const prompts: string[] = [];
  for (const tile of fresh) {
    await scanGrid(page, (seen) => seen.some((x) => x.id === tile.id));
    const el = mediaTile(page, tile.id!);
    await el.scrollIntoViewIfNeeded();
    await el.hover();
    await el.getByRole("button", { name: "Reuse prompt" }).click();
    await pause(page, 900);
    prompts.push(await page.locator(".ProseMirror").first().innerText());
  }
  await closeAgentSession(page);

  const assigned = matchScenes(
    indexes.map((i) => scenes[i]),
    prompts,
  );
  const drop = Number(process.env.FLOW_MCP_SIMULATE_MISSING ?? 0); // test hook: pretend this scene number failed
  mkdirSync(s.output_dir, { recursive: true });
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  let produced = 0;
  for (const [n, tileIndexes] of assigned.entries()) {
    const sceneIndex = indexes[n];
    if (!tileIndexes.length || sceneIndex + 1 === drop) continue;
    for (const [v, tileIndex] of tileIndexes.entries()) {
      const id = fresh[tileIndex].id!;
      await scanGrid(page, (seen) => seen.some((x) => x.id === id));
      const stem = join(s.output_dir, `scene-${String(base + sceneIndex).padStart(2, "0")}${v ? `-v${v + 1}` : ""}`);
      files.push(...(await downloadTile(page, mediaTile(page, id), stem, s.download_quality ?? "original")));
      await pause(page, 800);
    }
    done.add(sceneIndex);
    produced++;
  }
  return { produced, timedOut, failedTiles };
}

// Hands a whole multi-scene script to Flow's own agent, which generates every image in parallel (seconds instead
// of one paced job per scene). Scenes the agent drops are asked for again, then re-run one by one as a last resort.
// Continues a clip from its own last frame WITH characters still attached - the combination the composer refuses.
// Flow's composer offers Frames OR Ingredients, never both, but agent mode does both, and this is the route the user
// demonstrated: save the clip's last frame, Animate that image (which switches Flow into agent mode by itself), then
// add the avatar or character as a second chip. Verified step by step against the live UI on 2026-09-20.
export async function runContinue(job: Job): Promise<string[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const balance = await readCredits(page).catch(() => undefined);

  await ensureProjectGrid(page);
  const wanted = s.continue_from!.toLowerCase();
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(wanted);
  const source = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!source) throw new Error(`No video whose title starts with "${s.continue_from}". Use flow_assets to list titles.`);

  try {
    // 1. Open the clip and park the playhead on its final frame, then let Flow save that frame as an image.
    job.progress = "saving the last frame";
    const tile = tileOf(page, source);
    await hoverTile(page, tile);
    await tile.click();
    await page.waitForURL(/\/edit\//, { timeout: 30_000 });
    await pause(page, 4000);
    await page.getByRole("button", { name: "Skip to next clip" }).click();
    await pause(page, 2500);
    await page.getByRole("button", { name: "Save frame" }).click();
    await pause(page, 4500);
    await page.getByRole("button", { name: "Back button to go to previous page" }).click();
    await pause(page, 3500);
    await ensureProjectGrid(page);
    await scrollToTop(page);

    // 2. Animate the frame we just saved. Flow names it after the source and puts the newest copy at the top, and
    //    the click also flips Agent on, which is what lets a character ride along.
    job.progress = "loading the frame into the composer";
    const frame = page.locator(`flow-grid-tile-container[aria-label="${`Saved frame from ${source.name}`.replace(/"/g, '\\"')}"]`).first();
    await frame.waitFor({ state: "visible", timeout: 30_000 });
    await hoverTile(page, frame);
    await frame.getByRole("button", { name: "More options" }).click();
    await pause(page, 1500);
    await page.getByRole("menuitem", { name: "Animate", exact: true }).click();
    await pause(page, 3500);
    await setAgentMode(page, true);

    // 3. The second chip: an avatar ("Me") or any character. Only useful in likeness mode - Flow's first-frame tool
    //    (I2V) ignores extra references, and attaching one just makes the agent stop and ask which we meant.
    for (const name of s.continue_mode === "likeness" ? (s.attach ?? []) : []) {
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 1200);
    }

    // 4. Agent mode asks for confirmation unless told not to, which would stall an unattended run.
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");
    // Agent mode treats both chips as ingredients and decides what to do with them. Attaching the saved frame is not
    // enough - without being told, the agent reads it as a style reference and stages a fresh shot. It has to be told
    // in words that the frame IS the opening frame. (Cost 15 credits to learn on 2026-09-20.)
    const cast = (s.attach ?? []).join(" and ");
    const exact = s.continue_mode !== "likeness";
    // Naming the tool settles it in one go. Flow offers first-frame animation (I2V), which continues an image exactly
    // but ignores other references, or reference-to-video (R2V), which honours a character but only approximates the
    // frame. Left unsaid, the agent stops mid-run and asks - which stalls an unattended job.
    await typePrompt(
      page,
      (exact
        ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly ` +
          `on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an ` +
          `unbroken continuation of the shot it came from. Do not use any other reference.`
        : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, ` +
          `so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`) +
        ` ${s.prompt}`,
    );
    const before = await mediaIds(page);
    job.progress = "generating";
    await page.getByRole("button", { name: "Start generation" }).click();

    // The agent sometimes still stops to ask which tool to use. Nobody is watching an unattended run, so answer it.
    for (let i = 0; i < 12; i++) {
      await pause(page, 5000);
      const asking = await page.evaluate(() => /Would you like to|which you prefer|I2V|R2V/i.test(document.body.innerText));
      const working = await page.evaluate(() => /\d{1,3}%/.test(document.body.innerText));
      if (working) break;
      if (!asking) continue;
      job.progress = "answering the agent's question";
      await typePrompt(
        page,
        exact
          ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
          : "Use R2V, reference-to-video, using both attached references so the person stays consistent.",
      );
      await page.keyboard.press("Enter");
      await pause(page, 6000);
      break;
    }

    const fresh = await waitForNewMedia(page, before, 1, VIDEO_TIMEOUT_MS, job);
    job.progress = undefined;
    mkdirSync(s.output_dir, { recursive: true });
    const saved = await saveFinished(page, job, fresh[0], join(s.output_dir, s.file_stem));
    const after = await readCredits(page).catch(() => undefined);
    if (balance !== undefined && after !== undefined) job.credits = balance - after;
    return saved;
  } finally {
    // Leave the composer the way the rest of the driver expects to find it. Order matters: the session panel has to go
    // first and the grid has to be back, otherwise the toggles below are clicking at something that is not there.
    await closeAgentSession(page).catch(() => {});
    await pause(page, 1500);
    await ensureProjectGrid(page).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
    const clear = page.getByRole("button", { name: "Clear prompt" });
    if (await clear.isVisible().catch(() => false)) await clear.click().catch(() => {});
  }
}

export async function runAgentBatch(job: Job): Promise<string[]> {
  const state = await getFlowState(false, true);
  if (!state.signedIn || !state.inProject || !state.onScreen) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const scenes = s.agent_scenes!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);

  const files: string[] = [];
  const done = new Set<number>();
  let agentTimedOut = false;
  let failedTiles = 0;
  let agentRetries = 0;
  try {
    await setAgentMode(page, true);
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");
    for (let round = 0; round < 3; round++) {
      const todo = scenes.map((_, i) => i).filter((i) => !done.has(i));
      if (!todo.length) break;
      if (round) {
        agentRetries += todo.length;
        job.progress = `asking the agent again for ${todo.length} scene(s)`;
      }
      const out = await agentRound(page, job, scenes, todo, round > 0, files, done);
      agentTimedOut ||= out.timedOut;
      failedTiles = out.failedTiles;
      if (!out.produced) break; // the agent delivered nothing this round: stop asking it
    }
  } finally {
    await ensureProjectGrid(page).catch(() => {});
    await closeAgentSession(page).catch(() => {});
    await setAgentMode(page, true).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
  }

  // Anything the agent still has not delivered is generated one by one, which is slower but exact.
  const missing = scenes.map((_, i) => i).filter((i) => !done.has(i));
  const failed: number[] = [];
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  for (const [n, i] of missing.entries()) {
    job.progress = `re-running scene ${i + 1} one by one (${n + 1}/${missing.length})`;
    const single: Job = {
      ...job,
      files: [],
      params: {
        prompt: scenes[i],
        type: "image",
        max_credits: 0,
        aspect_ratio: s.aspect_ratio,
        download_quality: s.download_quality,
        output_dir: s.output_dir,
        file_stem: `scene-${String(base + i).padStart(2, "0")}`,
      },
    };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (attempt || n) await pause(page, 8000);
      try {
        const got = await runGeneration(single);
        files.push(...got);
        ok = got.length > 0; // a finished image whose download failed comes back empty, with a note
      } catch {
        /* one more attempt, then give up on this scene */
      }
    }
    if (!ok) failed.push(i + 1);
  }
  job.progress = undefined;
  files.sort();
  job.note = [
    agentTimedOut ? "the agent stalled and was stopped" : "",
    `${done.size} of ${scenes.length} scenes came from the agent`,
    agentRetries ? `${agentRetries} asked again` : "",
    failedTiles ? `${failedTiles} tile(s) failed in Flow` : "",
    missing.length ? `${missing.length - failed.length} re-run one by one` : "",
    failed.length ? `still failed: scene ${failed.join(", ")} (use Retry)` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!files.length) throw new Error("No image could be generated for any scene. Open the Flow tab to see what Flow reported.");

  const left = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && left !== undefined) job.credits = balance - left;
  return files;
}
