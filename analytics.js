const { Pool } = require('pg');
const crypto = require('crypto');

const FREE_MINUTES_DEFAULT = parseInt(process.env.FREE_MINUTES) || 20;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// ── Initialize Database ──
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        fingerprint TEXT PRIMARY KEY,
        ip TEXT,
        names TEXT[] DEFAULT '{}',
        first_seen BIGINT,
        last_seen BIGINT,
        total_visits INT DEFAULT 0,
        total_play_time BIGINT DEFAULT 0,
        games_played INT DEFAULT 0,
        rooms_created INT DEFAULT 0,
        user_agent TEXT,
        screen_size TEXT,
        language TEXT,
        referrer TEXT,
        device_type TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        access_granted_until BIGINT,
        session_start BIGINT
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        name TEXT,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at BIGINT,
        last_login BIGINT
      );

      CREATE TABLE IF NOT EXISTS vip_ips (
        ip TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS vip_fingerprints (
        fingerprint TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS hourly_activity (
        hour INT PRIMARY KEY,
        count INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        visits INT DEFAULT 0,
        unique_visitors INT DEFAULT 0,
        rooms_created INT DEFAULT 0,
        games_played INT DEFAULT 0,
        peak_concurrent INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS words (
        id SERIAL PRIMARY KEY,
        word TEXT NOT NULL,
        hints TEXT[] DEFAULT '{}',
        category TEXT DEFAULT '',
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS sintonia_sessions (
        id SERIAL PRIMARY KEY,
        room_id INT,
        num_players INT,
        result TEXT,
        level_reached INT,
        total_levels INT,
        created_at BIGINT
      );
    `);

    // Initialize hourly_activity rows
    for (let h = 0; h < 24; h++) {
      await client.query(
        `INSERT INTO hourly_activity (hour, count) VALUES ($1, 0) ON CONFLICT (hour) DO NOTHING`,
        [h]
      );
    }

    // Initialize default admin if none exists
    const adminCount = await client.query('SELECT COUNT(*) FROM admin_users');
    if (parseInt(adminCount.rows[0].count) === 0) {
      await client.query(
        `INSERT INTO admin_users (id, username, name, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), 'admin', 'Administrador', hashPassword('admin1234'), 'superadmin', Date.now()]
      );
      console.log('  [DB] Admin padrão criado: admin / admin1234');
    }

    // Initialize default config
    const defaults = {
      monetization_enabled: 'false',
      free_minutes: String(FREE_MINUTES_DEFAULT),
      price: '5,00',
      pix_key: 'sua-chave-pix@email.com',
    };
    for (const [key, value] of Object.entries(defaults)) {
      await client.query(
        `INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    // Seed words from words.js if table is empty
    const wordCount = await client.query('SELECT COUNT(*) FROM words');
    if (parseInt(wordCount.rows[0].count) === 0) {
      try {
        const wordBank = require('./words');
        for (const w of wordBank) {
          await client.query(
            'INSERT INTO words (word, hints, category, created_at) VALUES ($1, $2, $3, $4)',
            [w.word, w.hints, '', Date.now()]
          );
        }
        console.log(`  [DB] ${wordBank.length} palavras importadas`);
      } catch (e) {
        console.log('  [DB] Sem arquivo words.js para importar');
      }
    }

    console.log('  [DB] Banco de dados inicializado');
  } finally {
    client.release();
  }
}

// ── Online tracking (in-memory, real-time only) ──
let onlineSet = new Set();

// ── Config helpers ──
async function getConfigValue(key) {
  const res = await pool.query('SELECT value FROM config WHERE key = $1', [key]);
  return res.rows[0]?.value || null;
}

async function setConfigValue(key, value) {
  await pool.query(
    'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, String(value)]
  );
}

async function getFreeMinutes() {
  const val = await getConfigValue('free_minutes');
  return parseInt(val) || FREE_MINUTES_DEFAULT;
}

// ── Visitors ──
async function ensureVisitor(fingerprint) {
  const res = await pool.query('SELECT * FROM visitors WHERE fingerprint = $1', [fingerprint]);
  if (res.rows[0]) return res.rows[0];
  await pool.query(
    `INSERT INTO visitors (fingerprint, first_seen, last_seen, total_visits, total_play_time, games_played, rooms_created, names)
     VALUES ($1, $2, $2, 0, 0, 0, 0, '{}') ON CONFLICT (fingerprint) DO NOTHING`,
    [fingerprint, Date.now()]
  );
  const r2 = await pool.query('SELECT * FROM visitors WHERE fingerprint = $1', [fingerprint]);
  return r2.rows[0];
}

async function trackVisit(fingerprint, ip, meta = {}) {
  await ensureVisitor(fingerprint);
  await pool.query(
    `UPDATE visitors SET
      ip = $2, last_seen = $3, total_visits = total_visits + 1, session_start = $3,
      user_agent = COALESCE($4, user_agent),
      screen_size = COALESCE($5, screen_size),
      language = COALESCE($6, language),
      referrer = COALESCE($7, referrer),
      device_type = COALESCE($8, device_type)
    WHERE fingerprint = $1`,
    [fingerprint, ip, Date.now(), meta.userAgent || null, meta.screenSize || null,
     meta.language || null, meta.referrer || null, meta.deviceType || null]
  );

  // Hourly
  const hour = new Date().getHours();
  await pool.query('UPDATE hourly_activity SET count = count + 1 WHERE hour = $1', [hour]);

  // Daily
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO daily_stats (date, visits, unique_visitors, rooms_created, games_played, peak_concurrent)
     VALUES ($1, 1, 1, 0, 0, 0)
     ON CONFLICT (date) DO UPDATE SET visits = daily_stats.visits + 1`,
    [today]
  );

  // Update unique visitors count
  const uniqueToday = await pool.query(
    `SELECT COUNT(*) FROM visitors WHERE last_seen >= $1`,
    [new Date(today).getTime()]
  );
  await pool.query('UPDATE daily_stats SET unique_visitors = $1 WHERE date = $2', [uniqueToday.rows[0].count, today]);

  // Online tracking
  onlineSet.add(fingerprint);
  const onlineCount = onlineSet.size;
  await pool.query(
    'UPDATE daily_stats SET peak_concurrent = GREATEST(peak_concurrent, $1) WHERE date = $2',
    [onlineCount, today]
  );
}

async function trackGeo(fingerprint, geo) {
  await pool.query(
    'UPDATE visitors SET city = $2, state = $3, country = $4 WHERE fingerprint = $1',
    [fingerprint, geo.city || null, geo.state || null, geo.country || null]
  );
}

async function trackDisconnect(fingerprint) {
  const res = await pool.query('SELECT session_start, total_play_time FROM visitors WHERE fingerprint = $1', [fingerprint]);
  if (res.rows[0]?.session_start) {
    const elapsed = Date.now() - parseInt(res.rows[0].session_start);
    await pool.query(
      'UPDATE visitors SET total_play_time = total_play_time + $2, session_start = NULL WHERE fingerprint = $1',
      [fingerprint, elapsed]
    );
  }
  onlineSet.delete(fingerprint);
}

async function trackName(fingerprint, name) {
  if (!name) return;
  await pool.query(
    `UPDATE visitors SET names = array_append(
      CASE WHEN $2 = ANY(names) THEN names ELSE names END,
      CASE WHEN $2 = ANY(names) THEN NULL ELSE $2 END
    ) WHERE fingerprint = $1 AND NOT ($2 = ANY(names))`,
    [fingerprint, name]
  );
}

async function trackRoomCreated(fingerprint) {
  await pool.query('UPDATE visitors SET rooms_created = rooms_created + 1 WHERE fingerprint = $1', [fingerprint]);
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO daily_stats (date, visits, unique_visitors, rooms_created, games_played, peak_concurrent)
     VALUES ($1, 0, 0, 1, 0, 0)
     ON CONFLICT (date) DO UPDATE SET rooms_created = daily_stats.rooms_created + 1`,
    [today]
  );
}

async function trackGamePlayed(fingerprint) {
  await pool.query('UPDATE visitors SET games_played = games_played + 1 WHERE fingerprint = $1', [fingerprint]);
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO daily_stats (date, visits, unique_visitors, rooms_created, games_played, peak_concurrent)
     VALUES ($1, 0, 0, 0, 1, 0)
     ON CONFLICT (date) DO UPDATE SET games_played = daily_stats.games_played + 1`,
    [today]
  );
}

