/**
 * VeloQ – Vercel API Gateway
 * Replaces api.php for Vercel deployment.
 *
 * Env vars needed (set in Vercel dashboard → Settings → Environment Variables):
 *   SNAPSHOT_API_URL  = http://161.248.189.156:8787
 *   DEVX_API_KEY      = devx-1c4m31f7r1ww1pcqg48rp4bfg7h8mgdi
 *   DB_HOST, DB_NAME, DB_USER, DB_PASS
 *   JWT_SECRET        = any random string (32+ chars)
 */

import formidable from 'formidable';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

export const config = { api: { bodyParser: false } };

// ─── Config ──────────────────────────────────────────────────────────────────
const SNAPSHOT_API  = (process.env.SNAPSHOT_API_URL  || 'http://161.248.189.156:8787').replace(/\/$/, '');
const DEVX_API_KEY  = process.env.DEVX_API_KEY  || '';
const DEVX_CHAT_URL = 'https://dev-x-vision.vercel.app/api/chat';
const JWT_SECRET    = process.env.JWT_SECRET    || 'veloq-change-me-in-prod';
const COOKIE_NAME   = 'veloq_token';

// ─── Database ─────────────────────────────────────────────────────────────────
let _db = null;
async function getDB() {
  if (_db) {
    try { await _db.ping(); return _db; } catch { _db = null; }
  }
  _db = await mysql.createConnection({
    host:     process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'gammaxal_veloq',
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10000,
  });
  return _db;
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────
function setCookie(res, name, value, maxAge = 7 * 24 * 3600) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// ─── Session helpers ──────────────────────────────────────────────────────────
function getSession(req) {
  const token = getCookie(req, COOKIE_NAME);
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

async function getCurrentUser(req) {
  const session = getSession(req);
  if (!session?.userId) return null;
  try {
    const db = await getDB();
    const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [session.userId]);
    return rows[0] || null;
  } catch { return null; }
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, password, ...safe } = user;
  return safe;
}

// ─── Form parser ──────────────────────────────────────────────────────────────
async function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: 12 * 1024 * 1024, multiples: false });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function fv(fields, key) {          // get first value from formidable field
  const v = fields[key];
  return Array.isArray(v) ? v[0] : (v ?? null);
}

// ─── JSON response helper ─────────────────────────────────────────────────────
function jsonResp(res, success, message, code, data = {}) {
  const body = { success, message, ...data };
  if (code) body.code = code;
  res.status(200).json(body);       // always 200 so frontend can read the JSON
}

// ─── Vision / AI analysis ─────────────────────────────────────────────────────
const ANALYSIS_PROMPT = `You are an expert binary options & forex trading signal analyst.
Analyze this chart image carefully and respond ONLY with a single valid JSON object — no markdown, no extra text:

{
  "signal":        "CALL" or "PUT",
  "confidence":    number 0-100,
  "current_trend": "BULLISH" | "BEARISH" | "SIDEWAYS",
  "candle_pattern":"string",
  "chart_pattern": "string",
  "market_phase":  "TRENDING" | "RANGING",
  "setup_quality": "HIGH" | "MEDIUM" | "LOW",
  "risk_level":    "HIGH" | "MEDIUM" | "LOW",
  "expiry_hint":   "1 minute" (or appropriate timeframe),
  "action_note":   "one sentence tip",
  "logic":         "2-3 sentence reasoning"
}`;

async function callVisionAPI(imageBuffer, mimeType, extraContext = '') {
  if (!DEVX_API_KEY) throw new Error('DEVX_API_KEY env var not set');

  const blob = new Blob([imageBuffer], { type: mimeType || 'image/jpeg' });
  const fd   = new FormData();
  fd.append('message',       ANALYSIS_PROMPT + (extraContext ? `\n\nContext: ${extraContext}` : ''));
  fd.append('history',       JSON.stringify([]));
  fd.append('image',         blob, 'chart.jpg');
  fd.append('authorization', `Bearer ${DEVX_API_KEY}`);

  const resp = await fetch(DEVX_CHAT_URL, { method: 'POST', body: fd });
  if (!resp.ok) throw new Error(`Vision API error ${resp.status}`);
  const json = await resp.json();
  return json.reply || '';
}

