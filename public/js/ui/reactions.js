// Emoji reactions (Phase 6b). Floating emojis, rate-limited to 1/s, relayed to
// the peer and validated against the preset list on receipt.

import { $ } from '../lib/dom.js';

const REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '🎉'];

export function createReactions(ctx) {
  let lastReactionAt = 0;

  for (const btn of document.querySelectorAll('#reaction-bar button')) {
    btn.addEventListener('click', () => {
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