// ── Access Control ──
async function checkAccess(fingerprint, ip) {
  const monetization = await getConfigValue('monetization_enabled');
  if (monetization !== 'true') {
    return { allowed: true, remainingMs: null, free: true };
  }

  // VIP fingerprint
  const vipFp = await pool.query('SELECT 1 FROM vip_fingerprints WHERE fingerprint = $1', [fingerprint]);
  if (vipFp.rows.length > 0) return { allowed: true, remainingMs: null, vip: true };

  // VIP IP
  if (ip) {
    const vipIp = await pool.query('SELECT 1 FROM vip_ips WHERE ip = $1', [ip]);
    if (vipIp.rows.length > 0) return { allowed: true, remainingMs: null, vip: true };
  }

  const res = await pool.query('SELECT * FROM visitors WHERE fingerprint = $1', [fingerprint]);
  const v = res.rows[0];
  if (!v) {
    const fm = await getFreeMinutes();
    return { allowed: true, remainingMs: fm * 60000 };
  }

  // Paid access
  if (v.access_granted_until && parseInt(v.access_granted_until) > Date.now()) {
    return { allowed: true, paid: true, remainingMs: null };
  }

  let currentSession = 0;
  if (v.session_start) currentSession = Date.now() - parseInt(v.session_start);
  const totalUsed = parseInt(v.total_play_time) + currentSession;
  const fm = await getFreeMinutes();
  const limitMs = fm * 60000;

  if (totalUsed >= limitMs) {
    return { allowed: false, remainingMs: 0, totalUsedMs: totalUsed };
  }

  return { allowed: true, remainingMs: limitMs - totalUsed };
}

