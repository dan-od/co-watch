// CoWatch signaling server.
// Serves the static client and relays JSON messages between the (at most) two
// peers in a room. It never inspects payloads beyond `type` and `room`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Load .env (simple KEY=VALUE lines) without a dependency. Real env vars win.
try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2];
    }
  }
} catch {
  // no .env — fine, run STUN-only
}

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ICE config served to clients. TURN credentials come from the environment
// (PRD §15: secrets never go in source). Note: whatever is served here is
// visible to anyone who can open a room link — inherent to browser TURN.
function iceConfig() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  const forceRelay = /^(1|true|yes)$/i.test(process.env.FORCE_RELAY || '');
  return { iceServers, forceRelay };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// --- TorBox proxy ------------------------------------------------------------
// api.torbox.app is not CORS-enabled for browsers, so the client posts to these
// endpoints and the server forwards the call. The user's API key is passed
// through per request and never stored or logged. Only these three fixed
// TorBox endpoints are reachable — this is not a general proxy.

const TORBOX_API = 'https://api.torbox.app/v1/api';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleTorbox(req, res, urlPath) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, detail: 'POST only' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { success: false, detail: 'invalid JSON body' });
    return;
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    sendJson(res, 400, { success: false, detail: 'missing apiKey' });
    return;
  }
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const tbJson = (r) => r.json().catch(() => null);

  // Redacted diagnostic: logs response SHAPE only (status, success/detail, and
  // the keys of `data`) — never the API key, token, or stream URL. Opt-in via
  // TORBOX_DEBUG=1 so it stays quiet in normal use.
  const tbLog = (label, r, j) => {
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
  };

  try {
    // ---- Composed endpoints (Phase 4c/4d UI) ----

    if (urlPath === '/torbox/check') {
      // Validate the API key against the user endpoint.
      const r = await fetch(`${TORBOX_API}/user/me?settings=false`, { headers: authHeaders });
      const j = await tbJson(r);
      tbLog('check', r, j);
      sendJson(res, 200, {
        valid: !!j?.success,
        plan: j?.data?.plan ?? null,
        detail: j?.success ? null : j?.detail || `HTTP ${r.status}`,
      });
      return;
    }

    if (urlPath === '/torbox/fetch') {
      // Fetch torrent metadata. First call: {magnet, hash} — checks cache,
      // adds the torrent, returns files. Poll call: {torrentId} — returns
      // download state/progress/files for an already-added torrent.
      let torrentId = body.torrentId ?? null;
      let cached = null;
      if (!torrentId) {
        const hash = String(body.hash || '').toLowerCase();
        const ccR = await fetch(`${TORBOX_API}/torrents/checkcached?format=object&list_files=true`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: [hash] }),
        });
        const cc = await tbJson(ccR);
        tbLog('checkcached', ccR, cc);
        if (cc?.success === false && cc?.detail) {
          sendJson(res, 200, { success: false, detail: cc.detail });
          return;
        }
        cached = !!cc?.data?.[hash];
        const form = new FormData();
        form.set('magnet', String(body.magnet || ''));
        const ctR = await fetch(`${TORBOX_API}/torrents/createtorrent`, {
          method: 'POST',
          headers: authHeaders,
          body: form,
        });
        const ct = await tbJson(ctR);
        tbLog('createtorrent', ctR, ct);
        torrentId = ct?.data?.torrent_id ?? ct?.data?.id ?? null;
        if (!torrentId) {
          // Torrent may already exist in the account — find it by hash.
          const mlR = await fetch(`${TORBOX_API}/torrents/mylist?bypass_cache=true`, { headers: authHeaders });
          const ml = await tbJson(mlR);
          const list = Array.isArray(ml?.data) ? ml.data : [];
          torrentId = list.find((t) => (t?.hash || '').toLowerCase() === hash)?.id ?? null;
        }
        if (!torrentId) {
          sendJson(res, 200, { success: false, detail: ct?.detail || 'TorBox did not accept this torrent' });
          return;
        }
      }
      const tR = await fetch(`${TORBOX_API}/torrents/mylist?id=${encodeURIComponent(torrentId)}&bypass_cache=true`, {
        headers: authHeaders,
      });
      const tj = await tbJson(tR);
      tbLog('mylist(byId)', tR, tj);
      const t = Array.isArray(tj?.data) ? tj.data[0] : tj?.data;
      const files = (t?.files || []).map((f, i) => ({
        id: f?.id ?? i,
        name: f?.name || f?.short_name || `file ${i}`,
        size: f?.size ?? 0,
        mimetype: f?.mimetype || '',
      }));
      sendJson(res, 200, {
        success: true,
        torrentId,
        cached,
        state: t?.download_state ?? 'unknown',
        progress: typeof t?.progress === 'number' ? t.progress : 0,
        finished: !!t?.download_finished,
        files,
      });
      return;
    }

    if (urlPath === '/torbox/load') {
      // Resolve a torrent file to a direct stream URL.
      const q = new URLSearchParams({ token: apiKey, torrent_id: String(body.torrentId ?? '') });
      if (body.fileId != null) q.set('file_id', String(body.fileId));
      const r = await fetch(`${TORBOX_API}/torrents/requestdl?${q}`);
      const j = await tbJson(r);
      tbLog('requestdl', r, j);
      const streamUrl = typeof j?.data === 'string' ? j.data : j?.data?.url;
      if (!streamUrl) {
        sendJson(res, 200, { success: false, detail: j?.detail || 'TorBox did not return a download URL' });
        return;
      }
      sendJson(res, 200, { success: true, streamUrl });
      return;
    }

    if (urlPath === '/torbox/subfile') {
      // Fetch a SUBTITLE file from the user's own torrent (the TorBox CDN is
      // not CORS-open, so the text comes through here). Hard 3 MB cap so a
      // mis-picked video file can't be pulled through this path.
      const MAX_SUB_BYTES = 3 * 1024 * 1024;
      const q = new URLSearchParams({ token: apiKey, torrent_id: String(body.torrentId ?? '') });
      if (body.fileId != null) q.set('file_id', String(body.fileId));
      const r = await fetch(`${TORBOX_API}/torrents/requestdl?${q}`);
      const j = await tbJson(r);
      tbLog('subfile:requestdl', r, j);
      const url = typeof j?.data === 'string' ? j.data : j?.data?.url;
      if (!url) {
        sendJson(res, 200, { success: false, detail: j?.detail || 'TorBox did not return a download URL' });
        return;
      }
      const fR = await fetch(url);
      if (!fR.ok || !fR.body) {
        sendJson(res, 200, { success: false, detail: `subtitle fetch failed (HTTP ${fR.status})` });
        return;
      }
      if (Number(fR.headers.get('content-length') || 0) > MAX_SUB_BYTES) {
        fR.body.cancel?.();
        sendJson(res, 200, { success: false, detail: 'that file is too large to be a subtitle' });
        return;
      }
      const reader = fR.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_SUB_BYTES) {
          reader.cancel();
          sendJson(res, 200, { success: false, detail: 'that file is too large to be a subtitle' });
          return;
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks);
      let text = buf.toString('utf8');
      if (text.includes('�')) text = buf.toString('latin1'); // common for older .srt files
      sendJson(res, 200, { success: true, text });
      return;
    }

    // ---- Raw pass-through endpoints (Phase 4b; kept for compatibility) ----
    let upstream;
    if (urlPath === '/torbox/checkcached') {
      upstream = await fetch(`${TORBOX_API}/torrents/checkcached?format=object&list_files=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: Array.isArray(body.hashes) ? body.hashes : [] }),
      });
    } else if (urlPath === '/torbox/createtorrent') {
      const form = new FormData();
      form.set('magnet', String(body.magnet || ''));
      upstream = await fetch(`${TORBOX_API}/torrents/createtorrent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else if (urlPath === '/torbox/requestdl') {
      const q = new URLSearchParams({ token: apiKey, torrent_id: String(body.torrent_id ?? '') });
      if (body.file_id != null) q.set('file_id', String(body.file_id));
      upstream = await fetch(`${TORBOX_API}/torrents/requestdl?${q}`);
    } else {
      sendJson(res, 404, { success: false, detail: 'unknown torbox endpoint' });
      return;
    }
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch {
    sendJson(res, 502, { success: false, detail: 'TorBox API unreachable from server' });
  }
}

// --- TMDb metadata proxy (Phase 4e) -------------------------------------------
// Metadata only: title/poster/overview/rating search. The key comes from the
// x-tmdb-key header (user's own, stored client-side) or TMDB_API_KEY env.

const TMDB_API = 'https://api.themoviedb.org/3';

async function handleTmdbSearch(req, res, url) {
  const apiKey = String(req.headers['x-tmdb-key'] || process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) {
    sendJson(res, 400, { success: false, detail: 'TMDb API key required. Enter one in Settings.' });
    return;
  }
  const query = (url.searchParams.get('query') || '').trim();
  if (!query) {
    sendJson(res, 400, { success: false, detail: 'missing query' });
    return;
  }
  const year = url.searchParams.get('year') || '';
  const page = url.searchParams.get('page') || '1';
  const type = url.searchParams.get('type') || 'all';

  try {
    const results = [];
    const searchKind = async (kind) => {
      const p = new URLSearchParams({ api_key: apiKey, query, page, include_adult: 'false' });
      if (year) p.set(kind === 'movie' ? 'year' : 'first_air_date_year', year);
      const r = await fetch(`${TMDB_API}/search/${kind}?${p}`);
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.success === false) {
        throw new Error(j?.status_message || `TMDb HTTP ${r.status}`);
      }
      for (const it of j?.results || []) {
        results.push({
          id: it.id,
          title: kind === 'movie' ? it.title : it.name,
          year: (kind === 'movie' ? it.release_date : it.first_air_date)?.split('-')[0] || null,
          poster_path: it.poster_path || null,
          overview: it.overview || '',
          vote_average: it.vote_average ?? null,
          popularity: it.popularity ?? 0,
          type: kind === 'movie' ? 'movie' : 'tv',
        });
      }
    };
    if (type === 'all' || type === 'movie') await searchKind('movie');
    if (type === 'all' || type === 'tv') await searchKind('tv');
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    sendJson(res, 200, { success: true, data: results });
  } catch (err) {
    sendJson(res, 502, { success: false, detail: err.message || 'TMDb unreachable' });
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://x');
  const urlPath = decodeURIComponent(reqUrl.pathname);

  if (urlPath === '/api/tmdb/search') {
    handleTmdbSearch(req, res, reqUrl);
    return;
  }

  if (urlPath === '/ice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(iceConfig()));
    return;
  }

  if (urlPath.startsWith('/torbox/')) {
    handleTorbox(req, res, urlPath);
    return;
  }

  // Room links (/r/<id>) and the landing page both serve the SPA shell.
  let filePath;
  if (urlPath === '/' || urlPath.startsWith('/r/')) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else {
    filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- Connection log (Phase 5) ------------------------------------------------
// One JSON line per event, appended to logs/connections.log.

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOG_DIR, 'connections.log'), { flags: 'a' });

let socketSeq = 0;
function logConn(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  logStream.write(line + '\n');
  console.log(line);
}

// roomId -> Set<WebSocket> (max 2)
const rooms = new Map();

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function peerOf(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return null;
  for (const other of room) {
    if (other !== ws) return other;
  }
  return null;
}

// The server is the single source of truth for room occupancy. Every
// membership or baton change re-broadcasts the authoritative state to every
// member; clients rebuild their UI from this instead of cached peer state.
// youAre doubles as the perfect-negotiation role assignment (first=impolite,
// second=polite) so roles stay consistent across reconnects.
function broadcastRoomState(room) {
  const members = [...room]; // Set preserves insertion order
  members.forEach((sock, i) => {
    send(sock, {
      type: 'room-state',
      count: members.length,
      youAre: i === 0 ? 'first' : 'second',
      peerPresent: members.length === 2,
      shareHolder: room.sharer ? (room.sharer === sock ? 'you' : 'peer') : null,
    });
  });
}

// --- Heartbeat (Phase 5, root-cause fix) --------------------------------------
// Cloudflare Tunnel (and some NATs) close idle WebSockets; protocol-level pings
// every HEARTBEAT_MS keep them warm. A socket that misses two pongs in a row is
// dead — terminate it so its peer gets a prompt peer-left instead of a zombie.

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 25_000;

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws.missedPongs ?? 0) >= 2) {
      logConn('heartbeat-terminate', { socket: ws.socketId, room: ws.roomId ?? null });
      ws.terminate(); // fires 'close' → normal peer-left cleanup
      continue;
    }
    ws.missedPongs = (ws.missedPongs ?? 0) + 1;
    try {
      ws.ping();
    } catch {
      // socket already going away; the close handler cleans up
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws, req) => {
  ws.socketId = ++socketSeq;
  ws.connectedAt = Date.now();
  ws.missedPongs = 0;
  ws.on('pong', () => {
    ws.missedPongs = 0;
  });
  logConn('connect', { socket: ws.socketId, ip: req.socket.remoteAddress });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      if (ws.roomId) return; // already joined
      const roomId = String(msg.room || '');
      if (!/^[\w-]{4,64}$/.test(roomId)) {
        send(ws, { type: 'error', reason: 'invalid-room' });
        return;
      }
      let room = rooms.get(roomId);
      if (!room) {
        room = new Set();
        rooms.set(roomId, room);
      }
      if (room.size >= 2) {
        send(ws, { type: 'room-full' });
        ws.close();
        return;
      }
      room.add(ws);
      ws.roomId = roomId;
      logConn('join', { socket: ws.socketId, room: roomId, peers: room.size });
      broadcastRoomState(room); // both members re-sync from the authoritative state
      return;
    }

    // Share baton: only one active sharer per room. First claim received wins
    // (deterministic on simultaneous clicks); the loser is told it's taken.
    if (msg.type === 'share-claim') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      if (!room.sharer || room.sharer === ws || room.sharer.readyState !== room.sharer.OPEN) {
        room.sharer = ws;
        send(ws, { type: 'share-granted' }); // direct reply: capture may start
        broadcastRoomState(room); // both sides learn the new shareHolder
      } else {
        send(ws, { type: 'share-denied' });
      }
      return;
    }
    if (msg.type === 'share-release') {
      const room = rooms.get(ws.roomId);
      if (room && room.sharer === ws) {
        room.sharer = null;
        broadcastRoomState(room);
      }
      return;
    }

    // Everything else is relayed verbatim to the other peer in the room.
    if (!ws.roomId) return;
    const peer = peerOf(ws);
    if (peer) send(peer, msg);
  });

  ws.on('close', (code, reason) => {
    logConn('close', {
      socket: ws.socketId,
      room: ws.roomId ?? null,
      code,
      reason: reason?.toString() || null,
      lifetimeMs: Date.now() - ws.connectedAt,
    });
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws); // immediate cleanup — no ghost members
    if (room.sharer === ws) {
      room.sharer = null; // the baton dies with the sharer's socket
    }
    if (room.size === 0) {
      rooms.delete(ws.roomId);
    } else {
      broadcastRoomState(room); // the survivor sees count drop to 1
    }
  });
});

server.listen(PORT, () => {
  const { iceServers, forceRelay } = iceConfig();
  const turnConfigured = iceServers.length > 1;
  console.log(`CoWatch listening on http://localhost:${PORT}`);
  console.log(`TURN: ${turnConfigured ? 'configured' : 'not configured (STUN-only)'}`);
  if (forceRelay) {
    console.log(
      turnConfigured
        ? 'FORCE_RELAY is ON — all media will go through TURN (testing mode).'
        : 'WARNING: FORCE_RELAY is ON but no TURN is configured — connections WILL fail.'
    );
  }
});
