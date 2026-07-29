// Static file serving. Room links (/r/<id>) and the landing page both serve the
// SPA shell; everything else maps to a file under public/ (with a traversal
// guard).

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  // WebAssembly.instantiateStreaming REJECTS anything that isn't
  // application/wasm, so the vendored decoders need this to load at all.
  '.wasm': 'application/wasm',
};

// Revalidate every load: the client is many ES modules + CSS that must come
// from the SAME deploy — a cached old style.css alongside new JS breaks layout
// (e.g. cameras covering the stage during a share).
const NO_CACHE = 'no-cache';

function serveStatic(req, res, urlPath) {
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

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const total = stat.size;

    // Byte ranges. Media loaders — the <video> element, and anything reading a
    // container header before the rest of the file — need to know the size and
    // to ask for parts of it. Serving everything as one chunked 200 with no
    // Content-Length made a local .mkv unopenable ("open stream failed").
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : total - Number(range[2]); // "-N" = last N bytes
      let end = range[1] && range[2] ? Number(range[2]) : total - 1;
      start = Math.max(0, start);
      end = Math.min(total - 1, end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': NO_CACHE,
      });
      if (req.method === 'HEAD') return res.end();
      const s = fs.createReadStream(filePath, { start, end });
      s.on('error', () => res.end());
      res.on('close', () => s.destroy());
      s.pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': NO_CACHE,
    });
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(filePath);
    s.on('error', () => res.end());
    res.on('close', () => s.destroy());
    s.pipe(res);
  });
}

module.exports = { serveStatic, PUBLIC_DIR };
