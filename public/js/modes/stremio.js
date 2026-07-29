// Stremio mode — the browse experience from the approved mockup:
//
//   rail (search · All/Movies/TV · catalog · count)
//     → poster grid
//        → movie: stream picker drawer
//        → series: detail (backdrop + facts | season accordion)
//                   → episode: stream picker drawer
//   setup card when no add-on is loaded yet.
//
// Streams that carry a direct `url` (debrid-resolved) play as-is; streams with
// an `infoHash` fall back to the TorBox resolve flow. Playback is broadcast so
// peers re-resolve the same title with THEIR own add-on, and every browse step
// is mirrored to watchers (see modes/spectate.js).

import { $, spinner } from '../lib/dom.js';
import { getKey, resolveMagnet, infoHashToMagnet } from '../lib/torbox.js';

const ADDON_KEY = 'stremio_addon_url';
const SHARE_ACK_KEY = 'stremio_share_ack';
const getTmdbKey = () => (localStorage.getItem('tmdb_api_key') || '').trim();
const isSeries = (type) => type === 'series' || type === 'tv';
const IMG = (path, size = 'w300') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : '');

const SHARE_WARNING =
  'Heads up: sharing lets everyone in the room stream through YOUR debrid ' +
  'account — your add-on link carries its keys. It is shared only while they ' +
  'are here and is never saved on their devices. Share your add-on so keyless ' +
  'friends can follow?';

