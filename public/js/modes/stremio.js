// Stremio source mode: paste an add-on URL (e.g. AIOStreams) → discover titles
// (the add-on's own catalogs if it has any, otherwise TMDb search) → pick a
// title → list the add-on's streams → play. Streams that carry a direct `url`
// (debrid-resolved) play as-is; streams that carry an `infoHash` fall back to
// the TorBox resolve flow. Playback is broadcast so peers re-resolve the same
// title with THEIR own add-on (add-on URLs are debrid/IP-locked, like TorBox).

import { $, spinner } from '../lib/dom.js';
import { getKey, resolveMagnet, infoHashToMagnet } from '../lib/torbox.js';

const ADDON_KEY = 'stremio_addon_url';
const getTmdbKey = () => (localStorage.getItem('tmdb_api_key') || '').trim();
const isSeries = (type) => type === 'series' || type === 'tv';
const PLACEHOLDER = 'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#1E1910"/></svg>');

export function createStremio(ctx) {
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);
  let manifest = null;
  let catalogs = [];
  let pending = null; // series title awaiting a season/episode pick

  const getAddonUrl = () => (localStorage.getItem(ADDON_KEY) || '').trim();
  const setAddonUrl = (url) => localStorage.setItem(ADDON_KEY, (url || '').trim());

  const status = (text, kind = '') => {
    $('stremio-status').textContent = text;
    $('stremio-status').className = `hint ${kind}`;
  };

  // ---- proxy calls ----
  async function proxy(resource, params) {
    const qs = new URLSearchParams({ url: getAddonUrl(), ...params });
    const res = await fetch(`/api/stremio/${resource}?${qs}`);
    const json = await res.json().catch(() => null);
    if (!json?.success) throw new Error(json?.detail || `Stremio ${resource} failed (HTTP ${res.status})`);
    return json.data;
  }
  const fetchManifest = () => proxy('manifest', {});
  const fetchCatalog = (type, id, extra) => proxy('catalog', extra ? { type, id, extra } : { type, id });
  const fetchStreams = (type, id) => proxy('stream', { type, id });

  // ---- add-on load ----
  async function loadAddon(url) {
    setAddonUrl(url);
    manifest = null;
    catalogs = [];
    $('stremio-se').hidden = true;
    $('stremio-results').replaceChildren();
    status('Loading add-on…');
    try {
      manifest = await fetchManifest();
      catalogs = (manifest.catalogs || []).filter((c) => c.type && c.id);
      $('stremio-addon').textContent = manifest.name ? `✓ ${manifest.name}` : '✓ add-on loaded';
      buildCatalogSelect();
      status(
        catalogs.length
          ? `Loaded — browse a catalog, or search a title above.`
          : `Loaded — this add-on has no catalogs; search a title above.`,
        'ok'
      );
      if (catalogs.length) openCatalog(catalogs[0]);
    } catch (err) {
      $('stremio-addon').textContent = '';
      status(`Could not load add-on: ${err.message || err}`, 'warn');
    }
  }

  function buildCatalogSelect() {
    const sel = $('stremio-catalog');
    sel.replaceChildren();
    const search = document.createElement('option');
    search.value = 'search';
    search.textContent = '🔍 Search (TMDb)';
    sel.append(search);
    catalogs.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = `cat:${i}`;
      o.textContent = `${c.name || c.id} · ${c.type}`;
      sel.append(o);
    });
    sel.hidden = catalogs.length === 0;
    sel.value = catalogs.length ? 'cat:0' : 'search';
  }

  $('stremio-load').addEventListener('click', () => {
    const url = $('stremio-url').value.trim();
    if (url) loadAddon(url);
  });
  $('stremio-catalog').addEventListener('change', () => {
    const v = $('stremio-catalog').value;
    if (v.startsWith('cat:')) openCatalog(catalogs[Number(v.slice(4))]);
    else status('Type a title above and press Search.');
  });

  // ---- discovery: catalog browse ----
  async function openCatalog(cat) {
    $('stremio-se').hidden = true;
    status(`Loading “${cat.name || cat.id}”…`);
    spinner(true);
    try {
      const data = await fetchCatalog(cat.type, cat.id);
      const metas = (data.metas || []).map((m) => ({
        name: m.name || m.title,
        poster: m.poster,
        type: m.type || cat.type,
        id: m.id, // already a Stremio id
      }));
      renderGrid(metas);
      status(`${metas.length} titles.`, metas.length ? 'ok' : '');
    } catch (err) {
      status(`Catalog failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  // ---- discovery: TMDb search (used from the shared sync-input) ----
  async function run(query) {
    if (!getAddonUrl()) {
      status('Paste a Stremio add-on URL and press Load first.', 'warn');
      return;
    }
    if (!getTmdbKey()) {
      status('Enter your TMDb API key (gear icon) to search titles.', 'warn');
      ctx.settings.openSettings(true);
      return;
    }
    $('stremio-se').hidden = true;
    $('stremio-catalog').value = 'search';
    status('Searching…');
    spinner(true);
    try {
      const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(query)}`, {
        headers: { 'x-tmdb-key': getTmdbKey() },
      });
      const data = await res.json().catch(() => null);
      if (!data?.success) throw new Error(data?.detail || 'search failed');
      const metas = data.data.map((m) => ({
        name: m.title,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w300${m.poster_path}` : '',
        type: m.type === 'tv' ? 'series' : 'movie',
        tmdbId: m.id,
        year: m.year,
      }));
      renderGrid(metas);
      status(`${metas.length} results.`, metas.length ? 'ok' : '');
    } catch (err) {
      status(`Search failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  // ---- grid + selection ----
  function renderGrid(items) {
    const container = $('stremio-results');
    container.replaceChildren();
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Nothing found.';
      container.append(p);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'results-grid';
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'result-card';
      const img = document.createElement('img');
      img.src = item.poster || PLACEHOLDER;
      img.alt = item.name || '';
      img.loading = 'lazy';
      const body = document.createElement('div');
      body.className = 'card-body';
      const h = document.createElement('h4');
      h.textContent = item.name || 'Untitled';
      h.title = item.name || '';
      const meta = document.createElement('span');
      meta.className = 'card-meta';
      meta.textContent = `${item.year || ''} · ${isSeries(item.type) ? 'TV' : 'Movie'}`.trim();
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = isSeries(item.type) ? 'Episodes' : 'Streams';
      btn.addEventListener('click', () => selectTitle(item));
      body.append(h, meta, btn);
      card.append(img, body);
      grid.append(card);
    }
    container.append(grid);
  }

  // Resolve a grid item to a Stremio stream id (imdb preferred; tmdb: fallback).
  async function baseIdOf(item) {
    if (item.id) return item.id; // catalog metas carry a Stremio id already
    if (item.tmdbId) {
      const imdb = await tmdbImdb(item.tmdbId, isSeries(item.type) ? 'tv' : 'movie');
      return imdb || `tmdb:${item.tmdbId}`;
    }
    return null;
  }

  async function tmdbImdb(tmdbId, kind) {
    const key = getTmdbKey();
    if (!key) return null;
    try {
      const res = await fetch(`https://api.themoviedb.org/3/${kind}/${tmdbId}/external_ids?api_key=${encodeURIComponent(key)}`);
      const j = await res.json().catch(() => null);
      return j?.imdb_id || null;
    } catch {
      return null;
    }
  }

  async function selectTitle(item) {
    const baseId = await baseIdOf(item);
    if (!baseId) {
      notice('Could not resolve a stream id for this title.', 'warn', 4000);
      return;
    }
    if (isSeries(item.type)) {
      pending = { name: item.name, baseId };
      $('stremio-se-title').textContent = item.name || '';
      $('stremio-se').hidden = false;
      return;
    }
    getStreams('movie', baseId, item.name);
  }

  $('stremio-back').addEventListener('click', () => ($('stremio-se').hidden = true));
  $('stremio-get').addEventListener('click', () => {
    if (!pending) return;
    const s = Math.max(0, Number($('stremio-season').value) || 1);
    const e = Math.max(0, Number($('stremio-episode').value) || 1);
    getStreams('series', `${pending.baseId}:${s}:${e}`, `${pending.name} S${s}E${e}`);
  });

  // ---- streams ----
  async function getStreams(type, id, title) {
    status(`Fetching streams for ${title}…`);
    spinner(true);
    try {
      const data = await fetchStreams(type, id);
      const streams = data.streams || [];
      renderStreams(streams, { type, id, title });
      status(`${streams.length} streams for ${title}.`, streams.length ? 'ok' : '');
    } catch (err) {
      status(`Streams failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  function renderStreams(streams, meta) {
    const container = $('stremio-results');
    container.replaceChildren();
    if (!streams.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No streams available.';
      container.append(p);
      return;
    }
    const list = document.createElement('div');
    list.className = 'torrent-list';
    for (const stream of streams) {
      const row = document.createElement('div');
      row.className = 'torrent-item';
      const info = document.createElement('div');
      info.className = 'torrent-info';
      const name = document.createElement('span');
      name.className = 'torrent-name';
      name.textContent = stream.name || stream.title || 'Stream';
      const desc = document.createElement('span');
      desc.className = 'torrent-meta';
      desc.textContent = (stream.description || stream.title || '').replace(/\n/g, ' · ').slice(0, 90);
      info.append(name, desc);
      const actions = document.createElement('div');
      actions.className = 'torrent-actions';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = 'Play';
      btn.addEventListener('click', () => play(stream, meta, btn));
      actions.append(btn);
      row.append(info, actions);
      list.append(row);
    }
    container.append(list);
  }

  // ---- playback ----
  async function play(stream, meta, btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const url = await resolveStream(stream, (p) => (btn.textContent = `Downloading ${Math.round(p * 100)}%`));
      if (!url) {
        notice('This stream has no playable source.', 'warn', 4000);
        btn.disabled = false;
        btn.textContent = 'Play';
        return;
      }
      const source = {
        kind: 'stremio',
        type: meta.type,
        streamId: meta.id,
        name: stream.name || stream.title || '',
        title: meta.title,
        resolvedUrl: url,
      };
      rememberMeta(source);
      await ctx.syncCore.loadSource(source);
      ctx.signaling.signal({ type: 'sync-load', source });
      ctx.syncMode.setSourceMode('torbox'); // reveal the player (hide the stremio panel)
      notice(`Streaming: ${meta.title}`, 'ok', 4000);
    } catch (err) {
      notice(`Playback failed: ${err.message || err}`, 'error', 5000);
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // A Stremio stream → a playable URL. Direct `url` wins; otherwise an
  // `infoHash` goes through TorBox.
  async function resolveStream(stream, onProgress) {
    if (stream.url) return stream.url;
    if (stream.infoHash) {
      const apiKey = getKey();
      if (!apiKey) {
        notice('This stream needs a magnet resolver — enter your TorBox API key (gear icon).', 'warn', 4000);
        ctx.settings.openSettings(true);
        return null;
      }
      const hash = String(stream.infoHash).toLowerCase();
      const magnet = infoHashToMagnet(hash, stream.sources, stream.name);
      const { streamUrl } = await resolveMagnet(apiKey, magnet, hash, { onProgress });
      return streamUrl;
    }
    return null;
  }

  // Peer follows: re-resolve the same title from THEIR add-on (add-on URLs are
  // debrid/IP-locked, so the sharer's resolvedUrl usually won't work for them).
  async function resolveForPeer(source) {
    if (!getAddonUrl()) return null;
    try {
      const data = await fetchStreams(source.type, source.streamId);
      const streams = data.streams || [];
      const pick =
        streams.find((s) => s.name === source.name && (s.url || s.infoHash)) ||
        streams.find((s) => s.url || s.infoHash);
      if (!pick) return null;
      return resolveStream(pick, () => {});
    } catch {
      return null;
    }
  }

  function rememberMeta(source) {
    try {
      const map = JSON.parse(localStorage.getItem('hash_meta') || '{}');
      map[source.streamId] = { title: source.title };
      localStorage.setItem('hash_meta', JSON.stringify(map));
    } catch {
      // cosmetic
    }
  }

  // Called by setSourceMode('stremio'): restore the saved add-on + its URL.
  function activate() {
    const saved = getAddonUrl();
    if (saved) $('stremio-url').value = saved;
    if (saved && !manifest) loadAddon(saved);
    else if (!saved) status('Paste a Stremio add-on URL (…/manifest.json) and press Load.');
  }

  return { run, activate, resolveForPeer };
}
