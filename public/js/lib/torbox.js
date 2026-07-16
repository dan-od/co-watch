// Frontend TorBox API client: a thin POST wrapper plus local API-key access.
// The server proxies these calls to TorBox — the key is sent per-request and
// never stored server-side.

export async function torboxPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return { success: false, detail: `unexpected response (HTTP ${res.status})` };
  }
}

export function getKey() {
  return (localStorage.getItem('torbox_api_key') || '').trim();
}

const VIDEO_RE = /\.(mp4|mkv|webm|m4v|mov|avi)$/i;
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
];

// Build a magnet from a bare btih infoHash (+ optional Stremio stream.sources,
// which are "tracker:<url>" / "dht:<node>" strings).
export function infoHashToMagnet(infoHash, sources = [], name = '') {
  const trackers = (sources || [])
    .filter((s) => typeof s === 'string' && s.startsWith('tracker:'))
    .map((s) => s.slice('tracker:'.length));
  const tr = (trackers.length ? trackers : DEFAULT_TRACKERS)
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join('');
  return `magnet:?xt=urn:btih:${infoHash}${name ? `&dn=${encodeURIComponent(name)}` : ''}${tr}`;
}

// Shared TorBox resolve: add a magnet, wait for cache/finish (reporting 0–1
// progress), pick the largest video file, and return its stream URL. Used by
// the Stremio infoHash fallback (and available to any magnet-based source).
export async function resolveMagnet(apiKey, magnet, hash, { onProgress, poll = 3000 } = {}) {
  let meta = await torboxPost('/torbox/fetch', { apiKey, magnet, hash });
  if (!meta?.success) throw new Error(meta?.detail || 'could not add torrent');
  while (!meta.cached && !meta.finished) {
    onProgress?.(meta.progress || 0);
    await new Promise((r) => setTimeout(r, poll));
    meta = await torboxPost('/torbox/fetch', { apiKey, torrentId: meta.torrentId });
    if (!meta?.success) throw new Error(meta?.detail || 'download failed');
  }
  const videos = (meta.files || []).filter((f) => VIDEO_RE.test(f.name || ''));
  if (!videos.length) throw new Error('no video files in this torrent');
  videos.sort((a, b) => (b.size || 0) - (a.size || 0));
  const file = videos[0];
  const dl = await torboxPost('/torbox/load', { apiKey, torrentId: meta.torrentId, fileId: file.id });
  if (!dl?.success || !dl.streamUrl) throw new Error(dl?.detail || 'could not get stream URL');
  // `meta` carries the full file list (incl. .srt/.vtt) + torrentId so callers
  // can hand it to tracks.setTorrentSubs() for the CC panel.
  return { streamUrl: dl.streamUrl, fileName: file.name, magnet, hash, meta };
}
