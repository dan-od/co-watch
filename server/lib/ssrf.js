// SSRF guard for user-supplied URLs that the SERVER will fetch (the Stremio
// add-on proxy). Rejects non-http(s) schemes and any host that resolves to a
// private/loopback/link-local/reserved address, so the proxy can't be pointed
// at 127.0.0.1, 169.254.169.254 (cloud metadata), 10.x/192.168.x, etc.
//
// Residual risk (accepted for this personal app): a hostname could pass the
// check then a redirect or DNS rebind could land on a private IP. Callers use
// redirect:'manual' + re-validate to shrink that window.

const dns = require('dns').promises;
const net = require('net');

function v4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function v6Private(ip) {
  const lc = ip.toLowerCase().replace(/%.*$/, ''); // drop zone id
  if (lc === '::1' || lc === '::') return true; // loopback / unspecified
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lc)) return true; // fe80::/10 link-local
  const mapped = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return v4Private(mapped[1]);
  return false;
}

function ipIsPrivate(ip) {
  const type = net.isIP(ip);
  if (type === 4) return v4Private(ip);
  if (type === 6) return v6Private(ip);
  return true; // not an IP we understand → treat as unsafe
}

// Parse + validate. Returns the URL object, or throws with a safe reason.
async function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  const host = u.hostname;
  if (!host) throw new Error('missing host');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('local addresses are not allowed');

  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new Error('could not resolve host');
    }
  }
  if (!addrs.length || addrs.some(ipIsPrivate)) throw new Error('address not allowed');
  return u;
}

module.exports = { assertPublicUrl, ipIsPrivate };
