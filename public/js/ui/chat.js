// Text chat, relayed over the signaling socket. The message + form nodes are
// stable references (ctx.els) because the Document PiP companion relocates them
// out of the main document.

import { $ } from '../lib/dom.js';

export function createChat(ctx) {
  const elMessages = ctx.els.messages;
  const elSendForm = ctx.els.sendForm;

  function appendMessage(who, text) {
    const div = document.createElement('div');
    div.className = `msg ${who === 'You' ? 'mine' : 'theirs'}`;
    const label = document.createElement('strong');
    label.textContent = `${who}: `;
    div.append(label, document.createTextNode(text));
    elMessages.append(div);
    elMessages.scrollTop = elMessages.scrollHeight;
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

  return { appendMessage };
}