async function grantAccess(fingerprint, hours = 24) {
  await ensureVisitor(fingerprint);
  await pool.query(
    'UPDATE visitors SET access_granted_until = $2 WHERE fingerprint = $1',
    [fingerprint, Date.now() + (hours * 3600000)]
  );
}

async function revokeAccess(fingerprint) {
  await pool.query('UPDATE visitors SET access_granted_until = NULL WHERE fingerprint = $1', [fingerprint]);
}

// ── Monetization ──
async function setMonetization(enabled) {
  await setConfigValue('monetization_enabled', enabled ? 'true' : 'false');
}

async function isMonetizationEnabled() {
  return (await getConfigValue('monetization_enabled')) === 'true';
}

// ── Config ──
async function setConfig(cfg) {
  if (cfg.freeMinutes !== undefined) await setConfigValue('free_minutes', parseInt(cfg.freeMinutes) || FREE_MINUTES_DEFAULT);
  if (cfg.price !== undefined) await setConfigValue('price', String(cfg.price));
  if (cfg.pixKey !== undefined) await setConfigValue('pix_key', String(cfg.pixKey));
}

async function getConfig() {
  return {
    freeMinutes: await getFreeMinutes(),
    price: (await getConfigValue('price')) || '5,00',
    pixKey: (await getConfigValue('pix_key')) || 'sua-chave-pix@email.com',
  };
}

// ── VIP IPs ──
async function addVipIp(ip) {
  await pool.query('INSERT INTO vip_ips (ip) VALUES ($1) ON CONFLICT DO NOTHING', [ip]);
}

async function removeVipIp(ip) {
  await pool.query('DELETE FROM vip_ips WHERE ip = $1', [ip]);
}

async function getVipIps() {
  const res = await pool.query('SELECT ip FROM vip_ips');
  return res.rows.map(r => r.ip);
}

