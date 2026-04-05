const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'analytics.json');
const FREE_MINUTES = parseInt(process.env.FREE_MINUTES) || 20;

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// ── Default data structure ──
function createDefaultData() {
  return {
    visitors: {},        // keyed by fingerprint
    hourlyActivity: new Array(24).fill(0),
    dailyStats: {},      // keyed by "YYYY-MM-DD"
    totalRoomsCreated: 0,
    totalGamesPlayed: 0,
    monetizationEnabled: false,
    freeMinutes: null,      // null = use env default
    price: '5,00',
    pixKey: 'sua-chave-pix@email.com',
    vipIps: [],
    vipFingerprints: [],
    adminUsers: [],         // { id, username, name, passwordHash, role, createdAt }
  };
}

// ── Load / Save ──
let data = createDefaultData();

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      data = { ...createDefaultData(), ...parsed };
      console.log(`  [Analytics] Dados carregados: ${Object.keys(data.visitors).length} visitantes`);
    } else {
      save();
      console.log('  [Analytics] Arquivo criado');
    }
  } catch (e) {
    console.error('  [Analytics] Erro ao carregar:', e.message);
    data = createDefaultData();
  }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('  [Analytics] Erro ao salvar:', e.message);
  }
}

// Auto-save every 30 seconds
setInterval(save, 30000);

// ── Helpers ──
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDailyStats(dateKey) {
  if (!data.dailyStats[dateKey]) {
    data.dailyStats[dateKey] = {
      visits: 0,
      uniqueVisitors: new Set(),
      roomsCreated: 0,
      gamesPlayed: 0,
      peakConcurrent: 0,
    };
  }
  // Fix deserialization: Set might become array after JSON parse
  if (!(data.dailyStats[dateKey].uniqueVisitors instanceof Set)) {
    data.dailyStats[dateKey].uniqueVisitors = new Set(data.dailyStats[dateKey].uniqueVisitors || []);
  }
  return data.dailyStats[dateKey];
}

function getVisitor(fingerprint) {
  return data.visitors[fingerprint] || null;
}

function ensureVisitor(fingerprint) {
  if (!data.visitors[fingerprint]) {
    data.visitors[fingerprint] = {
      fingerprint,
      ip: null,
      names: [],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      totalVisits: 0,
      totalPlayTime: 0,
      gamesPlayed: 0,
      roomsCreated: 0,
      userAgent: null,
      screenSize: null,
      language: null,
      referrer: null,
      deviceType: null,
      city: null,
      state: null,
      country: null,
      accessGrantedUntil: null,
      sessionStart: null,
    };
  }
  return data.visitors[fingerprint];
}

// ── Online tracking ──
let onlineSet = new Set();

// ── Public API ──

function trackVisit(fingerprint, ip, meta = {}) {
  const v = ensureVisitor(fingerprint);
  v.ip = ip;
  v.lastSeen = Date.now();
  v.totalVisits++;
  v.sessionStart = Date.now();

  if (meta.userAgent) v.userAgent = meta.userAgent;
  if (meta.screenSize) v.screenSize = meta.screenSize;
  if (meta.language) v.language = meta.language;
  if (meta.referrer) v.referrer = meta.referrer;
  if (meta.deviceType) v.deviceType = meta.deviceType;

  // Hourly
  const hour = new Date().getHours();
  data.hourlyActivity[hour]++;

  // Daily
  const day = ensureDailyStats(todayKey());
  day.visits++;
  day.uniqueVisitors.add(fingerprint);

  // Online
  onlineSet.add(fingerprint);
  if (onlineSet.size > day.peakConcurrent) {
    day.peakConcurrent = onlineSet.size;
  }

  return v;
}

function trackGeo(fingerprint, geo) {
  const v = getVisitor(fingerprint);
  if (v) {
    if (geo.city) v.city = geo.city;
    if (geo.state) v.state = geo.state;
    if (geo.country) v.country = geo.country;
  }
}

function trackDisconnect(fingerprint) {
  const v = getVisitor(fingerprint);
  if (v && v.sessionStart) {
    v.totalPlayTime += Date.now() - v.sessionStart;
    v.sessionStart = null;
  }
  onlineSet.delete(fingerprint);
}

function trackName(fingerprint, name) {
  const v = getVisitor(fingerprint);
  if (v && name && !v.names.includes(name)) {
    v.names.push(name);
    if (v.names.length > 10) v.names = v.names.slice(-10);
  }
}

