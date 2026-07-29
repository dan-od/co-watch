// Emoji reactions. Floating emojis captioned with who sent them, rate-limited
// to 1/s (the button row dims and a gold rail drains for the cooldown), relayed
// to the peers and validated against the preset list on receipt. On touch the
// row collapses behind a single button (CSS-gated on pointer:coarse).

import { $ } from '../lib/dom.js';

const REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '🎉'];
const COOLDOWN_MS = 1000;

export function createReactions(ctx) {
  let lastReactionAt = 0;

  $('react-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('react-wrap').classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!$('react-wrap').contains(e.target)) $('react-wrap').classList.remove('open');
  });

  for (const btn of document.querySelectorAll('#reaction-bar button')) {
    btn.addEventListener('click', () => {
      $('react-wrap').classList.remove('open'); // popover closes on send
      const now = Date.now();
      if (now - lastReactionAt < COOLDOWN_MS) return;
      lastReactionAt = now;
      ctx.signaling.signal({ type: 'reaction', emoji: btn.dataset.emoji });
      showReaction(btn.dataset.emoji, 'You');
      runCooldown();
    });
  }

  // Dim the row and drain the rail for exactly one cooldown.
  function runCooldown() {
    const wrap = $('react-wrap');
    wrap.classList.remove('cooling');
    void wrap.offsetWidth; // restart the animation
    wrap.classList.add('cooling');
    setTimeout(() => wrap.classList.remove('cooling'), COOLDOWN_MS);
  }

  function showReaction(emoji, who = 'Someone') {
    if (!REACTIONS.includes(emoji)) return; // preset emojis only
    const el = document.createElement('div');
    el.className = 'react';
    el.style.left = `${6 + Math.random() * 82}%`;
    el.style.setProperty('--sway', `${Math.random() * 70 - 35}px`);
    el.style.fontSize = `${0.85 + Math.random() * 0.35}em`;
    const e = document.createElement('span');
    e.className = 'e';
    e.textContent = emoji;
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    el.append(e, w);
    $('reactions-layer').append(el);
    setTimeout(() => el.remove(), 3000);
  }

  return { showReaction };
}
