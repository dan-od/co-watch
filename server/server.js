// CoWatch entry point.
// Starts the HTTP server (static client + API routes) and the WebSocket
// signaling server (room matching + message relay). The signaling server is
// the single source of truth for room occupancy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');

// Load .env (simple KEY=VALUE lines) without a dependency. Real env vars win.
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2];
    }
  }
} catch {
  // no .env — fine, run STUN-only
}

const { iceConfig, handleIceConfig } = require('./routes/ice-config');
const { handleTmdbSearch } = require('./routes/tmdb');
const { handleTorbox } = require('./routes/torbox');
const { serveStatic } = require('./routes/static');

const PORT = process.env.PORT || 8080;

// --- HTTP routing ------------------------------------------------------------

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://x');
  const urlPath = decodeURIComponent(reqUrl.pathname);

  if (urlPath === '/api/tmdb/search') return handleTmdbSearch(req, res, reqUrl);
  if (urlPath === '/ice-config') return handleIceConfig(req, res);
  if (urlPath.startsWith('/torbox/')) return handleTorbox(req, res, urlPath);
  return serveStatic(req, res, urlPath);
});

// --- Connection log (Phase 5) ------------------------------------------------
// One JSON line per event, appended to logs/connections.log.

const LOG_DIR = path.join(ROOT, 'logs');
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
