#!/usr/bin/env node
/**
 * Folio Unraid worker — scheduled nhentai API v2 archivist.
 *
 * Same loop as 9-FS/nhentai_archivist:
 *   search tags (or read downloadme.txt)
 *   → skip IDs already on disk / in dontdownloadme.txt
 *   → write missing galleries as CBZ
 *   → delete downloadme.txt so the next cycle re-searches
 *   → sleep SLEEP_INTERVAL seconds
 *   → repeat forever in server mode (NHENTAI_TAGS set)
 */
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  applySafety,
  comicInfo,
  FALLBACK_CDN,
  galleryIsUnsafe,
  idFromFilename,
  libraryDir,
  loadConfigFrom,
  pageFilename,
  parseEnvFileText,
  parseIdList,
  pickTitle,
  sanitizeFilename,
} from "./lib.mjs";

const API = "https://nhentai.net/api/v2";
const DEFAULT_UA =
  "Folio/1.0 (nhentai API v2 archivist; +https://nhentai.net/api/v2/docs)";

const cfg = loadConfig();
const UA = cfg.USER_AGENT || DEFAULT_UA;
const logBuffer = [];
const MAX_LOG = 800;

const status = {
  version: "2.2.0",
  mode: cfg.NHENTAI_TAGS ? "server" : "client",
  state: "starting",
  cycle: 0,
  currentId: null,
  currentTitle: "",
  downloaded: 0,
  skipped: 0,
  failed: 0,
  addedThisCycle: 0,
  skippedThisCycle: 0,
  failedThisCycle: 0,
  libraryCount: 0,
  lastCycleAt: null,
  cycleStartedAt: null,
  sleepUntil: null,
  message: "",
  tags: cfg.NHENTAI_TAGS ? applySafety(cfg.NHENTAI_TAGS.join(" "), cfg.SAFETY_FILTER) : "",
  startedAt: new Date().toISOString(),
  searchPage: 0,
  searchPages: 0,
  searchTotal: 0,
  streak: 0,
  downloadDone: 0,
  downloadTotal: 0,
  recent: [],
  rateLimited: false,
  rateLimitCount: 0,
  rateLimitPath: "",
  rateLimitAt: null,
  rateLimitUntil: null,
  rateLimitGaveUp: false,
  paused: false,
  cycleReason: "",
  tagList: [],
  cycles: [],
};

let shuttingDown = false;
let sleepTimer = null;
let sleepResolve = null;
let lastApiAt = 0;
let apiCooldownUntil = 0;
let rateLimitHits = 0;
let liveTags = cfg.NHENTAI_TAGS ? [...cfg.NHENTAI_TAGS] : [];
let paused = false;
let runNow = false;
let abortCycle = false;
let cycles = [];

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

await mkdir(cfg.LIBRARY_PATH, { recursive: true });
await mkdir(dirname(cfg.DOWNLOADME_FILEPATH), { recursive: true }).catch(() => {});
await mkdir(dirname(cfg.DONTDOWNLOADME_FILEPATH), { recursive: true }).catch(() => {});
await mkdir("/app/log", { recursive: true }).catch(() => {});
loadLive();
loadCycles();
syncTagStatus();

if (cfg.STATUS_PORT) startStatusServer(cfg.STATUS_PORT);

log(
  "info",
  `Folio worker ${status.mode} mode. library=${cfg.LIBRARY_PATH} split=${cfg.LIBRARY_SPLIT} sleep=${cfg.SLEEP_INTERVAL}s delay=${cfg.REQUEST_DELAY_MS}ms tags=${status.tags || "(none)"}`,
);

await main();

