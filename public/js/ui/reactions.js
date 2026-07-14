// Emoji reactions (Phase 6b). Floating emojis, rate-limited to 1/s, relayed to
// the peers and validated against the preset list on receipt. On mobile the
// emoji row collapses into a single "react" button that opens a popover
// (CSS-gated on pointer:coarse); sending closes it.

import { $ } from '../lib/dom.js';

const REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '🎉'];

export function createReactions(ctx) {
  let lastReactionAt = 0;

  $('react-btn').addEventListener('click', () => $('react-wrap').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (!$('react-wrap').contains(e.target)) $('react-wrap').classList.remove('open');
  });

  for (const btn of document.querySelectorAll('#reaction-bar button')) {
    btn.addEventListener('click', () => {
      $('react-wrap').classList.remove('open'); // popover closes on send
      const now = Date.now();
      if (now - lastReactionAt < 1000) return; // max 1/s
      lastReactionAt = now;
      ctx.signaling.signal({ type: 'reaction', emoji: btn.dataset.emoji });
      showReaction(btn.dataset.emoji);
    });
  }

  function showReaction(emoji) {
    if (!REACTIONS.includes(emoji)) return; // preset emojis only
    const el = document.createElement('span');
    el.className = 'reaction';
    el.textContent = emoji;
    el.style.left = `${25 + Math.random() * 50}%`; // slight offset so repeats stack
    $('reactions-layer').append(el);
    setTimeout(() => el.remove(), 2100);
  }

  return { showReaction };
}
