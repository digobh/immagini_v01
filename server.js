'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'immagini-dev-secret-change-in-production';
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'immagini.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    email         TEXT    UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    filename     TEXT    NOT NULL,
    imported_at  TEXT    DEFAULT (datetime('now')),
    row_count    INTEGER DEFAULT 0,
    skipped_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    import_id   INTEGER REFERENCES imports(id) ON DELETE CASCADE,
    date_str    TEXT    NOT NULL,
    merchant    TEXT    NOT NULL,
    amount      REAL    NOT NULL,
    category_id TEXT    DEFAULT 'cat-uncategorized',
    sub_name    TEXT,
    notes       TEXT,
    is_tax      INTEGER DEFAULT 0,
    dedup_hash  TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now')),
    UNIQUE(user_id, dedup_hash)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    theme   TEXT DEFAULT 'default',
    balance REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    category_id TEXT    NOT NULL,
    label       TEXT,
    color       TEXT,
    icon_svg    TEXT,
    UNIQUE(user_id, category_id)
  );

  CREATE TABLE IF NOT EXISTS subcategories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    category_id   TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    keywords_json TEXT    DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS cat_keywords (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    category_id TEXT    NOT NULL,
    keyword     TEXT    NOT NULL
  );
`);

// Migrate: add balance column to imports if not present
try { db.exec('ALTER TABLE imports ADD COLUMN balance REAL'); } catch (_) {}

db.exec(`

  CREATE TABLE IF NOT EXISTS goals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    name           TEXT    NOT NULL,
    icon           TEXT    DEFAULT '🎯',
    target_amount  REAL    DEFAULT 0,
    color          TEXT    DEFAULT '#6c5ce7',
    sort_order     INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS goal_allocations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    goal_id        INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    amount         REAL    NOT NULL
  );
`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const user = db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?,?,?) RETURNING id, username'
    ).get(username.trim(), email?.trim() || null, hash);
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(user.id);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username } });
});

// ── Import ────────────────────────────────────────────────────────────────────
// Client sends pre-parsed transactions — server deduplicates and stores them.
function dedupHash(userId, dateStr, merchant, amount) {
  const s = `${userId}|${dateStr}|${merchant.toLowerCase().trim()}|${Number(amount).toFixed(2)}`;
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Normalise DD/MM/YYYY or DD-MM-YYYY → ISO YYYY-MM-DD
function normaliseDate(s) {
  const m = (s || '').match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return s;
  const day   = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year  = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${year}-${month}-${day}`;
}

app.post('/api/import', requireAuth, (req, res) => {
  const { filename, transactions, balance } = req.body || {};
  if (!Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'No transactions provided' });

  const stmtImport = db.prepare(
    'INSERT INTO imports (user_id, filename, row_count, skipped_count) VALUES (?,?,?,?)'
  );
  const stmtTxn = db.prepare(`
    INSERT OR IGNORE INTO transactions (user_id, import_id, date_str, merchant, amount, dedup_hash)
    VALUES (?,?,?,?,?,?)
  `);
  const stmtUpdateImport = db.prepare(
    'UPDATE imports SET row_count=?, skipped_count=?, balance=? WHERE id=?'
  );

  let added = 0, skipped = 0;
  const addedTxns = [];
  const hasNewBalance = balance != null && !isNaN(Number(balance));

  const result = db.transaction(() => {
    const imp = stmtImport.run(req.user.id, filename || 'import.csv', 0, 0);
    const importId = imp.lastInsertRowid;

    for (const t of transactions) {
      const dateIso = normaliseDate(t.date_str || t.date || '');
      const merchant = (t.merchant || t.desc || '').trim();
      const amount = Number(t.amount) || 0;
      if (!merchant || amount === 0) continue;

      const hash = dedupHash(req.user.id, dateIso, merchant, amount);
      const r = stmtTxn.run(req.user.id, importId, dateIso, merchant, amount, hash);
      if (r.changes > 0) {
        added++;
        addedTxns.push({ id: Number(r.lastInsertRowid), date_str: dateIso, merchant, amount,
          category_id: 'cat-uncategorized', sub_name: null });
      } else {
        skipped++;
      }
    }

    stmtUpdateImport.run(added, skipped, hasNewBalance ? Number(balance) : null, importId);
    return importId;
  })();

  // Save balance to user_settings only if CSV included one
  if (hasNewBalance) {
    db.prepare(`INSERT INTO user_settings (user_id, balance) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`)
      .run(req.user.id, Number(balance));
  }

  const resp = { import_id: Number(result), added, skipped, transactions: addedTxns };
  if (hasNewBalance) resp.balance = Number(balance);
  res.json(resp);
});

