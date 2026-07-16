// Stremio add-on proxy (CORS bypass + SSRF-guarded). The client can't call
// arbitrary add-on hosts from the browser (CORS), so it routes through here:
//   GET /api/stremio/manifest?url=<addon>
//   GET /api/stremio/catalog?url=<addon>&type=<t>&id=<id>[&extra=<seg>]
//   GET /api/stremio/stream?url=<addon>&type=<t>&id=<id>
//   GET /api/stremio/subtitles?url=<addon>&type=<t>&id=<id>   → subtitle LIST
//   GET /api/stremio/subfile?url=<subtitle-file-url>          → subtitle TEXT
// <addon> is the add-on URL the user pasted (may end in /manifest.json — we
// normalize to the base). Endpoints are built per the Stremio add-on protocol
// (resource/type/id[.json]). Only these resources are reachable — this is not
// a general proxy — and every fetched URL passes the SSRF guard. `subfile`
// fetches a subtitle file URL that came from a subtitles/stream response; it is
// guarded identically so an add-on can't point us at an internal address.

const { sendJson } = require('../lib/http');
const { assertPublicUrl } = require('../lib/ssrf');

const enc = encodeURIComponent;

// Stremio catalog "extra" is a single path segment like "skip=100&genre=Action"
// (literal = and &). Strip anything that could add path segments / traverse.
function sanitizeExtra(extra) {
  return extra ? String(extra).replace(/[/\\]/g, '').replace(/\.\./g, '') : '';
}

function buildEndpoint(resource, params) {
  const raw = params.get('url');
  if (!raw) return { error: 'missing url parameter' };
  const base = String(raw)
    .trim()
    .replace(/\/manifest\.json\/?$/i, '') // the user usually pastes the manifest URL
    .replace(/\/+$/, '');

  if (resource === 'manifest') return { endpoint: `${base}/manifest.json` };

  const type = params.get('type');
  const id = params.get('id');
  if (resource === 'catalog') {
    if (!type || !id) return { error: 'catalog needs type and id' };
    const extra = sanitizeExtra(params.get('extra'));
    return { endpoint: `${base}/catalog/${enc(type)}/${enc(id)}${extra ? `/${extra}` : ''}.json` };
  }
  if (resource === 'stream') {
    if (!type || !id) return { error: 'stream needs type and id' };
    return { endpoint: `${base}/stream/${enc(type)}/${enc(id)}.json` };
  }
  if (resource === 'subtitles') {
    if (!type || !id) return { error: 'subtitles need type and id' };
    return { endpoint: `${base}/subtitles/${enc(type)}/${enc(id)}.json` };
  }
  return { error: 'unknown endpoint' };
}

// Fetch with redirects followed MANUALLY so every hop is re-validated against
// the SSRF guard (a public host must not be able to 302 us onto a private one).
async function safeFetch(startUrl, accept = 'application/json') {
  let current = await assertPublicUrl(startUrl);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current.href, {
      headers: { 'User-Agent': 'CoWatch/1.0', Accept: accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without location (HTTP ${res.status})`);
      current = await assertPublicUrl(new URL(loc, current).href);
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

const BLOCKED_RE = /allowed|invalid URL|could not resolve|missing host|http\(s\)/i;

async function handleStremio(req, res, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, detail: 'GET only' });
    return;
  }
  const resource = url.pathname.replace(/^\/api\/stremio\//, '');

  // subfile: fetch an actual subtitle file (its URL came from a subtitles/
  // stream response) and return the raw text. SSRF-guarded like everything else.
  if (resource === 'subfile') {
    const suburl = url.searchParams.get('url');
    if (!suburl) {
      sendJson(res, 400, { success: false, detail: 'missing url parameter' });
      return;
    }
    try {
      const response = await safeFetch(suburl, 'text/vtt, text/plain, application/x-subrip, */*');
      if (!response.ok) throw new Error(`subtitle HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('subtitle file too large');
      sendJson(res, 200, { success: true, text });
    } catch (err) {
      const msg = err.message || 'subtitle unreachable';
      sendJson(res, BLOCKED_RE.test(msg) ? 400 : 502, { success: false, detail: msg });
    }
    return;
  }

  const { endpoint, error } = buildEndpoint(resource, url.searchParams);
  if (error) {
    sendJson(res, 400, { success: false, detail: error });
    return;
  }
  try {
    const response = await safeFetch(endpoint);
    if (!response.ok) throw new Error(`add-on HTTP ${response.status}`);
    const data = await response.json();
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    const msg = err.message || 'Stremio add-on unreachable';
    // guard rejections are client errors (bad/blocked URL) → 400; the rest 502
    sendJson(res, BLOCKED_RE.test(msg) ? 400 : 502, { success: false, detail: msg });
  }
}

module.exports = { handleStremio, buildEndpoint };
