// server.js — Scryfall NLP API (licenses + per-license rate limit + set resolver + PERSISTENCE)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const { Pool } = require('pg');

// ---------- database connection ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database table
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        license_key VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `);
    
    // Add test licenses if they don't exist
    await client.query(`
      INSERT INTO licenses (license_key, email, is_active) 
      VALUES ('TEST-1234-5678-ABCD', 'test@example.com', true)
      ON CONFLICT (license_key) DO NOTHING
    `);
    await client.query(`
      INSERT INTO licenses (license_key, email, is_active) 
      VALUES ('TEST-9999-8888-XXXX', 'test@example.com', true)
      ON CONFLICT (license_key) DO NOTHING
    `);
    
    const result = await client.query('SELECT COUNT(*) FROM licenses WHERE is_active = true');
    console.log(`📂 Database initialized. Active licenses: ${result.rows[0].count}`);
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
  } finally {
    client.release();
  }
}

// Check if license is valid
async function isLicenseValid(licenseKey) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM licenses WHERE license_key = $1 AND is_active = true',
      [licenseKey]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('License validation error:', error);
    return false;
  } finally {
    client.release();
  }
}

// Add new license
async function addLicense(licenseKey, email) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO licenses (license_key, email, is_active) VALUES ($1, $2, true)',
      [licenseKey, email]
    );
    console.log(`💾 License saved to database: ${licenseKey}`);
    return true;
  } catch (error) {
    console.error('Error saving license:', error);
    return false;
  } finally {
    client.release();
  }
}

// Get license by email (for session lookup)
async function getLicenseByEmail(email) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT license_key FROM licenses WHERE email = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1',
      [email]
    );
    return result.rows.length > 0 ? result.rows[0].license_key : null;
  } catch (error) {
    console.error('Error getting license by email:', error);
    return null;
  } finally {
    client.release();
  }
}

// ---------- utils ----------
function generateLicense() {
  const chunk = () =>
    Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return `SCRY-${chunk()}-${chunk()}-${chunk()}`;
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------- rate limit (per license) ----------
const WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60 * 60 * 1000); // 1h
const MAX_REQUESTS = Number(process.env.RATE_MAX_REQUESTS ?? 60);      // 60/h
const usage = new Map(); // licenseKey -> { count, resetAt }

function setRateHeaders(res, remaining, resetAt) {
  res.setHeader('RateLimit-Limit', String(MAX_REQUESTS));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader(
    'RateLimit-Reset',
    String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)))
  );
}

function rateLimitPerLicense(req, res, next) {
  const key = req.body?.licenseKey;
  if (!key) {
    setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
    return res.status(401).json({ error: 'License key required' });
  }
  const now = Date.now();
  let rec = usage.get(key);
  if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + WINDOW_MS };

  if (rec.count >= MAX_REQUESTS) {
    setRateHeaders(res, 0, rec.resetAt);
    return res.status(429).json({
      error: 'Rate limit exceeded. Try again later.',
      limit: MAX_REQUESTS,
      resetSeconds: Math.ceil((rec.resetAt - now) / 1000),
    });
  }
  rec.count += 1;
  usage.set(key, rec);
  setRateHeaders(res, MAX_REQUESTS - rec.count, rec.resetAt);
  next();
}

// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of usage) if (now > v.resetAt + WINDOW_MS) usage.delete(k);
}, 30 * 60 * 1000);

// ---------- sets resolver (cached) ----------
const SETS_CACHE = { data: null, fetchedAt: 0 };
const SETS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function fetchAllSets() {
  const now = Date.now();
  if (SETS_CACHE.data && now - SETS_CACHE.fetchedAt < SETS_TTL_MS) return SETS_CACHE.data;

  const resp = await fetch('https://api.scryfall.com/sets');
  if (!resp.ok) throw new Error('Failed to load Scryfall sets');
  const json = await resp.json();

  const sets = json.data.map((s) => ({
    code: (s.code || '').toLowerCase(),
    name: s.name || '',
    nameNorm: norm(s.name || ''),
    releasedAt: s.released_at || '0000-00-00',
  }));

  const aliases = [
    { code: 'cmm', name: 'commander masters' },
    { code: 'cma', name: 'commander anthology' },
    { code: 'mm2', name: 'modern masters 2015' },
    { code: 'mh2', name: 'modern horizons 2' },
    { code: '2xm', name: 'double masters' },
    { code: 'dom', name: 'dominaria' },
    { code: 'dmu', name: 'dominaria united' },
  ];
  for (const a of aliases) {
    sets.push({ code: a.code, name: a.name, nameNorm: norm(a.name), releasedAt: '9999-99-99' });
  }

  SETS_CACHE.data = sets;
  SETS_CACHE.fetchedAt = now;
  return sets;
}

function scoreMatch(q, nameNorm) {
  if (q.includes(nameNorm)) return 100;
  const qw = new Set(q.split(/\s+/));
  const nw = new Set(nameNorm.split(/\s+/));
  let overlap = 0;
  for (const w of nw) if (qw.has(w)) overlap++;
  return overlap;
}

async function getSetCandidatesFromQuery(query, k = 6) {
  const sets = await fetchAllSets();
  const q = norm(query);
  if (!q) return [];
  const qTight = q
    .replace(/\b(the|set|edition|masters|anthology|collection|series)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const scored = [];
  for (const s of sets) {
    const sTight = s.nameNorm
      .replace(/\b(the|set|edition|masters|anthology|collection|series)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const score = Math.max(scoreMatch(q, s.nameNorm), scoreMatch(qTight, sTight));
    if (score >= 1) scored.push({ ...s, score });
  }
  const bestByCode = new Map();
  for (const s of scored) {
    const prev = bestByCode.get(s.code);
    if (!prev || s.score > prev.score) bestByCode.set(s.code, s);
  }
  return [...bestByCode.values()]
    .sort((a, b) => b.score - a.score || b.releasedAt.localeCompare(a.releasedAt))
    .slice(0, k);
}

// ---------- app & storage ----------
const app = express();
app.use(cors());

// Initialize database on startup
initDatabase().catch(console.error);

function requireLicense(req, res, next) {
  const key = req.body?.licenseKey;
  if (!key) {
    setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
    return res.status(401).json({ error: 'License key required' });
  }
  
  // Check license validity from database
  isLicenseValid(key).then(valid => {
    if (!valid) {
      setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
      return res.status(403).json({ error: 'Invalid license key' });
    }
    next();
  }).catch(err => {
    console.error('License check error:', err);
    res.status(500).json({ error: 'License validation failed' });
  });
}

// ---------- Stripe webhook (MUST be FIRST route, BEFORE any body parsers) ----------
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!secret) {
      console.error('❌ STRIPE_WEBHOOK_SECRET not configured');
      return res.status(500).send('Webhook secret not configured');
    }
    
    let event;
    try {
      // Convert Buffer to string for Stripe
      const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
      event = stripe.webhooks.constructEvent(payload, sig, secret);
      console.log('✅ Webhook signature verified successfully');
    } catch (e) {
      console.error('❌ Webhook signature verification failed:', e.message);
      // For now, continue anyway to allow testing (remove this in production)
      console.warn('⚠️ Processing event without verification (INSECURE - testing only)');
      try {
        const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
        event = JSON.parse(bodyStr);
      } catch (parseError) {
        return res.status(400).send(`Webhook Error: ${e.message}`);
      }
    }

    if (event.type === 'checkout.session.completed') {
      const email = event.data.object.customer_details?.email?.toLowerCase() || 'unknown';
      const license = generateLicense();
      
      // Save to database
      await addLicense(license, email);

      console.log(`✅ Activated ${license} for ${email}`);

      // OPTIONAL email: only if RESEND_API_KEY is set
      if (resend && email !== 'unknown') {
        try {
          await resend.emails.send({
            from: 'onboarding@resend.dev', // TODO: Change to your domain after verifying in Resend
            to: email,
            replyTo: 'henrywisner8@gmail.com',
            subject: 'Your Scryfall Syntax Extension License Key',
            html: `
              <h2>Thank you for your purchase!</h2>
              
              <p>Your license key is:</p>
              <p style="background: #f5f5f5; padding: 15px; font-family: monospace; font-size: 16px; border-radius: 5px;">
                <strong>${license}</strong>
              </p>
              
              <h3>Installation Instructions:</h3>
              <ol>
                <li><strong>Download the extension:</strong><br>
                    <a href="YOUR_DOWNLOAD_LINK_HERE">Click here to download</a>
                    <!-- TODO: Replace YOUR_DOWNLOAD_LINK_HERE with actual download link -->
                </li>
                <li><strong>Install in Chrome:</strong>
                    <ul>
                      <li>Go to <code>chrome://extensions</code></li>
                      <li>Enable "Developer mode" (toggle in top right)</li>
                      <li>Click "Load unpacked"</li>
                      <li>Select the extension folder you downloaded</li>
                    </ul>
                </li>
                <li><strong>Activate your license:</strong>
                    <ul>
                      <li>Click the extension icon in your browser toolbar</li>
                      <li>Paste your license key: <code>${license}</code></li>
                      <li>Click "Activate"</li>
                    </ul>
                </li>
              </ol>
              
              <h3>Using the Extension:</h3>
              <p>Visit <a href="https://scryfall.com">scryfall.com</a> and start using natural language to search for Magic cards!</p>
              
              <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
              
              <p style="color: #666; font-size: 14px;">
                <strong>Need help?</strong> Reply to this email or contact support at 
                <a href="mailto:henrywisner8@gmail.com">henrywisner8@gmail.com</a>
              </p>
              
              <p style="color: #999; font-size: 12px;">
                Keep this email safe - you'll need your license key to use the extension.
              </p>
            `,
            text: `Thank you for your purchase!