// ── VIP Fingerprints ──
async function addVipFingerprint(fp) {
  await pool.query('INSERT INTO vip_fingerprints (fingerprint) VALUES ($1) ON CONFLICT DO NOTHING', [fp]);
}

async function isVip(fingerprint, ip) {
  const fp = await pool.query('SELECT 1 FROM vip_fingerprints WHERE fingerprint = $1', [fingerprint]);
  if (fp.rows.length > 0) return true;
  if (ip) {
    const ipRes = await pool.query('SELECT 1 FROM vip_ips WHERE ip = $1', [ip]);
    if (ipRes.rows.length > 0) return true;
  }
  return false;
}

// ── Admin Users ──
async function authenticateAdmin(username, password) {
  const res = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
  const user = res.rows[0];
  if (!user) return null;
  if (user.password_hash !== hashPassword(password)) return null;
  const token = crypto.randomUUID();
  await pool.query('UPDATE admin_users SET last_login = $1 WHERE id = $2', [Date.now(), user.id]);
  return { token, user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}

async function getAdminUsers() {
  const res = await pool.query('SELECT id, username, name, role, created_at, last_login FROM admin_users ORDER BY created_at');
  return res.rows.map(u => ({
    id: u.id, username: u.username, name: u.name, role: u.role,
    createdAt: parseInt(u.created_at), lastLogin: u.last_login ? parseInt(u.last_login) : null,
  }));
}

async function createAdminUser(username, name, password, role = 'admin') {
  const existing = await pool.query('SELECT 1 FROM admin_users WHERE username = $1', [username]);
  if (existing.rows.length > 0) return { error: 'Username já existe.' };
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO admin_users (id, username, name, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, username, name, hashPassword(password), role, Date.now()]
  );
  return { ok: true, user: { id, username, name, role } };
}

async function deleteAdminUser(id) {
  const res = await pool.query('SELECT role FROM admin_users WHERE id = $1', [id]);
  if (!res.rows[0]) return { error: 'Usuário não encontrado.' };
  if (res.rows[0].role === 'superadmin') return { error: 'Não é possível remover o superadmin.' };
  await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
  return { ok: true };
}

async function changeAdminPassword(id, newPassword) {
  const res = await pool.query('SELECT 1 FROM admin_users WHERE id = $1', [id]);
  if (!res.rows[0]) return { error: 'Usuário não encontrado.' };
  await pool.query('UPDATE admin_users SET password_hash = $2 WHERE id = $1', [id, hashPassword(newPassword)]);
  return { ok: true };
}

