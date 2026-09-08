#!/usr/bin/env node
/**
 * Folio Unraid worker — scheduled nhentai API v2 archivist.
 *
 * Same loop as 9-FS/nhentai_archivist:
 *   search tags (or read downloadme.txt)
 *   skip IDs already on disk / in dontdownloadme.txt
 *   write missing galleries as CBZ
 *   delete downloadme.txt so the next cycle re-searches
 *   sleep SLEEP_INTERVAL seconds
 *   repeat forever in server mode (NHENTAI_TAGS set)
 */
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
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
const MAX_LOG = 400;

const status = {
  version: "2.0.0",
  mode: cfg.NHENTAI_TAGS ? "server" : "client",
  state: "starting",
  cycle: 0,
  currentId: null,
  currentTitle: "",
  downloaded: 0,
  skipped: 0,
  failed: 0,
  libraryCount: 0,
  lastCycleAt: null,
  sleepUntil: null,
  message: "",
  tags: cfg.NHENTAI_TAGS ? applySafety(cfg.NHENTAI_TAGS.join(" "), cfg.SAFETY_FILTER) : "",
  startedAt: new Date().toISOString(),
};

let shuttingDown = false;
let sleepTimer = null;
let sleepResolve = null;

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

if (cfg.STATUS_PORT) startStatusServer(cfg.STATUS_PORT);

log(
  "info",
  `Folio worker ${status.mode} mode. library=${cfg.LIBRARY_PATH} split=${cfg.LIBRARY_SPLIT} sleep=${cfg.SLEEP_INTERVAL}s tags=${status.tags || "(none)"}`,
);

await mkdir(cfg.LIBRARY_PATH, { recursive: true });
await mkdir(dirname(cfg.DOWNLOADME_FILEPATH), { recursive: true }).catch(() => {});
await mkdir(dirname(cfg.DONTDOWNLOADME_FILEPATH), { recursive: true }).catch(() => {});
await mkdir("/app/log", { recursive: true }).catch(() => {});

await main();

async function main() {
  for (;;) {
    if (shuttingDown) break;
    status.cycle += 1;
    status.sleepUntil = null;
    try {
      await runCycle();
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      if (!cfg.NHENTAI_TAGS) process.exit(1);
    }
    if (!cfg.NHENTAI_TAGS || shuttingDown || cfg.RUN_ONCE) break;
    const seconds = cfg.SLEEP_INTERVAL || 3600;
    const until = new Date(Date.now() + seconds * 1000);
    status.state = "sleeping";
    status.sleepUntil = until.toISOString();
    status.message = `Sleeping until ${until.toISOString()}`;
    log("info", `Cycle ${status.cycle} done. Sleeping ${seconds}s`);
    await persistStatus();
    await sleep(seconds * 1000);
  }
  status.state = "stopped";
  status.message = shuttingDown ? "Stopped" : "Client mode finished";
  await persistStatus();
}

