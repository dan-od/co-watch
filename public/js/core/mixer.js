// Audio mixer (Web Audio) — one AudioContext graph for the whole room:
//
//   [each remote mic stream] → personGain → ┐
//   [remote screen-share audio] → mediaGain → ├─ masterGain → destination
//                                             ┘
//
// Every remote person routes through their own GainNode; the shared MOVIE
// routes through mediaGain; everything sums into masterGain → speakers. Sliders
// set node.gain via setTargetAtTime (a short ramp, no clicks). Mute is a
// separate toggle: gain 0 while remembering the slider level. Levels persist
// for the session (sessionStorage).
//
// CORS-safety: only MediaStreams go through GainNodes (WebRTC mics + screen
// audio are never CORS-tainted). The Mode-B movie is a <video>/YouTube/Vimeo
// player — routing a cross-origin element through Web Audio would SILENCE it,
// so its volume is driven by the adapter's setVolume(), scaled by master, and
// mediaGain carries only the screen-share (Mode A) audio. Same master, same
// feel, no risk of a silent movie.
//
// Fallback: if there's no AudioContext (or it throws), the mixer runs PASSIVE —
// per-person volume falls back to the tile <video>.volume, media to the player
// element. A mixer failure therefore never means silence.

import { $ } from '../lib/dom.js';