// ── Stats ──
async function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const fm = await getFreeMinutes();
  const monetization = (await getConfigValue('monetization_enabled')) === 'true';

  // Daily stats
  const dayRes = await pool.query('SELECT * FROM daily_stats WHERE date = $1', [today]);
  const day = dayRes.rows[0] || { visits: 0, unique_visitors: 0, rooms_created: 0, games_played: 0, peak_concurrent: 0 };

  // Hourly
  const hourlyRes = await pool.query('SELECT hour, count FROM hourly_activity ORDER BY hour');
  const hourlyActivity = new Array(24).fill(0);
  hourlyRes.rows.forEach(r => { hourlyActivity[r.hour] = r.count; });

  // Totals
  const totalVisitors = await pool.query('SELECT COUNT(*) FROM visitors');
  const totalGames = await pool.query('SELECT COALESCE(SUM(games_played), 0) as total FROM visitors');
  const totalRooms = await pool.query('SELECT COALESCE(SUM(rooms_created), 0) as total FROM visitors');

  // VIP data
  const vipIpsRes = await pool.query('SELECT ip FROM vip_ips');
  const vipFpsRes = await pool.query('SELECT fingerprint FROM vip_fingerprints');
  const vipIps = vipIpsRes.rows.map(r => r.ip);
  const vipFps = vipFpsRes.rows.map(r => r.fingerprint);

  // Visitors (last 50)
  const visitorsRes = await pool.query('SELECT * FROM visitors ORDER BY last_seen DESC LIMIT 50');
  const visitors = visitorsRes.rows.map(v => {
    let currentSession = 0;
    if (v.session_start) currentSession = Date.now() - parseInt(v.session_start);
    const totalUsed = parseInt(v.total_play_time) + currentSession;
    const limitMs = fm * 60000;
    const isPaid = v.access_granted_until && parseInt(v.access_granted_until) > Date.now();
    const playerIsVip = vipFps.includes(v.fingerprint) || (v.ip && vipIps.includes(v.ip));
    const isBlocked = monetization && !isPaid && !playerIsVip && totalUsed >= limitMs;

    return {
      fingerprint: v.fingerprint.slice(0, 12) + '...',
      fullFingerprint: v.fingerprint,
      ip: v.ip,
      names: v.names || [],
      firstSeen: parseInt(v.first_seen),
      lastSeen: parseInt(v.last_seen),
      totalVisits: v.total_visits,
      totalPlayTime: parseInt(v.total_play_time) + currentSession,
      gamesPlayed: v.games_played,
      roomsCreated: v.rooms_created,
      isOnline: onlineSet.has(v.fingerprint),
      isPaid: !!isPaid,
      isBlocked,
      isVip: playerIsVip,
      accessGrantedUntil: v.access_granted_until ? parseInt(v.access_granted_until) : null,
      userAgent: v.user_agent,
      screenSize: v.screen_size,
      language: v.language,
      referrer: v.referrer,
      deviceType: v.device_type,
      city: v.city,
      state: v.state,
      country: v.country,
    };
  });

  // Peak hour
  let peakHour = 0, peakCount = 0;
  hourlyActivity.forEach((count, hour) => { if (count > peakCount) { peakCount = count; peakHour = hour; } });

  // Paid count
  const paidRes = await pool.query('SELECT COUNT(*) FROM visitors WHERE access_granted_until > $1', [Date.now()]);

  const price = (await getConfigValue('price')) || '5,00';
  const pixKey = (await getConfigValue('pix_key')) || 'sua-chave-pix@email.com';

  return {
    online: onlineSet.size,
    todayVisits: parseInt(day.visits),
    todayUnique: parseInt(day.unique_visitors),
    todayGames: parseInt(day.games_played),
    todayRooms: parseInt(day.rooms_created),
    peakConcurrent: parseInt(day.peak_concurrent),
    totalVisitors: parseInt(totalVisitors.rows[0].count),
    totalGames: parseInt(totalGames.rows[0].total),
    totalRooms: parseInt(totalRooms.rows[0].total),
    hourlyActivity,
    peakHour: `${String(peakHour).padStart(2, '0')}:00`,
    visitors,
    freeMinutes: fm,
    price,
    pixKey,
    vipIps,
    paidCount: parseInt(paidRes.rows[0].count),
    blockedCount: visitors.filter(v => v.isBlocked).length,
    monetizationEnabled: monetization,
  };
}

// ── Words CRUD ──
async function getWords(search = '', limit = 50, offset = 0) {
  let query, params;
  if (search) {
    query = 'SELECT * FROM words WHERE LOWER(word) LIKE $1 ORDER BY word LIMIT $2 OFFSET $3';
    params = [`%${search.toLowerCase()}%`, limit, offset];
  } else {
    query = 'SELECT * FROM words ORDER BY word LIMIT $1 OFFSET $2';
    params = [limit, offset];
  }
  const res = await pool.query(query, params);
  const countQuery = search
    ? 'SELECT COUNT(*) FROM words WHERE LOWER(word) LIKE $1'
    : 'SELECT COUNT(*) FROM words';
  const countParams = search ? [`%${search.toLowerCase()}%`] : [];
  const countRes = await pool.query(countQuery, countParams);
  return {
    words: res.rows.map(w => ({ id: w.id, word: w.word, hints: w.hints || [], category: w.category || '' })),
    total: parseInt(countRes.rows[0].count),
  };
}