function parseAIResponse(reply) {
  try {
    const clean = reply.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(clean.slice(s, e + 1));
  } catch {}
  // Fallback: extract signal from free text
  const up = (reply || '').toUpperCase();
  return {
    signal:        up.includes('CALL') ? 'CALL' : up.includes('PUT') ? 'PUT' : 'HOLD',
    confidence:    55,
    current_trend: up.includes('BULL') ? 'BULLISH' : up.includes('BEAR') ? 'BEARISH' : 'SIDEWAYS',
    setup_quality: 'MEDIUM',
    risk_level:    'MEDIUM',
    logic:         reply,
  };
}

// ─── Action Handlers ──────────────────────────────────────────────────────────

async function handleLogin(req, res, fields) {
  const email    = fv(fields, 'email')    || '';
  const password = fv(fields, 'password') || '';
  if (!email || !password) return jsonResp(res, false, 'Email and password required');

  try {
    const db = await getDB();
    const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    const user = rows[0];
    if (!user) return jsonResp(res, false, 'Invalid credentials', 'AUTH');

    // Support both bcrypt and plain MD5 (legacy). Adjust as needed.
    let valid = false;
    const stored = user.password_hash || user.password || '';
    if (stored.startsWith('$2')) {
      const bcrypt = await import('bcryptjs');
      valid = await bcrypt.default.compare(password, stored);
    } else {
      // MD5 fallback
      const { createHash } = await import('crypto');
      valid = createHash('md5').update(password).digest('hex') === stored;
    }
    if (!valid) return jsonResp(res, false, 'Invalid credentials', 'AUTH');

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    setCookie(res, COOKIE_NAME, token);
    jsonResp(res, true, 'Logged in', null, { user: sanitizeUser(user) });
  } catch (e) {
    jsonResp(res, false, 'Login error: ' + e.message);
  }
}

async function handleRegister(req, res, fields) {
  const email    = (fv(fields, 'email')    || '').toLowerCase();
  const password = fv(fields, 'password')  || '';
  const name     = fv(fields, 'name')      || fv(fields, 'username') || '';
  if (!email || !password) return jsonResp(res, false, 'Email and password required');

  try {
    const db = await getDB();
    const [ex] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (ex.length) return jsonResp(res, false, 'Email already registered');

    const bcrypt   = await import('bcryptjs');
    const hash     = await bcrypt.default.hash(password, 10);
    const username = name || email.split('@')[0] + Math.floor(Math.random() * 9000 + 1000);

    const [result] = await db.execute(
      `INSERT INTO users (email, password_hash, username, plan, request_count, is_unlimited, verified, created_at)
       VALUES (?, ?, ?, 'Free', 3, 0, 0, NOW())`,
      [email, hash, username]
    );

    const token = jwt.sign({ userId: result.insertId, email }, JWT_SECRET, { expiresIn: '7d' });
    setCookie(res, COOKIE_NAME, token);
    jsonResp(res, true, 'Account created', null, {
      user: { id: result.insertId, email, username, plan: 'Free', request_count: 3, is_unlimited: 0, verified: 0 }
    });
  } catch (e) {
    jsonResp(res, false, 'Registration error: ' + e.message);
  }
}

async function handleLogout(req, res) {
  setCookie(res, COOKIE_NAME, '', 0);
  jsonResp(res, true, 'Logged out');
}

async function handleMe(req, res) {
  const user = await getCurrentUser(req);
  if (!user) return jsonResp(res, false, 'Not logged in', 'AUTH');
  jsonResp(res, true, 'OK', null, { user: sanitizeUser(user) });
}

// GET /assets  → proxy the external assets list
async function handleQuotexAssets(req, res) {
  try {
    const resp = await fetch(`${SNAPSHOT_API}/assets`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`Assets API ${resp.status}`);
    const data = await resp.json();
    jsonResp(res, true, 'Assets loaded', null, { assets: data });
  } catch (e) {
    jsonResp(res, false, 'Failed to load assets: ' + e.message);
  }
}

