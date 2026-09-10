# Changelog

Images stay on GHCR forever (until someone deletes the tag).
`latest` always points at the newest build. Pin Unraid to a version tag if you want a freeze.

| Unraid Repository | Meaning |
| --- | --- |
| `ghcr.io/valigha/folio-archivist:latest` | newest, may change |
| `ghcr.io/valigha/folio-archivist:2.2.0` | this release, frozen |
| `ghcr.io/valigha/folio-archivist:v2.2.0` | same image, `v` prefix |

## 2.3.2

- **Stop — newest N only** aborts the current full walk (after the gallery in progress), marks these chips as scanned, and starts an N-page cycle. Saved in `folio.json` so a container restart stays newest-only.

## 2.3.1

- After a 429, wait as before, then raise the API delay by 1 second (saved, cap 15s)
- Status banner shows the new delay

## 2.3.0

- Search page stays visible while a gallery is downloading
- After a full pass with the same chips, later cycles only search the newest N pages (`INCREMENTAL_PAGES`, default 10)
- Changing chips (or **Search all pages next**) walks everything again
- **Use newest-only from now** marks the current query scanned without waiting for 4K pages

## 2.2.0

- Pause / Run now on the status page
- Tag chips + live nhentai tag search
- Last-cycle history
- Query saved in `config/folio.json` (no container restart to change tags)

## 2.1.1

- 429 banner with backoff countdown

## 2.1.0

- Live dashboard (timer, search/download progress, recent CBZs, log panel)

## 2.0.1

- 2s delay between API calls, stop the cycle after repeated 429s

## 2.0.0

- First API v2 worker (search, skip existing, write CBZ, sleep loop)
