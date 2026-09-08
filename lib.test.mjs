import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySafety,
  idFromFilename,
  libraryDir,
  loadConfigFrom,
  parseIdList,
  parseTags,
  sanitizeFilename,
  galleryIsUnsafe,
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

test("galleryIsUnsafe", () => {
  assert.equal(galleryIsUnsafe({ tags: [{ name: "lolicon", type: "tag" }] }), true);
  assert.equal(galleryIsUnsafe({ tags: [{ name: "big breasts", type: "tag" }] }), false);
});
