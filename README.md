# neary-gtfs

Daily pipeline producing GTFS feeds for the [neary](https://github.com/ciotlosm/neary) PWA.

> **Active refactor**: the `refactor/feeds-from-transitous` branch is
> migrating to a multi-feed model aligned with
> [public-transport/transitous](https://github.com/public-transport/transitous).
> The legacy Tranzy-driven path is gone here; the `releases` branch on
> the remote (which v1 PWAs still consume) is left untouched.
>
> Roadmap: [neary docs/rebuild-v2/neary-gtfs-plan.md §10](https://github.com/ciotlosm/neary/blob/rebuild/v2-svelte-sqlite/docs/rebuild-v2/neary-gtfs-plan.md#10-evolution-roadmap)
> (M0 → M5). Current milestone: **M2** — SQLite generation + first
> Transitous-mirrored feed (Bucharest).

## What it produces

Published to the `binaries-staging` branch by
[`.github/workflows/daily.yml`](.github/workflows/daily.yml)
(promotes to `binaries` once CI is verified end-to-end):

| File | Source | Consumer |
|------|--------|----------|
| `feeds.json` | new pipeline | neary v2 app (single registry) |
| `feeds/<feedId>.gtfs.zip` | local build (ctp-cluj) / `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip` (mirrored) | external validators |
| `feeds/<feedId>.sqlite3.gz` | `make-sqlite.js` | neary v2 app (OPFS) |

Current feeds (verified locally):

| id | source | gtfs.zip | sqlite3.gz | rows |
|---|---|---:|---:|---|
| `ctp-cluj` | local CSV enhance | 1.7 MB | 5.4 MB | 14k trips · 193k stop_times · 70k shape pts |
| `bucuresti-ilfov` | Transitous mirror | 7.8 MB | 25 MB | 63k trips · 1.33M stop_times · 82k shape pts |

## How it works

`.github/workflows/daily.yml` runs at 00:30 UTC (after Transitous's
daily import) or on manual trigger:

1. **Pipeline** (`npm run pipeline`):
   - `resolve-feeds.js` — `countries.json` (countries + `include`
     whitelist) + Transitous `feeds/<iso>.json` → feed list. ctp-cluj
     is always prepended.
   - `fetch-gtfs.js` — for `ctp-cluj`: invoke `feeds/ctp-cluj/build.js`;
     for Transitous feeds: download from
     `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`
   - `derive-bbox.js` — extract `stops.txt`/`agency.txt`/`feed_info.txt`
     via `unzip -p`
   - `make-sqlite.js` — convert .zip → .sqlite3.gz (per-feed)
   - `make-app-registry.js` — write `outputs/feeds.json`, Ajv-validate
2. **GTFS validator** — canonical MobilityData validator; fails on any ERROR
3. **Publish** — push `outputs/` → `binaries-staging` branch

The Cluj enhancement (`feeds/ctp-cluj/build.js`):
- Fetches `https://external.gtfs.ro/cluj/CLUJ.zip` (mdb-2121 mirror) as seed
- Keeps `agency.txt`, `routes.txt`, `stops.txt`, `shapes.txt` from seed
- **Regenerates** `calendar.txt`, `trips.txt`, `stop_times.txt` from
  daily CTP CSV scrapes (`https://ctpcj.ro/orare/csv/orar_<route>_<svc>.csv`)
- Adds `feed_info.txt` with `feed_publisher_name="neary-gtfs"`
- Re-zips into `outputs/feeds/ctp-cluj.gtfs.zip`

Trip IDs follow the canonical CTP format
`<route_id>_<dir>_<service>_<seq>_<HHMM>` (e.g. `45_1_LV_9_0721`), which
matches the `cluj-rt-feed.gtfs.ro` GTFS-Realtime feed exactly.

App consumes from (M1+):
```
https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries-staging/feeds.json
```
M2 will rename the publish branch to `binaries` and put jsDelivr in front.

## Structure

```{ countries: [iso], include: [transitous source names] }
schemas/feeds.schema.json       # JSON Schema (draft-2020) for outputs/feeds.json
src/pipeline/
  build-all.js                  # orchestrator (npm run pipeline)
  resolve-feeds.js              # countries.json + Transitous → feed list
  fetch-gtfs.js                 # build local or fetch upstream
  derive-bbox.js                # zip → bbox + agencies + validity
  make-sqlite.js                # zip → .sqlite3.gz (per-feed)box + agencies + validity
  make-sqlite.js                # M2 stub
  make-app-registry.js          # → outputs/feeds.json (Ajv-validated)
  _smoke.js                     # local end-to-end check (no CI)
feeds/ctp-cluj/                 # the ONLY custom-built feed
  build.js                      # CSV enhance of CLUJ.zip
  config.json                   # CSV URL pattern, service IDs, ...
  lib/{csv,seed}.js             # parsers/loaders
.github/workflows/daily.yml     # cron 00:30 UTC → binaries-staging
```

## Local development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

Schedule data © CTP Cluj-Napoca. Generated for public transit information purposes.

