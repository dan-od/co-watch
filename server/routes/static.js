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
};

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

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Revalidate every load: the client is many ES modules + CSS that must
      // come from the SAME deploy — a cached old style.css alongside new JS
      // breaks layout (e.g. cameras covering the stage during a share).
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

module.exports = { serveStatic, PUBLIC_DIR };