export function createStremio(ctx) {
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);
  let manifest = null;
  let catalogs = [];
  let filterType = 'all';
  let lastQuery = '';
  let current = null; // the title whose detail/picker is open
  let followAddon = null; // borrowed from the host — MEMORY ONLY, never stored

  const getAddonUrl = () => (localStorage.getItem(ADDON_KEY) || '').trim();
  const setAddonUrl = (url) => localStorage.setItem(ADDON_KEY, (url || '').trim());
  const getEffectiveAddon = () => getAddonUrl() || followAddon || '';

  const status = (text, kind = '') => {
    $('stremio-status').textContent = text || '';
    $('stremio-status').className = `hint rail-status ${kind}`;
  };
  const setCount = (text) => ($('stremio-count').innerHTML = text || '');

  // ---- panes ----
  function showPane(which) {
    $('stremio-panel').hidden = which !== 'browse';
    $('stremio-detail').hidden = which !== 'detail';
    $('stremio-setup').hidden = which !== 'setup';
    syncBackTrap(which !== 'browse');
  }

  // Browser Back pops the detail view instead of leaving the room.
  let backTrapped = false;
  function syncBackTrap(deep) {
    if (deep && !backTrapped) {
      try {
        history.pushState({ cowatchStremio: true }, '');
        backTrapped = true;
      } catch {}
    }
  }
  window.addEventListener?.('popstate', () => {
    if (!backTrapped) return;
    backTrapped = false;
    if (!$('picker').classList.contains('show')) {
      if (!$('stremio-detail').hidden) showPane('browse');
    } else {
      closePicker();
    }
  });

  // ---- browse-cast (host side of spectate) ----
  const castBrowse = (data) => {
    try {
      ctx.signaling.signal({ type: 'browse', data });
    } catch {}
  };
  const gridCast = (label, metas) => ({
    view: 'grid',
    label,
    items: metas.slice(0, 24).map((m) => ({
      name: m.name,
      poster: m.poster || '',
      year: m.year || '',
      kind: isSeries(m.type) ? 'Series' : 'Movie',
    })),
  });

  // ---- proxy + TMDb ----
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

  async function resolveIds(item) {
    const kind = isSeries(item.type) ? 'tv' : 'movie';
    let tmdbId = item.tmdbId ? String(item.tmdbId) : null;
    let baseId = item.id || null;
    if (!baseId && tmdbId) {
      const imdb = (await tmdb(`${kind}/${tmdbId}/external_ids`))?.imdb_id;
      baseId = imdb || `tmdb:${tmdbId}`;
    }
    if (!tmdbId && baseId) {
      if (baseId.startsWith('tmdb:')) tmdbId = baseId.slice(5).split(':')[0];
      else if (/^tt\d+/.test(baseId)) {
        const found = await tmdb(`find/${baseId.split(':')[0]}`, { external_source: 'imdb_id' });
        const hit = kind === 'tv' ? found?.tv_results?.[0] : found?.movie_results?.[0];
        tmdbId = hit ? String(hit.id) : null;
      }
    }
    return { baseId, tmdbId, kind };
  }

  // ---- add-on ----
  async function loadAddon(url) {
    setAddonUrl(url);
    manifest = null;
    catalogs = [];
    status('Loading add-on…');
    try {
      manifest = await fetchManifest();
      catalogs = (manifest.catalogs || []).filter((c) => c.type && c.id);
      const name = manifest.name || 'Add-on';
      $('stremio-addon').textContent = name;
      $('stremio-chip-name').textContent = name;
      $('stremio-chip').hidden = ctx.controls.getMode() !== 'stremio';
      buildCatalogSelect();
      showPane('browse');
      status(
        catalogs.length ? 'Loaded — browse a catalog, or search a title.' : 'Loaded — search a title above.',
        'ok'
      );
      if (catalogs.length) openCatalog(catalogs[0]);
    } catch (err) {
      status(`Could not load add-on: ${err.message || err}`, 'warn');
      showPane('setup');
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
  $('stremio-cancel').addEventListener('click', () => showPane('browse'));
  $('stremio-change').addEventListener('click', () => {
    $('stremio-url').value = getAddonUrl();
    showPane('setup');
  });
  $('stremio-chip').addEventListener('click', () => {
    $('stremio-url').value = getAddonUrl();
    showPane('setup');
  });
  $('stremio-catalog').addEventListener('change', () => {
    const v = $('stremio-catalog').value;
    if (v.startsWith('cat:')) openCatalog(catalogs[Number(v.slice(4))]);
    else status('Type a title above and press Search.');
  });

  // ---- discovery ----
  async function openCatalog(cat) {
    status(`Loading “${cat.name || cat.id}”…`);
    spinner(true);
    try {
      const data = await fetchCatalog(cat.type, cat.id);
      const metas = (data.metas || []).map((m) => ({
        name: m.name || m.title,
        poster: m.poster,
        backdrop: m.background || '',
        type: m.type || cat.type,
        id: m.id,
      }));
      renderGrid(metas);
      setCount(`<b>${metas.length}</b> titles · ${manifest?.name || 'add-on'}`);
      status('');
      castBrowse(gridCast(cat.name || cat.id, metas));
    } catch (err) {
      status(`Catalog failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  async function run(query) {
    lastQuery = query;
    if (!getEffectiveAddon()) {
      showPane('setup');
      status('Load a Stremio add-on first.', 'warn');
      return;
    }
    if (!getTmdbKey()) {
      status('Enter your TMDb API key (gear icon) to search titles.', 'warn');
      ctx.settings.openSettings(true);
      return;
    }
    showPane('browse');
    status('Searching…');
    spinner(true);
    try {
      const qs = new URLSearchParams({ query, type: filterType === 'all' ? 'all' : filterType });
      const res = await fetch(`/api/tmdb/search?${qs}`, { headers: { 'x-tmdb-key': getTmdbKey() } });
      const data = await res.json().catch(() => null);
      if (!data?.success) throw new Error(data?.detail || 'search failed');
      const metas = data.data.map((m) => ({
        name: m.title,
        poster: IMG(m.poster_path),
        backdrop: IMG(m.backdrop_path, 'w1280'),
        overview: m.overview || '',
        rating: m.vote_average || 0,
        type: m.type === 'tv' ? 'series' : 'movie',
        tmdbId: m.id,
        year: m.year,
      }));
      renderGrid(metas);
      setCount(`<b>${metas.length}</b> results · ${manifest?.name || 'add-on'}`);
      status('');
      castBrowse(gridCast(`Searching “${query}”`, metas));
    } catch (err) {
      status(`Search failed: ${err.message || err}`, 'warn');
    } finally {
      spinner(false);
    }
  }

  $('stremio-search-btn').addEventListener('click', () => {
    const q = $('stremio-search').value.trim();
    if (q) run(q);
  });
  $('stremio-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = $('stremio-search').value.trim();
    if (q) run(q);
  });
  $('stremio-type').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filterType = b.dataset.type;
    for (const x of $('stremio-type').querySelectorAll('button')) {
      x.setAttribute('aria-pressed', String(x === b));
    }
    if (lastQuery) run(lastQuery);
  });

  // ---- poster grid ----
  function renderGrid(items) {
    const grid = $('stremio-results');
    grid.replaceChildren();
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Nothing found.';
      grid.append(p);
      return;
    }
    for (const item of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'poster-card';
      card.title = item.name || '';

      const poster = document.createElement('div');
      poster.className = 'poster';
      if (item.poster) {
        const img = document.createElement('img');
        img.src = item.poster;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove(), { once: true });
        poster.append(img);
      }
      const kind = document.createElement('span');
      kind.className = 'badge-type';
      kind.textContent = isSeries(item.type) ? 'Series' : 'Movie';
      const hover = document.createElement('div');
      hover.className = 'hoverlay';
      const hoverLabel = document.createElement('span');
      hoverLabel.textContent = isSeries(item.type) ? 'Pick an episode' : 'Play for everyone';
      hover.append(hoverLabel);
      poster.append(kind, hover);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = item.name || 'Untitled';
      const y = document.createElement('div');
      y.className = 'y';
      y.textContent = item.year || '';
      meta.append(t, y);

      card.append(poster, meta);
      card.addEventListener('click', () => selectTitle(item));
      grid.append(card);
    }
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
      current = { ...item, baseId, tmdbId };
      status('');
      if (isSeries(item.type)) await openDetail(current);
      else await openPicker('movie', baseId, item.name, { kicker: 'Movie', art: item });
    } finally {
      spinner(false);
    }
  }

  // ---- series detail ----
  async function openDetail(item) {
    showPane('detail');
    $('detail-kind').textContent = 'Series';
    $('detail-title').textContent = item.name || 'Series';
    $('detail-overview').textContent = item.overview || '';
    $('detail-backdrop').style.backgroundImage = item.backdrop ? `url("${item.backdrop.replace(/"/g, '%22')}")` : '';
    $('detail-poster').replaceChildren();
    if (item.poster) {
      const img = document.createElement('img');
      img.src = item.poster;
      img.alt = '';
      $('detail-poster').append(img);
    }
    $('stremio-seasons').replaceChildren();
    $('detail-facts').replaceChildren();
    $('detail-season-count').textContent = '';

    const info = await loadSeasons(item.tmdbId);
    const seasons = info?.seasons || [];
    if (info?.overview) $('detail-overview').textContent = info.overview;
    if (info?.backdrop) $('detail-backdrop').style.backgroundImage = `url("${info.backdrop.replace(/"/g, '%22')}")`;

    const totalEps = seasons.reduce((n, s) => n + (s.count || 0), 0);
    const facts = [
      info?.years || item.year || '',
      seasons.length ? `${seasons.length} season${seasons.length === 1 ? '' : 's'} · ${totalEps} episodes` : '',
      info?.runtime ? `${info.runtime} min` : '',
    ].filter(Boolean);
    renderFacts(facts, info?.rating ?? item.rating);
    $('detail-season-count').textContent = seasons.length ? `${seasons.length} seasons` : '';

    if (!seasons.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.padding = '14px 16px';
      p.textContent = 'No season data — add a TMDb key under the gear to list episodes.';
      $('stremio-seasons').append(p);
      return;
    }
    const art = { backdrop: info?.backdrop || item.backdrop || '', poster: item.poster };
    // Open the first REAL season, not Specials (season 0 is often a huge dump
    // of featurettes, and it's never what you came to watch).
    const firstReal = seasons.findIndex((s) => s.number > 0);
    const openIdx = firstReal === -1 ? 0 : firstReal;
    seasons.forEach((s, i) => $('stremio-seasons').append(buildSeasonBlock(item, s, art, i === openIdx)));

    castBrowse({
      view: 'seasons',
      title: {
        name: item.name || 'Series',
        poster: item.poster || '',
        backdrop: art.backdrop,
        year: item.year || '',
        overview: (info?.overview || item.overview || '').slice(0, 300),
      },
      seasons: seasons.map((s) => ({ number: s.number, count: s.count })),
    });
  }

  function renderFacts(bits, rating) {
    const box = $('detail-facts');
    box.replaceChildren();
    bits.forEach((b, i) => {
      if (i) box.append(Object.assign(document.createElement('i'), { className: 'sep' }));
      box.append(Object.assign(document.createElement('span'), { textContent: b }));
    });
    if (rating) {
      if (bits.length) box.append(Object.assign(document.createElement('i'), { className: 'sep' }));
      const r = document.createElement('span');
      r.className = 'rating';
      r.textContent = `★ ${Number(rating).toFixed(1)}`;
      box.append(r);
    }
  }

  $('stremio-back').addEventListener('click', () => {
    if (backTrapped) history.back();
    else showPane('browse');
  });

  async function loadSeasons(tmdbId) {
    if (!tmdbId) return null;
    const tv = await tmdb(`tv/${tmdbId}`);
    if (!tv?.seasons) return null;
    const first = (tv.first_air_date || '').split('-')[0];
    const last = (tv.last_air_date || '').split('-')[0];
    return {
      seasons: tv.seasons
        .filter((s) => (s.episode_count || 0) > 0)
        .map((s) => ({ number: s.season_number, count: s.episode_count, name: s.name, overview: s.overview })),
      backdrop: IMG(tv.backdrop_path, 'w1280'),
      overview: tv.overview || '',
      rating: tv.vote_average || 0,
      runtime: Array.isArray(tv.episode_run_time) ? tv.episode_run_time[0] : 0,
      years: first ? (last && last !== first ? `${first}–${last}` : first) : '',
    };
  }

  async function loadEpisodes(tmdbId, seasonNumber, count) {
    const data = tmdbId ? await tmdb(`tv/${tmdbId}/season/${seasonNumber}`) : null;
    if (data?.episodes?.length) {
      return data.episodes.map((e) => ({
        number: e.episode_number,
        name: e.name,
        air: e.air_date,
        overview: e.overview,
        still: e.still_path,
        runtime: e.runtime,
      }));
    }
    return Array.from({ length: count }, (_, i) => ({ number: i + 1, name: '' }));
  }

  function buildSeasonBlock(item, s, art, openFirst) {
    const block = document.createElement('div');
    block.className = `season${openFirst ? ' open' : ''}`;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'season-head';
    head.innerHTML =
      '<svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = s.number === 0 ? 'Specials' : `Season ${s.number}`;
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = `${s.count} episode${s.count === 1 ? '' : 's'}`;
    head.append(n, c);

    const eps = document.createElement('div');
    eps.className = 'eps';
    let loaded = false;

    const fill = async () => {
      if (loaded) return;
      loaded = true;
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.padding = '8px';
      p.textContent = 'Loading episodes…';
      eps.append(p);
      const list = await loadEpisodes(item.tmdbId, s.number, s.count);
      eps.replaceChildren();
      for (const ep of list) eps.append(buildEpisodeRow(item, s.number, ep, art));
      castBrowse({
        view: 'episodes',
        title: { name: item.name, backdrop: art.backdrop || '' },
        season: s.number,
        episodes: list.slice(0, 40).map((e) => ({
          number: e.number,
          name: e.name || '',
          air: e.air || '',
          still: e.still || '',
          runtime: e.runtime || 0,
          overview: (e.overview || '').slice(0, 220),
        })),
      });
    };

    head.addEventListener('click', () => {
      const open = block.classList.toggle('open');
      if (open) fill();
    });
    if (openFirst) fill();

    block.append(head, eps);
    return block;
  }

  function buildEpisodeRow(item, season, ep, art) {
    const future = !!ep.air && ep.air > new Date().toISOString().slice(0, 10);
    const row = document.createElement('div');
    row.className = `ep${future ? ' locked' : ''}`;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (ep.still) {
      const img = document.createElement('img');
      img.src = IMG(ep.still, 'w185');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { img.remove(); thumb.textContent = `${season}·${ep.number}`; }, { once: true });
      thumb.append(img);
    } else {
      thumb.textContent = `${season}·${ep.number}`;
    }

    const meta = document.createElement('div');
    meta.className = 'ep-meta';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = `${ep.number}. ${ep.name || `Episode ${ep.number}`}`;
    t.title = t.textContent;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = [future ? `Airs ${ep.air}` : ep.air, ep.runtime ? `${ep.runtime} min` : ''].filter(Boolean).join(' · ');
    meta.append(t, d);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'streams-btn';
    btn.textContent = future ? 'Not out' : 'Streams';
    btn.disabled = future;
    if (!future) {
      btn.addEventListener('click', () =>
        openPicker('series', `${item.baseId}:${season}:${ep.number}`, item.name, {
          kicker: `S${season} · E${ep.number}`,
          episodeTitle: ep.name,
          art,
        })
      );
    }

    row.append(thumb, meta, btn);
    return row;
  }

  // ---- stream picker (drawer) ----
  let pickerMeta = null;
  // What's on screen right now, so the CC panel can offer other audio options.
  let playing = null; // { streams, meta, streamKey }

  // Stream `name` is NOT unique (dozens share "⚡ 4K BluRay"), so identify a
  // release by its actual source.
  const streamKey = (s) =>
    s?.url || s?.infoHash || `${s?.name || ''}|${(s?.description || s?.title || '').slice(0, 80)}`;

  // Chrome/Firefox don't expose a media element's embedded audioTracks, so for
  // debrid files "switch audio track" really means "play the release that
  // carries that language". These are the alternatives for the CURRENT title,
  // one entry per language, resuming at the same timestamp.
  // Release tags that ride in the language field but aren't a language.
  const NON_LANG = new Set(['Unknown', 'Dubbed', 'Subbed', 'Dual', 'Original', 'Audio']);

  // Which audio can you ACTUALLY get in this browser?
  //
  // A file's FIRST listed language is the track the player defaults to, and
  // without audioTracks we cannot select any other track inside that file. So
  // an option is only real when some release LEADS with that language —
  // offering "Japanese" because a mostly-English file happens to contain a
  // Japanese track would load a different file and still play English.
  // Verified against the live add-on: all 43 Inception releases lead with
  // English, so the honest answer there is "English (+ Multi)", not 20 links.
  //
  // Returns { options, alsoInFile } — the latter is informational only.
  function getAudioOptions() {
    // Repaired playback is the one case where the tracks inside the file are
    // actually reachable: ffmpeg picks the track, so switching means re-running
    // the repair on a different one rather than loading a whole other release.
    if (playing?.source?.transcode && playing.fileTracks?.length > 1) {
      const seen = new Map();
      return {
        inFile: true, // these are tracks of ONE file, not separate releases
        options: playing.fileTracks.map((t) => {
          // switchAudio finds an option by its label, so two Japanese tracks
          // have to end up with different names or the second is unreachable.
          const base = t.label || t.lang || `Track ${t.index}`;
          const n = (seen.get(base) || 0) + 1;
          seen.set(base, n);
          return {
            lang: n > 1 ? `${base} (${n})` : base,
            trackIndex: t.index,
            audio: `${t.codec.toUpperCase()}${t.channels ? ` ${t.channels}` : ''}`,
            warn: false,
            current: t.index === playing.source.audioIndex,
          };
        }),
        alsoInFile: [],
      };
    }
    if (!playing?.streams?.length) return { options: [], alsoInFile: [] };
    const byLang = new Map();
    for (const s of playing.streams) {
      const f = streamFacts(s);
      const lead = f.langs[0];
      if (!lead || NON_LANG.has(lead)) continue; // only leading languages are selectable
      const cand = { lang: lead, stream: s, warn: f.warn, audio: f.audio, q: f.q, rank: audioRank(s) };
      const prev = byLang.get(lead);
      // Prefer the most widely audible release: AAC > Dolby-here > unknown.
      if (!prev || cand.rank < prev.rank) byLang.set(lead, cand);
    }
    const live = playing.streams.find((s) => streamKey(s) === playing.streamKey);
    const liveLangs = live ? streamLangs(live) : [];
    return {
      options: [...byLang.values()].map((o) => ({
        ...o,
        current: streamKey(o.stream) === playing.streamKey,
      })),
      // Extra tracks sitting inside the file we're playing — real, but not
      // reachable from a browser that hides audioTracks.
      alsoInFile: liveLangs.slice(1).filter((l) => !NON_LANG.has(l)),
    };
  }

  // Swap the playing stream, keeping everyone's position.
  async function switchAudio(lang) {
    const opt = getAudioOptions().options.find((o) => o.lang === lang);
    if (!opt || !playing) return false;
    if (opt.current) return false; // already this release — nothing to swap
    let at = 0;
    try {
      at = (await ctx.syncCore.getPlayer()?.getTime()) || 0;
    } catch {}
    notice(`Switching audio to ${lang}…`);

    // Same file, different track: re-run the repair from where we are.
    if (Number.isInteger(opt.trackIndex)) {
      const source = { ...playing.source, audioIndex: opt.trackIndex, startAt: at };
      playing = { ...playing, source };
      await ctx.syncCore.loadSource(source);
      ctx.signaling.signal({ type: 'sync-load', source });
      notice(`Audio: ${lang}`, 'ok', 3000);
      return true;
    }

    try {
      const { url, torrentMeta } = await resolveStream(opt.stream, () => {});
      if (!url) throw new Error('no playable source');
      const source = {
        kind: 'stremio',
        type: playing.meta.type,
        streamId: playing.meta.id,
        name: opt.stream.name || opt.stream.title || '',
        title: pickerMeta?.title || playing.meta.title || '',
        resolvedUrl: url,
      };
      const shareAddon = addonToShare();
      if (shareAddon) source.addonUrl = shareAddon;
      await ctx.syncCore.loadSource(source);
      playing = { ...playing, streamKey: streamKey(opt.stream) };
      const p = ctx.syncCore.getPlayer();
      if (p && at > 1) {
        p.seek(at); // land where we left off (and tell the room)
        ctx.signaling.signal({ type: 'sync', action: 'seek', time: at, rate: 1 });
      }
      applySubs(opt.stream, playing.meta, torrentMeta);
      ctx.signaling.signal({ type: 'sync-load', source });
      notice(`Audio: ${lang}`, 'ok', 3000);
      return true;
    } catch (err) {
      notice(`Could not switch audio: ${err.message || err}`, 'error', 5000);
      return false;
    }
  }

  async function openPicker(type, id, title, opts = {}) {
    pickerMeta = { type, id, title: opts.episodeTitle ? `${title} · ${opts.episodeTitle}` : title, art: opts.art };
    $('picker-kicker').textContent = opts.kicker || 'Streams';
    $('picker-title').textContent = opts.episodeTitle || title;
    $('picker-sub').textContent = 'Fetching streams…';
    $('picker-list').replaceChildren();
    $('picker').classList.add('show');
    $('scrim').classList.add('show');
    syncBackTrap(true);
    spinner(true);
    try {
      const data = await fetchStreams(type, id);
      const streams = data.streams || [];
      const ranked = streams
        .map((s, i) => ({ s, i, r: audioRank(s) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.s);
      renderPicker(ranked);
      pickerMeta.streams = ranked; // kept so the CC panel can offer other languages
      $('picker-sub').textContent = `${ranked.length} stream${ranked.length === 1 ? '' : 's'} · sorted by browser compatibility`;
      castBrowse({
        view: 'streams',
        title: pickerMeta.title,
        backdrop: opts.art?.backdrop || '',
        streams: ranked.slice(0, 30).map((s) => {
          const f = streamFacts(s);
          return {
            name: f.src,
            desc: [f.size, f.audio, f.peers ? `${f.peers} peers` : ''].filter(Boolean).join(' · '),
            tags: f.q ? [{ label: f.q, cls: 'res' }] : [],
            warn: f.warn,
          };
        }),
      });
    } catch (err) {
      $('picker-sub').textContent = 'Could not load streams.';
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.padding = '10px';
      p.textContent = String(err.message || err);
      $('picker-list').append(p);
    } finally {
      spinner(false);
    }
  }

  function closePicker() {
    $('picker').classList.remove('show');
    $('scrim').classList.remove('show');
  }
  $('picker-close').addEventListener('click', closePicker);
  $('scrim').addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
  });

  function renderPicker(streams) {
    const list = $('picker-list');
    list.replaceChildren();
    if (!streams.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.padding = '10px';
      p.textContent = 'No streams available for this title.';
      list.append(p);
      return;
    }
    const ok = streams.filter((s) => audioRank(s) !== SILENT);
    const bad = streams.filter((s) => audioRank(s) === SILENT);
    const universal = ok.filter((s) => audioRank(s) === 0).length;

    if (!ok.length) {
      const banner = document.createElement('div');
      banner.className = 'audio-banner';
      banner.textContent = browserPlaysDolby()
        ? 'None of these are confirmed to have browser-playable audio — most are DTS/lossless, so expect many to play silently.'
        : 'None of these have confirmed sound in this browser — the files use Dolby/DTS audio Chrome & Firefox can’t decode (the picture plays, but silent). Dolby (DD / DD+) streams DO play in Microsoft Edge or Safari.';
      list.append(banner);
    } else if (universal) {
      const tip = document.createElement('p');
      tip.className = 'hint';
      tip.style.padding = '4px 8px 0';
      tip.textContent = `${universal} stream${universal === 1 ? '' : 's'} use AAC — the only audio every device in the room can hear. Those are listed first.`;
      list.append(tip);
    } else {
      // Nothing here is universally audible. Say what actually works instead of
      // leaving people to guess why one person hears it and another doesn't.
      const tip = document.createElement('div');
      tip.className = 'audio-banner';
      tip.textContent = browserPlaysDolby()
        ? 'No release here uses AAC, so sound depends on each person’s browser: the Dolby ones play for you, but stay silent for anyone on Chrome or Firefox. For sound everyone hears, play it in a desktop player and use Share instead.'
        : 'No release here uses AAC, and this browser can’t decode Dolby — so these will play silently for you (Safari and Edge can). For sound everyone hears, play it in a desktop player and use Share instead.';
      list.append(tip);
    }
    for (const s of ok) list.append(buildStreamRow(s));
    if (bad.length) {
      const label = document.createElement('div');
      label.className = 'group-label';
      const span = document.createElement('span');
      span.className = 'label';
      span.textContent = "Won't play in browser";
      label.append(span);
      list.append(label);
      for (const s of bad) list.append(buildStreamRow(s));
    }
  }

  function buildStreamRow(stream) {
    const f = streamFacts(stream);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `stream${f.warn ? ' warned' : ''}`;

    const q = document.createElement('span');
    q.className = 'q';
    q.textContent = f.q || '—';

    const meta = document.createElement('span');
    meta.className = 's-meta';
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = f.src;
    src.title = f.src;
    const rowLine = document.createElement('span');
    rowLine.className = 'row';
    const add = (text, cls) => {
      if (!text) return;
      const el = document.createElement('span');
      if (cls) el.className = cls;
      el.textContent = text;
      rowLine.append(el);
    };
    add(f.size);
    if (f.audio) {
      const a = document.createElement('span');
      a.textContent = f.audio;
      if (f.warn) {
        const w = document.createElement('span');
        w.className = 'warn';
        w.textContent = ' ⚠ no browser audio';
        a.append(w);
      } else if (f.hereOnly) {
        // Dolby this browser decodes — but a Windows/Chrome viewer won't.
        const w = document.createElement('span');
        w.className = 'here-only';
        w.textContent = ' · sound on this device only';
        a.append(w);
      }
      rowLine.append(a);
    }
    if (f.langs.length) {
      const l = document.createElement('span');
      l.className = 'langs';
      l.textContent = `🌐 ${f.langs.slice(0, 3).join(', ')}${f.langs.length > 3 ? ` +${f.langs.length - 3}` : ''}`;
      l.title = f.langs.join(', ');
      rowLine.append(l);
    }
    add(f.peers ? `${f.peers} peers` : '');
    if (f.cached) add('cached', 'tag cached');
    meta.append(src, rowLine);

    const play = document.createElement('span');
    play.className = 'play';
    play.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

    row.append(q, meta, play);
    row.addEventListener('click', () => play_(stream, row));

    // Offer the server-side repair on anything not proven to work as-is. It
    // decodes Dolby/DTS to AAC and remuxes to MP4, so it fixes both the silent
    // codec AND the .mkv container Safari can't open at all.
    //
    // Crucially this includes UNADVERTISED audio (rank 2). Most add-on results
    // never name their codec, so gating the button on a known-bad codec meant
    // that on a whole page of releases — the common case — it never appeared.
    if (f.repair) {
      const fix = document.createElement('span');
      fix.className = 'fix-audio';
      fix.setAttribute('role', 'button');
      fix.tabIndex = 0;
      fix.textContent = f.repairLabel;
      fix.title = f.repairWhy;
      const go = (e) => {
        e.stopPropagation(); // don't also trigger the row's normal play
        play_(stream, row, { transcode: true });
      };
      fix.addEventListener('click', go);
      fix.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') go(e);
      });
      row.insertBefore(fix, play);
    }
    return row;
  }

  // ---- stream metadata ----
  const streamText = (s) => `${s.name || ''} ${s.description || s.title || ''}`;

  // Audio languages. Add-ons list them after a 🌐 marker, bullet-separated and
  // terminated by the next emoji field (e.g. "🌐 English • Ukrainian • 🛰️ Comet").
  const LANG_WORD = /^[A-Z][a-zA-Z-]{2,}(?:\s\([^)]+\))?$/;
  function streamLangs(stream) {
    const raw = `${stream.description || stream.title || ''}`;
    const seg = raw.match(/🌐([^\n|]*)/);
    const out = [];
    if (seg) {
      for (const part of seg[1].split(/[•·,]/)) {
        const t = part.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
        if (t && LANG_WORD.test(t) && !out.includes(t)) out.push(t);
      }
    }
    if (!out.length && /\bmulti\b/i.test(raw)) out.push('Multi');
    return out;
  }

  function streamFacts(stream) {
    const text = streamText(stream);
    const res = text.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
    const size = text.match(/(\d+(?:\.\d+)?)\s?(gb|mb)\b/i);
    const peers = text.match(/👤\s?(\d+)/);
    let audio = '';
    if (/\batmos\b/i.test(text)) audio = 'Atmos';
    else if (/\btrue-?hd\b/i.test(text)) audio = 'TrueHD';
    else if (/\bdts-?x\b/i.test(text)) audio = 'DTS:X';
    else if (/\bdts(-hd)?(\s?ma)?\b/i.test(text)) audio = 'DTS-HD';
    else if (/\be-?ac-?3\b|\beac3\b|\bdd\s?\+|\bddp\b/i.test(text)) audio = 'DD+';
    else if (/\bac-?3\b|\bdd\b|dolby\s?digital/i.test(text)) audio = 'DD';
    else if (/\baac\b/i.test(text)) audio = 'AAC';
    return {
      q: res ? (/4k/i.test(res[1]) ? '4K' : res[1].toLowerCase()) : '',
      size: size ? `${size[1]} ${size[2].toUpperCase()}` : '',
      audio,
      langs: streamLangs(stream),
      peers: peers ? peers[1] : '',
      cached: !!stream.url, // debrid-resolved direct links start instantly
      warn: audioRank(stream) === SILENT,
      hereOnly: audioRank(stream) === 1, // Dolby: fine here, silent for some peers
      ...repairOffer(stream, text),
      src: (stream.description || stream.title || stream.name || 'Stream')
        .split('\n')[0]
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90),
    };
  }

  // What audio can THIS browser decode? Dolby (AC-3/E-AC-3) ships in Edge &
  // Safari but not Chrome/Firefox; DTS/TrueHD ship nowhere. Debrid files are
  // almost all Dolby/DTS, which is why "no sound" is the norm on Chrome.
  let _audioSupport = null;
  function audioSupport() {
    if (_audioSupport) return _audioSupport;
    let v;
    try {
      v = document.createElement('video');
    } catch {
      v = null;
    }
    const can = (codec) => {
      if (!v?.canPlayType) return false;
      const r = v.canPlayType(`audio/mp4; codecs="${codec}"`);
      return r === 'probably' || r === 'maybe';
    };
    _audioSupport = { ac3: can('ac-3'), eac3: can('ec-3') };
    return _audioSupport;
  }
  const browserPlaysDolby = () => audioSupport().ac3 || audioSupport().eac3;

  // Rank for a WATCH-TOGETHER room, not just this machine:
  //   0 — universal (AAC/Opus/MP3/FLAC): every device in the room hears it.
  //   1 — Dolby this browser happens to decode: fine here, silent for someone
  //       on a platform without Dolby (Windows Chrome most notably).
  //   2 — no codec advertised: unknown.
  //   3 — silent in THIS browser (DTS/TrueHD/Atmos, or Dolby without support).
  // Sorting on this puts the "everyone can hear it" releases at the top.
  function audioRank(stream) {
    const text = streamText(stream);
    const sup = audioSupport();
    if (/\bdts(-hd)?(\s?ma)?\b|\bdts-?x\b|\btrue-?hd\b|\batmos\b/i.test(text)) return 3; // ~no browser
    if (/\baac\b|\bopus\b|\bmp3\b|\bvorbis\b|\bflac\b/i.test(text)) return 0; // plays everywhere
    if (/\be-?ac-?3\b|\beac3\b|\bdd\s?\+|\bddp\b/i.test(text)) return sup.eac3 ? 1 : 3;
    if (/\bac-?3\b|\bdd\b|dolby\s?digital/i.test(text)) return sup.ac3 ? 1 : 3;
    return 2; // unadvertised — could be anything
  }
  const SILENT = 3;

  // Safari has no Matroska support at all — container, not codec — so a .mkv
  // won't open there even when its audio is plain AAC.
  const isSafari = () =>
    /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent || '');

  // Should this row offer the server-side repair, and what do we call it?
  // Only a release we can positively confirm plays here as-is (rank 0, and not
  // an .mkv on Safari) is left alone.
  function repairOffer(stream, text) {
    const rank = audioRank(stream);
    // The filename usually only appears in the resolved URL or behaviorHints,
    // not in the human-readable description.
    const mkv = /\bmkv\b|\.mkv\b/i.test(
      `${text} ${stream.url || ''} ${stream.behaviorHints?.filename || ''}`
    );
    if (mkv && isSafari()) {
      return {
        repair: true,
        repairLabel: 'Fix playback',
        repairWhy:
          'Safari cannot open .mkv files. The server repackages this one to MP4 (and converts the audio to AAC) as it plays.',
      };
    }
    if (rank === 0) return { repair: false, repairLabel: '', repairWhy: '' };
    const why =
      rank === SILENT
        ? 'This release’s audio is a codec your browser can’t decode, so it would play silently.'
        : rank === 1
          ? 'This plays for you, but stays silent for anyone on Chrome or Firefox.'
          : 'This release doesn’t say what audio it uses, so it may well play silently.';
    return {
      repair: true,
      repairLabel: 'Fix audio',
      repairWhy: `${why} The server converts the audio to AAC as it plays, so everyone hears it (uses your upload bandwidth).`,
    };
  }

  // ---- playback ----
  function addonToShare() {
    const own = getAddonUrl();
    if (!own) return '';
    if (localStorage.getItem(SHARE_ACK_KEY)) return own;
    const ok = typeof window.confirm === 'function' && window.confirm(SHARE_WARNING);
    if (ok) {
      localStorage.setItem(SHARE_ACK_KEY, '1');
      return own;
    }
    return '';
  }

  async function play_(stream, row, { transcode = false } = {}) {
    row.disabled = true;
    const q = row.querySelector('.q');
    const was = q ? q.textContent : '';
    if (q) q.textContent = '…';
    let fileTracks = []; // audio tracks probe found INSIDE the file (repair only)
    try {
      const { url, torrentMeta } = await resolveStream(stream, (p) => {
        if (q) q.textContent = `${Math.round(p * 100)}%`;
      });
      if (!url) {
        notice('This stream has no playable source.', 'warn', 4000);
        return;
      }
      const source = {
        kind: 'stremio',
        type: pickerMeta.type,
        streamId: pickerMeta.id,
        name: stream.name || stream.title || '',
        title: pickerMeta.title,
        resolvedUrl: url,
      };
      if (transcode) {
        // A piped fMP4 carries no duration, so probe it first — the scrubber
        // needs a total to be usable at all.
        if (q) q.textContent = '⋯';
        source.transcode = true;
        // Probe first. It's the only chance to fail LOUDLY: once we hand the
        // URL to <video>, an unopenable source just looks like a black screen.
        try {
          const r = await fetch(`/api/transcode/probe?url=${encodeURIComponent(url)}`);
          const j = await r.json();
          if (j && j.ok === false) {
            // ▶ still works: the browser may well be able to fetch a link the
            // server can't, it just won't have sound.
            notice(
              `Can’t repair this one — ${j.detail || 'the server could not open it'}. Press ▶ to play it unrepaired.`,
              'error',
              9000
            );
            return;
          }
          if (j?.duration) source.duration = j.duration;
          if (j?.via === 'proxy') source.via = 'proxy';
          // Probe reads the real track list out of the file, so we can pick
          // English rather than whatever happens to be track 0.
          if (Number.isInteger(j?.audioIndex) && j.audioIndex >= 0) source.audioIndex = j.audioIndex;
          fileTracks = Array.isArray(j?.tracks) ? j.tracks : [];
          if (fileTracks.length > 1) {
            const picked = fileTracks.find((t) => t.index === source.audioIndex);
            if (picked?.label) notice(`Repairing audio · ${picked.label}`, '', 3000);
          }
        } catch {
          // no duration — playback still works, the scrubber just shows —:—
        }
      }
      const shareAddon = addonToShare();
      if (shareAddon) source.addonUrl = shareAddon;
      rememberMeta(source);
      playing = {
        streams: pickerMeta.streams || [],
        meta: { type: pickerMeta.type, id: pickerMeta.id, title: pickerMeta.title },
        streamKey: streamKey(stream),
        // Repaired playback can switch tracks WITHIN this file — the browser
        // can't, which is why the audio menu normally has to swap releases.
        source,
        fileTracks,
      };
      closePicker();
      await ctx.syncCore.loadSource(source); // switches to the watch view
      applySubs(stream, { type: pickerMeta.type, id: pickerMeta.id }, torrentMeta);
      castBrowse({ view: 'none' });
      ctx.signaling.signal({ type: 'sync-load', source });
      notice(`Playing ${pickerMeta.title} for everyone`, 'ok', 4000);
    } catch (err) {
      notice(`Playback failed: ${err.message || err}`, 'error', 5000);
    } finally {
      row.disabled = false;
      if (q) q.textContent = was;
    }
  }

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

  // Subtitles into the CC panel: torrent .srt/.vtt (infoHash path), a stream's
  // own subtitles[], and the add-on's /subtitles resource.
  async function applySubs(stream, meta, torrentMeta) {
    ctx.tracks.setTorrentSubs(torrentMeta || null);
    const subs = [];
    const push = (s) => {
      if (s?.url) subs.push({ lang: s.lang || s.language || s.id || 'Subtitle', url: s.url });
    };
    for (const s of stream.subtitles || []) push(s);
    try {
      const data = await proxy('subtitles', { type: meta.type, id: meta.id });
      for (const s of data?.subtitles || []) push(s);
    } catch {
      // add-on has no /subtitles resource for this id — fine
    }
    const seen = new Set();
    ctx.tracks.setAddonSubs(subs.filter((s) => (seen.has(s.url) ? false : seen.add(s.url))));
    ctx.tracks.renderTracksPanel();
  }

  // ---- watcher side ----
  async function followStream(source, fromName) {
    if (!getAddonUrl() && source.addonUrl) followAddon = source.addonUrl; // borrow, in memory only
    if (!getEffectiveAddon()) {
      notice('Load your Stremio add-on (Stremio tab) to follow this stream.', 'warn');
      return false;
    }
    try {
      let url = null;
      let torrentMeta = null;
      let chosen = null;
      let streams = [];
      try {
        const data = await fetchStreams(source.type, source.streamId);
        streams = data.streams || [];
        chosen =
          streams.find((s) => s.name === source.name && (s.url || s.infoHash)) ||
          streams.find((s) => s.url || s.infoHash) ||
          null;
        if (chosen) ({ url, torrentMeta } = await resolveStream(chosen, () => {}));
      } catch {
        // fall through to the sharer's URL
      }
      if (!url && source.resolvedUrl) url = source.resolvedUrl;
      if (!url) {
        notice('Could not resolve this stream from the add-on.', 'warn', 4000);
        return false;
      }
      await ctx.syncCore.loadSource({ ...source, resolvedUrl: url });
      // Watchers get the same audio-language choices as the host.
      playing = {
        streams,
        meta: { type: source.type, id: source.streamId, title: source.title },
        streamKey: chosen ? streamKey(chosen) : '',
      };
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
    } catch {}
  }

  // Called when the Stremio tab is opened.
  function activate() {
    const saved = getAddonUrl();
    $('stremio-chip').hidden = false;
    if (saved) {
      $('stremio-chip-name').textContent = manifest?.name || 'Add-on';
      if (!manifest) loadAddon(saved);
      else showPane('browse');
    } else if (followAddon) {
      $('stremio-chip-name').textContent = 'Host’s add-on';
      showPane('browse');
      status('Following the host’s add-on — search a title to browse it.', 'ok');
    } else {
      $('stremio-chip-name').textContent = 'No add-on';
      showPane('setup');
    }
  }

  return { run, activate, followStream, getAudioOptions, switchAudio };
}