async function main() {
  for (;;) {
    if (shuttingDown) break;
    await waitWhilePaused();
    if (shuttingDown) break;
    if (!liveTags.length) {
      const queued = await readIdFile(cfg.DOWNLOADME_FILEPATH);
      if (!queued.length) {
        status.state = "idle";
        status.sleepUntil = null;
        status.message = "No tags set — add chips below, then Run now";
        paused = true;
        status.paused = true;
        await saveLive();
        await persistStatus();
        continue;
      }
    }
    runNow = false;
    abortCycle = false;
    status.cycle += 1;
    status.sleepUntil = null;
    status.addedThisCycle = 0;
    status.skippedThisCycle = 0;
    status.failedThisCycle = 0;
    status.searchPage = 0;
    status.searchPages = 0;
    status.streak = 0;
    status.cycleReason = "";
    status.cycleStartedAt = new Date().toISOString();
    status.state = "searching";
    status.rateLimited = false;
    status.rateLimitGaveUp = false;
    try {
      await runCycle();
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      if (err?.code === "RATE_LIMIT") {
        status.cycleReason = "rate-limit";
        log("warn", "Rate limited — ending this cycle early.");
      } else if (!liveTags.length && !cfg.NHENTAI_TAGS) process.exit(1);
    }
    recordCycle();
    if (cfg.RUN_ONCE || shuttingDown) break;
    if (paused) continue;
    const seconds = cfg.SLEEP_INTERVAL || 3600;
    const until = new Date(Date.now() + seconds * 1000);
    status.state = "sleeping";
    status.sleepUntil = until.toISOString();
    status.currentId = null;
    status.currentTitle = "";
    status.downloadDone = 0;
    status.downloadTotal = 0;
    status.message = `Sleeping until ${until.toISOString()}`;
    pushEvent("cycle", { title: `Cycle ${status.cycle} done` });
    log("info", `Cycle ${status.cycle} done. Sleeping ${seconds}s…`);
    await persistStatus();
    await sleep(seconds * 1000);
    if (paused) continue;
  }
  status.state = "stopped";
  status.message = shuttingDown ? "Stopped" : "Finished";
  await persistStatus();
}

async function runCycle() {
  rateLimitHits = 0;
  const have = await indexLibrary(cfg.LIBRARY_PATH);
  status.libraryCount = have.size;
  const skip = new Set(await readIdFile(cfg.DONTDOWNLOADME_FILEPATH));
  const cdn = await fetchCdn();

  const fromFile = await readIdFile(cfg.DOWNLOADME_FILEPATH);
  if (fromFile.length) {
    log("info", `Loaded ${fromFile.length} IDs from ${cfg.DOWNLOADME_FILEPATH}`);
    await processIds(fromFile, have, skip, cdn);
  } else if (liveTags.length) {
    await searchAndDownload(have, skip, cdn);
  } else {
    log("info", "No NHENTAI_TAGS and no downloadme.txt — nothing to do");
  }

  await removeDownloadme();
  status.lastCycleAt = new Date().toISOString();
  status.currentId = null;
  status.currentTitle = "";
  status.libraryCount = have.size;
  await persistStatus();
}

