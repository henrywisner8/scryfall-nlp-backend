const BACKEND_URL = 'https://scryfall-nlp-backend-production.up.railway.app';
const FREE_SEARCH_LIMIT = 5;
const PAYMENT_LINK = 'https://buy.stripe.com/14A7sM1mCa0W6Mp8Dl2kw00';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await checkUserStatus();
  attachEventListeners();
}

function attachEventListeners() {
  document.getElementById('activateBtn').addEventListener('click', activateLicense);
  document.getElementById('deactivateBtn').addEventListener('click', deactivateLicense);
  document.getElementById('upgradeBtn').addEventListener('click', openUpgradeLink);
  document.getElementById('upgradeFromFree').addEventListener('click', (e) => {
    e.preventDefault();
    openUpgradeLink();
  });
  document.getElementById('licenseInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') activateLicense();
  });
  document.getElementById('helpLink').addEventListener('click', (e) => {
    e.preventDefault();
    showHelp();
  });
}

async function checkUserStatus() {
  const { licenseKey, searchCount } = await chrome.storage.sync.get(['licenseKey', 'searchCount']);
  const count = searchCount || 0;
  
  if (licenseKey) {
    // User has a license - validate it
    try {
      const response = await fetch(`${BACKEND_URL}/api/validate-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey })
      });
      const data = await response.json();
      if (data.valid) {
        showProView(licenseKey, count);
        return;
      } else {
        // License invalid - remove it and check free status
        await chrome.storage.sync.remove(['licenseKey']);
      }
    } catch (error) {
      console.error('License validation error:', error);
      // Network error - still show pro view if they have a license
      showProView(licenseKey, count);
      return;
    }
  }
  
  // No valid license - check free search count
  if (count >= FREE_SEARCH_LIMIT) {
    showLimitView();
  } else {
    showFreeView(count);
  }
}

function showProView(licenseKey, searchCount) {
  hideAllViews();
  document.getElementById('proView').classList.remove('hidden');
  document.getElementById('proSearchCount').textContent = searchCount;
  document.getElementById('licenseDisplay').textContent = licenseKey.substring(0, 13) + '...';
}

function showFreeView(searchCount) {
  hideAllViews();
  document.getElementById('freeView').classList.remove('hidden');
  document.getElementById('freeSearchCount').textContent = searchCount;
  document.getElementById('freeRemaining').textContent = FREE_SEARCH_LIMIT - searchCount;
  
  // Change color if running low
  const remaining = FREE_SEARCH_LIMIT - searchCount;
  if (remaining <= 1) {
    document.getElementById('freeRemaining').classList.add('warning');
  }
}

function showLimitView() {
  hideAllViews();
  document.getElementById('limitView').classList.remove('hidden');
}

function hideAllViews() {
  document.getElementById('proView').classList.add('hidden');
  document.getElementById('freeView').classList.add('hidden');
  document.getElementById('limitView').classList.add('hidden');
}

async function activateLicense() {
  const licenseInput = document.getElementById('licenseInput');
  const activateBtn = document.getElementById('activateBtn');
  const licenseKey = licenseInput.value.trim().toUpperCase();
  
  if (!licenseKey) {
    showAlert('Please enter a license key', 'error');
    return;
  }
  
  if (!licenseKey.startsWith('SCRY-') && !licenseKey.startsWith('TEST-')) {
    showAlert('Invalid license key format', 'error');
    return;
  }
  
  activateBtn.textContent = 'Validating...';
  activateBtn.disabled = true;
  
  try {
    const response = await fetch(`${BACKEND_URL}/api/validate-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey })
    });
    const data = await response.json();
    
    if (data.valid) {
      const { searchCount } = await chrome.storage.sync.get(['searchCount']);
      await chrome.storage.sync.set({ licenseKey });
      showAlert('✓ License activated successfully!', 'success');
      setTimeout(() => {
        showProView(licenseKey, searchCount || 0);
      }, 1500);
    } else {
      showAlert('Invalid license key. Please check and try again.', 'error');
    }
  } catch (error) {
    console.error('Activation error:', error);
    showAlert('Could not connect to server. Please try again.', 'error');
  } finally {
    activateBtn.textContent = 'Activate';
    activateBtn.disabled = false;
  }
}

async function deactivateLicense() {
  if (confirm('Are you sure you want to deactivate? You can reactivate with the same key later.')) {
    const { searchCount } = await chrome.storage.sync.get(['searchCount']);
    await chrome.storage.sync.remove(['licenseKey']);
    
    // Check if they should see free view or limit view
    if ((searchCount || 0) >= FREE_SEARCH_LIMIT) {
      showLimitView();
    } else {
      showFreeView(searchCount || 0);
    }
  }
}

function openUpgradeLink() {
  chrome.tabs.create({ url: PAYMENT_LINK });
}

function showAlert(message, type) {
  const alertBox = document.getElementById('alertBox');
  if (!alertBox) return;
  
  alertBox.textContent = message;
  alertBox.className = `alert alert-${type}`;
  alertBox.classList.remove('hidden');
  
  if (type === 'success') {
    setTimeout(() => {
      alertBox.classList.add('hidden');
    }, 3000);
  }
}

function showHelp() {
  const helpText = `Scryfall Easy Search - Help

How to use:
1. Go to scryfall.com
2. Click the "🔮 Natural Language" button
3. Type your search in plain English
4. The extension converts it to Scryfall syntax

Free Trial:
• 5 free searches to try it out
• No credit card required

Upgrade ($4.99):
• Unlimited searches
• Lifetime access
• One-time payment

Examples:
• "blue dinosaurs" → t:creature t:dinosaur c:u
• "cheap red removal" → c:r (o:destroy OR o:exile) mv<=3
• "modern zombies power 3+" → t:creature t:zombie f:modern pow>=3

Support: scrysyntaxextension@gmail.com`;
  alert(helpText);
}