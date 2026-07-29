// ICE config served to clients. TURN credentials come from the environment
// (PRD §15: secrets never go in source). Note: whatever is served here is
// visible to anyone who can open a room link — inherent to browser TURN.
//
// Two ways to configure the relay:
//
//   TURN_API_URL   (preferred) — a provider endpoint that mints fresh
//                  credentials, e.g. Metered's
//                  https://<app>.metered.live/api/v1/turn/credentials?apiKey=…
//                  The API KEY stays server-side; only the short-lived
//                  username/credential it returns reach the browser. Results
//                  are cached, and a failed refresh falls back to the static
//                  values below rather than dropping the relay entirely.
//
//   TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL — static credentials.
//
// The URLS AND CREDENTIALS MUST COME FROM THE SAME PLACE. Pointing valid
// credentials at a different relay host (…/global… vs …/standard…) makes the
// server refuse the allocation with a 400, which looks exactly like a bad key.

const { sendJson } = require('../lib/http');

const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const CACHE_MS = 30 * 60 * 1000; // refresh well inside a typical 24h validity

let cache = { at: 0, servers: null };

function staticServers() {
  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!turnUrls.length || !process.env.TURN_USERNAME || !process.env.TURN_CREDENTIAL) return [];
  return [
    {
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    },
  ];
}

// Ask the provider for fresh credentials. Returns [] on any problem so the
// caller can fall back.
async function fetchedServers() {
  const api = (process.env.TURN_API_URL || '').trim();
  if (!api) return [];
  if (cache.servers && Date.now() - cache.at < CACHE_MS) return cache.servers;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Providers return either a bare array or { iceServers: [...] }.
    const list = Array.isArray(body) ? body : body?.iceServers;
    const servers = (list || []).filter((s) => s && s.urls);
    if (!servers.length) throw new Error('no iceServers in response');
    cache = { at: Date.now(), servers };
    return servers;
  } catch (err) {
    // Keep serving the last good answer if we have one.
    if (cache.servers) return cache.servers;
    console.warn(`TURN_API_URL fetch failed (${err.message}) — using static TURN config.`);
    return [];
  }
}

async function iceConfig() {
  const relay = (await fetchedServers()) || [];
  const iceServers = [{ urls: DEFAULT_STUN }, ...(relay.length ? relay : staticServers())];
  const forceRelay = /^(1|true|yes)$/i.test(process.env.FORCE_RELAY || '');
  return { iceServers, forceRelay };
}

// True when SOME relay is configured (either route) — used by the startup log.
function turnConfigured() {
  return !!(process.env.TURN_API_URL || '').trim() || staticServers().length > 0;
}

async function handleIceConfig(req, res) {
  try {
    sendJson(res, 200, await iceConfig());
  } catch (err) {
    sendJson(res, 200, { iceServers: [{ urls: DEFAULT_STUN }], forceRelay: false, detail: err.message });
  }
}

module.exports = { iceConfig, handleIceConfig, turnConfigured };