async function runCycle() {
  const have = await indexLibrary(cfg.LIBRARY_PATH);
  status.libraryCount = have.size;
  const skip = new Set(await readIdFile(cfg.DONTDOWNLOADME_FILEPATH));
  const cdn = await fetchCdn();

  const fromFile = await readIdFile(cfg.DOWNLOADME_FILEPATH);
  if (fromFile.length) {
    log("info", `Loaded ${fromFile.length} IDs from ${cfg.DOWNLOADME_FILEPATH}`);
    await processIds(fromFile, have, skip, cdn);
  } else if (cfg.NHENTAI_TAGS?.length) {
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
  const query = applySafety(cfg.NHENTAI_TAGS.join(" "), cfg.SAFETY_FILTER);
  status.state = "searching";
  status.message = `Searching: ${query}`;
  log("info", `Searching ${query} sort=${cfg.SEARCH_SORT}`);

  let page = 1;
  let pages = 1;
  let streak = 0;
  let added = 0;
  const collected = [];

  while (page <= pages && !shuttingDown) {
    const data = await api(
      `/search?${new URLSearchParams({
        query,
        page: String(page),
        sort: cfg.SEARCH_SORT || "date",
      })}`,
    );
    pages = data.num_pages || 1;
    const rows = data.result || [];
    if (page === 1) {
      log("info", `Search: ${data.total ?? rows.length} galleries across ${pages} pages`);
    }
    log("info", `Search page ${page}/${pages}`);

    for (const item of rows) {
      const id = Number(item.id);
      if (!id) continue;
      collected.push(id);
      if (skip.has(id)) {
        status.skipped += 1;
        continue;
      }
      if (have.has(id)) {
        status.skipped += 1;
        streak += 1;
        if (cfg.CATCH_UP_STREAK > 0 && streak >= cfg.CATCH_UP_STREAK) {
          log("info", `Caught up after ${streak} already-archived galleries. Stopping this cycle.`);
          await writeDownloadme(collected);
          return;
        }
        continue;
      }
      streak = 0;
      if (cfg.MAX_PER_CYCLE > 0 && added >= cfg.MAX_PER_CYCLE) {
        log("info", `MAX_PER_CYCLE=${cfg.MAX_PER_CYCLE} reached`);
        await writeDownloadme(collected);
        return;
      }
      const ok = await downloadGallery(id, cdn, have);
      if (ok) added += 1;
    }
    page += 1;
  }
  await writeDownloadme(collected);
}

async function processIds(ids, have, skip, cdn) {
  let added = 0;
  for (const [i, id] of ids.entries()) {
    if (shuttingDown) break;
    log("info", `${i + 1}/${ids.length} | gallery ${id}`);
    if (skip.has(id)) {
      log("info", `#${id} blacklisted`);
      status.skipped += 1;
      continue;
    }
    if (have.has(id)) {
      log("info", `#${id} already in library. Skipped.`);
      status.skipped += 1;
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
      return false;
    }
    if (cfg.DRY_RUN) {
      log("info", `DRY_RUN would write ${dest}`);
      status.downloaded += 1;
      return true;
    }

    const pages = gallery.pages || [];
    if (!pages.length) throw new Error("Gallery has no pages");
    const tmpDir = join(cfg.LIBRARY_PATH, String(id));
    await mkdir(tmpDir, { recursive: true });

    await mapPool(pages, cfg.DOWNLOAD_WORKERS, async (page) => {
      const bytes = await fetchImage(page.path, cdn.image_servers);
      await writeFile(join(tmpDir, pageFilename(id, page.number, page.path)), bytes);
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
    status.libraryCount = have.size;
    log("info", `Wrote ${dest} (${pages.length} pages)`);
    if (cfg.CLEANUP_TEMPORARY_FILES) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    return true;
  } catch (err) {
    status.failed += 1;
    log("error", `#${id} ${err instanceof Error ? err.message : err}`);
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

async function api(path) {
  const headers = {
    "User-Agent": UA,
    Accept: "application/json",
  };
  if (cfg.API_KEY) headers.Authorization = `Key ${cfg.API_KEY}`;
  if (cfg.COOKIE) headers.Cookie = cfg.COOKIE;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}${path}`, { headers });
    if (res.status === 429) {
      const wait = 2000 * (i + 1);
      log("warn", `429 on ${path}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status} ${path} ${body.slice(0, 180)}`);
    }
    return res.json();
  }
  throw new Error(`API failed ${path}`);
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

function startStatusServer(port) {
  const server = createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/health")) {
      json(res, 200, { ok: true, state: status.state });
      return;
    }
    if (url.startsWith("/api/status") || url.startsWith("/status.json")) {
      json(res, 200, { ...status, log: logBuffer.slice(-80) });
      return;
    }
    html(res, 200, renderDashboard());
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

function renderDashboard() {
  const sleep = status.sleepUntil
    ? `until ${escapeHtml(status.sleepUntil.replace("T", " ").slice(0, 19))} UTC`
    : "-";
  const rows = [
    ["Mode", status.mode],
    ["State", status.state],
    ["Cycle", String(status.cycle)],
    ["Library", `${status.libraryCount} CBZ`],
    ["This run", `${status.downloaded} added / ${status.skipped} skipped / ${status.failed} failed`],
    ["Current", status.currentId ? `#${status.currentId} ${status.currentTitle}` : "-"],
    ["Tags", status.tags || "(client mode)"],
    ["Sleep", sleep],
    ["Started", status.startedAt.replace("T", " ").slice(0, 19) + " UTC"],
  ];
  const logLines = logBuffer
    .slice(-80)
    .map((line) => escapeHtml(line))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="8"/>
  <title>Folio Archivist</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0c0e; color: #ece8e1; line-height: 1.5; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
    .kicker { letter-spacing: .22em; text-transform: uppercase; color: #8a8680; font-size: 12px; }
    h1 { font-weight: 500; font-size: 40px; margin: 4px 0 8px; letter-spacing: -0.02em; }
    .lead { color: #8a8680; max-width: 40em; margin-bottom: 28px; }
    .badge { display: inline-block; border: 1px solid rgba(236,232,225,.16); padding: 4px 10px; border-radius: 999px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #7f9a8f; }
    dl { display: grid; grid-template-columns: 140px 1fr; gap: 10px 16px; margin: 0; padding: 20px; border: 1px solid rgba(236,232,225,.12); border-radius: 16px; background: #14161a; }
    dt { color: #8a8680; font-size: 13px; }
    dd { margin: 0; font-variant-numeric: tabular-nums; word-break: break-word; }
    pre { margin-top: 24px; padding: 16px; border-radius: 16px; background: #14161a; border: 1px solid rgba(236,232,225,.12); overflow: auto; font-family: ui-monospace, monospace; font-size: 12px; color: #cfc8be; min-height: 200px; }
  </style>
</head>
<body>
  <main>
    <p class="kicker">Unraid worker</p>
    <h1>Folio</h1>
    <p class="lead">Searches nhentai API v2, writes missing CBZ files, skips what is already in the library, then sleeps and checks again.</p>
    <p><span class="badge">${escapeHtml(status.state)}</span></p>
    <dl>
      ${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join("")}
    </dl>
    <pre>${logLines || "Waiting for the first cycle"}</pre>
  </main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&" + "amp;")
    .replaceAll("<", "&" + "lt;")
    .replaceAll(">", "&" + "gt;")
    .replaceAll('"', "&" + "quot;");
}

async function persistStatus() {
  try {
    await mkdir("/app/log", { recursive: true });
    await writeFile(
      "/app/log/status.json",
      JSON.stringify({ ...status, log: logBuffer.slice(-80) }, null, 2),
    );
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
