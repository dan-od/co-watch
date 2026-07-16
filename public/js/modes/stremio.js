// Stremio source mode: paste an add-on URL (e.g. AIOStreams) → discover titles
// (the add-on's own catalogs if it has any, otherwise TMDb search) → pick a
// title. Movies jump straight to the add-on's streams; series open a grouped
// season list (episode counts from TMDb, episodes lazy-loaded per season) and
// each episode drills into its streams. Streams that carry a direct `url`
// (debrid-resolved) play as-is; streams that carry an `infoHash` fall back to
// the TorBox resolve flow. Playback is broadcast so peers re-resolve the same
// title with THEIR own add-on (add-on URLs are debrid/IP-locked, like TorBox).
//
// The panel body swaps between three views via a small nav stack:
//   discovery (poster grid) → seasons (collapsible blocks) → streams (list)
// The nav bar is the breadcrumb + Back.

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
  let viewStack = []; // [{ label, render }] — top is the current view
  // A follower who has no add-on of their own can borrow the sharer's, received
  // over the wire (Part C). Kept in MEMORY ONLY — never written to localStorage,
  // never shown in plain text — and gone the moment they leave (leave reloads).
  let followAddon = null;

  const getAddonUrl = () => (localStorage.getItem(ADDON_KEY) || '').trim();
  const setAddonUrl = (url) => localStorage.setItem(ADDON_KEY, (url || '').trim());
  // Own add-on wins; otherwise fall back to a sharer's borrowed one.
  const getEffectiveAddon = () => getAddonUrl() || followAddon || '';

  const status = (text, kind = '') => {
    $('stremio-status').textContent = text;
    $('stremio-status').className = `hint ${kind}`;
  };

  // ---- view stack / breadcrumb ----
  function renderTop() {
    const top = viewStack[viewStack.length - 1];
    $('stremio-nav').hidden = viewStack.length <= 1;
    $('stremio-crumb').textContent = viewStack.map((v) => v.label).join('  ›  ');
    top?.render();
  }
  function resetView(view) { viewStack = [view]; renderTop(); }
  function pushView(view) { viewStack.push(view); renderTop(); }
  function popView() { if (viewStack.length > 1) { viewStack.pop(); renderTop(); } }

  $('stremio-back').addEventListener('click', popView);

  // ---- proxy calls (add-on, via the SSRF-guarded server proxy) ----
  async function proxy(resource, params) {
    const qs = new URLSearchParams({ url: getEffectiveAddon(), ...params });
    const res = await fetch(`/api/stremio/${resource}?${qs}`);
    const json = await res.json().catch(() => null);
    if (!json?.success) throw new Error(json?.detail || `Stremio ${resource} failed (HTTP ${res.status})`);
    return json.data;
  }
  const fetchManifest = () => proxy('manifest', {});
  const fetchCatalog = (type, id, extra) => proxy('catalog', extra ? { type, id, extra } : { type, id });
  const fetchStreams = (type, id) => proxy('stream', { type, id });

  // ---- TMDb helpers (direct; key stays client-side, same as external_ids) ----
  async function tmdb(path, params = {}) {
    const key = getTmdbKey();
    if (!key) return null;
    const qs = new URLSearchParams({ api_key: key, ...params });
    try {
      const r = await fetch(`https://api.themoviedb.org/3/${path}?${qs}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  // Resolve a grid item to a Stremio stream base id (imdb preferred) plus a
  // TMDb id (needed for season/episode data).
  async function resolveIds(item) {
    const kind = isSeries(item.type) ? 'tv' : 'movie';
    let tmdbId = item.tmdbId ? String(item.tmdbId) : null;
    let baseId = item.id || null; // catalog metas carry a Stremio id already
    if (!baseId && tmdbId) {
      const imdb = (await tmdb(`${kind}/${tmdbId}/external_ids`))?.imdb_id;
      baseId = imdb || `tmdb:${tmdbId}`;
    }
    if (!tmdbId && baseId) {
      if (baseId.startsWith('tmdb:')) {
        tmdbId = baseId.slice(5).split(':')[0];
      } else if (/^tt\d+/.test(baseId)) {
        const found = await tmdb(`find/${baseId.split(':')[0]}`, { external_source: 'imdb_id' });
        const hit = kind === 'tv' ? found?.tv_results?.[0] : found?.movie_results?.[0];
        tmdbId = hit ? String(hit.id) : null;
      }
    }
    return { baseId, tmdbId, kind };
  }

  // ---- add-on load ----
  async function loadAddon(url) {
    setAddonUrl(url);
    manifest = null;
    catalogs = [];
    viewStack = [];
    $('stremio-nav').hidden = true;
    $('stremio-results').replaceChildren();
    const tag = $('stremio-addon');
    tag.hidden = true;
    status('Loading add-on…');
    try {
      manifest = await fetchManifest();
      catalogs = (manifest.catalogs || []).filter((c) => c.type && c.id);
      tag.textContent = manifest.name ? `✓ ${manifest.name}` : '✓ loaded';
      tag.hidden = false;
      buildCatalogSelect();
      status(
        catalogs.length
          ? 'Loaded — browse a catalog, or search a title above.'
          : 'Loaded — this add-on has no catalogs; search a title above.',
        'ok'
      );
      if (catalogs.length) openCatalog(catalogs[0]);
    } catch (err) {
      tag.hidden = true;
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
      resetView({ label: cat.name || cat.id, render: () => renderGrid(metas) });
      status(`${metas.length} title${metas.length === 1 ? '' : 's'}.`, metas.length ? 'ok' : '');
    } catch (err) {
      status(`Catalog failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  // ---- discovery: TMDb search (driven by the shared sync-input) ----
  async function run(query) {
    if (!getEffectiveAddon()) {
      status('Paste a Stremio add-on URL and press Load first.', 'warn');
      return;
    }
    if (!getTmdbKey()) {
      status('Enter your TMDb API key (gear icon) to search titles.', 'warn');
      ctx.settings.openSettings(true);
      return;
    }
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
      resetView({ label: `“${query}”`, render: () => renderGrid(metas) });
      status(`${metas.length} result${metas.length === 1 ? '' : 's'}.`, metas.length ? 'ok' : '');
    } catch (err) {
      status(`Search failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  // ---- discovery grid ----
  function emptyMsg(container, text) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    container.append(p);
  }

  function renderGrid(items) {
    const container = $('stremio-results');
    container.replaceChildren();
    if (!items.length) { emptyMsg(container, 'Nothing found.'); return; }
    const grid = document.createElement('div');
    grid.className = 'results-grid';
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'result-card';
      const img = document.createElement('img');
      img.src = item.poster || PLACEHOLDER;
      img.alt = item.name || '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { img.src = PLACEHOLDER; }, { once: true });
      const body = document.createElement('div');
      body.className = 'card-body';
      const h = document.createElement('h4');
      h.textContent = item.name || 'Untitled';
      h.title = item.name || '';
      const meta = document.createElement('span');
      meta.className = 'card-meta';
      meta.textContent = [item.year, isSeries(item.type) ? 'TV' : 'Movie'].filter(Boolean).join(' · ');
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

  async function selectTitle(item) {
    status('Resolving…');
    spinner(true);
    try {
      const { baseId, tmdbId } = await resolveIds(item);
      if (!baseId) {
        notice('Could not resolve a stream id for this title.', 'warn', 4000);
        return;
      }
      if (isSeries(item.type)) {
        const seasons = await loadSeasons(tmdbId);
        pushView({ label: item.name || 'Series', render: () => renderSeasons(item.name, baseId, tmdbId, seasons) });
        status(
          seasons?.length
            ? `${seasons.length} season${seasons.length === 1 ? '' : 's'} — expand one to pick an episode.`
            : 'No season data (add a TMDb key) — enter a season/episode below.',
          seasons?.length ? 'ok' : ''
        );
      } else {
        await openStreams('movie', baseId, item.name);
      }
    } finally {
      spinner(false);
    }
  }

  // ---- series: seasons (TMDb) ----
  async function loadSeasons(tmdbId) {
    if (!tmdbId) return null;
    const tv = await tmdb(`tv/${tmdbId}`);
    if (!tv?.seasons) return null;
    return tv.seasons
      .filter((s) => (s.episode_count || 0) > 0)
      .map((s) => ({ number: s.season_number, count: s.episode_count, name: s.name, overview: s.overview }));
  }

  async function loadEpisodes(tmdbId, seasonNumber, count) {
    const data = tmdbId ? await tmdb(`tv/${tmdbId}/season/${seasonNumber}`) : null;
    if (data?.episodes?.length) {
      return data.episodes.map((e) => ({ number: e.episode_number, name: e.name, air: e.air_date, overview: e.overview }));
    }
    return Array.from({ length: count }, (_, i) => ({ number: i + 1, name: '' }));
  }

  function renderSeasons(name, baseId, tmdbId, seasons) {
    const container = $('stremio-results');
    container.replaceChildren();
    if (!seasons || !seasons.length) { renderManualSE(container, name, baseId); return; }
    for (const s of seasons) container.append(buildSeasonBlock(name, baseId, tmdbId, s));
  }

  function buildSeasonBlock(name, baseId, tmdbId, s) {
    const block = document.createElement('div');
    block.className = 'season-block';
    const header = document.createElement('div');
    header.className = 'season-header';
    if (s.overview) header.title = s.overview;
    const title = document.createElement('span');
    title.className = 'season-title';
    title.textContent = s.number === 0 ? 'Specials' : `Season ${s.number}`;
    const count = document.createElement('span');
    count.className = 'season-count';
    count.textContent = `${s.count} episode${s.count === 1 ? '' : 's'}`;
    const toggle = document.createElement('button');
    toggle.className = 'season-toggle ghost';
    toggle.textContent = '▸';
    header.append(title, count, toggle);

    const epList = document.createElement('div');
    epList.className = 'episode-list';
    epList.hidden = true;
    let loaded = false;

    const open = async () => {
      epList.hidden = !epList.hidden;
      toggle.textContent = epList.hidden ? '▸' : '▾';
      if (epList.hidden || loaded) return;
      loaded = true;
      const loading = document.createElement('p');
      loading.className = 'hint';
      loading.textContent = 'Loading episodes…';
      epList.append(loading);
      const eps = await loadEpisodes(tmdbId, s.number, s.count);
      epList.replaceChildren();
      for (const ep of eps) epList.append(buildEpisodeRow(name, baseId, s.number, ep));
    };
    header.addEventListener('click', (e) => { if (e.target !== toggle) open(); });
    toggle.addEventListener('click', open);

    block.append(header, epList);
    return block;
  }

  function buildEpisodeRow(showName, baseId, season, ep) {
    const row = document.createElement('div');
    row.className = 'torrent-item';
    const head = document.createElement('div');
    head.className = 'torrent-row-head';
    const info = document.createElement('div');
    info.className = 'torrent-info';
    const nm = document.createElement('span');
    nm.className = 'torrent-name';
    nm.textContent = `E${ep.number}${ep.name ? ` · ${ep.name}` : ''}`;
    nm.title = nm.textContent;
    info.append(nm);
    if (ep.air) {
      const meta = document.createElement('span');
      meta.className = 'torrent-meta';
      meta.textContent = ep.air;
      info.append(meta);
    }
    const actions = document.createElement('div');
    actions.className = 'torrent-actions';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Streams';
    btn.addEventListener('click', () =>
      openStreams('series', `${baseId}:${season}:${ep.number}`, `${showName} · S${season}E${ep.number}`)
    );
    actions.append(btn);
    head.append(info, actions);
    row.append(head);
    return row;
  }

  // Fallback when TMDb season data is unavailable: a compact manual S/E form.
  function renderManualSE(container, name, baseId) {
    const wrap = document.createElement('div');
    wrap.className = 'manual-se';
    const label = document.createElement('span');
    label.className = 'hint';
    label.textContent = `${name}: enter a season & episode`;
    const sInput = document.createElement('input');
    sInput.type = 'number'; sInput.min = '0'; sInput.value = '1'; sInput.className = 'se-num'; sInput.setAttribute('aria-label', 'Season');
    const eInput = document.createElement('input');
    eInput.type = 'number'; eInput.min = '1'; eInput.value = '1'; eInput.className = 'se-num'; eInput.setAttribute('aria-label', 'Episode');
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Get streams';
    go.addEventListener('click', () => {
      const s = Math.max(0, Number(sInput.value) || 1);
      const e = Math.max(0, Number(eInput.value) || 1);
      openStreams('series', `${baseId}:${s}:${e}`, `${name} · S${s}E${e}`);
    });
    wrap.append(label, labelled('S', sInput), labelled('E', eInput), go);
    container.append(wrap);
  }
  function labelled(text, input) {
    const l = document.createElement('label');
    l.className = 'se-field';
    l.append(document.createTextNode(text), input);
    return l;
  }

  // ---- streams ----
  async function openStreams(type, id, title) {
    status(`Fetching streams for ${title}…`);
    spinner(true);
    try {
      const data = await fetchStreams(type, id);
      const streams = data.streams || [];
      pushView({ label: title, render: () => renderStreams(streams, { type, id, title }) });
      status(`${streams.length} stream${streams.length === 1 ? '' : 's'}.`, streams.length ? 'ok' : '');
    } catch (err) {
      status(`Streams failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  function renderStreams(streams, meta) {
    const container = $('stremio-results');
    container.replaceChildren();
    if (!streams.length) { emptyMsg(container, 'No streams available for this title.'); return; }
    // Prefer browser-playable audio: float AAC/Opus streams up and sink
    // DTS/TrueHD/Atmos (which play silently in-browser) down. Stable sort keeps
    // the add-on's quality order within each compatibility tier.
    const ranked = streams.map((s, i) => ({ s, i, r: audioRank(s) }));
    ranked.sort((a, b) => a.r - b.r || a.i - b.i);
    const risky = ranked.filter((x) => x.r === 2).length;
    if (risky && risky < ranked.length) {
      const tip = document.createElement('p');
      tip.className = 'hint';
      tip.textContent = `${risky} stream${risky === 1 ? '' : 's'} use lossless audio (DTS/TrueHD/Atmos) that plays silently in a browser — those are marked ⚠ and sorted last.`;
      container.append(tip);
    }
    const list = document.createElement('div');
    list.className = 'torrent-list';
    for (const { s } of ranked) list.append(buildStreamRow(s, meta));
    container.append(list);
  }

  function buildStreamRow(stream, meta) {
    const row = document.createElement('div');
    row.className = 'torrent-item stream-row';
    const head = document.createElement('div');
    head.className = 'torrent-row-head';
    const info = document.createElement('div');
    info.className = 'torrent-info';

    const nm = document.createElement('span');
    nm.className = 'torrent-name';
    nm.textContent = cleanName(stream.name || stream.title || 'Stream');
    nm.title = nm.textContent;
    info.append(nm);

    const tags = parseTags(stream);
    if (audioRank(stream) === 2) tags.unshift({ label: '⚠ no browser audio', cls: 'warn' });
    if (tags.length) {
      const badges = document.createElement('div');
      badges.className = 'badges';
      for (const t of tags) {
        const b = document.createElement('span');
        b.className = `badge badge-${t.cls}`;
        b.textContent = t.label;
        if (t.cls === 'warn') b.title = 'This stream’s audio (DTS/TrueHD/Atmos) usually plays silently in a browser — pick an AAC/AC3 stream, or expect no sound.';
        badges.append(b);
      }
      info.append(badges);
    }

    const detail = descLine(stream);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'torrent-meta';
      d.textContent = detail;
      d.title = detail;
      info.append(d);
    }

    const actions = document.createElement('div');
    actions.className = 'torrent-actions';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Play';
    btn.addEventListener('click', () => play(stream, meta, btn));
    actions.append(btn);

    head.append(info, actions);
    row.append(head);
    return row;
  }

  // Collapse whitespace in an add-on's stream name (keeps its emoji flair).
  function cleanName(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }
  // Flatten the description (add-ons pack size/codec/audio across lines).
  function descLine(stream) {
    const raw = stream.description || stream.title || '';
    return String(raw).split('\n').map((l) => l.trim()).filter(Boolean).join(' · ').slice(0, 110);
  }
  const streamText = (stream) => `${stream.name || ''} ${stream.description || stream.title || ''}`;

  // Browser audio-codec compatibility: 0 = decodes in Chrome (AAC/Opus/MP3…),
  // 2 = usually SILENT in-browser (DTS/TrueHD/Atmos — object/lossless tracks a
  // <video> can't decode → picture plays, no sound), 1 = unknown/borderline
  // (AC3/E-AC3 Dolby Digital — inconsistent). Drives the warn badge + ordering.
  function audioRank(stream) {
    const text = streamText(stream);
    if (/\bdts(-hd)?(\s?ma)?\b|\bdts-?x\b|\btrue-?hd\b|\batmos\b/i.test(text)) return 2;
    if (/\baac\b|\bopus\b|\bmp3\b|\bvorbis\b|\bflac\b/i.test(text)) return 0;
    if (/\be-?ac-?3\b|\beac3\b|\bac-?3\b|\bdd\+?\b|\bddp\b|dolby\s?digital/i.test(text)) return 1;
    return 1;
  }

  // Best-effort quality badges parsed from name + description.
  function parseTags(stream) {
    const text = streamText(stream);
    const tags = [];
    const seen = new Set();
    const add = (label, cls) => { if (!seen.has(label)) { seen.add(label); tags.push({ label, cls }); } };
    const res = text.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
    if (res) add(/4k/i.test(res[1]) ? '4K' : res[1].toLowerCase(), 'res');
    if (/\bdolby\s?vision\b|\bdovi\b|\bdv\b/i.test(text)) add('DV', 'hdr');
    if (/\bhdr10\+?\b|\bhdr\b/i.test(text)) add('HDR', 'hdr');
    const size = text.match(/(\d+(?:\.\d+)?)\s?(gb|mb)\b/i);
    if (size) add(`${size[1]} ${size[2].toUpperCase()}`, 'size');
    if (/\bremux\b/i.test(text)) add('REMUX', 'src');
    else if (/\bblu-?ray\b|\bbdrip\b/i.test(text)) add('BluRay', 'src');
    else if (/\bweb-?dl\b|\bwebrip\b|\bweb\b/i.test(text)) add('WEB', 'src');
    if (/\batmos\b/i.test(text)) add('Atmos', 'aud');
    else if (/\bdts(-hd)?\b|\btruehd\b|\beac3\b|\bddp?\s?5\.1\b|\bac3\b/i.test(text)) add('DTS', 'aud');
    if (/\bhevc\b|\bx265\b|\bh\.?265\b/i.test(text)) add('HEVC', 'codec');
    else if (/\bav1\b/i.test(text)) add('AV1', 'codec');
    const seeders = text.match(/👤\s?(\d+)/);
    if (seeders) add(`${seeders[1]} seeders`, 'seed');
    return tags.slice(0, 6);
  }

  const SHARE_ACK_KEY = 'stremio_share_ack';
  const SHARE_WARNING =
    'Heads up: sharing lets everyone in the room stream through YOUR debrid ' +
    'account — your add-on link carries its keys. It is shared only while they ' +
    'are here and is never saved on their devices. Share your add-on so keyless ' +
    'friends can follow?';

  // The add-on URL to attach to a broadcast (or '' to withhold it). We only have
  // one to share if it's OUR own; and we ask for consent once. If we can't ask
  // (no confirm) or the user declines, we withhold it — playback still works,
  // watchers just need their own add-on. Declining leaves the flag unset, so
  // we ask again next time.
  function addonToShare() {
    const own = getAddonUrl();
    if (!own) return ''; // a follower has nothing of their own to re-share
    if (localStorage.getItem(SHARE_ACK_KEY)) return own;
    const ok = typeof window.confirm === 'function' && window.confirm(SHARE_WARNING);
    if (ok) { localStorage.setItem(SHARE_ACK_KEY, '1'); return own; }
    return '';
  }

  // ---- playback ----
  async function play(stream, meta, btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const { url, torrentMeta } = await resolveStream(stream, (p) => (btn.textContent = `Downloading ${Math.round(p * 100)}%`));
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
      // Part C: let keyless friends follow on OUR add-on — but only after a
      // one-time, eyes-open consent (the add-on URL embeds our debrid keys).
      const shareAddon = addonToShare();
      if (shareAddon) source.addonUrl = shareAddon;
      rememberMeta(source);
      await ctx.syncCore.loadSource(source);
      applySubs(stream, meta, torrentMeta); // torrent + add-on subtitles → CC panel
      ctx.signaling.signal({ type: 'sync-load', source });
      ctx.syncMode.setSourceMode('torbox'); // reveal the player (hide the stremio panel)
      notice(`Streaming: ${meta.title}`, 'ok', 4000);
    } catch (err) {
      notice(`Playback failed: ${err.message || err}`, 'error', 5000);
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // A Stremio stream → { url, torrentMeta }. Direct `url` wins; otherwise an
  // `infoHash` goes through TorBox (whose meta carries any .srt/.vtt files).
  async function resolveStream(stream, onProgress) {
    if (stream.url) return { url: stream.url, torrentMeta: null };
    if (stream.infoHash) {
      const apiKey = getKey();
      if (!apiKey) {
        notice('This stream needs a magnet resolver — enter your TorBox API key (gear icon).', 'warn', 4000);
        ctx.settings.openSettings(true);
        return { url: null, torrentMeta: null };
      }
      const hash = String(stream.infoHash).toLowerCase();
      const magnet = infoHashToMagnet(hash, stream.sources, stream.name);
      const { streamUrl, meta } = await resolveMagnet(apiKey, magnet, hash, { onProgress });
      return { url: streamUrl, torrentMeta: meta };
    }
    return { url: null, torrentMeta: null };
  }

  // Feed subtitles into the CC panel: (B1) .srt/.vtt inside the torrent for an
  // infoHash stream, (B2) a stream's own `subtitles` array, and (B3) the
  // add-on's /subtitles resource for this id. Add-on subs are lazy-loaded from
  // the panel (a title can carry dozens of languages).
  async function applySubs(stream, meta, torrentMeta) {
    ctx.tracks.setTorrentSubs(torrentMeta || null);
    const subs = [];
    const push = (s) => { if (s?.url) subs.push({ lang: s.lang || s.language || s.id || 'Subtitle', url: s.url }); };
    for (const s of stream.subtitles || []) push(s); // B2
    try {
      const data = await proxy('subtitles', { type: meta.type, id: meta.id }); // B3
      for (const s of data?.subtitles || []) push(s);
    } catch {
      // add-on has no /subtitles resource for this id — fine
    }
    const seen = new Set();
    ctx.tracks.setAddonSubs(subs.filter((s) => (seen.has(s.url) ? false : seen.add(s.url))));
    ctx.tracks.renderTracksPanel();
  }

  // A watcher follows the sharer's Stremio load. Re-resolve the same title from
  // an add-on (add-on URLs are debrid/IP-locked, so the sharer's resolvedUrl
  // usually won't play for us): our OWN add-on if we have one, else the sharer's
  // borrowed one (Part C — held in memory only). Then load it, wire subtitles
  // (Part B, watcher side), and show a "following {name}" note.
  async function followStream(source, fromName) {
    if (!getAddonUrl() && source.addonUrl) followAddon = source.addonUrl; // borrow, in memory
    const addon = getEffectiveAddon();
    if (!addon) {
      notice('Load your Stremio add-on (Sync → Stremio) to follow this stream.', 'warn');
      return false;
    }
    try {
      let url = null;
      let torrentMeta = null;
      let chosen = null;
      try {
        const data = await fetchStreams(source.type, source.streamId);
        const streams = data.streams || [];
        chosen =
          streams.find((s) => s.name === source.name && (s.url || s.infoHash)) ||
          streams.find((s) => s.url || s.infoHash) ||
          null;
        if (chosen) ({ url, torrentMeta } = await resolveStream(chosen, () => {}));
      } catch {
        // fall through to the sharer's URL
      }
      if (!url && source.resolvedUrl) url = source.resolvedUrl; // last resort (may be IP-locked)
      if (!url) {
        notice('Could not resolve this stream from the add-on.', 'warn', 4000);
        return false;
      }
      await ctx.syncCore.loadSource({ ...source, resolvedUrl: url });
      if (chosen) applySubs(chosen, { type: source.type, id: source.streamId }, torrentMeta);
      else ctx.tracks.setTorrentSubs(null);
      notice(fromName ? `Following ${fromName}’s stream` : 'Following stream', 'ok', 4000);
      return true;
    } catch (err) {
      notice(`Could not follow: ${err.message || err}`, 'warn', 4000);
      return false;
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
  // A follower borrowing the sharer's add-on can search it too — but we never
  // put that URL in the input (it's a secret); we just say so.
  function activate() {
    const saved = getAddonUrl();
    if (saved) {
      $('stremio-url').value = saved;
      if (!manifest) loadAddon(saved);
    } else if (followAddon) {
      status('Following the host’s add-on — search a title to browse it, or paste your own above.', 'ok');
    } else {
      status('Paste a Stremio add-on URL (…/manifest.json) and press Load.');
    }
  }

  return { run, activate, followStream };
}