function trackRoomCreated(fingerprint) {
  const v = getVisitor(fingerprint);
  if (v) v.roomsCreated++;
  data.totalRoomsCreated++;
  const day = ensureDailyStats(todayKey());
  day.roomsCreated++;
}

function trackGamePlayed(fingerprint) {
  const v = getVisitor(fingerprint);
  if (v) v.gamesPlayed++;
  data.totalGamesPlayed++;
  const day = ensureDailyStats(todayKey());
  day.gamesPlayed++;
}

// ── Access control ──

function getFreeMinutes() {
  return data.freeMinutes || FREE_MINUTES;
}

function checkAccess(fingerprint, ip) {
  // If monetization is off, everyone plays free
  if (!data.monetizationEnabled) {
    return { allowed: true, remainingMs: null, free: true };
  }

  // VIP fingerprint = unlimited
  if (data.vipFingerprints.includes(fingerprint)) {
    return { allowed: true, remainingMs: null, vip: true };
  }

  // VIP IP = unlimited
  if (ip && data.vipIps.includes(ip)) {
    return { allowed: true, remainingMs: null, vip: true };
  }

  const v = getVisitor(fingerprint);
  if (!v) return { allowed: true, remainingMs: getFreeMinutes() * 60000 };

  // If paid access is valid
  if (v.accessGrantedUntil && v.accessGrantedUntil > Date.now()) {
    return { allowed: true, paid: true, remainingMs: null };
  }

  // Calculate current session time
  let currentSession = 0;
  if (v.sessionStart) {
    currentSession = Date.now() - v.sessionStart;
  }

  const totalUsed = v.totalPlayTime + currentSession;
  const limitMs = getFreeMinutes() * 60000;

  if (totalUsed >= limitMs) {
    return { allowed: false, remainingMs: 0, totalUsedMs: totalUsed };
  }

  return { allowed: true, remainingMs: limitMs - totalUsed };
}

function grantAccess(fingerprint, hours = 24) {
  const v = ensureVisitor(fingerprint);
  v.accessGrantedUntil = Date.now() + (hours * 3600000);
  save();
  return v;
}

function revokeAccess(fingerprint) {
  const v = getVisitor(fingerprint);
  if (v) {
    v.accessGrantedUntil = null;
    save();
  }
}

// ── Monetization toggle ──

function setMonetization(enabled) {
  data.monetizationEnabled = !!enabled;
  save();
}

function isMonetizationEnabled() {
  return data.monetizationEnabled;
}

// ── Config ──

function setConfig(cfg) {
  if (cfg.freeMinutes !== undefined) data.freeMinutes = parseInt(cfg.freeMinutes) || null;
  if (cfg.price !== undefined) data.price = String(cfg.price);
  if (cfg.pixKey !== undefined) data.pixKey = String(cfg.pixKey);
  save();
}

function getConfig() {
  return {
    freeMinutes: getFreeMinutes(),
    price: data.price || '5,00',
    pixKey: data.pixKey || 'sua-chave-pix@email.com',
  };
}

// ── VIP IPs ──

function addVipIp(ip) {
  if (!data.vipIps.includes(ip)) {
    data.vipIps.push(ip);
    save();
  }
}

function removeVipIp(ip) {
  data.vipIps = data.vipIps.filter(i => i !== ip);
  save();
}

function getVipIps() {
  return data.vipIps || [];
}

// ── VIP Fingerprints ──

function addVipFingerprint(fp) {
  if (!data.vipFingerprints.includes(fp)) {
    data.vipFingerprints.push(fp);
    save();
  }
}

function isVip(fingerprint, ip) {
  return data.vipFingerprints.includes(fingerprint) || (ip && data.vipIps.includes(ip));
}

// ── Admin Users ──

function initDefaultAdmin() {
  if (!data.adminUsers || data.adminUsers.length === 0) {
    data.adminUsers = [{
      id: crypto.randomUUID(),
      username: 'admin',
      name: 'Administrador',
      passwordHash: hashPassword('admin1234'),
      role: 'superadmin',
      createdAt: Date.now(),
    }];
    save();
  }
}

function authenticateAdmin(username, password) {
  const user = (data.adminUsers || []).find(u => u.username === username);
  if (!user) return null;
  if (user.passwordHash !== hashPassword(password)) return null;
  // Generate session token
  const token = crypto.randomUUID();
  user.lastLogin = Date.now();
  save();
  return { token, user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}

function getAdminUsers() {
  return (data.adminUsers || []).map(u => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin || null,
  }));
}