// Quotex mode: fetch live snapshot → analyse with AI
async function handleQuotexAnalyze(req, res, fields, user) {
  const asset         = fv(fields, 'asset')          || '';
  const candles       = fv(fields, 'candles')        || '60';
  const strategy      = fv(fields, 'strategy')       || 'GammaAI Analysis';
  const hideIndicator = fv(fields, 'hide_indicator') === '1';

  if (!asset) return jsonResp(res, false, 'Asset required');
  if (!user.is_unlimited && Number(user.request_count || 0) <= 0)
    return jsonResp(res, false, 'No analysis requests remaining. Upgrade your plan.', 'NOREQUESTS');

  // 1. Fetch snapshot chart
  const snapshotUrl = `${SNAPSHOT_API}/snapshot?asset=${encodeURIComponent(asset)}&timeframe=1&candles=${candles}&direction=auto&overlay=${hideIndicator ? 'clean' : 'default'}`;
  let imageBuffer, mimeType = 'image/jpeg';
  try {
    const imgResp = await fetch(snapshotUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgResp.ok) throw new Error(`Snapshot API ${imgResp.status}`);
    mimeType    = imgResp.headers.get('content-type') || 'image/jpeg';
    imageBuffer = Buffer.from(await imgResp.arrayBuffer());
  } catch (e) {
    return jsonResp(res, false, 'Chart fetch failed: ' + e.message);
  }

  // 2. AI vision analysis
  let parsed;
  try {
    const reply = await callVisionAPI(imageBuffer, mimeType, `Asset: ${asset} | Strategy: ${strategy}`);
    parsed = parseAIResponse(reply);
  } catch (e) {
    return jsonResp(res, false, 'AI analysis failed: ' + e.message);
  }

  // 3. Decrement request count
  let newUserState = null;
  if (!user.is_unlimited) {
    try {
      const db = await getDB();
      await db.execute(
        'UPDATE users SET request_count = GREATEST(request_count - 1, 0) WHERE id = ?',
        [user.id]
      );
      newUserState = { request_count: Math.max(Number(user.request_count || 0) - 1, 0) };
    } catch {}
  }

  // 4. Save signal to DB
  try {
    const db   = await getDB();
    const entryTime = new Date(Date.now() + 60000).toISOString().slice(0, 19).replace('T', ' ');
    await db.execute(
      'INSERT INTO signals (user_id, pair, signal, strategy, entry_time, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [user.id, asset, parsed.signal || '', strategy, entryTime]
    );
  } catch {}

  // 5. Entry time = next minute
  const entryISO = new Date(Date.now() + 60000).toISOString();

  jsonResp(res, true, 'Analysis complete', null, {
    normalized: {
      PAIR:            asset,
      SIGNAL:          parsed.signal          || 'HOLD',
      CURRENT_TREND:   parsed.current_trend   || '',
      CANDLE_PATTERN:  parsed.candle_pattern  || '',
      CHART_PATTERN:   parsed.chart_pattern   || '',
      MARKET_PHASE:    parsed.market_phase    || '',
      SETUP_QUALITY:   parsed.setup_quality   || '',
      RISK_LEVEL:      parsed.risk_level      || '',
      EXPIRY_HINT:     parsed.expiry_hint     || '1 minute',
      ACTION_NOTE:     parsed.action_note     || '',
      LOGIC:           parsed.logic           || '',
    },
    logic:      parsed.logic || '',
    chart_url:  snapshotUrl,
    signal:     parsed.signal || 'HOLD',
    confidence: parsed.confidence || 0,
    entry:      { entry_time: entryISO },
    newUserState,
  });
}

