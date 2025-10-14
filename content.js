// content.js - Injects natural language search into Scryfall
(function() {
  'use strict';
  
  const BACKEND_URL = 'scryfall-nlp-backend-production.up.railway.app'; // Change to your Railway URL
  
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
    
    // Create toggle button
    const toggleButton = document.createElement('button');
    toggleButton.id = 'nlp-toggle';
    toggleButton.type = 'button';
    toggleButton.innerHTML = '✨ Natural Language';
    toggleButton.className = 'nlp-toggle-btn';
    
    // Create NL input container
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
    
    // Event listeners
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
      // Get license key from storage
      const { licenseKey } = await chrome.storage.sync.get(['licenseKey']);
      
      if (!licenseKey) {
        throw new Error('Please activate your license in the extension popup!');
      }
      
      // Call backend API
      const response = await fetch(`${BACKEND_URL}/api/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: input,
          licenseKey: licenseKey,
          provider: 'openai'
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Conversion failed');
      }
      
      const data = await response.json();
      const syntax = data.syntax;
      
      // Show result
      resultDiv.innerHTML = `
        <div class="nlp-result-label">Scryfall Syntax:</div>
        <code class="nlp-syntax">${syntax}</code>
      `;
      resultDiv.classList.remove('hidden');
      
      // Increment search count
      const { searchCount } = await chrome.storage.sync.get(['searchCount']);
      await chrome.storage.sync.set({ searchCount: (searchCount || 0) + 1 });
      
      // Auto-search after 1 second
      setTimeout(() => {
        const searchInput = document.querySelector('input[name="q"]');
        searchInput.value = syntax;
        searchInput.form.submit();
      }, 1000);
      
    } catch (error) {
      errorDiv.textContent = error.message;
      errorDiv.classList.remove('hidden');
    } finally {
      convertBtn.textContent = 'Convert & Search';
      convertBtn.disabled = false;
    }
  }
  
  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForSearchForm);
  } else {
    waitForSearchForm();
  }
})();