// Searches public torrent APIs (YTS for movies, EZTV for TV) and returns
// ready-to-resolve magnets. The magnets feed the existing TorBox flow, so
// callers get the same resolve/stream UX. 1337x has no public API (would need
// scraping/a proxy) so it stays stubbed.

const TORLINK_TIMEOUT_MS = Number(process.env.TORLINK_TIMEOUT_MS) || 10000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Trackers for building magnets from a bare btih hash (YTS gives a hash, EZTV
// usually gives a full magnet_url but sometimes only a hash).
const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://glotorrents.pw:6969/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
];

function toMagnet(hash, name) {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`;
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!n) return 'unknown';
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
}

// ---- YTS (movies) ----
async function searchYTS(query) {
  const url = `https://movies-api.accel.li/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`YTS HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.data?.movies) return []; // no matches → { data: { movie_count: 0 } }
  return data.data.movies.flatMap((m) =>
    (m.torrents || []).map((t) => ({
      name: `${m.title} (${m.year}) ${t.quality || ''}`.trim(),
      size: t.size || 'unknown',
      seeders: t.seeds || 0,
      peers: t.peers || 0,
      magnet: t.hash ? toMagnet(t.hash, `${m.title} (${m.year})`) : '',
      source: 'YTS',
      quality: t.quality || '',
      hash: (t.hash || '').toLowerCase(),
      type: 'movie',
    }))
  );
}

// ---- EZTV (TV) ----
// EZTV's API is imdb_id-based (its free-text `/api/search?q=` returns the HTML
// homepage, not JSON). So we resolve a title → imdb_id via TMDb (the same key
// the Search tab uses), or accept a directly-typed imdb id. Never throws — a TV
// miss must not sink the movie results.
const TMDB_API = 'https://api.themoviedb.org/3';

function parseImdbId(s) {
  const m = String(s).trim().match(/^(?:tt)?(\d{6,9})$/i);
  return m ? m[1] : null; // EZTV wants the numeric part, no "tt"
}

async function titleToImdbId(title, tmdbKey) {
  const sp = new URLSearchParams({ api_key: tmdbKey, query: title, include_adult: 'false' });
  const sR = await fetch(`${TMDB_API}/search/tv?${sp}`, { signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS) });
  const sj = await sR.json().catch(() => null);
  const id = sj?.results?.[0]?.id;
  if (!id) return null;
  const eR = await fetch(`${TMDB_API}/tv/${id}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`, {
    signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS),
  });
  const ej = await eR.json().catch(() => null);
  return ej?.imdb_id ? String(ej.imdb_id).replace(/^tt/i, '') : null; // 'tt0903747' → '0903747'
}

async function searchEZTV(query, tmdbKey) {
  try {
    let imdb = parseImdbId(query);
    if (!imdb && tmdbKey) imdb = await titleToImdbId(query, tmdbKey);
    if (!imdb) return []; // no imdb id → EZTV can't be queried by free text
    const url = `https://eztvx.to/api/get-torrents?imdb_id=${imdb}&limit=25&page=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const rows = data?.torrents || [];
    return rows.map((t) => {
      const se = t.season
        ? ` S${String(t.season).padStart(2, '0')}E${String(t.episode || 0).padStart(2, '0')}`
        : '';
      const hash = (t.hash || '').toLowerCase();
      const name = (t.filename || `${t.title || query}${se}`).replace(/\[eztv.*?\]/i, '').trim();
      return {
        name,
        size: t.size_bytes ? humanSize(t.size_bytes) : 'unknown',
        seeders: t.seeds ?? 0,
        peers: t.peers ?? 0,
        magnet: t.magnet_url || (hash ? toMagnet(hash, name) : ''),
        source: 'EZTV',
        quality: '',
        hash,
        type: 'tv',
      };
    });
  } catch {
    return [];
  }
}

// 1337x has no public API — return empty until a scraper/proxy is added.
async function search1337x() {
  return [];
}

async function searchTorrents(query, type = 'all', tmdbKey = '') {
  const jobs = [];
  if (type === 'all' || type === 'movie') jobs.push(searchYTS(query));
  if (type === 'all' || type === 'tv') jobs.push(searchEZTV(query, tmdbKey));
  const results = await Promise.all(jobs);
  const all = results.flat().filter((t) => t.magnet);
  all.sort((a, b) => (b.seeders || 0) - (a.seeders || 0)); // best-seeded first
  return all;
}

module.exports = { searchTorrents, searchYTS, searchEZTV };
