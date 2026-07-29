// Segmented audio repair. Supersedes the single-pipe /api/transcode for
// playback; that route stays for probing and as a fallback.
//
// The pipe version converted straight to one viewer's <video>, which welded
// three problems together:
//   - a second viewer meant a second connection to the source, and these hosts
//     allow exactly one;
//   - Safari will not play a progressive MP4 without byte ranges, and a live
//     pipe has none;
//   - seeking past the buffer had to restart ffmpeg, reopening the source —
//     which is how scrubbing killed a link mid-film.
//
// Writing HLS to disk collapses all three. ffmpeg converts ONCE into numbered
// segments plus a playlist; every viewer reads those files; seeking reads a
// segment that already exists and never touches the source again.
//
//   GET /api/hls/start?url=&a=&via=   → { id, playlist, duration, tracks }
//   GET /api/hls/<id>/index.m3u8      → playlist (grows as ffmpeg advances)
//   GET /api/hls/<id>/<file>.ts       → one segment
//   DELETE /api/hls/<id>              → give up the session early
//
// Video is copied, never re-encoded — only the audio is decoded to AAC, which
// is the entire point and also what keeps this cheap.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const ffmpegPath = require('ffmpeg-static');
const { sendJson } = require('../lib/http');
const { assertPublicUrl } = require('../lib/ssrf');
const {
  UA,
  headerBlock,
  reach,
  startRelay,
  claim,
  releaseClaim,
  LinkBusy,
  statusText,
  probe,
  preferredTrack,
} = require('./transcode');

const ROOT = path.join(os.tmpdir(), 'cowatch-hls');
const SEGMENT_SECONDS = 6;
// A session with nobody reading it is dead weight: it holds a source
// connection and fills the disk. Reaped once every viewer has stopped asking.
const IDLE_MS = 90_000;
const MAX_SESSIONS = 3;

const sessions = new Map(); // id -> session

const keyFor = (href, track, viaProxy) =>
  createHash('sha1').update(`${href}|${track}|${viaProxy ? 'p' : 'd'}`).digest('hex').slice(0, 16);

function findByKey(key) {
  for (const s of sessions.values()) if (s.key === key) return s;
  return null;
}

async function destroySession(s, why) {
  if (!s || s.dead) return;
  s.dead = true;
  sessions.delete(s.id);
  clearInterval(s.reaper);
  try {
    s.ff?.kill('SIGKILL');
  } catch {}
  try {
    s.relay?.close();
  } catch {}
  releaseClaim(s.href, s.claimEntry);
  s.exitedResolve?.();
  try {
    await fsp.rm(s.dir, { recursive: true, force: true });
  } catch {}
  console.log(`[hls] session ${s.id} gone (${why})`);
}

// ---- starting a session ------------------------------------------------------

async function start(res, target, wantedTrack, viaProxyHint) {
  let safe;
  try {
    safe = await assertPublicUrl(target);
  } catch (err) {
    sendJson(res, 400, { success: false, detail: err.message || 'blocked URL' });
    return;
  }

  // Probe first: it tells us the duration, the real track list, and whether
  // this host needs the relay. It also fails loudly, which is the whole reason
  // it runs before we commit to anything.
  const info = await probe(safe);
  if (!info.ok) {
    sendJson(res, 502, { success: false, detail: info.detail || 'could not open this source', status: info.status });
    return;
  }

  const track =
    Number.isInteger(wantedTrack) && wantedTrack >= 0
      ? wantedTrack
      : (preferredTrack(info.tracks)?.index ?? -1);
  const viaProxy = info.via === 'proxy' || viaProxyHint;
  const key = keyFor(safe.href, track, viaProxy);

  // THE point of this route: a second viewer of the same thing joins the
  // existing conversion instead of opening the source again.
  const existing = findByKey(key);
  if (existing && !existing.dead) {
    existing.lastRead = Date.now();
    console.log(`[hls] session ${existing.id} joined by another viewer`);
    sendJson(res, 200, {
      success: true,
      id: existing.id,
      playlist: `/api/hls/${existing.id}/index.m3u8`,
      duration: existing.duration,
      tracks: existing.tracks,
      audioIndex: existing.track,
      shared: true,
    });
    return;
  }

  if (sessions.size >= MAX_SESSIONS) {
    // Drop the least recently read rather than refusing outright.
    const oldest = [...sessions.values()].sort((a, b) => a.lastRead - b.lastRead)[0];
    await destroySession(oldest, 'evicted for a new session');
  }

  const id = randomUUID();
  const dir = path.join(ROOT, id);
  await fsp.mkdir(dir, { recursive: true });

  const session = {
    id,
    key,
    href: safe.href,
    dir,
    track,
    duration: info.duration,
    tracks: info.tracks,
    lastRead: Date.now(),
    dead: false,
    ff: null,
    relay: null,
    err: '',
  };

  // One connection per link, same as the pipe route.
  session.claimEntry = {
    key: `hls|${key}`,
    kill: () => {
      try {
        session.ff?.kill('SIGKILL');
      } catch {}
    },
    exited: new Promise((r) => (session.exitedResolve = r)),
  };
  try {
    await claim(safe.href, session.claimEntry);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    if (err instanceof LinkBusy) {
      sendJson(res, 409, { success: false, detail: 'that link is already busy — try again in a moment' });
      return;
    }
    sendJson(res, 500, { success: false, detail: err.message || 'could not start' });
    return;
  }

  if (viaProxy) {
    const r = await reach(safe, { range: 'bytes=0-1' });
    if (!r.ok) {
      releaseClaim(safe.href, session.claimEntry);
      session.exitedResolve?.();
      await fsp.rm(dir, { recursive: true, force: true });
      sendJson(res, 502, { success: false, detail: statusText(r.status) || 'could not fetch the source' });
      return;
    }
    session.relay = await startRelay(safe);
  }

  const input = session.relay ? session.relay.url : safe.href;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (!session.relay) {
    args.push('-user_agent', UA, '-headers', headerBlock(safe), '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push(
    '-i', input,
    '-map', '0:v:0',
    '-map', track >= 0 ? `0:${track}` : '0:a:0?',
    '-c:v', 'copy', // the expensive thing we are deliberately not doing
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2', // downmix so laptop speakers get the centre channel
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    // Append-only: the playlist grows as ffmpeg advances and nothing is ever
    // dropped, so anything already converted stays seekable.
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8')
  );

  session.ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.ff.stderr.on('data', (d) => {
    if (session.err.length < 8192) session.err += d;
  });
  session.ff.on('close', (code) => {
    session.exitedResolve?.();
    releaseClaim(session.href, session.claimEntry);
    session.finished = true;
    if (code && code !== 255 && session.err.trim()) {
      console.warn(`[hls] ${id} ffmpeg exited ${code}:\n${session.err.trim().slice(-600)}`);
    } else {
      console.log(`[hls] ${id} conversion complete`);
    }
  });
  session.ff.on('error', (err) => {
    session.exitedResolve?.();
    console.warn('[hls] spawn failed:', err.message);
  });

  session.reaper = setInterval(() => {
    if (Date.now() - session.lastRead > IDLE_MS) destroySession(session, 'idle');
  }, 15_000);
  session.reaper.unref?.();

  sessions.set(id, session);
  console.log(`[hls] session ${id} started (${session.relay ? 'relay' : 'direct'}, track ${track}, ${Math.round(info.duration)}s)`);

  // Wait for the first segment before answering, so the client never points a
  // player at a playlist that has no media in it yet.
  const ready = await waitForFirstSegment(session);
  if (!ready) {
    const detail = firstUsefulLine(session.err) || 'the converter produced no segments';
    await destroySession(session, 'no first segment');
    sendJson(res, 502, { success: false, detail });
    return;
  }

  sendJson(res, 200, {
    success: true,
    id,
    playlist: `/api/hls/${id}/index.m3u8`,
    duration: session.duration,
    tracks: session.tracks,
    audioIndex: track,
    shared: false,
  });
}

const firstUsefulLine = (s) =>
  String(s || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]\s*/, '').trim())
    .find((l) => l && !/^frame=|^video:/.test(l)) || '';