Your license key: ${license}

Installation Instructions:

1. Download the extension: YOUR_DOWNLOAD_LINK_HERE
2. Install in Chrome:
   - Go to chrome://extensions
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extension folder
3. Activate your license:
   - Click the extension icon
   - Paste your license key
   - Click "Activate"

Need help? Contact henrywisner8@gmail.com

Keep this email safe - you'll need your license key to use the extension.`
          });
          console.log('📧 License email sent');
        } catch (e) {
          console.error('Email send failed:', e.message);
        }
      }
    }

    res.json({ received: true });
  }
);

// Now add express.json for all other routes
app.use(express.json());

// ---------- system prompt ----------
const SYSTEM_PROMPT = `You are a Scryfall search syntax converter. Convert natural language to valid Scryfall syntax.

OUTPUT RULES:
- Output ONLY the search syntax
- No explanations, quotes, or extra text
- Use exact operators as shown below

COLORS:
c:w (white) c:u (blue) c:b (black) c:r (red) c:g (green)
c:colorless (colorless cards)

CARD TYPES AND CREATURE TYPES (CRITICAL):
- Use t:<type> for card types: t:creature t:instant t:sorcery t:artifact t:enchantment t:planeswalker t:land
- Use t:<subtype> for creature types (races, classes, tribes): t:bear t:elf t:dragon t:dinosaur t:goblin t:zombie t:vampire t:angel t:demon t:wizard t:soldier t:human t:cat t:dog t:bird t:beast etc.
- ALWAYS use t:creature along with the subtype when searching for creature types
- Examples: "green bears" → t:creature t:bear c:g (NOT o:bear)
- Examples: "white soldiers" → t:creature t:soldier c:w (NOT o:soldier)
- NEVER use o:<text> when the user is asking for a creature type - always use t:<subtype>

KEYWORD ABILITIES (CRITICAL):
- ALWAYS use kw:<keyword> for keyword abilities like flying, vigilance, deathtouch, lifelink, trample, haste, menace, reach, first strike, double strike, hexproof, indestructible, flash, defender
- Examples: kw:flying kw:vigilance kw:deathtouch kw:lifelink kw:menace kw:trample kw:haste kw:reach kw:hexproof
- NEVER use o:flying or o:vigilance etc. - these keywords should ALWAYS use kw: syntax
- Use o:<text> ONLY for non-keyword text like o:"draw a card" o:destroy o:exile o:counter o:"target creature"

ORACLE TEXT:
o:"draw a card" (exact phrases in quotes)
o:destroy o:exile o:counter o:"target creature"
DO NOT use o: for keywords or creature types - use kw: and t: instead

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
s:<code> (lowercase 3–5 letters, e.g., s:cmm)

RARITY:
r:c r:u r:r r:m

PRICES:
usd>=5 usd<=10

BOOLEAN LOGIC:
Space = AND
OR with parens: (c:w OR c:u)
NOT: -t:creature

SET SELECTION:
- If "RESOLVED SET CODES" or "CANDIDATE SETS" appear below, follow them strictly.
- If only a set NAME is provided (no code), choose the best official set code for that name. Never confuse lookalikes (cmm≠cma, mm2≠mh2, 2xm≠mm2).

EXAMPLES:
"blue dinosaurs" → t:creature t:dinosaur c:u
"green bears" → t:creature t:bear c:g
"white soldiers with vigilance" → t:creature t:soldier c:w kw:vigilance
"green dinosaurs with toughness less than 6" → t:creature t:dinosaur c:g tou<6
"red dragons with flying" → t:creature t:dragon c:r kw:flying
"black zombies modern legal power 2-5" → t:creature t:zombie c:b f:modern pow>=2 pow<=5
"legendary elves from Dominaria" → t:legendary t:creature t:elf s:dom
"cheap red removal" → c:r (o:destroy OR o:exile) mv<=3
"white or blue angels" → t:creature t:angel (c:w OR c:u)
"creatures with lifelink" → t:creature kw:lifelink
"elves with reach" → t:creature t:elf kw:reach

REMEMBER: 
- Creature types (bear, elf, dragon, etc.) ALWAYS use t:<type> syntax
- Keyword abilities (flying, vigilance, etc.) ALWAYS use kw:<keyword> syntax
- Only use o: for non-keyword rules text

Output syntax only.`;

