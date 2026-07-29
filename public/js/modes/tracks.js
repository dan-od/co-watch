// Subtitles & audio tracks (native player only).
// Per-person presentation: each side picks their own language; nothing is
// synced. Subtitle sources: a local .srt/.vtt file, or .srt/.vtt files that
// ship inside the torrent the user already loaded (fetched through the server
// because the TorBox CDN is not CORS-open). Audio switching uses the
// audioTracks API where the browser exposes it (Safari yes, Chrome no).

import { $ } from '../lib/dom.js';
import { torboxPost, getKey } from '../lib/torbox.js';

export function createTracks(ctx) {
  let currentTorrentSubs = null; // { torrentId, files: [{id, name}] }
  let currentAddonSubs = null; // [{ lang, url, id? }] from a Stremio add-on
  let subBlobUrls = [];

  const player = () => ctx.syncCore.getPlayer();
  const notice = (text, kind, ms) => ctx.controls.notice(text, kind, ms);

  function setTorrentSubs(meta) {
    const subs = (meta?.files || []).filter((f) => /\.(srt|vtt)$/i.test(f?.name || ''));
    currentTorrentSubs = subs.length ? { torrentId: meta.torrentId, files: subs } : null;
  }

  // Subtitles offered by a Stremio add-on (its /subtitles resource or a stream's
  // own `subtitles` array): [{ lang, url }]. Lazy-loaded from the CC panel.
  function setAddonSubs(subs) {
    currentAddonSubs = Array.isArray(subs) && subs.length ? subs : null;
  }

  function srtToVtt(text) {
    const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const body = noBom.replace(/\r/g, '');
    if (/^WEBVTT/.test(body)) return body;
    return 'WEBVTT\n\n' + body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }

  // Accepts raw .srt or .vtt — converts to VTT (idempotent) before blobbing.
  function addSubtitleTrack(label, text) {
    const el = player()?.el;
    if (!el) return;
    const url = URL.createObjectURL(new Blob([srtToVtt(text)], { type: 'text/vtt' }));
    subBlobUrls.push(url);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.src = url;
    el.append(track);
    selectSubtitle(el.textTracks.length - 1); // show the newest track
  }

  function selectSubtitle(index) {
    // index -1 = off
    const tracks = player()?.el?.textTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === index ? 'showing' : 'disabled';
    renderTracksPanel();
  }

  function selectAudio(index) {
    const tracks = player()?.el?.audioTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
    renderTracksPanel();
  }

  function radioRow(group, label, checked, onPick) {
    const row = document.createElement('label');
    row.className = 'track-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `track-${group}`;
    input.checked = checked;
    input.addEventListener('change', onPick);
    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = label;
    row.append(input, name);
    return row;
  }

  function renderTracksPanel() {
    const el = player()?.el;

    const subList = $('sub-list');
    subList.replaceChildren();
    const tracks = el?.textTracks || [];
    const anyShowing = [...tracks].some((t) => t.mode === 'showing');
    subList.append(radioRow('subs', 'Off', !anyShowing, () => selectSubtitle(-1)));
    [...tracks].forEach((t, i) => {
      subList.append(radioRow('subs', t.label || `Track ${i + 1}`, t.mode === 'showing', () => selectSubtitle(i)));
    });

    const torrentBox = $('torrent-subs');
    torrentBox.replaceChildren();
    if (currentTorrentSubs) {
      const h = document.createElement('span');
      h.className = 'label';
      h.textContent = 'From this torrent';
      torrentBox.append(h);
      for (const f of currentTorrentSubs.files) {
        const row = document.createElement('div');
        row.className = 'track-row';
        const name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = f.name.split('/').pop();
        name.title = f.name;
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.textContent = 'Load';
        btn.addEventListener('click', () => loadTorrentSub(f, btn));
        row.append(name, btn);
        torrentBox.append(row);
      }
    }

    const addonBox = $('addon-subs');
    addonBox.replaceChildren();
    if (currentAddonSubs) {
      const h = document.createElement('span');
      h.className = 'label';
      h.textContent = 'From the add-on';
      addonBox.append(h);
      for (const sub of currentAddonSubs) {
        const row = document.createElement('div');
        row.className = 'track-row';
        const name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = sub.lang || sub.id || 'Subtitle';
        name.title = name.textContent;
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.textContent = 'Load';
        btn.addEventListener('click', () => loadAddonSub(sub, btn));
        row.append(name, btn);
        addonBox.append(row);
      }
    }

    const audioList = $('audio-list');
    audioList.replaceChildren();
    const at = el?.audioTracks;
    const hint = (text) => {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = text;
      audioList.append(p);
    };

    // Best case (Safari): the element exposes real embedded tracks — switch
    // them in place.
    if (at && at.length > 1) {
      for (let i = 0; i < at.length; i++) {
        audioList.append(
          radioRow('audio', at[i].label || at[i].language || `Track ${i + 1}`, at[i].enabled, () => selectAudio(i))
        );
      }
      return;
    }

    // Chrome/Firefox hide embedded tracks, so offer the other language
    // RELEASES of this title instead — picking one reloads at the same spot.
    const opts = ctx.stremio?.getAudioOptions?.() || [];
    if (opts.length > 1) {
      for (const o of opts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sub';
        row.setAttribute('aria-selected', String(!!o.current));
        row.textContent = o.lang;
        const tag = document.createElement('span');
        if (o.warn) {
          tag.className = 'warn';
          tag.textContent = '⚠ no sound here';
        } else {
          tag.className = 'tag';
          tag.textContent = [o.q, o.audio].filter(Boolean).join(' · ') || 'audio';
        }
        row.append(tag);
        if (o.embedded) {
          // No release leads with this language — it's a secondary track inside
          // a multi-language file, which this browser can't isolate.
          row.title = 'Only available as a secondary track inside a multi-language file — this browser can’t isolate it.';
          tag.textContent = 'in-file';
          tag.className = 'tag';
        }
        row.addEventListener('click', async () => {
          if (o.current) return;
          row.disabled = true;
          await ctx.stremio.switchAudio(o.lang);
          renderTracksPanel();
        });
        audioList.append(row);
      }
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'This browser hides embedded tracks, so each option loads that language’s release — everyone keeps their place.';
      audioList.append(p);
      return;
    }

    if (at && at.length === 1) hint('Only one audio track in this video.');
    else if (opts.length === 1) hint(`Only one audio language available (${opts[0].lang}).`);
    else hint("This browser doesn't expose embedded audio tracks (Safari does; Chrome hides them).");
  }

  async function loadTorrentSub(f, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const r = await torboxPost('/torbox/subfile', {
        apiKey: getKey(),
        torrentId: currentTorrentSubs.torrentId,
        fileId: f.id,
      });
      if (!r?.success) throw new Error(r?.detail || 'could not fetch subtitle');
      addSubtitleTrack(f.name.split('/').pop(), r.text);
      notice(`Subtitles loaded: ${f.name.split('/').pop()}`, 'ok', 3000);
    } catch (err) {
      notice(`Subtitle failed: ${err.message || err}`, 'error', 5000);
      btn.disabled = false;
      btn.textContent = 'Load';
    }
  }

  // Fetch an add-on subtitle file through the SSRF-guarded proxy → add as track.
  async function loadAddonSub(sub, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch(`/api/stremio/subfile?url=${encodeURIComponent(sub.url)}`);
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.detail || 'could not fetch subtitle');
      addSubtitleTrack(sub.lang || sub.id || 'Subtitle', j.text);
      notice(`Subtitles loaded: ${sub.lang || 'track'}`, 'ok', 3000);
    } catch (err) {
      notice(`Subtitle failed: ${err.message || err}`, 'error', 5000);
      btn.disabled = false;
      btn.textContent = 'Load';
    }
  }

  $('tracks-btn').addEventListener('click', () => {
    const show = $('tracks-panel').hidden;
    if (show) renderTracksPanel();
    $('tracks-panel').hidden = !show;
  });
  document.addEventListener('click', (e) => {
    if (
      !$('tracks-panel').hidden &&
      !$('tracks-panel').contains(e.target) &&
      !$('tracks-btn').contains(e.target)
    ) {
      $('tracks-panel').hidden = true;
    }
  });

  $('sub-from-file').addEventListener('click', () => $('sub-file-input').click());
  $('sub-file-input').addEventListener('change', async () => {
    const file = $('sub-file-input').files[0];
    if (!file) return;
    addSubtitleTrack(file.name, await file.text());
    notice(`Subtitles loaded: ${file.name}`, 'ok', 3000);
    $('sub-file-input').value = '';
  });

  return {
    setTorrentSubs,
    setAddonSubs,
    renderTracksPanel,
    addSubtitleTrack,
    // Called by the sync engine when tearing down a player: drop this torrent's
    // subtitle blobs and hide the tracks widget. Add-on subs are cleared too
    // (they're re-set per stream); torrent subs are left for the load paths to
    // reset, since loadTorbox sets them just before the (teardown-triggering)
    // load.
    releaseSubs: () => {
      $('tracks-btn').hidden = true;
      $('tracks-panel').hidden = true;
      currentAddonSubs = null;
      for (const u of subBlobUrls) URL.revokeObjectURL(u);
      subBlobUrls = [];
    },
  };
}
