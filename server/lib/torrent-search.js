// Searches YTS (movies) and EZTV (TV). For TV with a TMDb key, resolves the
// title → TMDb show → imdb_id, pulls the show's episodes from EZTV, and groups
// them by season with TMDb season metadata. 1337x has no public API (would need
// scraping/a proxy) so it stays out.

const TORLINK_TIMEOUT_MS = Number(process.env.TORLINK_TIMEOUT_MS) || 10000;
const EZTV_MAX_PAGES = 5; // bound latency for very long-running shows
const TMDB_API = 'https://api.themoviedb.org/3';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  if (!data?.data?.movies) return [];
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
// EZTV's get-torrents is imdb_id-based and wants the NUMERIC id (no "tt").
// Paginated (capped) because a long show spans several pages. Never throws.
async function searchEZTV(imdbId) {
  try {
    const num = String(imdbId).replace(/^tt/i, ''); // "tt0944947" → "0944947"
    if (!/^\d{6,9}$/.test(num)) return [];
    const rows = [];
    let page = 1;
    let totalPages = 1;
    do {
      const url = `https://eztvx.to/api/get-torrents?imdb_id=${num}&limit=100&page=${page}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS) });
      if (!res.ok) break;
      const data = await res.json().catch(() => null);
      const batch = data?.torrents || [];
      if (!batch.length) break;
      rows.push(...batch);
      const per = data.limit || 100;
      totalPages = Math.max(1, Math.ceil((data.torrents_count || rows.length) / per));
      page++;
    } while (page <= totalPages && page <= EZTV_MAX_PAGES);

    return rows
      .map((t) => {
        const se = t.season
          ? `S${String(t.season).padStart(2, '0')}E${String(t.episode || 0).padStart(2, '0')}`
          : '';
        const hash = (t.hash || '').toLowerCase();
        const base = (t.filename || t.title || String(imdbId)).replace(/\[eztv.*?\]/i, '').trim();
        return {
          name: `${base} ${se}`.trim(),
          size: t.size_bytes ? humanSize(t.size_bytes) : t.size || 'unknown',
          seeders: t.seeds ?? t.seeders ?? 0,
          peers: t.peers ?? 0,
          magnet: t.magnet_url || t.magnet || (hash ? toMagnet(hash, base) : ''),
          source: 'EZTV',
          quality: t.quality || '',
          hash,
          type: 'tv',
          season: Number(t.season) || 0,
          episode: Number(t.episode) || 0,
          title: base,
        };
      })
      .filter((t) => t.magnet);
  } catch {
    return [];
  }
}

// ---- TMDb (title → imdb_id + season metadata) ----
async function searchTmdbTv(query, tmdbKey) {
  const url = `${TMDB_API}/search/tv?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(query)}&page=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TMDb TV search HTTP ${res.status}`);
  const data = await res.json();
  return data.results?.[0] || null;
}

async function getTmdbTvDetails(tmdbId, tmdbKey) {
  const url = `${TMDB_API}/tv/${tmdbId}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TORLINK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TMDb TV details HTTP ${res.status}`);
  return res.json();
}

// ---- Group flat EZTV episodes by season, folding in TMDb season metadata ----
function groupEztvBySeason(flat, tmdbSeasons) {
  const grouped = {};
  for (const ep of flat) {
    const n = ep.season || 0;
    if (!grouped[n]) {
      grouped[n] = { season: n, episodes: [], seasonOverview: '', seasonPoster: null, episodeCount: 0 };
    }
    grouped[n].episodes.push(ep);
  }
  for (const s of tmdbSeasons || []) {
    const g = grouped[s.season_number];
    if (g) {
      g.seasonOverview = s.overview || '';
      g.seasonPoster = s.poster_path || null;
      g.episodeCount = s.episode_count || g.episodes.length;
    }
  }
  for (const g of Object.values(grouped)) {
    g.episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));
    if (!g.episodeCount) g.episodeCount = g.episodes.length;
  }
  return Object.values(grouped).sort((a, b) => a.season - b.season);
}

// Resolve a TV query to episodes. `grouped` → array of season blocks (needs a
// TMDb key, unless the query is a bare imdb id); otherwise a flat episode list.
async function searchTv(query, tmdbKey, grouped) {
  const q = query.trim();
  let imdbId = null;
  let seasons = [];
  if (/^(tt)?\d{6,9}$/i.test(q)) {
    imdbId = q; // imdb id typed directly (searchEZTV strips the tt)
  } else if (tmdbKey) {
    const show = await searchTmdbTv(q, tmdbKey);
    if (show) {
      const details = await getTmdbTvDetails(show.id, tmdbKey);
      imdbId = details.external_ids?.imdb_id || null;
      seasons = details.seasons || [];
    }
  }
  if (!imdbId) return [];
  const flat = await searchEZTV(imdbId);
  return grouped ? groupEztvBySeason(flat, seasons) : flat;
}

// type='movie' → YTS flat · type='tv' → grouped seasons · type='all' → flat
// merge of movies + TV episodes (resilient: one source failing can't sink the
// other). TV grouping needs a TMDb key (or a bare imdb id in the query).
async function searchTorrents(query, type = 'all', tmdbKey = '') {
  if (type === 'movie') return searchYTS(query);
  if (type === 'tv') return searchTv(query, tmdbKey, true);
  const [movies, tv] = await Promise.all([
    searchYTS(query).catch(() => []),
    searchTv(query, tmdbKey, false).catch(() => []),
  ]);
  const all = [...movies, ...tv].filter((t) => t.magnet);
  all.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  return all;
}

module.exports = { searchTorrents, searchYTS, searchEZTV };
