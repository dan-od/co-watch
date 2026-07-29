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
//   GET /api/transcode/probe?url=<stream>          → { duration, tracks, via }
//   GET /api/transcode?url=<stream>&t=&a=&via=     → fragmented MP4 stream
//
// Every URL passes the same SSRF guard as the Stremio proxy, so this can't be
// turned into a port scanner.
//
// TWO WAYS IN. Normally ffmpeg opens the URL itself, which is what makes
// seeking cheap (-ss before -i jumps straight there with a Range request).
// Some hosts refuse ffmpeg's HTTP client outright while serving the identical
// URL to a browser, so there is a fallback: Node fetches it and pipes the body
// into ffmpeg's stdin. That path can't seek — stdin isn't seekable, and a
// Matroska file can't be entered part-way because its header is at the front —
// so it's only used when the direct route fails.

const http = require('http');
const { spawn } = require('child_process');
const { Readable } = require('stream');
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
function headerPairs(u) {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${u.origin}/`,
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}
const headerBlock = (u) =>
  Object.entries(headerPairs(u))
    .filter(([k]) => k !== 'User-Agent') // ffmpeg takes that one separately
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n') + '\r\n';

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
  return { status, text: statusText(status) || lines.find(isUseful) || lines[lines.length - 1] || '' };
}
const isUseful = (l) => /Error opening input|Invalid data found|Protocol not found|Connection|timed out/i.test(l);

function statusText(status) {
  if (status === 403 || status === 401) {
    return `the host refused the server’s request (HTTP ${status}) even though your browser can reach the same link — it is either tied to your device or blocking non-browser clients`;
  }
  if (status === 404 || status === 410) {
    return `the host answered HTTP ${status} for the server (your browser can still open this link) — it is refusing anything that isn’t the device that asked for it`;
  }
  if (status) return `the host answered HTTP ${status}`;
  return '';
}

// ---- track parsing -----------------------------------------------------------
// ffmpeg prints one line per stream on stderr, e.g.
//   Stream #0:1[0x2](hin): Audio: eac3, 48000 Hz, 5.1(side), fltp, 768 kb/s
// The index is absolute (usable directly as `-map 0:N`); the parenthesised tag
// is the ISO-639 language, which is the whole point — picking track 0 blindly
// is how an "English, Hindi" release ends up playing Hindi.
const LANG_NAMES = {
  eng: 'English', hin: 'Hindi', spa: 'Spanish', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', ita: 'Italian', jpn: 'Japanese', kor: 'Korean',
  chi: 'Chinese', zho: 'Chinese', rus: 'Russian', por: 'Portuguese', ara: 'Arabic',
  tur: 'Turkish', pol: 'Polish', dut: 'Dutch', nld: 'Dutch', tam: 'Tamil',
  tel: 'Telugu', ukr: 'Ukrainian', swe: 'Swedish', dan: 'Danish', nor: 'Norwegian',
  fin: 'Finnish', ces: 'Czech', cze: 'Czech', hun: 'Hungarian', tha: 'Thai',
  vie: 'Vietnamese', ind: 'Indonesian', heb: 'Hebrew', ell: 'Greek', gre: 'Greek',
};
const langName = (code) => {
  const c = String(code || '').toLowerCase();
  if (!c || c === 'und' || c === 'unk') return ''; // "undetermined" — say nothing rather than "UND"
  return LANG_NAMES[c] || c.toUpperCase();
};

function parseAudioTracks(text) {
  const out = [];
  // Only the INPUT section. ffmpeg lists the streams it is writing too, under
  // "Output #0", in the same format — counting those invented a duplicate
  // track (with the output's codec) that pointed at the wrong index.
  const input = String(text).split(/^Output #/m)[0];
  const re = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([a-z]{2,3})\))?: Audio: ([a-z0-9_]+)([^\n]*)/gi;
  let m;
  while ((m = re.exec(input))) {
    const [, index, lang, codec, rest] = m;
    const ch = rest.match(/,\s*(mono|stereo|5\.1(?:\([^)]*\))?|7\.1(?:\([^)]*\))?|\d+ channels)/i);
    out.push({
      index: Number(index),
      lang: (lang || '').toLowerCase(),
      label: langName(lang),
      codec: codec.toLowerCase(),
      channels: ch ? ch[1].replace(/\([^)]*\)/, '') : '',
      default: /\(default\)/.test(rest),
    });
  }
  return out;
}

// Which track should play if nobody chose? English wins, then the file's own
// default, then the first one.
function preferredTrack(tracks) {
  if (!tracks.length) return null;
  return (
    tracks.find((t) => t.lang === 'eng') || tracks.find((t) => t.default) || tracks[0]
  );
}

// ---- fetching ----------------------------------------------------------------
// Node's HTTP client as a second opinion. Undici sends an ordinary request and
// follows redirects the way a browser does, so a host that singles out ffmpeg
// will usually answer this normally.
async function reach(u, { range } = {}) {
  const headers = headerPairs(u);
  if (range) headers.Range = range;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(u.href, { headers, redirect: 'follow', signal: ctrl.signal });
    r.body?.cancel().catch(() => {}); // only the status mattered
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: err.message || String(err) };
  }
}

// A loopback stand-in for the remote file, fetched by Node instead of by
// ffmpeg. Feeding ffmpeg's stdin was the obvious alternative and it does not
// work: a pipe can't be seeked, so an MP4 whose index sits at the end of the
// file fails outright ("partial file"). Serving it over HTTP keeps the input
// seekable, so -ss and MP4 both behave exactly as on the direct path.
//
// Not an open proxy: it binds to 127.0.0.1 on an ephemeral port, lives only as
// long as this one transcode, and forwards to exactly one already-validated
// URL regardless of what is requested of it.
function startRelay(u) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (rq, rs) => {
      const headers = headerPairs(u);
      if (rq.headers.range) headers.Range = rq.headers.range;
      try {
        const r = await fetch(u.href, { headers, redirect: 'follow' });
        const pass = {};
        for (const h of ['content-length', 'content-range', 'content-type', 'accept-ranges']) {
          const v = r.headers.get(h);
          if (v) pass[h] = v;
        }
        rs.writeHead(r.status, pass);
        if (rq.method === 'HEAD' || !r.body) {
          r.body?.cancel().catch(() => {});
          rs.end();
          return;
        }
        Readable.fromWeb(r.body).pipe(rs);
      } catch (err) {
        if (!rs.headersSent) rs.writeHead(502);
        rs.end();
      }
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close(() => {}) });
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    ff.on('error', (e) => resolve(`Error opening input: ${e.message}`));
    ff.on('close', () => resolve(err));
  });
}

const PROBE_TAIL = ['-t', '0.1', '-f', 'null', '-'];

// Read enough of the container to learn duration and the audio layout.
async function probe(u) {
  // Fast path: let ffmpeg open the URL.
  let text = await runFfmpeg([
    '-hide_banner', '-user_agent', UA, '-headers', headerBlock(u), '-i', u.href, ...PROBE_TAIL,
  ]);
  let via = 'direct';

  if (!/Duration:/.test(text)) {
    // Direct open failed. Ask Node — if IT can fetch the file, the host is
    // refusing ffmpeg specifically, and going through the relay will work.
    const first = reasonFrom(text);
    const r = await reach(u, { range: 'bytes=0-1' });
    if (!r.ok) {
      console.warn(
        `[transcode] probe failed for ${u.host} — ffmpeg: HTTP ${first.status || '—'}, node fetch: ${r.status || r.error}`
      );
      return { ok: false, status: first.status || r.status, detail: statusText(r.status) || first.text, via: 'none', tracks: [] };
    }
    const relay = await startRelay(u);
    try {
      text = await runFfmpeg(['-hide_banner', '-i', relay.url, ...PROBE_TAIL]);
    } finally {
      relay.close();
    }
    if (/Duration:|Audio:/.test(text)) {
      via = 'proxy';
      console.log(
        `[transcode] ${u.host} refused ffmpeg directly (HTTP ${first.status || '—'}) but Node fetched it — routing through the relay`
      );
    }
  }

  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = text.match(/Stream #\d+:\d+.*: Video: ([a-z0-9_]+)/i);
  const tracks = parseAudioTracks(text);
  const ok = !!dur || tracks.length > 0;
  if (!ok) console.warn(`[transcode] probe produced nothing for ${u.host}:\n${text.trim().slice(-800)}`);
  const chosen = preferredTrack(tracks);
  return {
    ok,
    via,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    video: video ? video[1] : '',
    audio: chosen ? chosen.codec : '',
    tracks,
    audioIndex: chosen ? chosen.index : -1,
    detail: ok ? '' : reasonFrom(text).text,
  };
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
    const result = await probe(safe);
    sendJson(res, 200, { success: true, ...result });
    return;
  }

  if (active >= MAX_CONCURRENT) {
    sendJson(res, 503, { success: false, detail: 'too many transcodes running — try again shortly' });
    return;
  }

  const start = Math.max(0, Number(url.searchParams.get('t')) || 0);
  // Number(null) is 0, not NaN — reading the missing param naively made this
  // "-map 0:0", i.e. the video stream a second time, and no audio at all.
  const rawTrack = url.searchParams.get('a');
  const track = rawTrack === null || rawTrack === '' ? -1 : Number(rawTrack);
  const viaProxy = url.searchParams.get('via') === 'proxy';

  // Check the source is reachable before committing to anything, so a refusal
  // is still reportable as a status code rather than an empty video.
  let relay = null;
  if (viaProxy) {
    const r = await reach(safe, { range: 'bytes=0-1' });
    if (!r.ok) {
      sendJson(res, 502, {
        success: false,
        detail: statusText(r.status) || `could not fetch the source (${r.error || 'no body'})`,
      });
      return;
    }
    relay = await startRelay(safe);
  }

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (!viaProxy) {
    args.push(
      '-user_agent', UA,
      '-headers', headerBlock(safe),
      '-reconnect', '1', // debrid hosts drop idle connections
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }
  // Seeking works on both paths — the relay serves Range requests too.
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', relay ? relay.url : safe.href);
  args.push(
    '-map', '0:v:0',
    // An explicit track when the viewer picked one, otherwise ffmpeg's first —
    // the client normally passes the English track it found during probe.
    '-map', Number.isInteger(track) && track >= 0 ? `0:${track}` : '0:a:0?',
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
      relay?.close(); // stop pulling from the source too
      ff.kill('SIGKILL'); // don't leave ffmpeg pulling gigabytes after a hang-up
    } catch {}
  };

  // A host that accepts the connection then never sends anything would
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
      console.warn(`[transcode] ffmpeg exited ${code} for ${safe.host} (via ${viaProxy ? 'proxy' : 'direct'}):\n${errTail.trim().slice(-800)}`);
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
