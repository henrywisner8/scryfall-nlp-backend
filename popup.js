// popup.js - License management and settings

const BACKEND_URL = 'scryfall-nlp-backend-production.up.railway.app'; // Change to your Railway URL in production

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await checkLicenseStatus();
  attachEventListeners();
}

function attachEventListeners() {
  document.getElementById('activateBtn').addEventListener('click', activateLicense);
  document.getElementById('deactivateBtn').addEventListener('click', deactivateLicense);
  
  document.getElementById('licenseInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      activateLicense();
    }
  });
  
  document.getElementById('helpLink').addEventListener('click', (e) => {
    e.preventDefault();
    showHelp();
  });
  
  document.getElementById('supportLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'mailto:support@yoursite.com' });
  });
}

async function checkLicenseStatus() {
  const { licenseKey, searchCount } = await chrome.storage.sync.get(['licenseKey', 'searchCount']);
  
  if (licenseKey) {
    // Validate license with backend
    try {
      const response = await fetch(`${BACKEND_URL}/api/validate-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey })
      });
      
      const data = await response.json();
      
      if (data.valid) {
        showActivatedView(licenseKey, searchCount || 0);
      } else {
        showNotActivatedView('License key is invalid. Please re-enter.');
        await chrome.storage.sync.remove(['licenseKey']);
      }
    } catch (error) {
      console.error('License validation error:', error);
      showActivatedView(licenseKey, searchCount || 0); // Allow offline usage
    }
  } else {
    showNotActivatedView();
  }
}

function showActivatedView(licenseKey, searchCount) {
  document.getElementById('notActivatedView').classList.add('hidden');
  document.getElementById('activatedView').classList.remove('hidden');
  
  document.getElementById('searchCount').textContent = searchCount;
  document.getElementById('licenseDisplay').textContent = 
    licenseKey.substring(0, 13) + '...';
}

function showNotActivatedView(message = null) {
  document.getElementById('activatedView').classList.add('hidden');
  document.getElementById('notActivatedView').classList.remove('hidden');
  
  if (message) {
    showAlert(message, 'error');
  }
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
      await chrome.storage.sync.set({ licenseKey, searchCount: 0 });
      showAlert('✓ License activated successfully!', 'success');
      setTimeout(() => {
        showActivatedView(licenseKey, 0);
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
    await chrome.storage.sync.remove(['licenseKey']);
    showNotActivatedView();
  }
}

function showAlert(message, type) {
  const alertBox = document.getElementById('alertBox');
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
  const helpText = `Scryfall NLP - Help

How to use:
1. Go to scryfall.com
2. Click the "✨ Natural Language" button
3. Type your search in plain English
4. The extension converts it to Scryfall syntax

Examples:
• "blue dinosaurs" → t:dinosaur c:u
• "cheap red removal" → c:r (o:destroy OR o:exile) mv<=3
• "modern zombies with power 3+" → t:zombie f:modern pow>=3

Tips:
• Mention colors, types, abilities, formats
• Be specific for better results
• You can edit the syntax before searching

License:
• One-time $5 payment
• Unlimited searches
• Lifetime access

Support: support@yoursite.com`;
  
  alert(helpText);
}