const STORE_KEY = 'mixer_state';
const RAMP = 0.015; // seconds — setTargetAtTime time-constant

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function createMixer(ctx) {
  // ---- persisted state ----
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}');
  } catch {
    saved = {};
  }
  const persist = () => {
    try {
      sessionStorage.setItem(
        STORE_KEY,
        JSON.stringify({ master, media, people: personLevels() })
      );
    } catch {
      // storage blocked — levels just won't survive a reload
    }
  };

  let master = typeof saved.master === 'number' ? saved.master : 1;
  let media = typeof saved.media === 'number' ? saved.media : 1;
  const savedPeople = saved.people && typeof saved.people === 'object' ? saved.people : {};

  // ---- audio graph (active) or null (passive) ----
  let ac = null;
  let masterGain = null;
  let mediaGain = null;
  let mediaStreamSrc = null; // screen-share audio source
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      ac = new AC();
      masterGain = ac.createGain();
      mediaGain = ac.createGain();
      masterGain.gain.value = master;
      mediaGain.gain.value = media;
      mediaGain.connect(masterGain);
      masterGain.connect(ac.destination);
    }
  } catch {
    ac = null; // passive
  }
  const active = !!ac;

  let mediaAdapter = null; // current Mode-B player (has setVolume)

  // peerId → { gain?, source?, videoEl, level, muted, prevLevel, name, sliders:Set, muteBtns:Set }
  const people = new Map();
  const personLevels = () => {
    const o = {};
    for (const [id, p] of people) o[id] = { level: p.level, muted: p.muted };
    return o;
  };

  function ramp(param, value) {
    try {
      param.setTargetAtTime(value, ac.currentTime, RAMP);
    } catch {
      param.value = value; // some engines lack setTargetAtTime
    }
  }

  // ---- master / media ----
  function applyMedia() {
    if (active) ramp(mediaGain.gain, media);
    mediaAdapter?.setVolume?.(clamp01(media * master)); // Mode-B element/adapter
  }
  function applyMaster() {
    if (active) ramp(masterGain.gain, master);
    mediaAdapter?.setVolume?.(clamp01(media * master));
  }

  function setMasterVolume(v, originEl) {
    master = clamp01(v);
    applyMaster();
    syncSlider($('mix-master'), master, originEl);
    persist();
  }
  function setMediaVolume(v, originEl) {
    media = clamp01(v);
    applyMedia();
    syncSlider($('mix-media'), media, originEl);
    persist();
  }

  // A Mode-B player loaded / was destroyed.
  function setMediaAdapter(adapter) {
    mediaAdapter = adapter || null;
    mediaAdapter?.setVolume?.(clamp01(media * master));
  }

  // Screen-share (Mode A) audio: route the stream's audio through mediaGain.
  function attachMediaStream(stream) {
    detachMediaStream();
    if (!active || !stream?.getAudioTracks?.().length) return;
    try {
      mediaStreamSrc = ac.createMediaStreamSource(stream);
      mediaStreamSrc.connect(mediaGain);
    } catch {
      mediaStreamSrc = null;
    }
  }
  function detachMediaStream() {
    try {
      mediaStreamSrc?.disconnect();
    } catch {}
    mediaStreamSrc = null;
  }

  // ---- people ----
  function applyPerson(p) {
    const g = p.muted ? 0 : p.level;
    if (active && p.gain) ramp(p.gain.gain, g);
    else if (p.videoEl) p.videoEl.volume = g; // passive path
  }

  // Called by tiles when a remote stream arrives (or is replaced on reconnect).
  // In active mode we mute the <video> and take its audio through the graph
  // (the muted element must stay attached — that's what pulls the WebRTC audio
  // track for Web Audio to read).
  function attachPerson(peerId, stream, videoEl, name, tileSlider) {
    let p = people.get(peerId);
    if (!p) {
      const prior = savedPeople[peerId];
      p = {
        gain: null, source: null, videoEl,
        level: typeof prior?.level === 'number' ? prior.level : 1,
        muted: !!prior?.muted,
        prevLevel: typeof prior?.level === 'number' ? prior.level : 1,
        name: name || 'Someone',
        sliders: new Set(),
        muteBtns: new Set(),
      };
      people.set(peerId, p);
      if (active) p.gain = ac.createGain();
      if (tileSlider) bindSlider(peerId, tileSlider);
      addPanelRow(peerId, p);
    }
    p.videoEl = videoEl;
    if (name) p.name = name;
    if (active) {
      videoEl.muted = true; // audio comes from the graph, not the element
      try {
        p.source?.disconnect();
      } catch {}
      p.source = ac.createMediaStreamSource(stream);
      p.source.connect(p.gain);
      p.gain.connect(masterGain);
    } else {
      videoEl.muted = false; // passive: the element plays; we set its volume
    }
    applyPerson(p);
    refreshRow(peerId, p);
  }

  function detachPerson(peerId) {
    const p = people.get(peerId);
    if (!p) return;
    try {
      p.source?.disconnect();
      p.gain?.disconnect();
    } catch {}
    people.delete(peerId);
    p.rowEl?.remove();
    updatePanelEmpty();
  }

  function setPersonVolume(peerId, v, originEl) {
    const p = people.get(peerId);
    if (!p) return;
    p.level = clamp01(v);
    p.prevLevel = p.level;
    if (p.muted && p.level > 0) p.muted = false; // moving the slider un-mutes
    applyPerson(p);
    for (const s of p.sliders) syncSlider(s, p.level, originEl);
    refreshRow(peerId, p);
    persist();
  }

  function togglePersonMute(peerId) {
    const p = people.get(peerId);
    if (!p) return;
    p.muted = !p.muted; // gain 0 vs last level — the slider level is preserved
    applyPerson(p);
    refreshRow(peerId, p);
    persist();
  }

  function setPersonName(peerId, name) {
    const p = people.get(peerId);
    if (p && name) {
      p.name = name;
      if (p.rowNameEl) p.rowNameEl.textContent = name;
    }
  }

  // ---- slider/button helpers ----
  function syncSlider(slider, level, originEl) {
    if (slider && slider !== originEl) slider.value = String(Math.round(level * 100));
  }
  function bindSlider(peerId, slider) {
    const p = people.get(peerId);
    if (!p) return;
    p.sliders.add(slider);
    slider.value = String(Math.round((p.muted ? p.prevLevel : p.level) * 100));
    slider.addEventListener('input', () => setPersonVolume(peerId, Number(slider.value) / 100, slider));
  }

  // ---- mixer panel ----
  function addPanelRow(peerId, p) {
    const host = $('mixer-people');
    if (!host) return;
    const row = document.createElement('div');
    row.className = 'mix-row';
    row.dataset.peer = peerId;
    const idCol = document.createElement('span');
    idCol.className = 'mix-id';
    const nameEl = document.createElement('span');
    nameEl.className = 'mix-name';
    nameEl.textContent = p.name;
    const statusEl = document.createElement('span');
    statusEl.className = 'mix-status';
    idCol.append(nameEl, statusEl);
    const mute = document.createElement('button');
    mute.className = 'mix-mute';
    mute.title = 'Mute for me';
    mute.textContent = '🔊';
    mute.addEventListener('click', () => togglePersonMute(peerId));
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    row.append(idCol, mute, slider);
    host.append(row);
    p.rowEl = row;
    p.rowNameEl = nameEl;
    p.rowStatusEl = statusEl;
    p.muteBtns.add(mute);
    bindSlider(peerId, slider);
    updatePanelEmpty();
    refreshRow(peerId, p);
  }
  function refreshRow(peerId, p) {
    for (const b of p.muteBtns) b.textContent = p.muted ? '🔇' : '🔊';
    p.rowEl?.classList.toggle('muted', p.muted);
    if (p.rowStatusEl) {
      p.rowStatusEl.textContent = p.muted ? 'Muted' : p.speaking ? 'Speaking' : '';
      p.rowStatusEl.classList.toggle('speaking', !p.muted && !!p.speaking);
    }
  }

  // Live "Speaking" sub-label, driven by tiles' level meter (only on change).
  function setPersonSpeaking(peerId, speaking) {
    const p = people.get(peerId);
    if (!p || p.speaking === speaking) return;
    p.speaking = speaking;
    refreshRow(peerId, p);
  }
  function updatePanelEmpty() {
    const empty = $('mixer-empty');
    if (empty) empty.hidden = people.size > 0;
  }

  // ---- panel open/close + master/media wiring ----
  function openPanel(focusPeerId) {
    $('mixer-panel').hidden = false;
    if (focusPeerId) people.get(focusPeerId)?.rowEl?.scrollIntoView?.({ block: 'nearest' });
    resume();
  }
  const mixBtn = $('mixer-btn');
  mixBtn?.addEventListener('click', () => {
    const panel = $('mixer-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) resume();
  });
  document.addEventListener('click', (e) => {
    const panel = $('mixer-panel');
    if (!panel || panel.hidden) return;
    if (!panel.contains(e.target) && e.target !== mixBtn && !mixBtn?.contains(e.target)) panel.hidden = true;
  });
  const masterSlider = $('mix-master');
  const mediaSlider = $('mix-media');
  if (masterSlider) {
    masterSlider.value = String(Math.round(master * 100));
    masterSlider.addEventListener('input', () => setMasterVolume(Number(masterSlider.value) / 100, masterSlider));
  }
  if (mediaSlider) {
    mediaSlider.value = String(Math.round(media * 100));
    mediaSlider.addEventListener('input', () => setMediaVolume(Number(mediaSlider.value) / 100, mediaSlider));
  }

  // ---- gesture-gated resume ----
  function resume() {
    ac?.resume?.().catch(() => {});
  }
  document.addEventListener('click', resume, { capture: true });
  document.addEventListener('pointerdown', resume, { capture: true });

  // apply initial media/master to the (not-yet-present) adapter later; nodes
  // already hold master/media from construction.
  applyMedia();

  return {
    isActive: () => active,
    getContext: () => ac,
    resume,
    attachPerson,
    detachPerson,
    setPersonVolume,
    togglePersonMute,
    setPersonName,
    setPersonSpeaking,
    setMediaAdapter,
    attachMediaStream,
    detachMediaStream,
    setMasterVolume,
    setMediaVolume,
    openPanel,
    dispose: () => {
      detachMediaStream();
      for (const id of [...people.keys()]) detachPerson(id);
      ac?.close?.().catch?.(() => {});
    },
  };
}
