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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  if (urlPath === '/ice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(iceConfig()));
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

wss.on('connection', (ws) => {
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
      send(ws, { type: 'joined', peers: room.size });
      const peer = peerOf(ws);
      if (peer) send(peer, { type: 'peer-joined' });
      return;
    }

    // Everything else is relayed verbatim to the other peer in the room.
    if (!ws.roomId) return;
    const peer = peerOf(ws);
    if (peer) send(peer, msg);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(ws.roomId);
    }
    for (const other of room) {
      send(other, { type: 'peer-left' });
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