app.get('/api/imports', requireAuth, (req, res) => {
  const imports = db.prepare(`
    SELECT i.id, i.filename, i.imported_at, i.row_count, i.skipped_count, i.balance,
           MIN(t.date_str) as date_from, MAX(t.date_str) as date_to
    FROM imports i
    LEFT JOIN transactions t ON t.import_id = i.id AND t.user_id = i.user_id
    WHERE i.user_id = ?
    GROUP BY i.id
    ORDER BY i.imported_at DESC
  `).all(req.user.id);
  res.json(imports);
});

app.delete('/api/imports/:id', requireAuth, (req, res) => {
  const imp = db.prepare('SELECT id FROM imports WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  // Cascade deletes transactions via ON DELETE CASCADE
  db.prepare('DELETE FROM imports WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Transactions ──────────────────────────────────────────────────────────────
app.get('/api/transactions', requireAuth, (req, res) => {
  const { month } = req.query;   // "2026-06"
  const rows = month
    ? db.prepare(`SELECT id,date_str,merchant,amount,category_id,sub_name,notes,is_tax
                  FROM transactions WHERE user_id=? AND date_str LIKE ?
                  ORDER BY date_str DESC`).all(req.user.id, `${month}%`)
    : db.prepare(`SELECT id,date_str,merchant,amount,category_id,sub_name,notes,is_tax
                  FROM transactions WHERE user_id=? ORDER BY date_str DESC`).all(req.user.id);
  res.json(rows);
});

app.put('/api/transactions/:id', requireAuth, (req, res) => {
  const { category_id, sub_name, notes, is_tax } = req.body || {};
  const t = db.prepare('SELECT id FROM transactions WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Transaction not found' });
  db.prepare(`UPDATE transactions SET
    category_id = COALESCE(?,category_id),
    sub_name    = ?,
    notes       = ?,
    is_tax      = COALESCE(?,is_tax)
    WHERE id=? AND user_id=?`)
    .run(category_id ?? null, sub_name ?? null, notes ?? null, is_tax ?? null,
         req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  const settings     = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(req.user.id)
                       || { theme: 'default', balance: 0 };
  const categories   = db.prepare('SELECT * FROM user_categories WHERE user_id=?').all(req.user.id);
  const subcategories= db.prepare('SELECT * FROM subcategories WHERE user_id=?').all(req.user.id);
  const catKeywords  = db.prepare('SELECT * FROM cat_keywords WHERE user_id=?').all(req.user.id);
  const goals        = db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY sort_order').all(req.user.id);
  const allocations  = db.prepare('SELECT * FROM goal_allocations WHERE user_id=?').all(req.user.id);
  res.json({ settings, categories, subcategories, catKeywords, goals, allocations });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { theme, balance } = req.body || {};
  db.prepare(`INSERT INTO user_settings (user_id,theme,balance) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      theme   = COALESCE(excluded.theme, theme),
      balance = COALESCE(excluded.balance, balance)`)
    .run(req.user.id, theme || null, balance ?? null);
  res.json({ ok: true });
});

// Categories
app.post('/api/categories', requireAuth, (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const stmt = db.prepare(`INSERT INTO user_categories (user_id,category_id,label,color,icon_svg)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,category_id) DO UPDATE SET
      label    = COALESCE(excluded.label, label),
      color    = COALESCE(excluded.color, color),
      icon_svg = COALESCE(excluded.icon_svg, icon_svg)`);
  db.transaction(() => {
    for (const c of items) stmt.run(req.user.id, c.category_id, c.label||null, c.color||null, c.icon_svg||null);
  })();
  res.json({ ok: true });
});

// Subcategories
app.post('/api/subcategories', requireAuth, (req, res) => {
  const { category_id, name, keywords } = req.body || {};
  const r = db.prepare(
    'INSERT INTO subcategories (user_id,category_id,name,keywords_json) VALUES (?,?,?,?)'
  ).run(req.user.id, category_id, name, JSON.stringify(keywords || []));
  res.json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/subcategories/:id', requireAuth, (req, res) => {
  const { name, keywords } = req.body || {};
  db.prepare(`UPDATE subcategories SET
    name          = COALESCE(?,name),
    keywords_json = COALESCE(?,keywords_json)
    WHERE id=? AND user_id=?`)
    .run(name||null, keywords ? JSON.stringify(keywords) : null, req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/subcategories/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM subcategories WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Category-level keywords
app.post('/api/cat-keywords', requireAuth, (req, res) => {
  const { category_id, keyword } = req.body || {};
  const r = db.prepare(
    'INSERT INTO cat_keywords (user_id,category_id,keyword) VALUES (?,?,?)'
  ).run(req.user.id, category_id, keyword);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/cat-keywords/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM cat_keywords WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Goals
app.post('/api/goals', requireAuth, (req, res) => {
  const { name, icon, target_amount, color, sort_order } = req.body || {};
  const r = db.prepare(
    'INSERT INTO goals (user_id,name,icon,target_amount,color,sort_order) VALUES (?,?,?,?,?,?)'
  ).run(req.user.id, name, icon||'🎯', target_amount||0, color||'#6c5ce7', sort_order||0);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/goals/:id', requireAuth, (req, res) => {
  const { name, icon, target_amount, color, sort_order } = req.body || {};
  db.prepare(`UPDATE goals SET
    name          = COALESCE(?,name),
    icon          = COALESCE(?,icon),
    target_amount = COALESCE(?,target_amount),
    color         = COALESCE(?,color),
    sort_order    = COALESCE(?,sort_order)
    WHERE id=? AND user_id=?`)
    .run(name||null, icon||null, target_amount??null, color||null, sort_order??null,
         req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/goals/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM goals WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/goal-allocations', requireAuth, (req, res) => {
  const { transaction_id, goal_id, amount } = req.body || {};
  const r = db.prepare(
    'INSERT INTO goal_allocations (user_id,transaction_id,goal_id,amount) VALUES (?,?,?,?)'
  ).run(req.user.id, transaction_id, goal_id, amount);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/goal-allocations/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM goal_allocations WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Page routes ───────────────────────────────────────────────────────────────
// Serve static files from /public (landing page, login page)
app.use(express.static(path.join(__dirname, 'public')));

// Main app: inject the API bridge into the mockup HTML
app.get('/app', (req, res) => {
  try {
    const mockup = fs.readFileSync(path.join(__dirname, 'mockup', 'index.html'), 'utf8');
    const bridgeRaw = fs.readFileSync(path.join(__dirname, 'public', 'api-bridge.js'), 'utf8');
    // Escape $ so String.replace doesn't interpret $', $&, $1 etc. as special patterns
    const bridge = bridgeRaw.replace(/\$/g, '$$$$');

    // Compute dynamic 15-month window server-side (12 back, current, 3 forward)
    const LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();
    const dynMonths = [], dynTags = [];
    for (let i = -11; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      dynMonths.push(LONG[d.getMonth()] + ' ' + d.getFullYear());
      dynTags.push(SHORT[d.getMonth()]);
    }

    // Replace hardcoded month arrays and index in mockup before serving
    // Pattern targets only the global declarations (they contain 4-digit years)
    const html = mockup
      .replace(/var MONTHS = \['[A-Za-z]+ \d{4}'[^\]]*\];/, `var MONTHS = ${JSON.stringify(dynMonths)};`)
      .replace(/var MONTH_TAGS = \['[A-Za-z]{3}'(?:,\s*'[A-Za-z]{3}')*\];/, `var MONTH_TAGS = ${JSON.stringify(dynTags)};`)
      .replace(/var CURRENT_DATA_MONTH_INDEX = \d+;/, 'var CURRENT_DATA_MONTH_INDEX = 11;')
      .replace(/var monthIndex = \d+;/, 'var monthIndex = 11;')
      .replace(
        /(<\/script>\s*<\/body>)/,
        `\n// ===== API Bridge (injected by server) =====\n${bridge}\n$1`
      );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('Error serving app:', e);
    res.status(500).send('Error loading app');
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Immagini running at http://localhost:${PORT}`);
  console.log(`    App    → http://localhost:${PORT}/app`);
  console.log(`    Login  → http://localhost:${PORT}/login`);
  console.log('\n📡  To share with others while testing:');
  console.log('    1. Install ngrok: https://ngrok.com/download');
  console.log(`    2. Run: ngrok http ${PORT}`);
  console.log('    3. Share the https:// URL ngrok gives you\n');
});
