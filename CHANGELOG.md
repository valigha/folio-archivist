# Changelog

Images stay on GHCR forever (until someone deletes the tag).
`latest` always points at the newest build. Pin Unraid to a version tag if you want a freeze.

| Unraid Repository | Meaning |
| --- | --- |
| `ghcr.io/valigha/folio-archivist:latest` | newest, may change |
| `ghcr.io/valigha/folio-archivist:2.2.0` | this release, frozen |
| `ghcr.io/valigha/folio-archivist:v2.2.0` | same image, `v` prefix |

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