// Image-upload mode: user uploads chart → analyse with AI
async function handleAnalyze(req, res, fields, files, user) {
  if (!user.is_unlimited && Number(user.request_count || 0) <= 0)
    return jsonResp(res, false, 'No analysis requests remaining. Upgrade your plan.', 'NOREQUESTS');

  const chartFile = files?.chart?.[0] || files?.chartImage?.[0]
                 || (Array.isArray(files?.chart)      ? files.chart[0]      : files?.chart)
                 || (Array.isArray(files?.chartImage) ? files.chartImage[0] : files?.chartImage);

  if (!chartFile) return jsonResp(res, false, 'Chart image required');

  const strategy = fv(fields, 'strategy') || 'GammaAI Analysis';
  const mode     = fv(fields, 'mode')     || 'Binary';

  let imageBuffer;
  try   { imageBuffer = readFileSync(chartFile.filepath); }
  catch { return jsonResp(res, false, 'Failed to read uploaded image'); }

  let parsed;
  try {
    const reply = await callVisionAPI(imageBuffer, chartFile.mimetype || 'image/jpeg',
                                      `Strategy: ${strategy} | Mode: ${mode}`);
    parsed = parseAIResponse(reply);
  } catch (e) {
    return jsonResp(res, false, 'AI analysis failed: ' + e.message);
  }

  let newUserState = null;
  if (!user.is_unlimited) {
    try {
      const db = await getDB();
      await db.execute(
        'UPDATE users SET request_count = GREATEST(request_count - 1, 0) WHERE id = ?',
        [user.id]
      );
      newUserState = { request_count: Math.max(Number(user.request_count || 0) - 1, 0) };
    } catch {}
  }

  const entryISO = new Date(Date.now() + 60000).toISOString();

  jsonResp(res, true, 'Analysis complete', null, {
    normalized: {
      PAIR:           '',
      SIGNAL:         parsed.signal         || 'HOLD',
      CURRENT_TREND:  parsed.current_trend  || '',
      CANDLE_PATTERN: parsed.candle_pattern || '',
      CHART_PATTERN:  parsed.chart_pattern  || '',
      MARKET_PHASE:   parsed.market_phase   || '',
      SETUP_QUALITY:  parsed.setup_quality  || '',
      RISK_LEVEL:     parsed.risk_level     || '',
      EXPIRY_HINT:    parsed.expiry_hint    || '1 minute',
      ACTION_NOTE:    parsed.action_note    || '',
      LOGIC:          parsed.logic          || '',
    },
    logic:      parsed.logic || '',
    signal:     parsed.signal || 'HOLD',
    confidence: parsed.confidence || 0,
    entry:      { entry_time: entryISO },
    newUserState,
  });
}

async function handleMySignals(req, res, user) {
  try {
    const db = await getDB();
    const [signals] = await db.execute(
      'SELECT * FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      [user.id]
    );
    jsonResp(res, true, 'Signals loaded', null, { signals });
  } catch (e) {
    jsonResp(res, false, 'DB error: ' + e.message);
  }
}

async function handleSaveSettings(req, res, fields, user) {
  const strategy              = fv(fields, 'strategy')              ?? user.strategy;
  const learn_language        = fv(fields, 'learn_language')        ?? user.learn_language;
  const signal_pref           = fv(fields, 'signal_pref')           ?? fv(fields, 'signalPref') ?? user.signal_pref;
  const hide_chart_indicator  = fv(fields, 'hide_chart_indicator')  ?? user.hide_chart_indicator;
  const result_view_enabled   = fv(fields, 'result_view_enabled')   ?? user.result_view_enabled;
  const asset_view_mode       = fv(fields, 'asset_view_mode')       ?? user.asset_view_mode;

  try {
    const db = await getDB();
    await db.execute(
      `UPDATE users
         SET strategy = ?, learn_language = ?, signal_pref = ?,
             hide_chart_indicator = ?, result_view_enabled = ?, asset_view_mode = ?
       WHERE id = ?`,
      [strategy, learn_language, signal_pref, hide_chart_indicator, result_view_enabled, asset_view_mode, user.id]
    );
    jsonResp(res, true, 'Settings saved');
  } catch (e) {
    jsonResp(res, false, 'DB error: ' + e.message);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin',  req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse form (multipart or urlencoded)
  let fields = {}, files = {};
  if (req.method === 'POST') {
    try { ({ fields, files } = await parseForm(req)); }
    catch { return res.status(400).json({ success: false, message: 'Bad request body' }); }
  }

  // Action comes from POST body OR query string
  const action = fv(fields, 'action') || req.query.action || '';

  // ── Public actions (no auth required) ──────────────────────────────────────
  if (action === 'login')    return handleLogin(req, res, fields);
  if (action === 'register') return handleRegister(req, res, fields);
  if (action === 'logout')   return handleLogout(req, res);
  if (action === 'me')       return handleMe(req, res);

  // ── Protected actions ───────────────────────────────────────────────────────
  const user = await getCurrentUser(req);
  if (!user) return jsonResp(res, false, 'Not logged in', 'AUTH');

  if (action === 'quotex_assets')  return handleQuotexAssets(req, res);
  if (action === 'quotex_analyze') return handleQuotexAnalyze(req, res, fields, user);
  if (action === 'analyze')        return handleAnalyze(req, res, fields, files, user);
  if (action === 'my_signals')     return handleMySignals(req, res, user);
  if (action === 'save_settings')  return handleSaveSettings(req, res, fields, user);

  res.status(404).json({ success: false, message: `Unknown action: "${action}"` });
}
