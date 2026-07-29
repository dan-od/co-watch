// Spectate (browse-cast, watcher side). When the host browses Stremio —
// search results, a series' seasons, a season's episodes, a title's stream
// list — stremio.js broadcasts lean 'browse' snapshots (public metadata only:
// names, posters, backdrops; never the add-on URL or keys). This module
// renders them as a READ-ONLY cinematic overlay: same poster-wall / backdrop-
// hero language as the host's view, minus every input. Watchers purely
// spectate; the host drives. A sync-load (movie starting) hides it.

import { $ } from '../lib/dom.js';

const PLACEHOLDER = 'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#1E1910"/></svg>');

export function createSpectate(ctx) {
  let dismissed = false; // "Hide" holds until the next browse update arrives

  const panel = () => $('spectate-panel');
  const body = () => $('spectate-body');

  $('spectate-close').addEventListener('click', () => {
    dismissed = true;
    panel().hidden = true;
  });

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function poster(src) {
    const img = document.createElement('img');
    img.src = src || PLACEHOLDER;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.src = PLACEHOLDER; }, { once: true });
    return img;
  }

  function hero({ name, poster: posterUrl, backdrop, metaText, overview, slim }) {
    const h = el('div', `title-hero${slim ? ' slim' : ''}`);
    if (backdrop) h.style.backgroundImage = `url("${String(backdrop).replace(/"/g, '%22')}")`;
    h.append(el('div', 'hero-scrim'));
    const inner = el('div', 'hero-inner');
    if (posterUrl) {
      const img = poster(posterUrl);
      img.className = 'hero-poster';
      inner.append(img);
    }
    const bodyEl = el('div', 'hero-body');
    bodyEl.append(el('h2', '', name || 'Untitled'));
    if (metaText) bodyEl.append(el('span', 'hero-meta', metaText));
    if (overview && !slim) {
      const ov = el('p', 'hero-overview', overview);
      ov.title = overview;
      bodyEl.append(ov);
    }
    inner.append(bodyEl);
    h.append(inner);
    return h;
  }

  // ---- per-view renderers (read-only mirrors of the host's screens) ----
  const renderers = {
    grid(d) {
      if (d.label) body().append(el('p', 'spectate-label', d.label));
      const grid = el('div', 'grid');
      for (const item of d.items || []) {
        const card = el('div', 'poster-card');
        card.title = item.name || '';
        const art = el('div', 'poster');
        art.append(poster(item.poster));
        if (item.kind) art.append(el('span', 'badge-type', item.kind));
        const meta = el('div', 'meta');
        meta.append(el('div', 't', item.name || 'Untitled'));
        if (item.year) meta.append(el('div', 'y', String(item.year)));
        card.append(art, meta);
        grid.append(card);
      }
      body().append(grid);
    },

    seasons(d) {
      const t = d.title || {};
      const n = (d.seasons || []).length;
      body().append(
        hero({
          name: t.name,
          poster: t.poster,
          backdrop: t.backdrop,
          metaText: [t.year, `${n} season${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
          overview: t.overview,
        })
      );
      const row = el('div', 'spectate-chips');
      for (const s of d.seasons || []) {
        row.append(el('span', 'spectate-chip',
          `${s.number === 0 ? 'Specials' : `Season ${s.number}`} · ${s.count}`));
      }
      body().append(row);
    },

    episodes(d) {
      const t = d.title || {};
      body().append(
        hero({
          name: t.name,
          backdrop: t.backdrop,
          metaText: d.season === 0 ? 'Specials' : `Season ${d.season}`,
          slim: true,
        })
      );
      for (const ep of d.episodes || []) {
        const row = el('div', 'torrent-item episode-row');
        const head = el('div', 'torrent-row-head');
        if (ep.still) {
          const th = poster(`https://image.tmdb.org/t/p/w185${ep.still}`);
          th.className = 'episode-thumb';
          th.addEventListener('error', () => th.remove(), { once: true });
          head.append(th);
        }
        const info = el('div', 'torrent-info');
        const nm = el('span', 'torrent-name', `E${ep.number}${ep.name ? ` · ${ep.name}` : ''}`);
        nm.title = nm.textContent;
        info.append(nm);
        if (ep.overview) {
          const ov = el('span', 'episode-overview', ep.overview);
          ov.title = ep.overview;
          info.append(ov);
        }
        const meta = [ep.air, ep.runtime ? `${ep.runtime} min` : ''].filter(Boolean).join(' · ');
        if (meta) info.append(el('span', 'torrent-meta', meta));
        head.append(info);
        row.append(head);
        body().append(row);
      }
    },

    streams(d) {
      body().append(hero({ name: d.title, backdrop: d.backdrop, slim: true }));
      const list = el('div', 'torrent-list');
      for (const s of d.streams || []) {
        const row = el('div', 'torrent-item stream-row');
        const head = el('div', 'torrent-row-head');
        const info = el('div', 'torrent-info');
        const nm = el('span', 'torrent-name', s.name || 'Stream');
        nm.title = nm.textContent;
        info.append(nm);
        const tags = [...(s.warn ? [{ label: '⚠ no browser audio', cls: 'warn' }] : []), ...(s.tags || [])];
        if (tags.length) {
          const badges = el('div', 'badges');
          for (const t of tags) badges.append(el('span', `badge badge-${t.cls}`, t.label));
          info.append(badges);
        }
        if (s.desc) {
          const de = el('span', 'torrent-meta', s.desc);
          de.title = s.desc;
          info.append(de);
        }
        head.append(info);
        row.append(head);
        list.append(row);
      }
      body().append(list);
    },
  };

  // ---- API ----
  // A browse snapshot arrived from a peer. 'none' (host started playback or
  // reset) hides the overlay; anything else re-opens it, even after a manual
  // Hide (a NEW update is new information).
  function show(data, fromName) {
    if (!data || typeof data !== 'object') return;
    if (data.view === 'none') {
      hide();
      return;
    }
    const render = renderers[data.view];
    if (!render) return; // unknown view from a newer/older client — ignore
    dismissed = false;
    $('spectate-title').textContent = `${fromName || 'Someone'} is browsing`;
    body().replaceChildren();
    try {
      render(data);
    } catch {
      body().replaceChildren(el('p', 'hint', 'Could not render this update.'));
    }
    panel().hidden = false;
  }

  function hide() {
    panel().hidden = true;
  }

  return { show, hide, isDismissed: () => dismissed };
}
