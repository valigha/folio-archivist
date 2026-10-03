import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySafety,
  idFromFilename,
  libraryDir,
  loadConfigFrom,
  parseIdList,
  parseGalleryRefs,
  parseTags,
  sanitizeFilename,
  galleryIsUnsafe,
  searchPageCap,
  validateNhentaiImport,
  validateNhentaiExistsIds,
} from "./lib.mjs";

test("parseTags handles original docker array syntax", () => {
  assert.deepEqual(parseTags('[language:"english"]'), ['language:"english"']);
  assert.deepEqual(parseTags(`['language:"english"']`), ['language:"english"']);
  assert.deepEqual(parseTags('[tag:"ffm threesome", tag:"sister", -tag:"full censorship"]'), [
    'tag:"ffm threesome"',
    'tag:"sister"',
    '-tag:"full censorship"',
  ]);
});

test("parseTags handles a plain query string", () => {
  assert.deepEqual(parseTags('language:"english" -lolicon'), ['language:"english" -lolicon']);
  assert.deepEqual(parseTags(""), []);
  assert.deepEqual(parseTags(null), []);
});

test("applySafety appends exclusions once", () => {
  assert.equal(
    applySafety('language:"english"', true),
    'language:"english" -lolicon -shotacon -loli -shota -toddlercon',
  );
  assert.equal(applySafety("language:english -lolicon", true).includes("-lolicon -lolicon"), false);
  assert.equal(applySafety("language:english", false), "language:english");
});

test("libraryDir matches original split folders", () => {
  assert.equal(libraryDir("/app/hentai/", 0, 603864), "/app/hentai/");
  assert.equal(libraryDir("/app/hentai/", 1, 603864), "/app/hentai/603864");
  assert.equal(libraryDir("/app/hentai/", 10000, 603864), "/app/hentai/600000~609999");
  assert.equal(libraryDir("/app/hentai/", 10000, 42), "/app/hentai/0~9999");
});

test("idFromFilename and sanitizeFilename", () => {
  assert.equal(idFromFilename("603864 Some Title.cbz"), 603864);
  assert.equal(idFromFilename("12.cbz"), 12);
  assert.equal(idFromFilename("note.txt"), null);
  const name = sanitizeFilename(1, 'foo/bar:baz*"');
  assert.equal(name.startsWith("1 "), true);
  assert.equal(name.endsWith(".cbz"), true);
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes(":"), false);
});

test("parseIdList", () => {
  assert.deepEqual(parseIdList("1\n2 3,4"), [1, 2, 3, 4]);
});

test("parseGalleryRefs accepts nhentai links and raw IDs", () => {
  assert.deepEqual(parseGalleryRefs("https://nhentai.net/g/123456/"), [123456]);
  assert.deepEqual(parseGalleryRefs("https://www.nhentai.net/g/42"), [42]);
  assert.deepEqual(
    parseGalleryRefs("https://nhentai.net/g/1/\nhttps://nhentai.net/g/2/\n2"),
    [1, 2],
  );
  assert.deepEqual(parseGalleryRefs("603864"), [603864]);
  assert.deepEqual(parseGalleryRefs("not a link"), []);
  assert.deepEqual(
    parseGalleryRefs("https://nhentai.net/g/11/, https://nhentai.net/g/22/;https://nhentai.net/g/33/"),
    [11, 22, 33],
  );
  assert.deepEqual(parseGalleryRefs("100, 200;300"), [100, 200, 300]);
});

test("loadConfigFrom server mode", () => {
  const cfg = loadConfigFrom({
    NHENTAI_TAGS: '[language:"english"]',
    SLEEP_INTERVAL: "3600",
    LIBRARY_SPLIT: "10000",
    SAFETY_FILTER: "true",
  });
  assert.deepEqual(cfg.NHENTAI_TAGS, ['language:"english"']);
  assert.equal(cfg.SLEEP_INTERVAL, 3600);
  assert.equal(cfg.LIBRARY_SPLIT, 10000);
  assert.equal(cfg.SAFETY_FILTER, true);
  assert.equal(cfg.REQUEST_DELAY_MS, 2000);
  assert.equal(loadConfigFrom({}).NHENTAI_TAGS, null);
  assert.equal(loadConfigFrom({ REQUEST_DELAY_MS: "1500" }).REQUEST_DELAY_MS, 1500);
});

test("validateNhentaiImport accepts only an exact gallery url", () => {
  const ok = { source: "nhentai", id: "123456", url: "https://nhentai.net/g/123456/", title: "x", tags: [] };
  assert.equal(validateNhentaiImport(ok), "123456");
  assert.equal(validateNhentaiImport({ ...ok, id: 123456 }), null);
  assert.equal(validateNhentaiImport({ ...ok, id: "0123", url: "https://nhentai.net/g/0123/" }), null);
  assert.equal(validateNhentaiImport({ ...ok, url: "https://nhentai.net/g/123456" }), null);
  assert.equal(validateNhentaiImport({ ...ok, url: "http://nhentai.net/g/123456/" }), null);
  assert.equal(validateNhentaiImport({ ...ok, url: "https://www.nhentai.net/g/123456/" }), null);
  assert.equal(validateNhentaiImport({ ...ok, source: "other" }), null);
  assert.equal(validateNhentaiImport({ ...ok, id: "nope", url: "https://nhentai.net/g/nope/" }), null);
});

test("validateNhentaiExistsIds accepts a digit batch and drops duplicates", () => {
  assert.deepEqual(validateNhentaiExistsIds({ ids: ["123456", "789012", "123456"] }), ["123456", "789012"]);
  assert.deepEqual(validateNhentaiExistsIds({ ids: [] }), []);
  assert.equal(validateNhentaiExistsIds({ ids: ["0123"] }), null);
  assert.equal(validateNhentaiExistsIds({ ids: [123456] }), null);
  assert.equal(validateNhentaiExistsIds({ ids: ["12a"] }), null);
  assert.equal(validateNhentaiExistsIds({ ids: Array.from({ length: 51 }, (_, i) => String(i + 1)) }), null);
  assert.equal(validateNhentaiExistsIds({}), null);
});

test("galleryIsUnsafe", () => {
  assert.equal(galleryIsUnsafe({ tags: [{ name: "lolicon", type: "tag" }] }), true);
  assert.equal(galleryIsUnsafe({ tags: [{ name: "big breasts", type: "tag" }] }), false);
});

test("searchPageCap uses incremental pages only after a matching full pass", () => {
  const query = 'language:"english"';
  assert.deepEqual(
    searchPageCap({ query, lastFullQuery: "", incrementalPages: 10, forceFull: false, maxSearchPages: 0 }),
    { incremental: false, cap: 0 },
  );
  assert.deepEqual(
    searchPageCap({ query, lastFullQuery: query, incrementalPages: 10, forceFull: false, maxSearchPages: 0 }),
    { incremental: true, cap: 10 },
  );
  assert.deepEqual(
    searchPageCap({ query, lastFullQuery: query, incrementalPages: 10, forceFull: true, maxSearchPages: 0 }),
    { incremental: false, cap: 0 },
  );
  assert.deepEqual(
    searchPageCap({ query, lastFullQuery: "other", incrementalPages: 10, forceFull: false, maxSearchPages: 0 }),
    { incremental: false, cap: 0 },
  );
  assert.deepEqual(
    searchPageCap({ query, lastFullQuery: query, incrementalPages: 10, forceFull: false, maxSearchPages: 3 }),
    { incremental: true, cap: 3 },
  );
  assert.equal(loadConfigFrom({}).INCREMENTAL_PAGES, 10);
});