async function addWord(word, hints, category = '') {
  const existing = await pool.query('SELECT 1 FROM words WHERE LOWER(word) = LOWER($1)', [word]);
  if (existing.rows.length > 0) return { error: 'Palavra já existe.' };
  const res = await pool.query(
    'INSERT INTO words (word, hints, category, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [word, hints, category, Date.now()]
  );
  return { ok: true, id: res.rows[0].id };
}

async function updateWord(id, word, hints, category) {
  const res = await pool.query('SELECT 1 FROM words WHERE id = $1', [id]);
  if (!res.rows[0]) return { error: 'Palavra não encontrada.' };
  await pool.query(
    'UPDATE words SET word = $2, hints = $3, category = $4 WHERE id = $1',
    [id, word, hints, category || '']
  );
  return { ok: true };
}

async function deleteWord(id) {
  await pool.query('DELETE FROM words WHERE id = $1', [id]);
  return { ok: true };
}

async function getRandomWord() {
  const res = await pool.query('SELECT * FROM words ORDER BY RANDOM() LIMIT 1');
  if (!res.rows[0]) return null;
  const w = res.rows[0];
  return { word: w.word, hints: w.hints || [] };
}

// ── Sintonia tracking ──
async function trackSintoniaSession({ roomId, numPlayers, result, levelReached, totalLevels }) {
  try {
    await pool.query(
      'INSERT INTO sintonia_sessions (room_id, num_players, result, level_reached, total_levels, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [roomId, numPlayers, result, levelReached, totalLevels, Date.now()]
    );
  } catch (e) {
    console.error('[trackSintoniaSession]', e.message);
  }
}

async function getSintoniaStats() {
  try {
    const totalRes = await pool.query('SELECT COUNT(*) as total FROM sintonia_sessions');
    const winsRes = await pool.query("SELECT COUNT(*) as wins FROM sintonia_sessions WHERE result = 'win'");
    const lossesRes = await pool.query("SELECT COUNT(*) as losses FROM sintonia_sessions WHERE result = 'lose'");
    const avgLevelRes = await pool.query('SELECT COALESCE(AVG(level_reached), 0) as avg FROM sintonia_sessions');
    const byPlayersRes = await pool.query(
      'SELECT num_players, COUNT(*) as count FROM sintonia_sessions GROUP BY num_players ORDER BY num_players'
    );
    const recentRes = await pool.query(
      'SELECT room_id, num_players, result, level_reached, total_levels, created_at FROM sintonia_sessions ORDER BY created_at DESC LIMIT 20'
    );

    const total = parseInt(totalRes.rows[0].total);
    const wins = parseInt(winsRes.rows[0].wins);
    const losses = parseInt(lossesRes.rows[0].losses);
    return {
      total,
      wins,
      losses,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      avgLevelReached: parseFloat(avgLevelRes.rows[0].avg).toFixed(1),
      byPlayers: byPlayersRes.rows.map(r => ({ numPlayers: r.num_players, count: parseInt(r.count) })),
      recent: recentRes.rows.map(r => ({
        roomId: r.room_id,
        numPlayers: r.num_players,
        result: r.result,
        levelReached: r.level_reached,
        totalLevels: r.total_levels,
        createdAt: parseInt(r.created_at),
      })),
    };
  } catch (e) {
    console.error('[getSintoniaStats]', e.message);
    return { total: 0, wins: 0, losses: 0, winRate: 0, avgLevelReached: '0', byPlayers: [], recent: [] };
  }
}

module.exports = {
  initDB,
  trackVisit,
  trackGeo,
  trackDisconnect,
  trackName,
  trackRoomCreated,
  trackGamePlayed,
  checkAccess,
  grantAccess,
  revokeAccess,
  setMonetization,
  isMonetizationEnabled,
  setConfig,
  getConfig,
  addVipIp,
  removeVipIp,
  getVipIps,
  addVipFingerprint,
  isVip,
  authenticateAdmin,
  getAdminUsers,
  createAdminUser,
  deleteAdminUser,
  changeAdminPassword,
  getStats,
  getWords,
  addWord,
  updateWord,
  deleteWord,
  getRandomWord,
  trackSintoniaSession,
  getSintoniaStats,
};