// ---------- routes ----------
app.post('/api/convert', requireLicense, rateLimitPerLicense, async (req, res) => {
  const { query, provider } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  const explicitMatch =
    query.match(/\(\s*([A-Za-z0-9]{2,5})\s*\)/) ||
    query.match(/\b(?:set|code)\s*[:=]?\s*([A-Za-z0-9]{2,5})\b/i);
  const explicitCode = explicitMatch?.[1];

  let dynamicSystem = SYSTEM_PROMPT;

  if (explicitCode) {
    dynamicSystem += `

RESOLVED SET CODES (STRICT)
- explicit: s:${explicitCode.toLowerCase()}
Rules:
- Always use s:${explicitCode.toLowerCase()} when selecting a set code.
`;
  } else {
    const candidates = await getSetCandidatesFromQuery(query, 6);
    if (candidates.length === 1) {
      dynamicSystem += `

RESOLVED SET CODES (STRICT)
- "${candidates[0].name}" -> s:${candidates[0].code}
Rules:
- Always use s:${candidates[0].code} for this request.
`;
    } else if (candidates.length > 1) {
      dynamicSystem += `

CANDIDATE SETS (CHOOSE ONLY FROM THESE IF A SET IS IMPLIED)
${candidates.map((c) => `- s:${c.code} — ${c.name}`).join('\n')}

Rules:
- If a set is requested by name, choose the best match from the list above.
- Do NOT invent other set codes. If none fit, omit the set filter.
- Never confuse visually similar codes (e.g., cmm ≠ cma, mm2 ≠ mh2, 2xm ≠ mm2).
`;
    }
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
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 200,
          system: dynamicSystem,
          messages: [{ role: 'user', content: query }],
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        let errorText = '';
        try { errorText = await response.text(); } catch {}
        console.error('Anthropic API error:', errorText);
        throw new Error('AI service temporarily unavailable');
      }

      const data = await response.json();
      result = (data.content?.[0]?.text || '').trim();
    } else {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: dynamicSystem },
            { role: 'user', content: query },
          ],
          temperature: 0.1,
          max_tokens: 200,
        }),
      });

      if (!response.ok) {
        let errorText = '';
        try { errorText = await response.text(); } catch {}
        console.error('OpenAI API error:', errorText);
        throw new Error('AI service temporarily unavailable');
      }

      const data = await response.json();
      result = (data.choices?.[0]?.message?.content || '').trim();
    }

    console.log(`[${req.body.licenseKey.substring(0, 8)}...] "${query}" → "${result}"`);
    return res.json({ syntax: result });
  } catch (error) {
    console.error('Conversion error:', error);
    return res.status(500).json({ error: error.message || 'Conversion failed' });
  }
});

