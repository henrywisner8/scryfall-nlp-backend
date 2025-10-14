const BACKEND_URL = 'https://scryfall-nlp-backend-production.up.railway.app';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const done = (payload) => { try { sendResponse(payload); } catch {} };

  if (msg?.type === 'convert') {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/convert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: msg.query, licenseKey: msg.licenseKey })
        });
        const data = await res.json();
        done({ ok: true, data });
      } catch (e) {
        done({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // keep channel open
  }

  if (msg?.type === 'validate') {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/validate-license`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: msg.licenseKey })
        });
        const data = await res.json();
        done({ ok: true, data });
      } catch (e) {
        done({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
});
