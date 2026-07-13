// ICE config served to clients. TURN credentials come from the environment
// (PRD §15: secrets never go in source). Note: whatever is served here is
// visible to anyone who can open a room link — inherent to browser TURN.

function iceConfig() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  const forceRelay = /^(1|true|yes)$/i.test(process.env.FORCE_RELAY || '');
  return { iceServers, forceRelay };
}

function handleIceConfig(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(iceConfig()));
}

module.exports = { iceConfig, handleIceConfig };
