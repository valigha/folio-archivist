# Folio Unraid worker

Drop-in replacement for [9-FS/nhentai_archivist](https://github.com/9-FS/nhentai_archivist) after nhentai retired `/api/gallery/{id}` (now 403: “Use new API”).

It talks to official API v2, writes Komga-ready CBZ files with `ComicInfo.xml`, and runs the same **server-mode loop** the old image did:

1. Search `NHENTAI_TAGS` (or read `downloadme.txt` if you dropped IDs in by hand)
2. Skip anything already in the library **and** anything in `dontdownloadme.txt`
3. Download the rest as CBZ
4. Delete `downloadme.txt` so the next pass re-searches
5. Sleep `SLEEP_INTERVAL` seconds
6. Repeat forever

GitHub Actions publishes these tags (old ones are kept):

| Tag | What it is |
| --- | --- |
| `ghcr.io/valigha/folio-archivist:latest` | Newest build. This is what Force update pulls. |
| `ghcr.io/valigha/folio-archivist:2.3.1` | Frozen copy of that version |
| `ghcr.io/valigha/folio-archivist:v2.3.1` | Same image, `v` prefix |

**Follow new features:** leave Repository as `:latest` and Force update when we ship.

**Freeze a working build:** Edit the container → Repository → change `latest` to `2.2.0` → Apply. Library and appdata are untouched. Switch back to `:latest` later, or to an older number if a new one misbehaves.

See [CHANGELOG.md](CHANGELOG.md) for what each number includes. Bump `VERSION` (and the worker `version` string) whenever we add features so a new frozen tag is created and `latest` moves.

## Unraid the normal way (pull an image)

1. Unraid → Docker → **Add Container**
2. Repository: `ghcr.io/valigha/folio-archivist:latest`
3. Import `unraid.xml` (or fill the same fields by hand)
4. Map `/app/hentai` to your media share, `/app/config` to appdata
5. Set `NHENTAI_TAGS` and `SLEEP_INTERVAL` exactly like the old 9-FS container
6. Apply. WebUI is port 8099.

The status page is a live dashboard: countdown to the next run, search/download progress, recently written CBZs, a filterable log, **Pause / Run now**, and **tag chips** you can change without restarting. Tag search talks to nhentai `POST /api/v2/tags/search`. Saved chips live in `config/folio.json` (overrides `NHENTAI_TAGS` after the first save from the page).

Make the GHCR package **public** the first time (GitHub → the repo → Packages) so Unraid can pull without a login.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `NHENTAI_TAGS` | empty (client mode) | Setting this turns **server mode** on. Query syntax matches the site: `language:"english"`, `tag:"big breasts"`, `artist:shindol`, `-tag:"full censorship"`. Original list form still works: `[language:"english"]`. |
| `SLEEP_INTERVAL` | `3600` | Seconds to wait after a cycle. Original used `50000` (~14h). |
| `LIBRARY_PATH` | `/app/hentai/` | CBZ destination |
| `LIBRARY_SPLIT` | `0` | `10000` splits into `0~9999`, `10000~19999`, … like the original |
| `FILENAME_TITLE_TYPE` | `English` | `English` / `Japanese` / `Pretty` |
| `DOWNLOAD_WORKERS` | `5` | Parallel page fetches |
| `DONTDOWNLOADME_FILEPATH` | `/app/config/dontdownloadme.txt` | Blacklist, one ID per line |
| `DOWNLOADME_FILEPATH` | `/app/config/downloadme.txt` | Optional one-shot ID list (takes priority for that cycle, then is deleted) |
| `SAFETY_FILTER` | `true` | Appends `-lolicon -shotacon -loli -shota -toddlercon` and skips those tags |
| `CATCH_UP_STREAK` | `50` | Newest-first: stop the cycle after this many already-have galleries in a row. `0` = full sweep like the original. |
| `MAX_PER_CYCLE` | `0` | Cap new downloads per cycle (`0` = unlimited) |
| `REQUEST_DELAY_MS` | `2000` | Pause between API search/metadata calls. Raise to `3000`–`5000` if you still see 429s |
| `MAX_SEARCH_PAGES` | `0` | Hard cap on search pages per cycle (`0` = unlimited). |
| `INCREMENTAL_PAGES` | `10` | After a full pass with the same chips, later cycles only search this many newest pages. `0` = always walk everything. Changing chips forces a full pass again. |
| `CIRCUMVENT_LOAD_BALANCER` | `true` | Hit `i1`–`i4.nhentai.net` directly |
| `API_KEY` | empty | Optional. Sent as `Authorization: Key …` |
| `USER_AGENT` | Folio/1.0 … | API v2 wants a descriptive UA |
| `STATUS_PORT` | `8099` | Tiny dashboard. `0` disables it |
| `RUN_ONCE` | `false` | Do one cycle and exit even in server mode (useful to test) |
| `DRY_RUN` | `false` | Log what would be written without fetching pages |
| `PUID` / `PGID` / `UMASK` / `TZ` | `99` / `100` / `002` | Unraid defaults |

## Tag examples

```
language:"english"
tag:"big breasts"
parody:"kono subarashii sekai ni syukufuku o"
artist:"shindol"
character:"frieren"
tag:"ffm threesome" tag:"sister" -tag:"full censorship"
```

Do **not** start with a huge query like all of English unless you mean it — the first pass will keep downloading until `CATCH_UP_STREAK` hits already-archived IDs (empty library = no streak, so it will walk the whole search). Use `MAX_PER_CYCLE=20` while you test.

## Skip logic

A gallery is skipped when:

- a CBZ whose filename starts with `{id}` already exists anywhere under `LIBRARY_PATH` (split folders included), or
- the ID is listed in `dontdownloadme.txt`, or
- `SAFETY_FILTER` matches its tags

Title changes do not trigger a re-download.

## Client mode

Leave `NHENTAI_TAGS` empty, put IDs in `config/downloadme.txt` (one per line), start the container. It downloads the missing ones and exits.
