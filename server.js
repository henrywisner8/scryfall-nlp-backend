// Production backend with license key validation
const express = require('express');
const cors = require('cors');

// ---- Rate limiting (per license) ----
const WINDOW_MS = 60 * 60 * 1000;   // 1 hour
const MAX_REQUESTS = 60;            // per license per window
const usage = new Map();            // licenseKey -> { count, resetAt }

function setRateHeaders(res, remaining, resetAt) {
  // IETF draft headers: https://www.rfc-editor.org/rfc/rfc-x (common pattern)
  res.setHeader('RateLimit-Limit', String(MAX_REQUESTS));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))));
}

function rateLimitPerLicense(req, res, next) {
  // only apply to licensed endpoints
  const key = req.body?.licenseKey;
  if (!key) return res.status(401).json({ error: 'License key required' });

  let rec = usage.get(key);
  const now = Date.now();

  if (!rec || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + WINDOW_MS };
  }

  if (rec.count >= MAX_REQUESTS) {
    setRateHeaders(res, 0, rec.resetAt);
    return res.status(429).json({
      error: 'Rate limit exceeded. Try again later.',
      limit: MAX_REQUESTS,
      resetSeconds: Math.ceil((rec.resetAt - now) / 1000)
    });
  }

  rec.count += 1;
  usage.set(key, rec);

  setRateHeaders(res, MAX_REQUESTS - rec.count, rec.resetAt);
  next();
}

// (optional) periodic cleanup to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of usage) if (now > v.resetAt + WINDOW_MS) usage.delete(k);
}, 30 * 60 * 1000);
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory license key storage
// In production, use a database like PostgreSQL or MongoDB
const VALID_LICENSES = new Set();

// Add some test licenses (in production, these come from Stripe webhooks)
VALID_LICENSES.add('TEST-1234-5678-ABCD');
VALID_LICENSES.add('TEST-9999-8888-XXXX');

const SYSTEM_PROMPT = `You are a Scryfall search syntax converter. Convert natural language to valid Scryfall syntax.

OUTPUT RULES:
- Output ONLY the search syntax
- No explanations, quotes, or extra text
- Use exact operators as shown below

COLORS:
c:w (white) c:u (blue) c:b (black) c:r (red) c:g (green)
c:colorless (colorless cards)

CARD TYPES:
t:creature t:instant t:sorcery t:artifact t:enchantment t:planeswalker t:land
t:legendary (legendary supertype)
Creature subtypes: t:dinosaur t:dragon t:elf t:goblin t:zombie t:vampire t:angel t:demon

ORACLE TEXT:
o:flying o:deathtouch o:lifelink o:trample o:haste o:vigilance
o:"draw a card" (exact phrases in quotes)
o:destroy o:exile o:counter

MANA VALUE:
mv:3 (exactly 3)
mv>=4 (4 or more)
mv<=2 (2 or less)

POWER/TOUGHNESS:
pow:3 pow>5 pow<6 pow>=4 pow<=2
tou:4 tou>3 tou<6 tou>=2 tou<=5

FORMAT LEGALITY:
f:standard f:modern f:pioneer f:commander f:legacy f:vintage f:pauper

SETS:
s:dom s:khm s:war (3-letter codes)

RARITY:
r:c r:u r:r r:m

PRICES:
usd>=5 usd<=10

BOOLEAN LOGIC:
Space = AND
OR with parens: (c:w OR c:u)
NOT: -t:creature

EXAMPLES:
"blue dinosaurs" → t:dinosaur c:u
"green dinosaurs with toughness less than 6" → t:dinosaur c:g tou<6
"red dragons with flying" → t:dragon c:r o:flying
"black zombies modern legal power 2-5" → t:zombie c:b f:modern pow>2 pow<5
"legendary elves from Dominaria" → t:legendary t:elf s:dom
"cheap red removal" → c:r (o:destroy OR o:exile) mv<=3
"white or blue angels" → t:angel (c:w OR c:u)

Output syntax only.`;

// POST /api/convert - Main conversion endpoint
app.post('/api/convert', rateLimitPerLicense, async (req, res) => {

  const { query, licenseKey, provider } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }
  
  if (!licenseKey) {
    return res.status(401).json({ error: 'License key required' });
  }
  
  // Validate license key
  if (!VALID_LICENSES.has(licenseKey)) {
    return res.status(403).json({ error: 'Invalid license key' });
  }

  try {
    let result;
    const useProvider = provider || 'openai';
    
    if (useProvider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: query }],
          temperature: 0.1
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        console.error('Anthropic API error:', error);
        throw new Error('AI service temporarily unavailable');
      }
      
      const data = await response.json();
      result = data.content[0].text.trim();
    } else {
      // Default to OpenAI
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: query }
          ],
          temperature: 0.1,
          max_tokens: 200
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        console.error('OpenAI API error:', error);
        throw new Error('AI service temporarily unavailable');
      }
      
      const data = await response.json();
      result = data.choices[0].message.content.trim();
    }
    
    console.log(`[${licenseKey.substring(0, 8)}...] "${query}" → "${result}"`);
    res.json({ syntax: result });
    
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: error.message || 'Conversion failed' });
  }
});

// POST /api/validate-license - Check if license is valid
app.post('/api/validate-license', (req, res) => {
  const { licenseKey } = req.body;
  
  if (!licenseKey) {
    return res.status(400).json({ valid: false, error: 'License key required' });
  }
  
  const isValid = VALID_LICENSES.has(licenseKey);
  res.json({ valid: isValid });
});

// POST /api/activate-license - Activate a new license (called by Stripe webhook)
app.post('/api/activate-license', (req, res) => {
  const { licenseKey, stripeSignature } = req.body;
  
  // In production, verify Stripe webhook signature
  // For now, just add the license
  if (licenseKey && licenseKey.startsWith('SCRY-')) {
    VALID_LICENSES.add(licenseKey);
    console.log(`✓ Activated license: ${licenseKey}`);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid license format' });
  }
});

// GET /health - Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    licenses: VALID_LICENSES.size
  });
});

// GET / - Root
app.get('/', (req, res) => {
  res.json({ 
    name: 'Scryfall NLP API',
    version: '2.0.0',
    status: 'operational'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✨ Scryfall NLP API v2.0`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔑 Active licenses: ${VALID_LICENSES.size}`);
  console.log(`🤖 Provider: ${process.env.OPENAI_API_KEY ? 'OpenAI' : process.env.ANTHROPIC_API_KEY ? 'Anthropic' : 'NONE'}`);
});