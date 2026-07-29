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

// A plain browser UA. Not cosmetic: CDNs reject unfamiliar agents — a made-up
// one got a flat 403 from Google's storage host during testing, which reached
// the viewer as an empty video and no explanation.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Browser-shaped request headers. The bare defaults (ffmpeg sends an odd
// Icy-MetaData header and nothing else) are easy for a CDN's bot filter to
// spot, and some hosts answer them with 403 while serving the identical URL to
// Chrome. This doesn't beat TLS-fingerprint filtering, but it clears the simple
// header checks. Referer is set per-request to the URL's own origin.
function httpHeaders(u) {
  return [
    'Accept: */*',
    'Accept-Language: en-US,en;q=0.9',
    `Referer: ${u.origin}/`,
    'Sec-Fetch-Dest: video',
    'Sec-Fetch-Mode: no-cors',
    'Sec-Fetch-Site: cross-site',
    '',
  ].join('\r\n');
}

// Turn ffmpeg's stderr into something worth showing a human. Returns the HTTP
// status when there was one, so the caller can say what actually happened
// rather than guess at a cause.
function reasonFrom(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean);
  const http = lines.find((l) => /HTTP error|Server returned/i.test(l));
  const status = Number(http?.match(/\b(\d{3})\b/)?.[1]) || 0;
  if (status === 403 || status === 401) {
    return {
      status,
      text: `the host refused the server’s request (HTTP ${status}) even though your browser can reach the same link — it is either tied to your device or blocking non-browser clients. Try a different release`,
    };
  }
  if (status === 404 || status === 410) {
    return {
      status,
      text: `the link is gone (HTTP ${status}) — these expire, so close and reopen the stream list to get a fresh one`,
    };
  }
  if (status) return { status, text: `the host answered HTTP ${status}` };
  const open = lines.find((l) => /Error opening input|Invalid data found|Protocol not found|Connection|timed out/i.test(l));
  return { status: 0, text: open || lines[lines.length - 1] || '' };
}

// Read just the container header to learn duration + stream layout.
function probe(u) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-user_agent', UA, '-headers', httpHeaders(u), '-i', u.href, '-t', '0.1', '-f', 'null', '-'],
      { timeout: 20000, maxBuffer: 1 << 22 },
      (err, _stdout, stderr) => {
        // ffmpeg always reports the metadata we want on stderr, and exits
        // non-zero for `-f null` on some builds — parse regardless.
        const text = String(stderr || '');
        const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const audio = text.match(/Stream #\d+:\d+.*: Audio: ([a-z0-9_]+)/i);
        const video = text.match(/Stream #\d+:\d+.*: Video: ([a-z0-9_]+)/i);
        const ok = !!dur;
        const why = ok ? { status: 0, text: '' } : reasonFrom(text);
        if (!ok) {
          // Full stderr to the log — the one-liner the viewer sees is
          // deliberately short, but diagnosing a picky host needs the rest.
          console.warn(`[transcode] probe failed for ${u.host} (HTTP ${why.status || '—'}):\n${text.trim().slice(-800)}`);
        }
        resolve({
          duration: ok ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
          audio: audio ? audio[1] : '',
          video: video ? video[1] : '',
          ok,
          status: why.status,
          // Why it failed, so the client can say something true instead of
          // dropping the viewer into a black screen.
          detail: why.text,
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
    safe = await assertPublicUrl(target); // same guard as the add-on proxy
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
    '-headers', httpHeaders(safe),
    '-reconnect', '1', // debrid hosts drop idle connections
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];
  if (start > 0) args.push('-ss', String(start)); // fast seek, before -i
  args.push(
    '-i', safe.href,
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
  let errTail = '';
  // The response status has to wait for ffmpeg's first byte. Committing
  // "200 video/mp4" up-front — as this used to — means a source that can't be
  // opened at all still looks like a valid empty video: the viewer gets a black
  // frame and no reason, which is indistinguishable from the button doing
  // nothing. Nothing out means a real error status instead.
  let headersSent = false;
  const sendHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    clearTimeout(stallTimer);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  };
  const fail = (status, detail) => {
    if (!headersSent) {
      headersSent = true;
      sendJson(res, status, { success: false, detail });
    } else {
      res.end();
    }
  };
  const cleanup = () => {
    if (done) return;
    done = true;
    active--;
    clearTimeout(stallTimer);
    try {
      ff.kill('SIGKILL'); // don't leave ffmpeg pulling gigabytes after a hang-up
    } catch {}
  };

  // A debrid host that accepts the connection then never sends anything would
  // otherwise hang the viewer forever on a spinner.
  const stallTimer = setTimeout(() => {
    if (headersSent) return;
    console.warn('[transcode] no output after 45s — giving up');
    cleanup();
    fail(504, 'the source accepted the connection but sent no data in 45s — try picking the stream again');
  }, 45000);

  // Manual pipe (rather than .pipe) so the first chunk is what commits the
  // status line; res.write's return value still drives backpressure.
  ff.stdout.on('data', (chunk) => {
    sendHeaders();
    if (!res.write(chunk)) ff.stdout.pause();
  });
  res.on('drain', () => ff.stdout.resume());

  ff.stderr.on('data', (d) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });
  ff.on('error', (err) => {
    console.warn('[transcode] spawn failed:', err.message);
    cleanup();
    fail(500, `could not start the converter: ${err.message}`);
  });
  ff.on('close', (code) => {
    const reason = reasonFrom(errTail);
    if (code && code !== 255 && errTail.trim()) {
      console.warn(`[transcode] ffmpeg exited ${code} for ${safe.host}:\n${errTail.trim().slice(-800)}`);
    }
    cleanup();
    if (!headersSent) fail(502, reason.text || 'the converter produced no output for this source');
    else res.end();
  });
  // Viewer closed the tab / seeked / switched stream.
  res.on('close', cleanup);
  req.on('aborted', cleanup);
}

module.exports = { handleTranscode };
