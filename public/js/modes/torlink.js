// Torlink source mode: torrent search (YTS movies + EZTV TV, via the server
// proxy) → magnet → resolve/stream through the user's own TorBox account.
// Shows each result's cache status and, for uncached picks, downloads to TorBox
// with a live progress bar before streaming. Closes the loop the app otherwise
// leaves to the user (find + paste a magnet yourself).

import { $, spinner } from '../lib/dom.js';
import { torboxPost, getKey } from '../lib/torbox.js';

const VIDEO_RE = /\.(mp4|mkv|webm|m4v|mov|avi)$/i;

export function createTorlink(ctx) {
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);
  let pollTimers = []; // in-flight download polls, cleared when a new search runs

  function clearPolls() {
    for (const t of pollTimers) clearInterval(t);
    pollTimers = [];
  }

  async function search(query, type = 'all') {
    // Send the TMDb key so the server can resolve a TV title → imdb_id for EZTV.
    const headers = {};
    const tmdbKey = (localStorage.getItem('tmdb_api_key') || '').trim();
    if (tmdbKey) headers['x-tmdb-key'] = tmdbKey;
    const res = await fetch(`/api/search/torrents?q=${encodeURIComponent(query)}&type=${type}`, { headers });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.detail || `search failed (HTTP ${res.status})`);
    return data.data || [];
  }

  // Ask TorBox which of these hashes are already cached (instant stream).
  // Without a key we can't check — mark unknown and let the download flow prompt.
  async function checkCacheStatus(results) {
    const apiKey = getKey();
    const hashes = results.map((r) => r.hash).filter(Boolean);
    if (!apiKey || !hashes.length) {
      return results.map((r) => ({ ...r, cached: false, cacheChecked: false }));
    }
    try {
      const data = await torboxPost('/torbox/checkcached', { apiKey, hashes });
      const cachedMap = data?.data || {};
      return results.map((r) => ({ ...r, cached: !!cachedMap[r.hash], cacheChecked: true }));
    } catch {
      return results.map((r) => ({ ...r, cached: false, cacheChecked: false }));
    }
  }

  function renderResults(results, container) {
    container.replaceChildren();
    if (!results.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No torrents found. Try a different title (or the exact TMDb title).';
      container.append(p);
      return;
    }

    const list = document.createElement('div');
    list.className = 'torrent-list';

    for (const item of results) {
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
      loadBtn.textContent = item.cached ? 'Stream via TorBox' : 'Download & stream';
      actions.append(badge, loadBtn);
      head.append(info, actions);

      // Progress bar (revealed only while an uncached pick downloads).
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
      loadBtn.addEventListener('click', () =>
        streamItem(item, { badge, loadBtn, progress, fill, pct })
      );

      list.append(row);
    }
    container.append(list);
  }

  // One-click: add to TorBox → (wait for cache if needed) → resolve stream URL →
  // play locally + broadcast to the peer.
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
      let meta = await torboxPost('/torbox/fetch', { apiKey, magnet: item.magnet, hash: item.hash });
      if (!meta?.success) throw new Error(meta?.detail || 'could not add torrent');

      if (!meta.cached && !meta.finished) {
        progress.hidden = false;
        badge.textContent = '⏳ downloading';
        badge.style.color = 'var(--accent)';
        loadBtn.textContent = 'Downloading…';
        meta = await pollUntilReady(apiKey, meta.torrentId, fill, pct);
        progress.hidden = true;
        if (!meta) {
          // download failed — pollUntilReady already notified + reset the button
          return;
        }
      }

      const videos = (meta.files || []).filter((f) => VIDEO_RE.test(f.name || ''));
      if (!videos.length) throw new Error('no video files in this torrent');
      videos.sort((a, b) => (b.size || 0) - (a.size || 0));
      const file = videos[0];

      const dl = await torboxPost('/torbox/load', { apiKey, torrentId: meta.torrentId, fileId: file.id });
      if (!dl?.success || !dl.streamUrl) throw new Error(dl?.detail || 'could not get stream URL');

      // Full source: magnet + fileName let the peer re-resolve with their own
      // key (TorBox stream URLs are IP-locked), resolvedUrl is our local play.
      const source = {
        kind: 'torbox',
        magnet: item.magnet,
        hash: item.hash,
        fileName: file.name,
        resolvedUrl: dl.streamUrl,
      };
      rememberMeta(item);
      await ctx.syncCore.loadSource(source);
      ctx.signaling.signal({ type: 'sync-load', source });
      ctx.search.showKnownMeta(item.hash);
      ctx.syncMode.setSourceMode('torbox'); // reveal the player (hide the torlink panel)

      badge.textContent = '✅ cached';
      badge.style.color = 'var(--ok)';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Stream via TorBox';
      notice(`Streaming: ${item.name}`, 'ok', 4000);
    } catch (err) {
      notice(`TorBox: ${err.message || err}`, 'error', 5000);
      progress.hidden = true;
      loadBtn.disabled = false;
      loadBtn.textContent = 'Retry';
    }
  }

  // Poll /torbox/fetch (progress is a 0–1 fraction) until the torrent is cached
  // or finished. Resolves with the final metadata, or null on failure.
  function pollUntilReady(apiKey, torrentId, fill, pct) {
    return new Promise((resolve) => {
      const timer = setInterval(async () => {
        let m;
        try {
          m = await torboxPost('/torbox/fetch', { apiKey, torrentId });
        } catch {
          return; // transient network blip — keep polling
        }
        if (!m?.success) {
          clearInterval(timer);
          pollTimers = pollTimers.filter((t) => t !== timer);
          notice(`TorBox: ${m?.detail || 'download failed'}`, 'error', 5000);
          resolve(null);
          return;
        }
        const p = Math.round((m.progress || 0) * 100);
        fill.style.width = `${p}%`;
        pct.textContent = `${p}%`;
        if (m.finished || m.cached) {
          clearInterval(timer);
          pollTimers = pollTimers.filter((t) => t !== timer);
          resolve(m);
        }
      }, 3000);
      pollTimers.push(timer);
    });
  }

  function rememberMeta(item) {
    try {
      const map = JSON.parse(localStorage.getItem('hash_meta') || '{}');
      map[item.hash] = { title: item.name };
      localStorage.setItem('hash_meta', JSON.stringify(map));
    } catch {
      // localStorage full/blocked — the "now watching" hint is cosmetic
    }
  }

  // Full flow used by the Torlink tab: search → cache-check → render.
  async function run(query) {
    clearPolls();
    const status = $('torlink-status');
    const container = $('torlink-results');
    const type = $('torlink-type').value;
    status.textContent = 'Searching torrents…';
    status.className = 'hint';
    spinner(true);
    container.replaceChildren();
    try {
      const results = await search(query, type);
      if (!results.length) {
        status.textContent = 'No torrents found.';
        status.className = 'hint';
        renderResults([], container);
        return;
      }
      status.textContent = `Found ${results.length} — checking TorBox cache…`;
      const enriched = await checkCacheStatus(results);
      const cached = enriched.filter((r) => r.cached).length;
      const checked = enriched.some((r) => r.cacheChecked);
      status.textContent = checked
        ? `${enriched.length} results — ${cached} cached (instant), ${enriched.length - cached} need a download.`
        : `${enriched.length} results — add your TorBox key to see which are cached.`;
      status.className = 'hint ok';
      renderResults(enriched, container);
    } catch (err) {
      renderResults([], container);
      status.textContent = `Search failed: ${err.message || err}`;
      status.className = 'hint warn';
    } finally {
      spinner(false);
    }
  }

  return { search, checkCacheStatus, renderResults, run };
}