// license validation
app.post('/api/validate-license', async (req, res) => {
  const { licenseKey } = req.body || {};
  if (!licenseKey) {
    setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
    return res.status(400).json({ valid: false, error: 'License key required' });
  }
  
  const valid = await isLicenseValid(licenseKey);
  return res.json({ valid });
});

// success-page helper: get license via Stripe session_id
app.get('/api/license/by-session', async (req, res) => {
  try {
    const sid = req.query.session_id;
    if (!sid) return res.status(400).json({ error: 'session_id required' });
    const session = await stripe.checkout.sessions.retrieve(sid);
    const email = session.customer_details?.email?.toLowerCase();
    if (!email) return res.status(404).json({ error: 'email not found' });
    const license = await getLicenseByEmail(email);
    return license ? res.json({ license }) : res.status(404).json({ error: 'license not found' });
  } catch (e) {
    return res.status(500).json({ error: 'lookup failed' });
  }
});

// health & root
app.get('/health', async (_req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT COUNT(*) FROM licenses WHERE is_active = true');
    client.release();
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(), 
      licenses: parseInt(result.rows[0].count),
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});
app.get('/', (_req, res) =>
  res.json({ name: 'Scryfall NLP API', version: '2.0.0', status: 'operational' })
);

// start
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log('✨ Scryfall NLP API v2.0');
  console.log(`📡 Port: ${PORT}`);
  console.log(
    `🤖 Provider: ${process.env.OPENAI_API_KEY ? 'OpenAI' : process.env.ANTHROPIC_API_KEY ? 'Anthropic' : 'NONE'}`
  );
});

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down...`);
    await pool.end(); // Close database connections
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });
});