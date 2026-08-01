// Settings popover: TorBox + TMDb API keys. Keys live only in this browser's
// localStorage and are sent per-request; Save validates against the provider.

import { $ } from '../lib/dom.js';
import { torboxPost, getKey } from '../lib/torbox.js';
import { checkTurn } from '../lib/turn-check.js';

export function createSettings(ctx) {
  const getTmdbKey = () => (localStorage.getItem('tmdb_api_key') || '').trim();

  function openSettings(open) {
    $('settings-panel').hidden = !open;
  }

  // Reveal-eye on the key inputs (they stay type=password by default).
  function bindEye(inputId, eyeId) {
    const input = $(inputId);
    const eye = $(eyeId);
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.classList.toggle('active', show);
      eye.title = show ? 'Hide key' : 'Show key';
    });
  }
  bindEye('torbox-key', 'torbox-eye');
  bindEye('tmdb-key', 'tmdb-eye');

  // ---- Relay (TURN) self-test ----
  $('turn-test').addEventListener('click', async () => {
    const btn = $('turn-test');
    const out = $('turn-test-status');
    btn.disabled = true;
    out.className = 'key-status';
    out.textContent = 'Testing the relay…';
    try {
      const r = await checkTurn();
      out.textContent = r.verdict;
      out.className = `key-status ${r.ok ? 'valid' : 'invalid'}`;
      // Full detail (candidate types + every ICE error) for a deeper look.
      console.info('[cowatch] relay test', r);
      out.title = r.iceErrors?.length ? r.iceErrors.join('\n') : '';
    } catch (err) {
      out.textContent = `Relay test failed: ${err.message || err}`;
      out.className = 'key-status invalid';
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Room server (app only) ----
  // The one thing a local-only app cannot decide for itself: where the shared
  // room lives. This used to be a Room-menu item that called window.prompt()
  // from the main process — Electron's renderer does not reliably support
  // that call, and it hung the page the same way the display-name prompt did.
  // A field in this already-working panel avoids native dialogs entirely.
  if (window.__cowatchDesktop) {
    $('room-server-field').hidden = false;
    window.__cowatchDesktop
      .getSettings()
      .then((s) => {
        $('room-server').value = s?.signaling || '';
      })
      .catch(() => {});

    const saveSignaling = async () => {
      const value = $('room-server').value.trim();
      const status = $('room-server-status');
      status.textContent = 'Saving…';
      status.className = 'key-status';
      try {
        await window.__cowatchDesktop.setSignaling(value);
        // The shell reloads the page to reconnect on the new address — this
        // message is the last thing that will be visible before that happens.
        status.textContent = value ? 'Saved — reconnecting…' : 'Cleared — rooms will stay on this machine.';
        status.className = 'key-status valid';
      } catch (err) {
        status.textContent = `Could not save: ${err.message || err}`;
        status.className = 'key-status invalid';
      }
    };
    $('room-server-save').addEventListener('click', saveSignaling);
    $('room-server').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveSignaling();
      }
    });
  }

  // ---- TorBox key ----
  $('torbox-key').value = getKey();
  updateKeyStatus(getKey() ? 'unknown' : 'empty');

  $('settings-btn').addEventListener('click', () => openSettings($('settings-panel').hidden));
  document.addEventListener('click', (e) => {
    if (
      !$('settings-panel').hidden &&
      !$('settings-panel').contains(e.target) &&
      e.target !== $('settings-btn') &&
      !$('settings-btn').contains(e.target)
    )
      openSettings(false);
  });

  $('torbox-save').addEventListener('click', validateAndSaveKey);
  $('torbox-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      validateAndSaveKey();
    }
  });

  async function validateAndSaveKey() {
    const key = $('torbox-key').value.trim();
    localStorage.setItem('torbox_api_key', key);
    if (!key) {
      updateKeyStatus('empty');
      return;
    }
    updateKeyStatus('checking');
    try {
      const r = await torboxPost('/torbox/check', { apiKey: key });
      updateKeyStatus(r?.valid ? 'valid' : 'invalid', r?.plan, r?.detail);
    } catch {
      updateKeyStatus('invalid', null, 'could not reach TorBox');
    }
  }

  // ---- TMDb key ----
  $('tmdb-key').value = getTmdbKey();
  updateTmdbKeyStatus(getTmdbKey() ? 'unknown' : 'empty');
  $('tmdb-save').addEventListener('click', validateAndSaveTmdbKey);
  $('tmdb-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      validateAndSaveTmdbKey();
    }
  });

  async function validateAndSaveTmdbKey() {
    const key = $('tmdb-key').value.trim();
    localStorage.setItem('tmdb_api_key', key);
    if (!key) {
      updateTmdbKeyStatus('empty');
      ctx.search.checkTmdbKey();
      return;
    }
    updateTmdbKeyStatus('checking');
    try {
      const res = await fetch('/api/tmdb/search?query=test', { headers: { 'x-tmdb-key': key } });
      const j = await res.json().catch(() => null);
      updateTmdbKeyStatus(j?.success ? 'valid' : 'invalid', j?.detail);
    } catch {
      updateTmdbKeyStatus('invalid', 'could not reach the server');
    }
    ctx.search.checkTmdbKey();
  }

  function updateTmdbKeyStatus(state, detail) {
    const el = $('tmdb-key-status');
    if (state === 'empty') {
      el.textContent = 'No key saved.';
      el.className = 'key-status';
    } else if (state === 'unknown') {
      el.textContent = 'Key saved (click Save to re-validate).';
      el.className = 'key-status';
    } else if (state === 'checking') {
      el.textContent = 'Checking…';
      el.className = 'key-status';
    } else if (state === 'valid') {
      el.textContent = 'Valid.';
      el.className = 'key-status valid';
    } else {
      el.textContent = `Invalid${detail ? ` — ${detail}` : ''}.`;
      el.className = 'key-status invalid';
    }
  }

  function updateKeyStatus(state, plan, detail) {
    const el = $('torbox-key-status');
    if (state === 'empty') {
      el.textContent = 'No key saved.';
      el.className = 'key-status';
    } else if (state === 'unknown') {
      el.textContent = 'Key saved (click Save to re-validate).';
      el.className = 'key-status';
    } else if (state === 'checking') {
      el.textContent = 'Checking…';
      el.className = 'key-status';
    } else if (state === 'valid') {
      el.textContent = plan ? `Valid — ${plan} plan.` : 'Valid.';
      el.className = 'key-status valid';
    } else {
      el.textContent = `Invalid${detail ? ` — ${detail}` : ''}.`;
      el.className = 'key-status invalid';
    }
  }

  return { openSettings };
}
