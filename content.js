// content.js – injects Natural Language UI and delegates network calls to background.js
(function () {
  'use strict';

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
        <div id="nlp-result" class="nlp-result hidden"></div>
        <div id="nlp-error" class="nlp-error hidden"></div>
      </div>
    `;

    const searchContainer = searchInput.parentElement;
    searchContainer.appendChild(toggleButton);
    searchContainer.appendChild(nlContainer);

    toggleButton.addEventListener('click', () => {
      nlContainer.classList.toggle('hidden');
      if (!nlContainer.classList.contains('hidden')) {
        document.getElementById('nlp-input').focus();
      }
    });

    document.getElementById('nlp-cancel').addEventListener('click', () => {
      nlContainer.classList.add('hidden');
      document.getElementById('nlp-input').value = '';
      document.getElementById('nlp-result').classList.add('hidden');
      document.getElementById('nlp-error').classList.add('hidden');
    });

    document.getElementById('nlp-convert').addEventListener('click', handleConvert);

    document.getElementById('nlp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleConvert();
      }
    });
  }

  async function handleConvert() {
    const input = document.getElementById('nlp-input').value.trim();
    const resultDiv = document.getElementById('nlp-result');
    const errorDiv = document.getElementById('nlp-error');
    const convertBtn = document.getElementById('nlp-convert');

    if (!input) return;

    resultDiv.classList.add('hidden');
    errorDiv.classList.add('hidden');

    convertBtn.textContent = 'Converting...';
    convertBtn.disabled = true;

    try {
      const { licenseKey } = await chrome.storage.sync.get(['licenseKey']);
      if (!licenseKey) throw new Error('Please activate your license in the extension popup!');

      const resp = await chrome.runtime.sendMessage({
        type: 'convert',
        query: input,
        licenseKey,
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

      const { searchCount } = await chrome.storage.sync.get(['searchCount']);
      await chrome.storage.sync.set({ searchCount: (searchCount || 0) + 1 });

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
