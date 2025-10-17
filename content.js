// content.js – injects Natural Language UI with freemium support
(function () {
  'use strict';

  const FREE_SEARCH_LIMIT = 5;

  function waitForSearchForm() {
    const searchForm = document.querySelector('form[action="/search"]');
    if (searchForm) {
      injectNaturalLanguageUI(searchForm);
    } else {
      setTimeout(waitForSearchForm, 500);
    }
  }

  function injectNaturalLanguageUI(searchForm) {
    if (document.getElementById('nlp-toggle')) return;

    const searchInput = searchForm.querySelector('input[name="q"]');
    if (!searchInput) return;

    const toggleButton = document.createElement('button');
    toggleButton.id = 'nlp-toggle';
    toggleButton.type = 'button';
    toggleButton.innerHTML = '✨ Natural Language';
    toggleButton.className = 'nlp-toggle-btn';

    const nlContainer = document.createElement('div');
    nlContainer.id = 'nlp-container';
    nlContainer.className = 'nlp-container hidden';
    nlContainer.innerHTML = `
      <div class="nlp-box">
        <label for="nlp-input" class="nlp-label">
          Describe the cards you want in plain English:
        </label>
        <textarea 
          id="nlp-input" 
          class="nlp-input" 
          placeholder="e.g., blue dinosaurs with flying"
          rows="2"
        ></textarea>
        <div class="nlp-actions">
          <button id="nlp-convert" class="nlp-convert-btn" type="button">
            Convert & Search
          </button>
          <button id="nlp-cancel" class="nlp-cancel-btn" type="button">
            Cancel
          </button>
        </div>
        <div id="nlp-usage" class="nlp-usage hidden"></div>
        <div id="nlp-result" class="nlp-result hidden"></div>
        <div id="nlp-error" class="nlp-error hidden"></div>
      </div>
    `;

    const searchContainer = searchInput.parentElement;
    searchContainer.appendChild(toggleButton);
    searchContainer.appendChild(nlContainer);

    toggleButton.addEventListener('click', async () => {
      nlContainer.classList.toggle('hidden');
      if (!nlContainer.classList.contains('hidden')) {
        document.getElementById('nlp-input').focus();
        await updateUsageDisplay();
      }
    });

    document.getElementById('nlp-cancel').addEventListener('click', () => {
      nlContainer.classList.add('hidden');
      document.getElementById('nlp-input').value = '';
      document.getElementById('nlp-result').classList.add('hidden');
      document.getElementById('nlp-error').classList.add('hidden');
      document.getElementById('nlp-usage').classList.add('hidden');
    });

    document.getElementById('nlp-convert').addEventListener('click', handleConvert);

    document.getElementById('nlp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleConvert();
      }
    });
  }

  async function updateUsageDisplay() {
    const usageDiv = document.getElementById('nlp-usage');
    if (!usageDiv) return;
    
    try {
      const { licenseKey, searchCount } = await chrome.storage.sync.get(['licenseKey', 'searchCount']);
      const count = searchCount || 0;

      if (licenseKey) {
        // Has license - unlimited
        usageDiv.innerHTML = `<span style="color: #22543d;">⭐ PRO: Unlimited searches</span>`;
        usageDiv.classList.remove('hidden');
      } else if (count >= FREE_SEARCH_LIMIT) {
        // Limit reached
        usageDiv.innerHTML = `<span style="color: #742a2a;">🔒 Free limit reached. <a href="#" id="nlp-upgrade-link" style="color: #667eea; text-decoration: underline;">Upgrade for unlimited</a></span>`;
        usageDiv.classList.remove('hidden');
        
        // Add click handler for upgrade link
        setTimeout(() => {
          document.getElementById('nlp-upgrade-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.sendMessage({ type: 'openUpgrade' });
          });
        }, 100);
      } else {
        // Free searches remaining
        const remaining = FREE_SEARCH_LIMIT - count;
        const color = remaining <= 1 ? '#c53030' : '#2c5282';
        usageDiv.innerHTML = `<span style="color: ${color};">🎁 Free trial: ${remaining} search${remaining !== 1 ? 'es' : ''} remaining</span>`;
        usageDiv.classList.remove('hidden');
      }
    } catch (error) {
      console.error('Error updating usage display:', error);
      usageDiv.classList.add('hidden');
    }
  }

  async function handleConvert() {
    const input = document.getElementById('nlp-input').value.trim();
    const resultDiv = document.getElementById('nlp-result');
    const errorDiv = document.getElementById('nlp-error');
    const convertBtn = document.getElementById('nlp-convert');

    if (!input) return;

    resultDiv.classList.add('hidden');
    errorDiv.classList.add('hidden');

    // Check usage limits
    const { licenseKey, searchCount } = await chrome.storage.sync.get(['licenseKey', 'searchCount']);
    const count = searchCount || 0;

    if (!licenseKey && count >= FREE_SEARCH_LIMIT) {
      errorDiv.innerHTML = `
        You've used all 5 free searches! 🎉<br>
        <a href="#" id="nlp-upgrade-error" style="color: #667eea; text-decoration: underline; font-weight: bold;">
          Upgrade to unlimited for $4.99
        </a>
      `;
      errorDiv.classList.remove('hidden');
      
      setTimeout(() => {
        document.getElementById('nlp-upgrade-error')?.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.runtime.sendMessage({ type: 'openUpgrade' });
        });
      }, 100);
      return;
    }

    convertBtn.textContent = 'Converting...';
    convertBtn.disabled = true;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'convert',
        query: input,
        licenseKey: licenseKey || 'FREE_TRIAL',
        provider: 'openai'
      });

      if (!resp || !resp.ok) {
        throw new Error(resp?.error || 'Conversion failed');
      }

      const syntax = resp.data?.syntax;
      if (!syntax) throw new Error('No syntax returned from backend');

      resultDiv.innerHTML = `
        <div class="nlp-result-label">Scryfall Syntax:</div>
        <code class="nlp-syntax">${syntax}</code>
      `;
      resultDiv.classList.remove('hidden');

      // Increment search count
      await chrome.storage.sync.set({ searchCount: count + 1 });
      await updateUsageDisplay();

      setTimeout(() => {
        const searchInput = document.querySelector('input[name="q"]');
        if (searchInput && searchInput.form) {
          searchInput.value = syntax;
          searchInput.form.submit();
        }
      }, 1000);
    } catch (error) {
      errorDiv.textContent = error.message;
      errorDiv.classList.remove('hidden');
    } finally {
      convertBtn.textContent = 'Convert & Search';
      convertBtn.disabled = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForSearchForm);
  } else {
    waitForSearchForm();
  }
})();