async function searchAndDownload(have, skip, cdn) {
  if (!liveTags.length) return;
  const query = applySafety(liveTags.join(" "), cfg.SAFETY_FILTER);
  status.state = "searching";
  status.message = `Searching: ${query}`;
  log("info", `Searching “${query}” sort=${cfg.SEARCH_SORT}`);

  let page = 1;
  let pages = 1;
  let streak = 0;
  let added = 0;
  const collected = [];

  while (page <= pages && !shuttingDown) {
    if (paused || abortCycle) {
      status.cycleReason = paused ? "paused" : "aborted";
      log("info", paused ? "Paused — finishing this cycle" : "Cycle aborted");
      await writeDownloadme(collected);
      return;
    }
    if (cfg.MAX_SEARCH_PAGES > 0 && page > cfg.MAX_SEARCH_PAGES) {
      log("info", `MAX_SEARCH_PAGES=${cfg.MAX_SEARCH_PAGES} reached`);
      await writeDownloadme(collected);
      return;
    }
    let data;
    try {
      data = await api(
        `/search?${new URLSearchParams({
          query,
          page: String(page),
          sort: cfg.SEARCH_SORT || "date",
        })}`,
      );
    } catch (err) {
      if (err?.code === "RATE_LIMIT") {
        log("warn", "Search hit rate limit — stopping this cycle.");
        status.state = "rate-limited";
        status.rateLimitGaveUp = true;
        status.message = "Rate limited — will sleep and retry next cycle";
        pushEvent("rate", { title: "Search rate limited" });
        await writeDownloadme(collected);
        return;
      }
      throw err;
    }
    pages = data.num_pages || 1;
    const rows = data.result || data.galleries || data.items || [];
    status.searchPage = page;
    status.searchPages = pages;
    status.searchTotal = Number(data.total) || status.searchTotal;
    status.state = "searching";
    status.message = `Search page ${page}/${pages}`;
    if (page === 1) {
      log("info", `Search: ${data.total ?? rows.length} galleries across ${pages} pages`);
    }

    let pageHave = 0;
    let pageSkip = 0;
    let pageNew = 0;
    for (const item of rows) {
      const id = Number(item?.id ?? item?.gallery_id ?? item?.galleryId);
      if (!id) continue;
      collected.push(id);
      if (skip.has(id) || have.has(id)) {
        if (skip.has(id)) pageSkip += 1;
        else pageHave += 1;
        status.skipped += 1;
        status.skippedThisCycle += 1;
        streak += 1;
        status.streak = streak;
        if (cfg.CATCH_UP_STREAK > 0 && streak >= cfg.CATCH_UP_STREAK) {
          log(
            "info",
            `Search page ${page}/${pages} — ${pageHave} in library, ${pageSkip} blacklisted, ${pageNew} new (streak ${streak})`,
          );
          log("info", `Caught up after ${streak} already-handled galleries. Stopping this cycle.`);
          status.cycleReason = "caught-up";
          pushEvent("caught-up", { title: `Caught up after ${streak} already in library` });
          await writeDownloadme(collected);
          return;
        }
        continue;
      }
      streak = 0;
      status.streak = 0;
      if (cfg.MAX_PER_CYCLE > 0 && added >= cfg.MAX_PER_CYCLE) {
        log("info", `MAX_PER_CYCLE=${cfg.MAX_PER_CYCLE} reached`);
        status.cycleReason = "max";
        await writeDownloadme(collected);
        return;
      }
      pageNew += 1;
      try {
        const ok = await downloadGallery(id, cdn, have);
        if (ok) added += 1;
        status.state = "searching";
        status.message = `Search page ${page}/${pages}`;
      } catch (err) {
        if (err?.code === "RATE_LIMIT") {
          log("warn", "Rate limited while downloading — stopping this cycle.");
          await writeDownloadme(collected);
          return;
        }
        throw err;
      }
    }
    log(
      "info",
      `Search page ${page}/${pages} — ${pageHave} in library, ${pageSkip} blacklisted, ${pageNew} new (streak ${streak})`,
    );
    page += 1;
  }
  await writeDownloadme(collected);
  if (!status.cycleReason) status.cycleReason = "complete";
}

async function processIds(ids, have, skip, cdn) {
  let added = 0;
  for (const [i, id] of ids.entries()) {
    if (shuttingDown) break;
    log("info", `${i + 1}/${ids.length} | gallery ${id}`);
    if (skip.has(id)) {
      log("info", `#${id} blacklisted`);
      status.skipped += 1;
      status.skippedThisCycle += 1;
      continue;
    }
    if (have.has(id)) {
      log("info", `#${id} already in library. Skipped.`);
      status.skipped += 1;
      status.skippedThisCycle += 1;
      continue;
    }
    if (cfg.MAX_PER_CYCLE > 0 && added >= cfg.MAX_PER_CYCLE) {
      log("info", `MAX_PER_CYCLE=${cfg.MAX_PER_CYCLE} reached`);
      break;
    }
    const ok = await downloadGallery(id, cdn, have);
    if (ok) added += 1;
  }
}