function createAdminUser(username, name, password, role = 'admin') {
  if ((data.adminUsers || []).some(u => u.username === username)) {
    return { error: 'Username já existe.' };
  }
  const user = {
    id: crypto.randomUUID(),
    username,
    name,
    passwordHash: hashPassword(password),
    role,
    createdAt: Date.now(),
  };
  data.adminUsers.push(user);
  save();
  return { ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}

function deleteAdminUser(id) {
  const user = (data.adminUsers || []).find(u => u.id === id);
  if (!user) return { error: 'Usuário não encontrado.' };
  if (user.role === 'superadmin') return { error: 'Não é possível remover o superadmin.' };
  data.adminUsers = data.adminUsers.filter(u => u.id !== id);
  save();
  return { ok: true };
}

function changeAdminPassword(id, newPassword) {
  const user = (data.adminUsers || []).find(u => u.id === id);
  if (!user) return { error: 'Usuário não encontrado.' };
  user.passwordHash = hashPassword(newPassword);
  save();
  return { ok: true };
}

// ── Stats for admin ──

function getStats() {
  const today = todayKey();
  const dayStats = ensureDailyStats(today);

  // Serialize Sets for JSON
  const dailyStatsSerialized = {};
  for (const [key, val] of Object.entries(data.dailyStats)) {
    dailyStatsSerialized[key] = {
      ...val,
      uniqueVisitors: val.uniqueVisitors instanceof Set
        ? val.uniqueVisitors.size
        : (Array.isArray(val.uniqueVisitors) ? val.uniqueVisitors.length : 0),
    };
  }

  // Recent visitors (last 50, sorted by lastSeen)
  const visitors = Object.values(data.visitors)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 50)
    .map(v => {
      let currentSession = 0;
      if (v.sessionStart) currentSession = Date.now() - v.sessionStart;
      const totalUsed = v.totalPlayTime + currentSession;
      const limitMs = getFreeMinutes() * 60000;
      const isPaid = v.accessGrantedUntil && v.accessGrantedUntil > Date.now();
      const playerIsVip = isVip(v.fingerprint, v.ip);
      const isBlocked = data.monetizationEnabled && !isPaid && !playerIsVip && totalUsed >= limitMs;

      return {
        fingerprint: v.fingerprint.slice(0, 12) + '...',
        fullFingerprint: v.fingerprint,
        ip: v.ip,
        names: v.names,
        firstSeen: v.firstSeen,
        lastSeen: v.lastSeen,
        totalVisits: v.totalVisits,
        totalPlayTime: v.totalPlayTime + currentSession,
        gamesPlayed: v.gamesPlayed,
        roomsCreated: v.roomsCreated,
        isOnline: onlineSet.has(v.fingerprint),
        isPaid,
        isBlocked,
        isVip: playerIsVip,
        accessGrantedUntil: v.accessGrantedUntil,
        userAgent: v.userAgent,
        screenSize: v.screenSize,
        language: v.language,
        referrer: v.referrer,
        deviceType: v.deviceType,
        city: v.city,
        state: v.state,
        country: v.country,
      };
    });

  // Find peak hour
  let peakHour = 0;
  let peakCount = 0;
  data.hourlyActivity.forEach((count, hour) => {
    if (count > peakCount) { peakCount = count; peakHour = hour; }
  });

  return {
    online: onlineSet.size,
    todayVisits: dayStats.visits,
    todayUnique: dayStats.uniqueVisitors instanceof Set
      ? dayStats.uniqueVisitors.size
      : (Array.isArray(dayStats.uniqueVisitors) ? dayStats.uniqueVisitors.length : 0),
    todayGames: dayStats.gamesPlayed,
    todayRooms: dayStats.roomsCreated,
    peakConcurrent: dayStats.peakConcurrent,
    totalVisitors: Object.keys(data.visitors).length,
    totalGames: data.totalGamesPlayed,
    totalRooms: data.totalRoomsCreated,
    hourlyActivity: data.hourlyActivity,
    peakHour: `${String(peakHour).padStart(2, '0')}:00`,
    dailyStats: dailyStatsSerialized,
    visitors,
    freeMinutes: getFreeMinutes(),
    price: data.price || '5,00',
    pixKey: data.pixKey || 'sua-chave-pix@email.com',
    vipIps: data.vipIps || [],
    paidCount: Object.values(data.visitors).filter(v => v.accessGrantedUntil && v.accessGrantedUntil > Date.now()).length,
    blockedCount: visitors.filter(v => v.isBlocked).length,
    monetizationEnabled: data.monetizationEnabled,
  };
}

// ── Initialize ──
load();
initDefaultAdmin();

module.exports = {
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
  save,
};
