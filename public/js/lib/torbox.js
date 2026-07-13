// Frontend TorBox API client: a thin POST wrapper plus local API-key access.
// The server proxies these calls to TorBox — the key is sent per-request and
// never stored server-side.

export async function torboxPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return { success: false, detail: `unexpected response (HTTP ${res.status})` };
  }
}

export function getKey() {
  return (localStorage.getItem('torbox_api_key') || '').trim();
}
