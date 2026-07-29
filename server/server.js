// CoWatch entry point.
// Starts the HTTP server (static client + API routes) and the WebSocket
// signaling server (room matching + message relay). The signaling server is
// the single source of truth for room occupancy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');

// Load .env (simple KEY=VALUE lines) without a dependency. Real env vars win.
// COWATCH_ENV_FILE lets the desktop app keep its settings next to its data
// rather than inside a read-only application bundle.
for (const envPath of [process.env.COWATCH_ENV_FILE, path.join(ROOT, '.env')].filter(Boolean)) {
  try {
    const envText = fs.readFileSync(envPath, 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trimStart().startsWith('#') && !(m[1] in process.env)) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    // missing or unreadable — the next candidate, else STUN-only
  }
}

const { handleIceConfig, turnConfigured } = require('./routes/ice-config');
const { handleTranscode } = require('./routes/transcode');
const { handleHls, cleanupOnBoot: hlsCleanup, shutdown: hlsShutdown } = require('./routes/hls');
const { handleTmdbSearch } = require('./routes/tmdb');
const { handleTorrentSearch } = require('./routes/search');
const { handleStremio } = require('./routes/stremio');
const { handleTorbox } = require('./routes/torbox');
const { serveStatic } = require('./routes/static');

const PORT = process.env.PORT || 8080;

// --- HTTP routing ------------------------------------------------------------

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://x');
  const urlPath = decodeURIComponent(reqUrl.pathname);

  if (urlPath === '/api/tmdb/search') return handleTmdbSearch(req, res, reqUrl);
  if (urlPath === '/api/search/torrents') return handleTorrentSearch(req, res, reqUrl);
  if (urlPath.startsWith('/api/stremio/')) return handleStremio(req, res, reqUrl);
  if (urlPath.startsWith('/api/hls')) return handleHls(req, res, reqUrl);
  if (urlPath.startsWith('/api/transcode')) return handleTranscode(req, res, reqUrl);
  if (urlPath === '/ice-config') return handleIceConfig(req, res);
  if (urlPath.startsWith('/torbox/')) return handleTorbox(req, res, urlPath);
  return serveStatic(req, res, urlPath);
});

// --- Connection log (Phase 5) ------------------------------------------------
// One JSON line per event, appended to logs/connections.log.

// Overridable because a packaged app cannot write inside its own bundle — the
// desktop shell points this at the OS user-data directory.
const LOG_DIR = process.env.COWATCH_LOG_DIR || path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOG_DIR, 'connections.log'), { flags: 'a' });

let socketSeq = 0;
function logConn(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  logStream.write(line + '\n');
  console.log(line);
}

// roomId -> Set<WebSocket> (max MAX_ROOM)
const MAX_ROOM = 6; // full mesh; reject the 7th
const rooms = new Map();

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// The server is the single source of truth for room occupancy. Every
// membership or baton change re-broadcasts the authoritative state to every
// member; clients rebuild their UI from this instead of cached peer state.
// Members are stable peer ids (the client re-presents its id on reconnect),
// so perfect-negotiation roles derived from them survive reconnects — unlike
// join order, which can swap when both sides drop and rejoin.
function broadcastRoomState(room) {
  const list = [...room];
  for (const sock of room) {
    send(sock, {
      type: 'room-state',
      you: sock.peerId,
      count: list.length,
      members: list.map((s) => ({ peerId: s.peerId, name: s.name, isYou: s === sock })),
      shareHolder: room.sharer ? room.sharer.peerId : null,
    });
  }
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
      // Reconnect: a client presenting the id of an existing member IS that
      // member on a new socket (wifi blip, reload) — replace the lingering
      // old socket BEFORE the size check, or a quick rejoin reads as a full
      // room and the client gives up for good. (Ids only circulate via the
      // private room link — same trust model as the message relay.)
      const presented =
        typeof msg.peerId === 'string' && /^[\w-]{8,64}$/.test(msg.peerId) ? msg.peerId : null;
      const stale = presented ? [...room].find((s) => s.peerId === presented) : null;
      if (stale) {
        room.delete(stale);
        if (room.sharer === stale) room.sharer = null; // a still-capturing client re-claims on room-state
        stale.roomId = null; // its close handler must not re-touch the room
        stale.terminate();
        logConn('rejoin-replace', { socket: ws.socketId, replaced: stale.socketId, room: roomId });
      }
      if (room.size >= MAX_ROOM) {
        send(ws, { type: 'room-full' });
        ws.close();
        return;
      }
      ws.peerId = presented || randomUUID();
      ws.name =
        String(msg.name || '')
          .trim()
          .slice(0, 24) || `Guest-${ws.peerId.slice(0, 4)}`;
      room.add(ws);
      ws.roomId = roomId;
      logConn('join', { socket: ws.socketId, room: roomId, peer: ws.peerId, peers: room.size });
      broadcastRoomState(room); // everyone re-syncs from the authoritative state
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

    // Everything else is relayed with a server-stamped `from` (can't be
    // spoofed). A `to: peerId` addresses one member (offer/answer/ICE must be
    // per-peer on a mesh); no `to` broadcasts to every other member (chat,
    // reactions, sync, screen-share announcements, mic-state).
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const out = { ...msg, from: ws.peerId };
    delete out.to;
    for (const other of room) {
      if (other === ws) continue;
      if (msg.to && other.peerId !== msg.to) continue;
      send(other, out);
    }
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

// Segment directories outlive a hard kill — clear them before serving, and try
// to take them with us on the way out.
hlsCleanup();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    hlsShutdown();
    process.exit(0);
  });
}

// Started by `npm start` on a fixed port, or by the desktop app on an ephemeral
// one. In the app every viewer runs this locally, which is the point: stream
// resolution and audio repair then happen on the machine the debrid link was
// issued to, instead of on a server the host refuses to serve.
// host: unchanged for `npm start` (every interface, so a tunnel or another
// device on the LAN can reach it). The desktop app passes 127.0.0.1, because
// its server is for itself alone.
function start({ port = PORT, host = process.env.HOST } = {}) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const relayed = turnConfigured();
      const forceRelay = /^(1|true|yes)$/i.test(process.env.FORCE_RELAY || '');
      const via = (process.env.TURN_API_URL || '').trim()
        ? 'auto-refreshed from the provider API'
        : 'static credentials';
      console.log(`CoWatch listening on http://localhost:${actual}`);
      console.log(`TURN: ${relayed ? `configured (${via})` : 'not configured (STUN-only)'}`);
      if (forceRelay) {
        console.log(
          relayed
            ? 'FORCE_RELAY is ON — all media will go through TURN (testing mode).'
            : 'WARNING: FORCE_RELAY is ON but no TURN is configured — connections WILL fail.'
        );
      }
      resolve({ port: actual, server });
    });
  });
}

function stop() {
  hlsShutdown();
  try {
    server.close();
  } catch {}
}

// Run directly (`npm start`) → listen straight away. Required as a module (the
// desktop app) → the caller decides when and on which port.
if (require.main === module) start();

module.exports = { start, stop, app: server };
