/**
 * Pure helpers for the Folio Unraid worker.
 * Drop-in behavior for 9-FS/nhentai_archivist, talking to nhentai API v2.
 */

export const SAFETY_EXCLUDE = ["lolicon", "shotacon", "loli", "shota", "toddlercon"];

export const FALLBACK_CDN = {
  image_servers: [
    "https://i1.nhentai.net",
    "https://i2.nhentai.net",
    "https://i3.nhentai.net",
    "https://i4.nhentai.net",
  ],
};

export function parseTags(raw) {
  if (raw == null) return [];
  let s = String(raw).trim();
  if (!s) return [];
  if (
    (s.startsWith("[") && s.endsWith("]")) ||
    (s.startsWith("(") && s.endsWith(")"))
  ) {
    s = s.slice(1, -1).trim();
  }
  const parts = splitCommaOutsideQuotes(s);
  return parts.map(unwrapQuotes).filter(Boolean);
}

function unwrapQuotes(p) {
  const s = p.trim();
  if (
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2) ||
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function splitCommaOutsideQuotes(s) {
  const parts = [];
  let buf = "";
  let quote = null;
  for (const ch of s) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      if (buf.trim()) parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.length ? parts : s ? [s] : [];
}

export function applySafety(query, enabled) {
  const q = String(query || "").trim();
  if (!enabled) return q;
  const have = q.toLowerCase();
  const extras = SAFETY_EXCLUDE.filter((t) => !have.includes(`-${t}`)).map((t) => `-${t}`);
  return [q, ...extras].filter(Boolean).join(" ").trim();
}

export function parseIdList(text) {
  if (!text) return [];
  return String(text)
    .split(/[\s,;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function idFromFilename(name) {
  const m = String(name).match(/^(\d+)\b/);
  return m ? Number(m[1]) : null;
}

export function libraryDir(libraryPath, librarySplit, id) {
  const split = Number(librarySplit) || 0;
  if (!split) return libraryPath;
  if (split === 1) return joinPosix(libraryPath, String(id));
  const start = Math.floor(id / split) * split;
  const end = start + split - 1;
  return joinPosix(libraryPath, `${start}~${end}`);
}

function joinPosix(a, b) {
  if (!a) return b;
  return `${String(a).replace(/\/+$/, "")}/${b}`;
}

export function pickTitle(gallery, titleType) {
  const type = String(titleType || "english").toLowerCase();
  if (type === "japanese" && gallery.title?.japanese) return gallery.title.japanese;
  if (type === "pretty" && gallery.title?.pretty) return gallery.title.pretty;
  return gallery.title?.english || gallery.title?.pretty || String(gallery.id);
}

export function sanitizeFilename(id, title) {
  const cleaned = String(title)
    .replace(/[\\/:*?"<>|\t\n]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const overhead = `${id} .cbz`.length;
  let out = "";
  let bytes = 0;
  for (const ch of cleaned) {
    const size = Buffer.byteLength(ch);
    if (overhead + bytes + size > 255) break;
    out += ch;
    bytes += size;
  }
  return `${id}${out ? ` ${out}` : ""}.cbz`;
}

export function pageFilename(id, number, path) {
  const ext = (String(path).split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const safe = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext) ? ext : "jpg";
  return `${id}-${String(number).padStart(5, "0")}.${safe}`;
}

export function galleryIsUnsafe(gallery) {
  const tags = Array.isArray(gallery.tags) ? gallery.tags : [];
  const names = new Set(tags.map((t) => String(t.name || t.slug || "").toLowerCase()));
  return SAFETY_EXCLUDE.some((t) => names.has(t));
}

export function comicInfo(g) {
  const uploaded = new Date((g.upload_date || 0) * 1000);
  const tags = Array.isArray(g.tags) ? g.tags : [];
  const of = (types, withType) =>
    tags
      .filter((t) => types.includes(t.type))
      .map((t) => (withType ? `${t.type}: ${t.name}` : t.name))
      .sort()
      .join(",") || undefined;
  const esc = (s) =>
    String(s)
      .replaceAll("&", "&" + "amp;")
      .replaceAll("<", "&" + "lt;")
      .replaceAll(">", "&" + "gt;")
      .replaceAll('"', "&" + "quot;");
  const maybe = (tag, val) => (val ? `  <${tag}>${esc(val)}</${tag}>\n` : "");
  const title = `${g.id} ${g.title?.pretty || g.title?.english || ""}`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n` +
    `  <Title>${esc(title)}</Title>\n` +
    `  <Year>${uploaded.getUTCFullYear()}</Year>\n` +
    `  <Month>${uploaded.getUTCMonth() + 1}</Month>\n` +
    `  <Day>${uploaded.getUTCDate()}</Day>\n` +
    maybe("Writer", of(["artist"], false)) +
    maybe("Translator", g.scanlator) +
    maybe("Publisher", of(["group"], false)) +
    maybe("Genre", of(["category"], false)) +
    maybe("Tags", of(["character", "language", "parody", "tag"], true)) +
    `  <Web>https://nhentai.net/g/${g.id}/</Web>\n` +
    `  <PageCount>${g.num_pages || 0}</PageCount>\n` +
    `  <Manga>YesAndRightToLeft</Manga>\n</ComicInfo>\n`
  );
}

export function loadConfigFrom(env) {
  const tags = parseTags(env.NHENTAI_TAGS);
  const bool = (v, fallback) => {
    if (v == null || v === "") return fallback;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return fallback;
  };
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    API_KEY: env.API_KEY || env.NHENTAI_API_KEY || "",
    COOKIE: env.COOKIE || "",
    USER_AGENT: env.USER_AGENT || "",
    LIBRARY_PATH: env.LIBRARY_PATH || "./hentai/",
    LIBRARY_SPLIT: Math.max(0, num(env.LIBRARY_SPLIT, 0)),
    DOWNLOAD_WORKERS: Math.max(1, num(env.DOWNLOAD_WORKERS, 5)),
    DOWNLOADME_FILEPATH: env.DOWNLOADME_FILEPATH || "./config/downloadme.txt",
    DONTDOWNLOADME_FILEPATH: env.DONTDOWNLOADME_FILEPATH || "./config/dontdownloadme.txt",
    FILENAME_TITLE_TYPE: (env.FILENAME_TITLE_TYPE || "English").toLowerCase(),
    NHENTAI_TAGS: tags.length ? tags : null,
    SLEEP_INTERVAL: Math.max(0, num(env.SLEEP_INTERVAL, 3600)),
    CIRCUMVENT_LOAD_BALANCER: bool(env.CIRCUMVENT_LOAD_BALANCER, true),
    CLEANUP_TEMPORARY_FILES: bool(env.CLEANUP_TEMPORARY_FILES, true),
    SAFETY_FILTER: bool(env.SAFETY_FILTER, true),
    CATCH_UP_STREAK: Math.max(0, num(env.CATCH_UP_STREAK, 50)),
    MAX_PER_CYCLE: Math.max(0, num(env.MAX_PER_CYCLE, 0)),
    SEARCH_SORT: env.SEARCH_SORT || "date",
    DRY_RUN: bool(env.DRY_RUN, false),
    RUN_ONCE: bool(env.RUN_ONCE, false),
    DEBUG: bool(env.DEBUG, false),
    STATUS_PORT: Math.max(0, num(env.STATUS_PORT, 8099)),
    REQUEST_DELAY_MS: Math.max(0, num(env.REQUEST_DELAY_MS, 2000)),
    MAX_SEARCH_PAGES: Math.max(0, num(env.MAX_SEARCH_PAGES, 0)),
    TZ: env.TZ || "",
  };
}

export function parseEnvFileText(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = val;
  }
  return out;
}
