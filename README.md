# neary-gtfs

Daily pipeline that syncs transit data from the Tranzy API and builds offline schedules from CTP Cluj CSV timetables. Publishes everything to the `releases` branch, served directly to the [neary](https://github.com/ciotlosm/neary) PWA via `raw.githubusercontent.com` (CORS-open, no proxy needed).

## What it produces

| File | Source | Consumer |
|------|--------|----------|
| `data/<id>/routes.json` | Tranzy API | neary app (static data) |
| `data/<id>/stops.json` | Tranzy API | neary app (static data) |
| `data/<id>/trips.json` | Tranzy API | neary app (static data) |
| `data/<id>/stop_times.json` | Tranzy API | neary app (static data) |
| `data/<id>/shapes.json` | Tranzy API | neary app (static data) |
| `data/agency.json` | Tranzy API | neary app (agency list) |
| `data/hashes.json` | Computed | neary app (freshness check) |
| `agency-2-schedule.json` | CTP CSV scrape | neary app (offline schedule) |
| `agency-2-gtfs.zip` | CTP CSV scrape | GTFS validators/interop |

## How it works

A single GitHub Action runs daily at 00:00 UTC (or on manual trigger):

1. **Sync** (`npm run sync`) — fetches all agencies' static data from the Tranzy API. Compares SHA-256 hashes against previous run; only writes changed files.

2. **Build** (`node src/build.js --agency 2`) — scrapes CTP Cluj CSV schedules, generates GTFS files + compact schedule JSON.

3. **Publish** — pushes changed files to the `releases` branch. Creates a GitHub Release with the schedule ZIP (only if schedule hash changed).

The neary app fetches from:
```
https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/data/<id>/<endpoint>.json
```

## Structure

```
agencies/2/config.json       # CTP Cluj URL patterns + service day mappings
src/sync-tranzy.js           # Syncs all agencies from Tranzy API
src/build.js                 # Builds schedule from CTP CSV files
.github/workflows/           # Daily pipeline
```

## Local development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

Schedule data © CTP Cluj-Napoca. Generated for public transit information purposes.