function waitForFirstSegment(session, timeoutMs = 45_000) {
  const playlist = path.join(session.dir, 'index.m3u8');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(async () => {
      if (session.dead) {
        clearInterval(tick);
        return resolve(false);
      }
      try {
        const text = await fsp.readFile(playlist, 'utf8');
        if (/\.ts\s*$/m.test(text)) {
          clearInterval(tick);
          return resolve(true);
        }
      } catch {
        // not written yet
      }
      // ffmpeg died without producing anything, or took too long.
      if (session.finished || Date.now() - t0 > timeoutMs) {
        clearInterval(tick);
        return resolve(false);
      }
    }, 250);
  });
}

// ---- serving the playlist and segments ---------------------------------------

async function serve(res, id, file) {
  const session = sessions.get(id);
  if (!session || session.dead) {
    sendJson(res, 404, { success: false, detail: 'that playback session has ended — start it again' });
    return;
  }
  // Only ever the files we generated, by exact name.
  if (!/^(index\.m3u8|seg\d{5}\.ts)$/.test(file)) {
    sendJson(res, 400, { success: false, detail: 'no such file' });
    return;
  }
  session.lastRead = Date.now();

  const full = path.join(session.dir, file);
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    sendJson(res, 404, { success: false, detail: 'not written yet' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'Content-Length': stat.size,
    // The playlist changes while converting; segments never do.
    'Cache-Control': file.endsWith('.m3u8') ? 'no-store' : 'public, max-age=31536000',
    'Access-Control-Allow-Origin': '*',
  });
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.end());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---- routing -----------------------------------------------------------------

async function handleHls(req, res, url) {
  const rest = url.pathname.replace(/^\/api\/hls\/?/, '');

  if (rest === 'start') {
    if (req.method !== 'GET') return sendJson(res, 405, { success: false, detail: 'GET only' });
    const target = url.searchParams.get('url');
    if (!target) return sendJson(res, 400, { success: false, detail: 'missing url parameter' });
    const raw = url.searchParams.get('a');
    const wanted = raw === null || raw === '' ? -1 : Number(raw);
    return start(res, target, wanted, url.searchParams.get('via') === 'proxy');
  }

  const m = /^([0-9a-f-]{36})(?:\/(.+))?$/i.exec(rest);
  if (!m) return sendJson(res, 404, { success: false, detail: 'no such session' });
  const [, id, file] = m;

  if (req.method === 'DELETE') {
    await destroySession(sessions.get(id), 'client finished');
    return sendJson(res, 200, { success: true });
  }
  if (!file) return sendJson(res, 400, { success: false, detail: 'no file given' });
  return serve(res, id, file);
}

// Leftover directories from a crash or a hard restart.
async function cleanupOnBoot() {
  try {
    await fsp.rm(ROOT, { recursive: true, force: true });
  } catch {}
}

function shutdown() {
  for (const s of [...sessions.values()]) destroySession(s, 'server shutting down');
}

module.exports = { handleHls, cleanupOnBoot, shutdown };
