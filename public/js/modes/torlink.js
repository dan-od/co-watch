// Torlink source mode: torrent search (YTS movies + EZTV TV) → magnet →
// resolve/stream through the user's own TorBox account. Shows each result's
// cache status and, for uncached picks, downloads to TorBox with a live
// progress bar before streaming. TV (type='tv') comes back GROUPED by season —
// collapsible season blocks with per-episode rows — while movies / "All" stay
// a flat list. Every row (episode or movie) keeps the cache badge + progress.

import { $, spinner } from '../lib/dom.js';
import { torboxPost, getKey, resolveMagnet } from '../lib/torbox.js';

// Server returns season blocks ({season, episodes[], …}) for grouped TV.
const isGrouped = (r) => Array.isArray(r) && r[0] && Array.isArray(r[0].episodes) && r[0].season !== undefined;

export function createTorlink(ctx) {
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);

  async function search(query, type = 'all') {
    // Send the TMDb key in a header (kept out of the URL/logs) so the server can
    // resolve a TV title → imdb_id + seasons for EZTV.
    const headers = {};
    const tmdbKey = (localStorage.getItem('tmdb_api_key') || '').trim();
    if (tmdbKey) headers['x-tmdb-key'] = tmdbKey;
    const res = await fetch(`/api/search/torrents?q=${encodeURIComponent(query)}&type=${type}`, { headers });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.detail || `search failed (HTTP ${res.status})`);
    return data.data || [];
  }

  // Ask TorBox which of these hashes are cached; annotate the items in place
  // (works for a flat list or the flattened episodes of grouped seasons).
  async function enrich(flat) {
    const apiKey = getKey();
    const hashes = flat.map((r) => r.hash).filter(Boolean);
    let checked = false;
    let map = {};
    if (apiKey && hashes.length) {
      try {
        const data = await torboxPost('/torbox/checkcached', { apiKey, hashes });
        map = data?.data || {};
        checked = true;
      } catch {
        checked = false;
      }
    }
    for (const it of flat) {
      it.cached = !!map[it.hash];
      it.cacheChecked = checked;
    }
    return { checked, cached: flat.filter((i) => i.cached).length };
  }

  // Build one result row (used for both movies and TV episodes): name/meta,
  // cache badge, stream button, and a hidden progress bar.
  function buildItemRow(item) {
    const row = document.createElement('div');
    row.className = 'torrent-item';
    row.dataset.hash = item.hash;

    const head = document.createElement('div');
    head.className = 'torrent-row-head';

    const info = document.createElement('div');
    info.className = 'torrent-info';
    const name = document.createElement('span');
    name.className = 'torrent-name';
    name.textContent = item.name;
    name.title = item.name;
    const meta = document.createElement('span');
    meta.className = 'torrent-meta';
    meta.textContent = `${item.source || '?'} · ${item.size || 'N/A'} · ${item.seeders || 0} seeders`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'torrent-actions';
    const badge = document.createElement('span');
    badge.className = 'cache-badge';
    if (!item.cacheChecked) {
      badge.textContent = '🔑 add key';
      badge.title = 'Add your TorBox API key to check cache status';
      badge.style.color = 'var(--dim)';
    } else if (item.cached) {
      badge.textContent = '✅ cached';
      badge.style.color = 'var(--ok)';
    } else {
      badge.textContent = '⏳ not cached';
      badge.style.color = 'var(--accent)';
    }
    const loadBtn = document.createElement('button');
    loadBtn.className = 'primary';
    loadBtn.textContent = item.cached ? 'Stream' : 'Download & stream';
    actions.append(badge, loadBtn);
    head.append(info, actions);

    const progress = document.createElement('div');
    progress.className = 'progress-container';
    progress.hidden = true;
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('i');
    bar.append(fill);
    const pct = document.createElement('span');
    pct.className = 'progress-text';
    pct.textContent = '0%';
    progress.append(bar, pct);

    row.append(head, progress);
    loadBtn.addEventListener('click', () => streamItem(item, { badge, loadBtn, progress, fill, pct }));
    return row;
  }

  function buildSeasonBlock(season) {
    const block = document.createElement('div');
    block.className = 'season-block';

    const header = document.createElement('div');
    header.className = 'season-header';
    if (season.seasonOverview) header.title = season.seasonOverview;
    const title = document.createElement('span');
    title.className = 'season-title';
    title.textContent = season.season === 0 ? 'Specials' : `Season ${season.season}`;
    const count = document.createElement('span');
    count.className = 'season-count';
    count.textContent = `${season.episodes.length} torrents`;
    const toggle = document.createElement('button');
    toggle.className = 'season-toggle ghost';
    toggle.textContent = '▸';
    header.append(title, count, toggle);

    const epList = document.createElement('div');
    epList.className = 'episode-list';
    epList.hidden = true; // collapsed by default (a show can have hundreds of rows)
    for (const ep of season.episodes) epList.append(buildItemRow(ep));

    const toggleOpen = () => {
      epList.hidden = !epList.hidden;
      toggle.textContent = epList.hidden ? '▸' : '▾';
    };
    header.addEventListener('click', (e) => {
      if (e.target !== toggle) toggleOpen(); // toggle button handles its own click
    });
    toggle.addEventListener('click', toggleOpen);

    block.append(header, epList);
    return block;
  }

  function renderResults(results, container) {
    container.replaceChildren();
    if (!results || !results.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No torrents found. Try a different title (or the exact TMDb title).';
      container.append(p);
      return;
    }
    if (isGrouped(results)) {
      for (const season of results) container.append(buildSeasonBlock(season));
    } else {
      const list = document.createElement('div');
      list.className = 'torrent-list';
      for (const item of results) list.append(buildItemRow(item));
      container.append(list);
    }
  }

  // One-click: add to TorBox → (wait for cache if needed) → resolve stream URL →
  // play locally + broadcast to the peers.
  async function streamItem(item, ui) {
    const { badge, loadBtn, progress, fill, pct } = ui;
    if (!item.magnet) {
      notice('No magnet link available.', 'warn', 3000);
      return;
    }
    const apiKey = getKey();
    if (!apiKey) {
      notice('Enter your TorBox API key (gear icon) to resolve magnets.', 'warn', 3000);
      ctx.settings.openSettings(true);
      return;
    }

    loadBtn.disabled = true;
    loadBtn.textContent = 'Starting…';
    try {
      // Shared resolve: add magnet → wait for cache/finish (0–1 progress) →
      // largest video → stream URL. Same flow the Stremio infoHash path uses.
      let downloading = false;
      const { streamUrl, fileName } = await resolveMagnet(apiKey, item.magnet, item.hash, {
        onProgress: (p) => {
          if (!downloading) {
            downloading = true;
            progress.hidden = false;
            badge.textContent = '⏳ downloading';
            badge.style.color = 'var(--accent)';
            loadBtn.textContent = 'Downloading…';
          }
          const pc = Math.round((p || 0) * 100);
          fill.style.width = `${pc}%`;
          pct.textContent = `${pc}%`;
        },
      });
      progress.hidden = true;

      // magnet + fileName let each peer re-resolve with their own key
      // (TorBox stream URLs are IP-locked); resolvedUrl is our local play.
      const source = {
        kind: 'torbox',
        magnet: item.magnet,
        hash: item.hash,
        fileName,
        resolvedUrl: streamUrl,
      };
      rememberMeta(item);
      await ctx.syncCore.loadSource(source);
      ctx.signaling.signal({ type: 'sync-load', source });
      ctx.search.showKnownMeta(item.hash);
      ctx.syncMode.setSourceMode('torbox'); // reveal the player (hide the torlink panel)

      badge.textContent = '✅ cached';
      badge.style.color = 'var(--ok)';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Stream';
      notice(`Streaming: ${item.name}`, 'ok', 4000);
    } catch (err) {
      notice(`TorBox: ${err.message || err}`, 'error', 5000);
      progress.hidden = true;
      loadBtn.disabled = false;
      loadBtn.textContent = 'Retry';
    }
  }

  function rememberMeta(item) {
    try {
      const map = JSON.parse(localStorage.getItem('hash_meta') || '{}');
      map[item.hash] = { title: item.title || item.name };
      localStorage.setItem('hash_meta', JSON.stringify(map));
    } catch {
      // localStorage full/blocked — the "now watching" hint is cosmetic
    }
  }

  // Full flow used by the Torlink tab: search → cache-check → render.
  async function run(query) {
    const status = $('torlink-status');
    const container = $('torlink-results');
    const type = $('torlink-type').value;
    status.textContent = 'Searching…';
    status.className = 'hint';
    spinner(true);
    container.replaceChildren();
    try {
      const results = await search(query, type);
      if (!results || !results.length) {
        status.textContent = 'No torrents found.';
        status.className = 'hint';
        renderResults([], container);
        return;
      }
      const grouped = isGrouped(results);
      const flat = grouped ? results.flatMap((s) => s.episodes) : results;
      status.textContent = grouped
        ? `${results.length} season${results.length > 1 ? 's' : ''} · ${flat.length} torrents — checking cache…`
        : `Found ${flat.length} — checking TorBox cache…`;
      const { checked, cached } = await enrich(flat); // annotates episodes in place
      const tail = checked
        ? ` — ${cached} cached (instant), ${flat.length - cached} need a download.`
        : ' — add your TorBox key to see which are cached.';
      status.textContent = grouped
        ? `${results.length} season${results.length > 1 ? 's' : ''} · ${flat.length} torrents${tail}`
        : `${flat.length} results${tail}`;
      status.className = 'hint ok';
      renderResults(results, container);
    } catch (err) {
      renderResults([], container);
      status.textContent = `Search failed: ${err.message || err}`;
      status.className = 'hint warn';
    } finally {
      spinner(false);
    }
  }

  return { search, enrich, renderResults, run };
}
