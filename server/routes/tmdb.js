// TMDb metadata proxy (Phase 4e).
// Metadata only: title/poster/overview/rating search. The key comes from the
// x-tmdb-key header (user's own, stored client-side) or TMDB_API_KEY env.

const { sendJson } = require('../lib/http');

const TMDB_API = 'https://api.themoviedb.org/3';

async function handleTmdbSearch(req, res, url) {
  const apiKey = String(req.headers['x-tmdb-key'] || process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) {
    sendJson(res, 400, { success: false, detail: 'TMDb API key required. Enter one in Settings.' });
    return;
  }
  const query = (url.searchParams.get('query') || '').trim();
  if (!query) {
    sendJson(res, 400, { success: false, detail: 'missing query' });
    return;
  }
  const year = url.searchParams.get('year') || '';
  const page = url.searchParams.get('page') || '1';
  const type = url.searchParams.get('type') || 'all';

  try {
    const results = [];
    const searchKind = async (kind) => {
      const p = new URLSearchParams({ api_key: apiKey, query, page, include_adult: 'false' });
      if (year) p.set(kind === 'movie' ? 'year' : 'first_air_date_year', year);
      const r = await fetch(`${TMDB_API}/search/${kind}?${p}`);
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.success === false) {
        throw new Error(j?.status_message || `TMDb HTTP ${r.status}`);
      }
      for (const it of j?.results || []) {
        results.push({
          id: it.id,
          title: kind === 'movie' ? it.title : it.name,
          year: (kind === 'movie' ? it.release_date : it.first_air_date)?.split('-')[0] || null,
          poster_path: it.poster_path || null,
          backdrop_path: it.backdrop_path || null, // wide art for the cinematic hero/headers
          overview: it.overview || '',
          vote_average: it.vote_average ?? null,
          popularity: it.popularity ?? 0,
          type: kind === 'movie' ? 'movie' : 'tv',
        });
      }
    };
    if (type === 'all' || type === 'movie') await searchKind('movie');
    if (type === 'all' || type === 'tv') await searchKind('tv');
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    sendJson(res, 200, { success: true, data: results });
  } catch (err) {
    sendJson(res, 502, { success: false, detail: err.message || 'TMDb unreachable' });
  }
}

module.exports = { handleTmdbSearch };
