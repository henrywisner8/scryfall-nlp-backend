// background.js – handles API calls and upgrade link
const BACKEND_URL = 'https://scryfall-nlp-backend-production.up.railway.app';
const PAYMENT_LINK = 'https://buy.stripe.com/14A7sM1mCa0W6Mp8Dl2kw00';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'convert') {
    handleConvert(request, sendResponse);
    return true; // Keep channel open for async response
  }
  
  if (request.type === 'openUpgrade') {
    chrome.tabs.create({ url: PAYMENT_LINK });
    return false;
  }
});

async function handleConvert(request, sendResponse) {
  const { query, licenseKey, provider } = request;

  try {
    const response = await fetch(`${BACKEND_URL}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        licenseKey,
        provider: provider || 'openai'
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      sendResponse({
        ok: false,
        error: errorData.error || `Server error: ${response.status}`
      });
      return;
    }

    const data = await response.json();
    sendResponse({
      ok: true,
      data: data
    });
  } catch (error) {
    console.error('Conversion error:', error);
    sendResponse({
      ok: false,
      error: error.message || 'Network error'
    });
  }
}