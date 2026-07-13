// Shared TorBox API utilities.
// api.torbox.app is not CORS-enabled for browsers, so the client posts to the
// /torbox/* routes and the server forwards the call. The user's API key is
// passed through per request and never stored or logged.

const TORBOX_API = 'https://api.torbox.app/v1/api';

const tbJson = (r) => r.json().catch(() => null);

// Redacted diagnostic: logs response SHAPE only (status, success/detail, and
// the keys of `data`) — never the API key, token, or stream URL. Opt-in via
// TORBOX_DEBUG=1 so it stays quiet in normal use.
function tbLog(label, r, j) {
  if (!/^(1|true|yes)$/i.test(process.env.TORBOX_DEBUG || '')) return;
  const d = j?.data;
  const shape = Array.isArray(d)
    ? `array[${d.length}]${d[0] && typeof d[0] === 'object' ? ' item{' + Object.keys(d[0]).join(',') + '}' : ''}`
    : d && typeof d === 'object'
      ? `{${Object.keys(d).join(',')}}`
      : typeof d === 'string'
        ? `string(len ${d.length})`
        : String(d);
  console.log(`[torbox] ${label} HTTP ${r?.status} success=${j?.success} detail=${j?.detail ?? ''} data=${shape}`);
}

module.exports = { TORBOX_API, tbJson, tbLog };
