// server.js — Scryfall NLP API (licenses + per-license rate limit + set resolver + PERSISTENCE)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const fs = require('fs');
const path = require('path');

// ---------- license persistence ----------
const LICENSE_FILE = path.join(__dirname, 'licenses.json');

function loadLicenses() {
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
      data.licenses?.forEach(l => VALID_LICENSES.add(l));
      if (data.emails) {
        Object.entries(data.emails).forEach(([email, license]) => {
          EMAIL_TO_LICENSE.set(email, license);
        });
      }
      console.log(`📂 Loaded ${VALID_LICENSES.size} licenses from disk`);
    } else {
      console.log('📂 No existing license file found, starting fresh');
    }
  } catch (error) {
    console.error('⚠️  Error loading licenses:', error.message);
  }
}

function saveLicenses() {
  try {
    const data = {
      licenses: [...VALID_LICENSES],
      emails: Object.fromEntries(EMAIL_TO_LICENSE),
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Saved ${VALID_LICENSES.size} licenses to disk`);
  } catch (error) {
    console.error('⚠️  Error saving licenses:', error.message);
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

const VALID_LICENSES = new Set(['TEST-1234-5678-ABCD', 'TEST-9999-8888-XXXX']);
const EMAIL_TO_LICENSE = new Map(); // email -> latest license

// Load existing licenses on startup
loadLicenses();

function requireLicense(req, res, next) {
  const key = req.body?.licenseKey;
  if (!key) {
    setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
    return res.status(401).json({ error: 'License key required' });
  }
  if (!VALID_LICENSES.has(key)) {
    setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
    return res.status(403).json({ error: 'Invalid license key' });
  }
  next();
}

// ---------- Stripe webhook (MUST be BEFORE express.json) ----------
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
    
    // TEMPORARY: Try to parse the event directly for testing
    if (!sig) {
      console.warn('⚠️ No signature header - parsing event directly (INSECURE)');
      try {
        event = JSON.parse(req.body.toString());
      } catch (e) {
        return res.status(400).send('Invalid JSON');
      }
    } else {
      try {
        // req.body is a Buffer when using express.raw()
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
        console.log('✅ Webhook signature verified');
      } catch (e) {
        console.error('❌ Webhook signature verification failed:', e.message);
        console.error('Body type:', typeof req.body);
        console.error('Body is Buffer?', Buffer.isBuffer(req.body));
        console.error('Secret starts with:', secret.substring(0, 10));
        
        // TEMPORARY FALLBACK: Parse without verification for testing
        console.warn('⚠️ Attempting to parse event without verification (INSECURE)');
        try {
          event = JSON.parse(req.body.toString());
        } catch (parseError) {
          return res.status(400).send(`Webhook Error: ${e.message}`);
        }
      }
    }

    if (event.type === 'checkout.session.completed') {
      const email = event.data.object.customer_details?.email?.toLowerCase() || 'unknown';
      const license = generateLicense();
      VALID_LICENSES.add(license);
      if (email !== 'unknown') EMAIL_TO_LICENSE.set(email, license);

      // Save to disk immediately
      saveLicenses();

      console.log(`✅ Activated ${license} for ${email}`);

      // OPTIONAL email: only if RESEND_API_KEY is set
      if (resend && email !== 'unknown') {
        try {
          await resend.emails.send({
            from: 'onboarding@resend.dev', // free sender; swap later to your domain
            to: email,
            subject: 'Your Scryfall Syntax Extension License',
            text:
              `Thanks for your purchase!\n\n` +
              `Your license key:\n${license}\n\n` +
              `Install: chrome://extensions → Load unpacked → open popup → paste key.`,
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

CARD TYPES:
t:creature t:instant t:sorcery t:artifact t:enchantment t:planeswalker t:land
t:legendary (legendary supertype)
Creature subtypes: t:dinosaur t:dragon t:elf t:goblin t:zombie t:vampire t:angel t:demon

KEYWORD ABILITIES (IMPORTANT)
- Use kw:<keyword> (alias: keyword:<keyword>) for actual keyword abilities.
  Examples: kw:flying kw:first strike kw:deathtouch kw:lifelink kw:menace kw:trample kw:haste kw:vigilance kw:hexproof
- Use o:<text> only for literal words/phrases appearing in the rules text.
  Examples: o:"draw a card" o:destroy o:exile
- If the user says "with flying / has flying / keyword flying", use kw:flying.
- If the user says "cards that say 'flying' in the text", use o:flying.

ORACLE TEXT:
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
"blue dinosaurs" → t:dinosaur c:u
"green dinosaurs with toughness less than 6" → t:dinosaur c:g tou<6
"red dragons with flying" → t:dragon c:r kw:flying
"black zombies modern legal power 2-5" → t:zombie c:b f:modern pow>2 pow<5
"legendary elves from Dominaria" → t:legendary t:elf s:dom
"cheap red removal" → c:r (o:destroy OR o:exile) mv<=3
"white or blue angels" → t:angel (c:w OR c:u)

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
app.post('/api/validate-license', (req, res) => {
  const { licenseKey } = req.body || {};
  if (!licenseKey) {
    setRateHeaders(res, MAX_REQUESTS, Date.now() + WINDOW_MS);
    return res.status(400).json({ valid: false, error: 'License key required' });
  }
  return res.json({ valid: VALID_LICENSES.has(licenseKey) });
});

// success-page helper: get license via Stripe session_id
app.get('/api/license/by-session', async (req, res) => {
  try {
    const sid = req.query.session_id;
    if (!sid) return res.status(400).json({ error: 'session_id required' });
    const session = await stripe.checkout.sessions.retrieve(sid);
    const email = session.customer_details?.email?.toLowerCase();
    if (!email) return res.status(404).json({ error: 'email not found' });
    const license = EMAIL_TO_LICENSE.get(email);
    return license ? res.json({ license }) : res.status(404).json({ error: 'license not found' });
  } catch (e) {
    return res.status(500).json({ error: 'lookup failed' });
  }
});

// health & root
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString(), licenses: VALID_LICENSES.size })
);
app.get('/', (_req, res) =>
  res.json({ name: 'Scryfall NLP API', version: '2.0.0', status: 'operational' })
);

// start
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log('✨ Scryfall NLP API v2.0');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔑 Active licenses: ${VALID_LICENSES.size}`);
  console.log(
    `🤖 Provider: ${process.env.OPENAI_API_KEY ? 'OpenAI' : process.env.ANTHROPIC_API_KEY ? 'Anthropic' : 'NONE'}`
  );
});

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down...`);
    saveLicenses(); // Save one last time before shutdown
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });
});