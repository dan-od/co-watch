// Relay (TURN) self-test.
//
// Cameras, mics and screen share ride WebRTC, which needs a working relay once
// two people are on different networks. Chat and Sync playback don't — they go
// over the room's own socket — which is exactly why "Sync works but nobody can
// see each other" points here.
//
// This asks the browser to gather RELAY-ONLY candidates using the very ICE
// config the server hands out, so it exercises the same credentials the app
// does, from the machine that's actually failing.

export async function checkTurn() {
  let cfg;
  try {
    cfg = await (await fetch('/ice-config')).json();
  } catch {
    return { verdict: 'Could not reach this room’s server to read its relay settings.', iceErrors: [] };
  }
  const turns = (cfg.iceServers || [])
    .flatMap((s) => [].concat(s.urls || []))
    .filter((u) => /^turns?:/i.test(u));

  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: 'relay' });
  const found = new Set();
  const errors = [];
  pc.onicecandidate = (e) => {
    const m = e.candidate && / typ (\w+)/.exec(e.candidate.candidate);
    if (m) found.add(m[1]);
  };
  pc.onicecandidateerror = (e) =>
    errors.push(`${e.errorCode} ${e.errorText || ''} ${e.url || ''}`.trim());
  pc.createDataChannel('probe');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((done) => {
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, 8000); // never hang on a stalled gather
    check();
  });
  pc.close();

  const ok = found.has('relay');
  const code = (re) => errors.some((e) => re.test(e));
  return {
    turnServersConfigured: turns,
    relayCandidateFound: ok,
    candidateTypes: [...found],
    iceErrors: errors,
    ok,
    verdict: ok
      ? 'Relay works — cameras and screen share can connect across networks.'
      : !turns.length
        ? 'No relay configured. Set TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL in .env and restart the server.'
        : code(/^401 /)
          ? 'The relay rejected the credentials (401). Regenerate them and restart the server.'
          : code(/^486 /)
            ? 'The relay is out of allowance (486 quota reached).'
            : code(/^400 /)
              ? 'The relay refused the allocation (400) — usually wrong credentials for this relay URL, or an expired/disabled key. Copy the exact URL *and* credentials from your provider’s dashboard.'
              : code(/^70[01] /)
                ? 'The relay host could not be reached (DNS or a blocked port). Check TURN_URLS.'
                : 'No relay candidate was produced, and the relay reported no error.',
  };
}
