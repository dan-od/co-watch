// Text chat, relayed over the signaling socket. The message + form nodes are
// stable references (ctx.els) because the Document PiP companion relocates them
// out of the main document (#chat-head stays in the rail — only messages/form
// move, and they re-append after it on return, preserving order).
//
// Message layout (design pass): the sender's name sits as a small dim label
// ABOVE the bubble (skipped for consecutive messages from the same sender, and
// for your own — yours are right-aligned gold-tinted). Join/leave events land
// as small centered system lines so the log keeps a trace of who came and went.

import { $ } from '../lib/dom.js';

export function createChat(ctx) {
  const elMessages = ctx.els.messages;
  const elSendForm = ctx.els.sendForm;
  let lastSender = null; // group consecutive messages: name label only on change

  function appendMessage(who, text) {
    const mine = who === 'You';
    if (!mine && who !== lastSender) {
      const name = document.createElement('div');
      name.className = 'msg-name';
      name.textContent = who;
      elMessages.append(name);
    }
    lastSender = who;
    const div = document.createElement('div');
    div.className = `msg ${mine ? 'mine' : 'theirs'}`;
    div.textContent = text;
    elMessages.append(div);
    elMessages.scrollTop = elMessages.scrollHeight;
  }

  // Small centered dim line ("Sarah joined", "Marcus left").
  function appendSystem(text) {
    lastSender = null; // next real message re-labels its sender
    const div = document.createElement('div');
    div.className = 'msg-sys';
    div.textContent = text;
    elMessages.append(div);
    elMessages.scrollTop = elMessages.scrollHeight;
  }

  // Occupancy chip in the rail header (count includes yourself).
  function setOnlineCount(n) {
    $('online-chip').textContent = n === 1 ? '1 here' : `${n} here`;
  }

  elSendForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('send-input');
    const text = input.value.trim();
    if (!text || !ctx.signaling.isOpen()) return;
    ctx.signaling.signal({ type: 'chat', text });
    appendMessage('You', text);
    input.value = '';
  });

  // Invite = the copy-link flow (same clipboard write + button feedback).
  $('invite-btn').addEventListener('click', () => {
    $('copy-link').click();
    ctx.controls.notice('Room link copied — send it to a friend.', 'ok', 3000);
  });

  return { appendMessage, appendSystem, setOnlineCount };
}
