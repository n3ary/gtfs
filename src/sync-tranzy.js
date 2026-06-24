#!/usr/bin/env node

/**
 * Sync all static data from the Tranzy API for all agencies.
 *
 * Usage:
 *   TRANZY_API_KEY=<key> node src/sync-tranzy.js
 *
 * Environment:
 *   TRANZY_API_KEY  — required
 *
 * What it does:
 *   1. Fetches /agency to discover all agencies
 *   2. For each agency: fetches /routes, /stops, /trips, /stop_times, /shapes
 *   3. Stores raw JSON responses in data/<agency_id>/<endpoint>.json
 *   4. Also writes the transformed registry files that build.js expects
 *      (agencies/<id>/routes.json, stops.json, trips.json, stop_times.json)
 *
 * The raw files in data/ are the source of truth for the neary app's static
 * data (served from the releases branch). The registry files in agencies/
 * are the intermediate format consumed by the offline schedule builder.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API_KEY = process.env.TRANZY_API_KEY;
if (!API_KEY) {
  console.error('Error: TRANZY_API_KEY environment variable is required');
  process.exit(1);
}

const BASE_URL = 'https://api.tranzy.ai/v1/opendata';
const LOG = (msg) => console.log(`[sync-tranzy] ${msg}`);

// ============================================================================
// Fetching
// ============================================================================

async function fetchJson(endpoint, agencyId = null) {
  const url = `${BASE_URL}/${endpoint}`;
  const headers = { 'X-API-Key': API_KEY };
  if (agencyId) headers['X-Agency-Id'] = String(agencyId);

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60000), // 60s timeout (shapes is large)
  });

  if (!res.ok) {
    throw new Error(`${endpoint} (agency ${agencyId}) → HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================================
// Storage helpers
// ============================================================================

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

function writeJsonPretty(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================================================
// Registry generation (for build.js compatibility)
// ============================================================================

function writeRegistry(agencyId, rawRoutes, rawStops, rawTrips, rawStopTimes) {
  const outDir = join(ROOT, 'agencies', String(agencyId));
  mkdirSync(outDir, { recursive: true });

  // routes.json
  const routes = {
    _comment: `Auto-generated from Tranzy /routes API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    routes: rawRoutes
      .map(r => ({
        shortName: r.route_short_name,
        routeId: r.route_id,
        longName: r.route_long_name,
        type: r.route_type,
      }))
      .sort((a, b) => a.routeId - b.routeId),
  };
  writeJsonPretty(join(outDir, 'routes.json'), routes);

  // stops.json
  const stops = {
    _comment: `Auto-generated from Tranzy /stops API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    stops: rawStops
      .map(s => ({
        stopId: s.stop_id,
        name: s.stop_name,
        lat: s.stop_lat,
        lon: s.stop_lon,
      }))
      .sort((a, b) => a.stopId - b.stopId),
  };
  writeJsonPretty(join(outDir, 'stops.json'), stops);

  // trips.json
  const trips = {
    _comment: `Auto-generated from Tranzy /trips API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    trips: rawTrips
      .map(t => ({
        tripId: t.trip_id,
        routeId: t.route_id,
        directionId: t.direction_id,
        headsign: t.trip_headsign,
        shapeId: t.shape_id,
        serviceId: t.service_id,
      }))
      .sort((a, b) => a.routeId - b.routeId || a.directionId - b.directionId),
  };
  writeJsonPretty(join(outDir, 'trips.json'), trips);

  // stop_times.json (grouped by trip_id)
  const byTrip = {};
  for (const st of rawStopTimes) {
    if (!byTrip[st.trip_id]) byTrip[st.trip_id] = [];
    byTrip[st.trip_id].push({ stopId: st.stop_id, sequence: st.stop_sequence });
  }
  for (const tripId of Object.keys(byTrip)) {
    byTrip[tripId].sort((a, b) => a.sequence - b.sequence);
  }
  const stopTimes = {
    _comment: `Auto-generated from Tranzy /stop_times API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    stopTimes: byTrip,
  };
  writeJsonPretty(join(outDir, 'stop_times.json'), stopTimes);

  return { routes: routes.routes.length, stops: stops.stops.length, trips: trips.trips.length };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  LOG('Fetching agency list...');
  const agencies = await fetchJson('agency');
  LOG(`Found ${agencies.length} agencies`);

  // Store raw agency list
  const dataDir = join(ROOT, 'data');
  writeJson(join(dataDir, 'agency.json'), agencies);
  LOG(`Saved data/agency.json`);

  // Process each agency
  for (const agency of agencies) {
    const id = agency.agency_id;
    const name = agency.agency_name;
    const agencyDataDir = join(dataDir, String(id));
    mkdirSync(agencyDataDir, { recursive: true });

    LOG(`\n── Agency ${id}: ${name} ──`);

    try {
      // Fetch all static endpoints
      LOG(`  Fetching routes...`);
      const routes = await fetchJson('routes', id);
      writeJson(join(agencyDataDir, 'routes.json'), routes);
      LOG(`  ✓ routes: ${routes.length}`);

      LOG(`  Fetching stops...`);
      const stops = await fetchJson('stops', id);
      writeJson(join(agencyDataDir, 'stops.json'), stops);
      LOG(`  ✓ stops: ${stops.length}`);

      LOG(`  Fetching trips...`);
      const trips = await fetchJson('trips', id);
      writeJson(join(agencyDataDir, 'trips.json'), trips);
      LOG(`  ✓ trips: ${trips.length}`);

      LOG(`  Fetching stop_times...`);
      const stopTimes = await fetchJson('stop_times', id);
      writeJson(join(agencyDataDir, 'stop_times.json'), stopTimes);
      LOG(`  ✓ stop_times: ${stopTimes.length}`);

      LOG(`  Fetching shapes...`);
      const shapes = await fetchJson('shapes', id);
      writeJson(join(agencyDataDir, 'shapes.json'), shapes);
      LOG(`  ✓ shapes: ${shapes.length} points`);

      // Write registry files (for build.js compatibility)
      const stats = writeRegistry(id, routes, stops, trips, stopTimes);
      LOG(`  ✓ registry: ${stats.routes} routes, ${stats.stops} stops, ${stats.trips} trips`);

    } catch (err) {
      LOG(`  ✗ ERROR: ${err.message}`);
      // Continue with other agencies
    }
  }

  LOG('\nSync complete.');
}

main().catch(err => {
  console.error('[sync-tranzy] Fatal:', err.message);
  process.exit(1);
});
