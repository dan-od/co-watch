// Text chat, relayed over the signaling socket. The message + form nodes are
// stable references (ctx.els) because the Document PiP companion relocates them
// out of the main document (#chat-head stays in the rail).
//
// Layout per the mockups: a mono "Name · time" line above each message, and
// join/leave events as italic system lines.

import { $ } from '../lib/dom.js';

const clock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export function createChat(ctx) {
  const elMessages = ctx.els.messages;
  const elSendForm = ctx.els.sendForm;

  function appendMessage(who, text) {
    const mine = who === 'You';
    const div = document.createElement('div');
    div.className = `msg${mine ? ' mine' : ''}`;
    const head = document.createElement('div');
    head.className = 'who';
    head.textContent = who;
    const time = document.createElement('span');
    time.textContent = clock();
    head.append(time);
    const body = document.createElement('p');
    body.textContent = text;
    div.append(head, body);
    elMessages.append(div);
    elMessages.scrollTop = elMessages.scrollHeight;
  }

  // Italic centered line ("Sarah joined", "Marcus left").
  function appendSystem(text) {
    const div = document.createElement('div');
    div.className = 'msg sys';
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
