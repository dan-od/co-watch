// Metadata search + watchlist (Phase 4e).
// TMDb metadata browsing only (posters, ratings, overviews). Watching still
// requires the user to paste their own URL or magnet in URL/TorBox mode —
// nothing here fetches, resolves, or discovers content. Also holds the
// hash→metadata memory so a re-pasted magnet shows what it is.

import { $, spinner } from '../lib/dom.js';

const WATCHLIST_KEY = 'watchlist';
const HASH_META_KEY = 'hash_meta'; // magnet hash -> saved metadata

export function createSearch(ctx) {
  let lastSelectedMeta = null; // most recently opened search result

  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);
  const getTmdbKey = () => (localStorage.getItem('tmdb_api_key') || '').trim();

  function searchStatus(text, kind = '') {
    $('search-status').textContent = text;
    $('search-status').className = `hint ${kind}`;
  }

  function checkTmdbKey() {
    if (!getTmdbKey()) {
      searchStatus('Enter your TMDb API key (gear icon) to search metadata.', 'warn');
    } else if (!$('search-results').childElementCount) {
      searchStatus('Search for a movie or show to see posters and details.');
    }
  }

  async function runSearch(query) {
    if (!getTmdbKey()) {
      searchStatus('Enter your TMDb API key (gear icon) to search metadata.', 'warn');
      ctx.settings.openSettings(true);
      return;
    }
    $('search-detail').hidden = true;
    $('watchlist-toggle').classList.remove('active');
    searchStatus('Searching…');
    spinner(true);
    try {
      const p = new URLSearchParams({ query, type: $('search-type').value });
      const year = $('search-year').value.trim();
      if (year) p.set('year', year);
      const res = await fetch(`/api/tmdb/search?${p}`, { headers: { 'x-tmdb-key': getTmdbKey() } });
      const data = await res.json().catch(() => null);
      if (!data?.success) {
        searchStatus(`Search failed: ${data?.detail || `HTTP ${res.status}`}`, 'error');
        return;
      }
      if (!data.data.length) {
        $('search-results').replaceChildren();
        searchStatus('No results — try different keywords or drop the year.', 'warn');
        return;
      }
      renderCards(data.data, { watchlist: false });
      searchStatus(`${data.data.length} results — click one for details.`, 'ok');
    } catch (err) {
      searchStatus(`Search failed: ${err.message || err}`, 'error');
    } finally {
      spinner(false);
    }
  }

  function posterEl(item, width) {
    if (item.poster_path) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w${width}${item.poster_path}`;
      img.alt = item.title;
      img.loading = 'lazy';
      return img;
    }
    const div = document.createElement('div');
    div.className = 'no-poster';
    div.textContent = 'No poster';
    return div;
  }

  // UX shortcut: turn a picked title into a paste-ready magnet query. We don't
  // have a magnet — we hand the user a suggested search string: copy it to the
  // clipboard, flip to the TorBox paste tab, and pre-fill (and select) the input
  // so they can search a tracker and paste the real magnet back — or just click
  // Load if they already have one. The paste flow itself is unchanged.
  async function watchNow(item) {
    const query = `${item.title}${item.year ? ` ${item.year}` : ''}`.trim();
    $('search-detail').hidden = true;
    ctx.syncMode.setSourceMode('torbox');
    const input = $('sync-input');
    input.value = query;
    input.focus();
    input.select();
    try {
      await navigator.clipboard.writeText(query);
      notice(`Copied “${query}” — find a magnet, paste it, then hit Load.`, '', 4000);
    } catch {
      notice(`Search “${query}”, paste the magnet here, then hit Load.`, '', 4000);
    }
  }

  function renderCards(items, { watchlist }) {
    const grid = $('search-results');
    grid.replaceChildren();
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.append(posterEl(item, 200));
      const body = document.createElement('div');
      body.className = 'card-body';
      const h = document.createElement('h4');
      h.textContent = item.title;
      h.title = item.title;
      const meta = document.createElement('span');
      meta.className = 'card-meta';
      meta.textContent = `${item.year || '—'} · ${item.type === 'movie' ? 'Movie' : 'TV'}`;
      const rating = document.createElement('span');
      rating.className = 'card-rating';
      rating.textContent = item.vote_average ? `★ ${item.vote_average.toFixed(1)}` : '';
      const watch = document.createElement('button');
      watch.className = 'primary';
      watch.textContent = 'Watch';
      watch.addEventListener('click', () => watchNow(item));
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Details';
      btn.addEventListener('click', () => showDetail(item));
      body.append(h, meta, rating, watch, btn);
      if (watchlist) {
        const rm = document.createElement('button');
        rm.className = 'ghost';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => {
          saveWatchlist(loadWatchlist().filter((w) => !(w.id === item.id && w.type === item.type)));
          renderWatchlist();
        });
        body.append(rm);
      }
      card.append(body);
      grid.append(card);
    }
  }

  function showDetail(item) {
    lastSelectedMeta = {
      id: item.id,
      type: item.type,
      title: item.title,
      year: item.year,
      poster_path: item.poster_path,
      vote_average: item.vote_average,
    };
    const box = $('search-detail');
    box.replaceChildren();
    box.append(posterEl(item, 342));
    const body = document.createElement('div');
    body.className = 'detail-body';
    const h = document.createElement('h3');
    h.textContent = `${item.title}${item.year ? ` (${item.year})` : ''}`;
    const meta = document.createElement('span');
    meta.className = 'detail-meta';
    meta.textContent = `${item.type === 'movie' ? 'Movie' : 'TV show'}${
      item.vote_average ? ` · ★ ${item.vote_average.toFixed(1)} / 10` : ''
    }`;
    const overview = document.createElement('p');
    overview.className = 'detail-overview';
    overview.textContent = item.overview || 'No overview available.';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Watch copies the title and opens the paste box — find a magnet, paste it there, then hit Load.';
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const toPaste = document.createElement('button');
    toPaste.className = 'primary';
    toPaste.textContent = 'Watch';
    toPaste.addEventListener('click', () => watchNow(item));
    const save = document.createElement('button');
    const listed = loadWatchlist().some((w) => w.id === item.id && w.type === item.type);
    save.textContent = listed ? 'In watchlist ✓' : 'Save to watchlist';
    save.disabled = listed;
    save.addEventListener('click', () => {
      const list = loadWatchlist();
      if (!list.some((w) => w.id === item.id && w.type === item.type)) {
        list.push({ ...lastSelectedMeta, overview: item.overview, addedAt: Date.now() });
        saveWatchlist(list);
      }
      save.textContent = 'In watchlist ✓';
      save.disabled = true;
    });
    const back = document.createElement('button');
    back.className = 'ghost';
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      box.hidden = true;
    });
    actions.append(toPaste, save, back);
    body.append(h, meta, overview, hint, actions);
    box.append(body);
    box.hidden = false;
  }

  const loadWatchlist = () => {
    try {
      return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]');
    } catch {
      return [];
    }
  };
  const saveWatchlist = (list) => localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));

  function renderWatchlist() {
    const list = loadWatchlist().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    renderCards(list, { watchlist: true });
    searchStatus(
      list.length ? `${list.length} saved.` : 'Watchlist is empty — search and save something.',
      list.length ? 'ok' : ''
    );
  }

  $('watchlist-toggle').addEventListener('click', () => {
    const on = $('watchlist-toggle').classList.toggle('active');
    $('search-detail').hidden = true;
    if (on) {
      renderWatchlist();
    } else {
      $('search-results').replaceChildren();
      checkTmdbKey();
    }
  });

  // Metadata memory: associate a loaded magnet's hash with the most recently
  // selected search result so re-pasting it later shows what it is.
  const loadHashMeta = () => {
    try {
      return JSON.parse(localStorage.getItem(HASH_META_KEY) || '{}');
    } catch {
      return {};
    }
  };
  function rememberHashMeta(hash) {
    if (!lastSelectedMeta || !hash) return;
    const map = loadHashMeta();
    map[hash] = lastSelectedMeta;
    localStorage.setItem(HASH_META_KEY, JSON.stringify(map));
  }
  function showKnownMeta(hash) {
    const m = hash ? loadHashMeta()[hash] : null;
    if (m) notice(`Now watching: ${m.title}${m.year ? ` (${m.year})` : ''} — synced.`, 'ok', 6000);
  }

  return {
    checkTmdbKey,
    runSearch,
    rememberHashMeta,
    showKnownMeta,
  };
}
