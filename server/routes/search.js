// Torrent search proxy: GET /api/search/torrents?q=The+Matrix&type=movie
// Public trackers aren't CORS-open (and shouldn't be hit straight from the
// browser), so the client asks the server, which returns magnets (from YTS for
// movies, EZTV for TV) for the existing TorBox resolve/stream flow.

const { searchTorrents } = require('../lib/torrent-search');
const { sendJson } = require('../lib/http');

async function handleTorrentSearch(req, res, url) {
  const query = (url.searchParams.get('q') || '').trim();
  const type = (url.searchParams.get('type') || 'all').trim(); // 'all' | 'movie' | 'tv'
  // TMDb key (user's own via header, or a server-wide one) — used to resolve a
  // TV title to an imdb_id for EZTV. Optional; movies don't need it.
  const tmdbKey = String(req.headers['x-tmdb-key'] || process.env.TMDB_API_KEY || '').trim();
  if (!query) {
    sendJson(res, 400, { success: false, detail: 'missing query (use ?q=)' });
    return;
  }
  try {
    const results = await searchTorrents(query, type, tmdbKey);
    sendJson(res, 200, { success: true, data: results });
  } catch (err) {
    sendJson(res, 502, { success: false, detail: err.message || 'torrent search failed' });
  }
}

module.exports = { handleTorrentSearch };
