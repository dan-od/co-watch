// CoWatch client — Phase 1: room join + relayed messages over the signaling socket.

const $ = (id) => document.getElementById(id);

const roomMatch = location.pathname.match(/^\/r\/([\w-]{4,64})$/);

if (roomMatch) {
  enterRoom(roomMatch[1]);
} else {
  showLanding();
}

function showLanding() {
  $('landing').hidden = false;
  $('create-room').addEventListener('click', () => {
    const id = randomRoomId();
    location.href = `/r/${id}`;
  });
}

function randomRoomId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

function enterRoom(roomId) {
  $('room').hidden = false;
  const linkInput = $('room-link');
  linkInput.value = location.href;

  $('copy-link').addEventListener('click', async () => {
    await navigator.clipboard.writeText(linkInput.value);
    $('copy-link').textContent = 'Copied!';
    setTimeout(() => ($('copy-link').textContent = 'Copy link'), 1500);
  });

  const status = $('status');
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `status ${kind}`;
  };

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  let peerPresent = false;
  let rejected = false; // room-full: keep that status when the server closes the socket

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId }));
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'joined':
        peerPresent = msg.peers === 2;
        setStatus(
          peerPresent ? 'Connected — your friend is here.' : 'Waiting for the other person to join…',
          peerPresent ? 'ok' : ''
        );
        break;
      case 'peer-joined':
        peerPresent = true;
        setStatus('Connected — your friend is here.', 'ok');
        break;
      case 'peer-left':
        peerPresent = false;
        setStatus('The other person left. Waiting for them to rejoin…', 'warn');
        break;
      case 'room-full':
        rejected = true;
        setStatus('This room already has two people. Rooms are limited to two.', 'error');
        break;
      case 'chat':
        appendMessage('Them', msg.text);
        break;
    }
  });

  ws.addEventListener('close', () => {
    if (!rejected) setStatus('Disconnected from the server. Refresh to reconnect.', 'error');
  });

  ws.addEventListener('error', () => {
    setStatus('Could not reach the server.', 'error');
  });

  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('send-input');
    const text = input.value.trim();
    if (!text || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
    appendMessage('You', text);
    input.value = '';
  });

  function appendMessage(who, text) {
    const div = document.createElement('div');
    div.className = `msg ${who === 'You' ? 'mine' : 'theirs'}`;
    const label = document.createElement('strong');
    label.textContent = `${who}: `;
    div.append(label, document.createTextNode(text));
    $('messages').append(div);
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}
