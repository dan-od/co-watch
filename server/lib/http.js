// Small shared HTTP helpers for the route modules.

// Read and JSON-parse a request body, rejecting anything over 64 KB.
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

module.exports = { readJsonBody, sendJson };
