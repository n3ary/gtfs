/**
 * Shared HTTP helpers - single User-Agent + WAF body guard.
 *
 * The WAF guard is the important half of this module. Transitous and
 * MDB have been known to respond with HTTP 200 + a Cloudflare
 * challenge page when their edge rate-limits us. The captcha HTML
 * doesn't carry a non-2xx status, so a plain `res.ok` check lets it
 * through - and the downstream pipeline then writes the HTML to disk
 * labelled `<id>.gtfs.zip`, the unzip step either errors loudly or,
 * worse, parses garbage into rows. The resulting SQLite shipped to
 * consumers crashes "stops near me" (and other views) with SQL errors
 * against bogus data.
 *
 * Catches:
 *   - 200 + Content-Type: text/html (Cloudflare challenge page)
 *   - 200 + body starts with HTML markers even if Content-Type lies
 *     (some WAFs strip the header)
 *   - 200 + non-ZIP magic bytes for `.gtfs.zip` downloads
 *
 * The guard throws with the URL + sniffed marker so the daily pipeline
 * fails the build instead of silently publishing a poisoned feed.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UA = 'gtfs/2.0 (https://github.com/n3ary/gtfs-publisher)';

// Local file header magic: 'PK\x03\x04'.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// Markers commonly seen in Cloudflare / generic WAF challenge pages.
// Sniffed case-insensitively against the first ~1 KB of the body.
const HTML_MARKERS = [
  '<!doctype html',
  '<html',
  'cloudflare',
  'attention required',
  'cf-mitigated',
  'just a moment',
  'checking your browser',
  'access denied',
  'forbidden',
  'captcha',
] as const;

type ExpectedKind = 'zip' | 'json';

function contentTypeLooksHtml(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml+xml');
}

function sniffMarker(buf: Buffer): string | null {
  // Only the first ~1 KB - keeps the cost trivial and avoids
  // streaming the whole body just to decide it's a WAF page.
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('utf8').toLowerCase();
  for (const m of HTML_MARKERS) {
    if (head.includes(m)) return m;
  }
  return null;
}

/**
 * Buffer the response and validate it isn't a WAF/captcha page before
 * returning the body to the caller. Returns the buffered body so the
 * caller doesn't re-download.
 *
 * Throws with the URL + the sniffed marker (or ZIP-magic mismatch)
 * on a hit. Caller should let the error propagate - the daily pipeline
 * uses `set -euo pipefail` so the run fails loudly and no
 * feeds.json + sqlite.gz get published.
 */
export async function assertNotWafBody(
  res: Response,
  url: string,
  expected: ExpectedKind,
): Promise<{ buf: Buffer }> {
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  // Cheap path: Content-Type advertises HTML when it shouldn't.
  if (contentTypeLooksHtml(res.headers.get('content-type'))) {
    throw new Error(
      `GET ${url}: upstream returned HTML body ` +
      `(content-type=${res.headers.get('content-type') ?? '<none>'}) - ` +
      `looks like a WAF / captcha page. Aborting to avoid shipping poisoned output.`,
    );
  }

  // Sniff first ~1 KB for HTML markers regardless of Content-Type.
  // Some WAFs strip / mislabel the header; this catches those.
  const marker = sniffMarker(buf);
  if (marker !== null) {
    throw new Error(
      `GET ${url}: upstream body contains "${marker}" marker - ` +
      `looks like a WAF / captcha page. Aborting to avoid shipping poisoned output.`,
    );
  }

  // ZIP-specific: magic bytes check. A WAF that returns 200 +
  // application/octet-stream + HTML body would slip past the
  // Content-Type + marker checks above, so verify the magic.
  if (expected === 'zip') {
    if (buf.length < 4 || !buf.subarray(0, 4).equals(ZIP_MAGIC)) {
      const head = buf.subarray(0, Math.min(buf.length, 64))
        .toString('utf8')
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      throw new Error(
        `GET ${url}: upstream body is not a ZIP file ` +
        `(first bytes: "${head.slice(0, 64)}") - ` +
        `aborting to avoid shipping poisoned output.`,
      );
    }
  }

  return { buf };
}

export async function fetchJson(url: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...extraHeaders } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  // Guard catches the 200+HTML / 200+error-JSON cases that
  // res.json() would otherwise either parse as data or fail with
  // a generic SyntaxError. Adds URL + marker context.
  const { buf } = await assertNotWafBody(res, url, 'json');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`GET ${url}: response body is not valid JSON: ${(e as Error).message}`);
  }
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

export async function fetchToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  // Buffer the body in memory so we can sniff for WAF HTML /
  // captcha pages BEFORE writing to disk. fetchToFile is used for
  // .gtfs.zip downloads (Transitous + remote sources). A Cloudflare
  // challenge page returned with HTTP 200 used to be written to
  // disk as a zip file - either failing unzip loudly downstream or
  // parsing as garbage rows. Either way the published SQLite ended
  // up poisoned.
  const { buf } = await assertNotWafBody(res, url, 'zip');
  await pipeline(Readable.from(buf), createWriteStream(dest));
}