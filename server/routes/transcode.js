// On-the-fly audio repair for streams a browser can't hear.
//
// Debrid releases are overwhelmingly Dolby (AC-3/E-AC-3) or DTS, which Chrome
// and Firefox never shipped decoders for, and they're usually in a .mkv, which
// Safari can't open at all. Both problems die here in one pass:
//
//   -c:v copy      keep the video bitstream untouched (cheap — no re-encode)
//   -c:a aac       decode Dolby/DTS/TrueHD, re-encode to AAC (plays everywhere)
//   -f mp4 (frag)  remux out of Matroska so Safari can open it too
//
// Because the video is copied, this costs a few percent of a core rather than a
// whole one. It DOES cost bandwidth twice (we pull from the debrid host and
// push to the viewer), which is why the client only uses it on demand.
//
//   GET /api/transcode?url=<stream>&t=<seconds>   → fragmented MP4 stream
//   GET /api/transcode/probe?url=<stream>         → { duration, audio, video }
//
// Every URL passes the same SSRF guard as the Stremio proxy, so this can't be
// turned into a port scanner.

const { spawn, execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { sendJson } = require('../lib/http');
const { assertPublicUrl } = require('../lib/ssrf');

// Transcodes are long-lived and CPU/bandwidth-bound — don't let a room start
// an unbounded number of them.
const MAX_CONCURRENT = 3;
let active = 0;

const UA = 'Mozilla/5.0 CoWatch';

// Read just the container header to learn duration + stream layout.
function probe(url) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-user_agent', UA, '-i', url, '-t', '0.1', '-f', 'null', '-'],
      { timeout: 20000, maxBuffer: 1 << 22 },
      (err, _stdout, stderr) => {
        // ffmpeg always reports the metadata we want on stderr, and exits
        // non-zero for `-f null` on some builds — parse regardless.
        const text = String(stderr || '');
        const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const audio = text.match(/Stream #\d+:\d+.*: Audio: ([a-z0-9_]+)/i);
        const video = text.match(/Stream #\d+:\d+.*: Video: ([a-z0-9_]+)/i);
        resolve({
          duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
          audio: audio ? audio[1] : '',
          video: video ? video[1] : '',
          ok: !!dur,
        });
      }
    );
  });
}

async function handleTranscode(req, res, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, detail: 'GET only' });
    return;
  }
  const target = url.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { success: false, detail: 'missing url parameter' });
    return;
  }
  let safe;
  try {
    safe = (await assertPublicUrl(target)).href; // same guard as the add-on proxy
  } catch (err) {
    sendJson(res, 400, { success: false, detail: err.message || 'blocked URL' });
    return;
  }

  if (url.pathname.endsWith('/probe')) {
    sendJson(res, 200, { success: true, ...(await probe(safe)) });
    return;
  }

  if (active >= MAX_CONCURRENT) {
    sendJson(res, 503, { success: false, detail: 'too many transcodes running — try again shortly' });
    return;
  }

  const start = Math.max(0, Number(url.searchParams.get('t')) || 0);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', UA,
    '-reconnect', '1', // debrid hosts drop idle connections
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];
  if (start > 0) args.push('-ss', String(start)); // fast seek, before -i
  args.push(
    '-i', safe,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy', // never re-encode video — that's what keeps this cheap
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2', // downmix surround so laptop speakers get the centre channel
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  );

  active++;
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    active--;
    try {
      ff.kill('SIGKILL'); // don't leave ffmpeg pulling gigabytes after a hang-up
    } catch {}
  };

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  ff.stdout.pipe(res);

  let errTail = '';
  ff.stderr.on('data', (d) => {
    errTail = (errTail + d.toString()).slice(-500);
  });
  ff.on('error', (err) => {
    console.warn('[transcode] spawn failed:', err.message);
    cleanup();
    res.end();
  });
  ff.on('close', (code) => {
    if (code && code !== 255 && errTail.trim()) {
      console.warn(`[transcode] ffmpeg exited ${code}: ${errTail.trim().slice(0, 200)}`);
    }
    cleanup();
    res.end();
  });
  // Viewer closed the tab / seeked / switched stream.
  res.on('close', cleanup);
  req.on('aborted', cleanup);
}

module.exports = { handleTranscode };