async function downloadGallery(id, cdn, have) {
  status.state = cfg.DRY_RUN ? "dry-run" : "downloading";
  status.currentId = id;
  status.message = `Gallery ${id}`;
  try {
    const gallery = await api(`/galleries/${id}`);
    if (cfg.SAFETY_FILTER && galleryIsUnsafe(gallery)) {
      log("warn", `#${id} skipped by safety filter`);
      await appendBlacklist(id);
      status.skipped += 1;
      status.skippedThisCycle += 1;
      return false;
    }
    const filename = sanitizeFilename(id, pickTitle(gallery, cfg.FILENAME_TITLE_TYPE));
    status.currentTitle = filename;
    const destDir = libraryDir(cfg.LIBRARY_PATH, cfg.LIBRARY_SPLIT, id);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, filename);
    if ((await exists(dest)) || have.has(id)) {
      log("info", `Already have ${filename}`);
      have.add(id);
      status.skipped += 1;
      status.skippedThisCycle += 1;
      return false;
    }
    if (cfg.DRY_RUN) {
      log("info", `DRY_RUN would write ${dest}`);
      status.downloaded += 1;
      status.addedThisCycle += 1;
      pushEvent("wrote", { id, title: filename, pages: gallery.num_pages || 0 });
      return true;
    }

    const pages = gallery.pages || [];
    if (!pages.length) throw new Error("Gallery has no pages");
    const tmpDir = join(cfg.LIBRARY_PATH, String(id));
    await mkdir(tmpDir, { recursive: true });
    status.downloadDone = 0;
    status.downloadTotal = pages.length;

    await mapPool(pages, cfg.DOWNLOAD_WORKERS, async (page) => {
      const bytes = await fetchImage(page.path, cdn.image_servers);
      await writeFile(join(tmpDir, pageFilename(id, page.number, page.path)), bytes);
      status.downloadDone += 1;
    });

    const zip = new JSZip();
    zip.file("ComicInfo.xml", comicInfo(gallery));
    for (const page of pages) {
      const name = pageFilename(id, page.number, page.path);
      zip.file(name, await readFile(join(tmpDir, name)));
    }
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const tmp = join(tmpDir, `${id}.temp`);
    await writeFile(tmp, buf);
    await rename(tmp, dest);
    have.add(id);
    status.downloaded += 1;
    status.addedThisCycle += 1;
    status.libraryCount = have.size;
    log("info", `Wrote ${dest} (${pages.length} pages)`);
    pushEvent("wrote", { id, title: filename, pages: pages.length });
    if (cfg.CLEANUP_TEMPORARY_FILES) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    return true;
  } catch (err) {
    if (err?.code === "RATE_LIMIT") throw err;
    status.failed += 1;
    status.failedThisCycle += 1;
    log("error", `#${id} ${err instanceof Error ? err.message : err}`);
    pushEvent("error", { id, title: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function fetchImage(path, servers) {
  const shuffled = [...servers].sort(() => Math.random() - 0.5);
  if (!cfg.CIRCUMVENT_LOAD_BALANCER) shuffled.unshift("https://i.nhentai.net");
  let last = "no servers";
  for (const server of shuffled) {
    const url = `${server.replace(/\/$/, "")}/${path}`;
    try {
      const res = await fetch(url, { headers: imageHeaders() });
      if (!res.ok) {
        last = `${res.status} ${url}`;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        last = `empty ${url}`;
        continue;
      }
      return buf;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`Image failed (${path}): ${last}`);
}

async function fetchCdn() {
  try {
    const data = await api("/cdn");
    if (data.image_servers?.length) return data;
  } catch (err) {
    log("warn", `CDN config failed, using fallback: ${err instanceof Error ? err.message : err}`);
  }
  return FALLBACK_CDN;
}

async function throttleApi() {
  const now = Date.now();
  const waitUntil = Math.max(apiCooldownUntil, lastApiAt + (cfg.REQUEST_DELAY_MS || 0));
  const wait = waitUntil - now;
  if (wait > 0) await sleep(wait);
  lastApiAt = Date.now();
}

async function api(path) {
  const headers = {
    "User-Agent": UA,
    Accept: "application/json",
  };
  if (cfg.API_KEY) headers.Authorization = `Key ${cfg.API_KEY}`;
  if (cfg.COOKIE) headers.Cookie = cfg.COOKIE;
  for (let i = 0; i < 8; i++) {
    await throttleApi();
    const res = await fetch(`${API}${path}`, { headers });
    if (res.status === 429) {
      rateLimitHits += 1;
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(300_000, 15_000 * 2 ** i);
      apiCooldownUntil = Date.now() + wait;
      status.rateLimited = true;
      status.rateLimitCount += 1;
      status.rateLimitPath = String(path).split("?")[0] || path;
      status.rateLimitAt = new Date().toISOString();
      status.rateLimitUntil = new Date(apiCooldownUntil).toISOString();
      log("warn", `429 on ${path}, waiting ${Math.round(wait / 1000)}s (hit ${rateLimitHits})`);
      pushEvent("rate", { title: `429 ${status.rateLimitPath}`, path: status.rateLimitPath });
      if (rateLimitHits >= 6) {
        status.rateLimitGaveUp = true;
        status.state = "rate-limited";
        status.message = `Giving up this cycle after ${rateLimitHits} rate limits`;
        const err = new Error(`Giving up this cycle after ${rateLimitHits} rate limits`);
        err.code = "RATE_LIMIT";
        throw err;
      }
      await sleep(wait);
      continue;
    }
    if (res.status === 503 || res.status === 502) {
      const wait = Math.min(120_000, 5000 * 2 ** i);
      log("warn", `${res.status} on ${path}, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status} ${path} ${body.slice(0, 180)}`);
    }
    if (rateLimitHits > 0) rateLimitHits = Math.max(0, rateLimitHits - 1);
    if (Date.now() >= apiCooldownUntil) status.rateLimited = false;
    return res.json();
  }
  const err = new Error(`API failed ${path}`);
  err.code = "RATE_LIMIT";
  throw err;
}

function imageHeaders() {
  const headers = {
    "User-Agent": UA,
    Referer: "https://nhentai.net/",
    Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
  };
  if (cfg.COOKIE) headers.Cookie = cfg.COOKIE;
  return headers;
}

async function indexLibrary(root) {
  const ids = new Set();
  async function scan(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) await scan(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cbz")) {
        const id = idFromFilename(entry.name);
        if (id) ids.add(id);
      }
    }
  }
  await scan(root, 0);
  log("info", `Library index: ${ids.size} existing CBZ`);
  return ids;
}

async function readIdFile(path) {
  try {
    return parseIdList(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

async function writeDownloadme(ids) {
  if (!cfg.DOWNLOADME_FILEPATH || !ids.length) return;
  try {
    await mkdir(dirname(cfg.DOWNLOADME_FILEPATH), { recursive: true });
    await writeFile(cfg.DOWNLOADME_FILEPATH, [...new Set(ids)].join("\n") + "\n");
  } catch (err) {
    log("warn", `Could not write downloadme: ${err instanceof Error ? err.message : err}`);
  }
}

async function removeDownloadme() {
  if (!cfg.DOWNLOADME_FILEPATH) return;
  try {
    await unlink(cfg.DOWNLOADME_FILEPATH);
    log("info", `Removed ${cfg.DOWNLOADME_FILEPATH} so the next cycle re-searches`);
  } catch {
    // missing is fine
  }
}

async function appendBlacklist(id) {
  if (!cfg.DONTDOWNLOADME_FILEPATH) return;
  try {
    await mkdir(dirname(cfg.DONTDOWNLOADME_FILEPATH), { recursive: true });
    const existing = await readIdFile(cfg.DONTDOWNLOADME_FILEPATH);
    if (existing.includes(id)) return;
    await writeFile(cfg.DONTDOWNLOADME_FILEPATH, `${existing.concat(id).join("\n")}\n`);
  } catch (err) {
    log("warn", `Could not update blacklist: ${err instanceof Error ? err.message : err}`);
  }
}

function loadConfig() {
  const envFile = process.env.ENV_FILE || "./config/.env";
  let file = {};
  try {
    file = parseEnvFileText(readFileSync(envFile, "utf8"));
  } catch {
    file = {};
  }
  return loadConfigFrom({ ...file, ...process.env });
}

function liveConfigPath() {
  return (
    process.env.FOLIO_CONFIG ||
    join(dirname(cfg.DOWNLOADME_FILEPATH || "./config/downloadme.txt"), "folio.json")
  );
}

function cyclesPath() {
  return "/app/log/cycles.json";
}

function syncTagStatus() {
  status.tagList = [...liveTags];
  status.tags = liveTags.length ? applySafety(liveTags.join(" "), cfg.SAFETY_FILTER) : "";
  status.mode = liveTags.length ? "server" : "client";
  status.paused = paused;
}

function loadLive() {
  try {
    const j = JSON.parse(readFileSync(liveConfigPath(), "utf8"));
    if (Array.isArray(j.tags)) {
      liveTags = j.tags.map((s) => String(s).trim()).filter(Boolean);
    }
    if (typeof j.paused === "boolean") paused = j.paused;
  } catch {
    // first run: seed from Unraid env
  }
  syncTagStatus();
}

async function saveLive() {
  try {
    const path = liveConfigPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ tags: liveTags, paused }, null, 2) + "\n");
  } catch (err) {
    log("warn", `Could not save folio.json: ${err instanceof Error ? err.message : err}`);
  }
  syncTagStatus();
}

function loadCycles() {
  try {
    const rows = JSON.parse(readFileSync(cyclesPath(), "utf8"));
    if (Array.isArray(rows)) cycles = rows.slice(0, 12);
  } catch {
    cycles = [];
  }
  status.cycles = cycles;
}

function recordCycle() {
  const rec = {
    n: status.cycle,
    at: status.cycleStartedAt,
    ended: new Date().toISOString(),
    added: status.addedThisCycle,
    skipped: status.skippedThisCycle,
    failed: status.failedThisCycle,
    page: status.searchPage,
    pages: status.searchPages,
    rateLimited: Boolean(status.rateLimitGaveUp || status.cycleReason === "rate-limit"),
    reason: status.cycleReason || "done",
  };
  cycles.unshift(rec);
  if (cycles.length > 12) cycles.length = 12;
  status.cycles = cycles;
  writeFile(cyclesPath(), JSON.stringify(cycles, null, 2)).catch(() => {});
}

async function waitWhilePaused() {
  while (paused && !runNow && !shuttingDown) {
    status.state = "paused";
    status.paused = true;
    status.sleepUntil = null;
    status.message = "Paused — click Run now to start a cycle";
    await persistStatus();
    await sleep(400);
  }
}

function wake() {
  if (sleepResolve) {
    clearTimeout(sleepTimer);
    const r = sleepResolve;
    sleepTimer = null;
    sleepResolve = null;
    r();
  }
}

async function setPaused(value) {
  paused = Boolean(value);
  status.paused = paused;
  if (paused) {
    abortCycle = true;
    runNow = false;
    log("info", "Pause requested — finishing the current gallery");
  }
  await saveLive();
  wake();
}

async function requestRun() {
  paused = false;
  status.paused = false;
  runNow = true;
  abortCycle = false;
  log("info", "Run now — starting a cycle");
  await saveLive();
  wake();
}

function sanitizeTerms(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    const t = String(raw || "").trim();
    if (!t || t.length > 80) continue;
    if (/[\n\r]/.test(t)) continue;
    out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}

async function nhTagSearch(query, type) {
  const q = String(query || "").trim().slice(0, 80);
  if (q.length < 1) return [];
  const body = { query: q, limit: 15 };
  if (type && type !== "all") body.type = type;
  const res = await fetch(`${API}/tags/search`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const err = new Error("Tag search rate limited");
    err.code = "RATE_LIMIT";
    throw err;
  }
  if (!res.ok) throw new Error(`Tag search ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).map((t) => ({
    id: t.id,
    type: t.type,
    name: t.name,
    count: t.count,
    slug: t.slug,
  }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 20_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function pushEvent(type, data) {
  status.recent.unshift({ type, at: new Date().toISOString(), ...data });
  if (status.recent.length > 40) status.recent.length = 40;
}

function snapshot() {
  return {
    ...status,
    paused,
    tagList: [...liveTags],
    cycles,
    log: logBuffer.slice(-200),
    now: new Date().toISOString(),
    rateLimitHits,
    catchUpStreak: cfg.CATCH_UP_STREAK,
    maxPerCycle: cfg.MAX_PER_CYCLE,
    sleepSeconds: cfg.SLEEP_INTERVAL,
    delayMs: cfg.REQUEST_DELAY_MS,
  };
}

function dashboardPage() {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "dashboard.html"),
    "/app/dashboard.html",
    "./dashboard.html",
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  return "<!doctype html><title>Folio</title><p>dashboard.html missing. Try /api/status</p>";
}

function startStatusServer(port) {
  const page = dashboardPage();
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/health") {
      json(res, 200, { ok: true, state: status.state, paused });
      return;
    }
    if (path === "/api/status" || path === "/status.json") {
      json(res, 200, snapshot());
      return;
    }
    if (path === "/api/tags" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const type = url.searchParams.get("type") || "all";
      nhTagSearch(q, type)
        .then((result) => json(res, 200, { result }))
        .catch((err) =>
          json(res, err?.code === "RATE_LIMIT" ? 429 : 502, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return;
    }
    if (path === "/api/control" && req.method === "POST") {
      readJsonBody(req)
        .then(async (body) => {
          const action = String(body.action || "").toLowerCase();
          if (action === "pause") await setPaused(true);
          else if (action === "resume" || action === "run") await requestRun();
          else {
            json(res, 400, { error: "action must be pause or run" });
            return;
          }
          json(res, 200, snapshot());
        })
        .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (path === "/api/config" && req.method === "POST") {
      readJsonBody(req)
        .then(async (body) => {
          const next = sanitizeTerms(body.tags);
          if (!next) {
            json(res, 400, { error: "tags must be an array of strings" });
            return;
          }
          liveTags = next;
          syncTagStatus();
          await saveLive();
          log("info", `Tags updated (${liveTags.length}): ${status.tags || "(none)"}`);
          json(res, 200, snapshot());
        })
        .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    html(res, 200, page);
  });
  server.listen(port, "0.0.0.0", () => {
    log("info", `Status page on port ${port}`);
  });
}

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function html(res, code, body) {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function persistStatus() {
  try {
    await mkdir("/app/log", { recursive: true });
    await writeFile("/app/log/status.json", JSON.stringify(snapshot(), null, 2));
  } catch {
    // running outside docker
  }
}

function onSignal() {
  shuttingDown = true;
  log("info", "Shutdown requested — finishing current gallery");
  if (sleepResolve) {
    clearTimeout(sleepTimer);
    sleepResolve();
  }
}

function mapPool(items, limit, fn) {
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  return Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG) logBuffer.splice(0, logBuffer.length - MAX_LOG);
  appendFile("/app/log/archivist.log", line + "\n").catch(() => {});
}
