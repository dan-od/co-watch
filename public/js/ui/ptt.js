// Push-to-talk (Phase 6c).
// PTT on: mic muted unless Space (or the Hold-to-talk button) is held.
// PTT off: the normal mute toggle rules the mic.

import { $ } from '../lib/dom.js';

export function createPtt(ctx) {
  let pttOn = false;
  let pttSpeaking = false;

  function setMicEnabled(on) {
    const t = ctx.media.getLocalStream()?.getAudioTracks()[0];
    if (t) t.enabled = on;
  }

  function setPtt(on) {
    pttOn = on;
    pttSpeaking = false;
    $('ptt').classList.toggle('active', on);
    $('ptt').title = on
      ? 'Push-to-talk on — hold Space or the Hold-to-talk button to speak'
      : 'Enable push-to-talk';
    $('ptt-hold').classList.toggle('visible', on);
    $('toggle-mic').disabled = on;
    setMicEnabled(!on); // on -> muted until held; off -> back to open mic
    updateSpeakingUi();
    ctx.controls.syncToggleButtons();
  }

  function setSpeaking(on) {
    if (!pttOn || pttSpeaking === on) return;
    pttSpeaking = on;
    setMicEnabled(on);
    updateSpeakingUi();
    ctx.controls.syncToggleButtons();
  }

  function updateSpeakingUi() {
    $('ptt').classList.toggle('speaking', pttSpeaking);
    $('ptt-hold').classList.toggle('speaking', pttSpeaking);
    $('ptt-indicator').hidden = !pttSpeaking;
  }

  $('ptt').addEventListener('click', () => setPtt(!pttOn));

  const holdBtn = $('ptt-hold');
  holdBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setSpeaking(true);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    holdBtn.addEventListener(ev, () => setSpeaking(false));
  }

  const isTypingTarget = (el) =>
    el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  window.addEventListener('keydown', (e) => {
    if (!pttOn || e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
    e.preventDefault(); // don't scroll or trigger the focused button
    setSpeaking(true);
  });
  window.addEventListener('keyup', (e) => {
    if (!pttOn || e.code !== 'Space') return;
    if (!isTypingTarget(e.target)) e.preventDefault();
    setSpeaking(false);
  });
  window.addEventListener('blur', () => setSpeaking(false)); // don't strand an open mic

  return {
    // Re-apply the current mic gate after the local stream is (re)acquired.
    reapplyMic: () => {
      if (pttOn) setMicEnabled(pttSpeaking);
    },
  };
}
