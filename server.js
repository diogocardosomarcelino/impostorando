const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const analytics = require('./analytics');
const wordBank = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin Auth ──
const adminTokens = new Map(); // token -> { user, expiresAt }

function verifyAdmin(req, res, next) {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Token obrigatório. Faça login.' });
  const session = adminTokens.get(token);
  if (!session || session.expiresAt < Date.now()) {
    adminTokens.delete(token);
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
  req.adminUser = session.user;
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Preencha usuário e senha.' });
  const result = analytics.authenticateAdmin(username, password);
  if (!result) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  // Token expires in 24h
  adminTokens.set(result.token, { user: result.user, expiresAt: Date.now() + 86400000 });
  res.json({ ok: true, token: result.token, user: result.user });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Admin Routes (all protected) ──
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
  res.json(analytics.getStats());
});

app.post('/api/admin/grant-access', verifyAdmin, (req, res) => {
  const { fingerprint, hours } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint obrigatório' });
  analytics.grantAccess(fingerprint, hours || 24);
  for (const [, s] of io.sockets.sockets) {
    if (s.fingerprint === fingerprint) s.emit('access-granted');
  }
  res.json({ ok: true });
});

app.post('/api/admin/revoke-access', verifyAdmin, (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint obrigatório' });
  analytics.revokeAccess(fingerprint);
  res.json({ ok: true });
});

app.post('/api/admin/monetization', verifyAdmin, (req, res) => {
  const { enabled } = req.body;
  analytics.setMonetization(enabled);
  res.json({ ok: true, monetizationEnabled: analytics.isMonetizationEnabled() });
});

app.post('/api/admin/config', verifyAdmin, (req, res) => {
  analytics.setConfig(req.body);
  res.json({ ok: true, ...analytics.getConfig() });
});

app.post('/api/admin/vip-ip', verifyAdmin, (req, res) => {
  const { ip, action } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP obrigatório' });
  if (action === 'add') analytics.addVipIp(ip);
  else if (action === 'remove') analytics.removeVipIp(ip);
  res.json({ ok: true, vipIps: analytics.getVipIps() });
});

app.post('/api/admin/vip-fp', verifyAdmin, (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint obrigatório' });
  analytics.addVipFingerprint(fingerprint);
  res.json({ ok: true });
});

// ── Admin Users CRUD ──
app.get('/api/admin/users', verifyAdmin, (req, res) => {
  res.json(analytics.getAdminUsers());
});

app.post('/api/admin/users', verifyAdmin, (req, res) => {
  if (req.adminUser.role !== 'superadmin') return res.status(403).json({ error: 'Apenas superadmin pode criar usuários.' });
  const { username, name, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e senha obrigatórios.' });
  const result = analytics.createAdminUser(username, name || username, password, role || 'admin');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/admin/users/:id', verifyAdmin, (req, res) => {
  if (req.adminUser.role !== 'superadmin') return res.status(403).json({ error: 'Apenas superadmin pode remover usuários.' });
  const result = analytics.deleteAdminUser(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/admin/users/:id/password', verifyAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha obrigatória.' });
  // Can change own password or superadmin can change anyone's
  if (req.adminUser.id !== req.params.id && req.adminUser.role !== 'superadmin') {
    return res.status(403).json({ error: 'Sem permissão.' });
  }
  const result = analytics.changeAdminPassword(req.params.id, password);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ── Room State ──
const rooms = new Map();
let nextRoomId = 1;

// ── Session persistence: sessionId -> { roomId, playerName } ──
const sessions = new Map();

function formatRoomId(id) {
  return String(id).padStart(4, '0');
}

function pickWord() {
  return wordBank[Math.floor(Math.random() * wordBank.length)];
}

function assignRoles(playerCount, impostorCount) {
  const roles = Array(playerCount).fill(false);
  const indices = [];
  while (indices.length < impostorCount) {
    const idx = Math.floor(Math.random() * playerCount);
    if (!indices.includes(idx)) {
      indices.push(idx);
      roles[idx] = true;
    }
  }
  return roles;
}

function broadcastLobby(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const playerNames = room.players.map(p => p.name);
  for (const p of room.players) {
    p.socket.emit('lobby-update', {
      players: playerNames,
      isHost: p.socket.id === room.host,
      settings: room.settings,
      roomName: `Sala ${formatRoomId(roomId)}`,
      roomCode: formatRoomId(roomId),
    });
  }
}

function sendGameData(room) {
  const maxImpostors = Math.floor(room.players.length / 2) || 1;
  room.settings.impostorCount = Math.min(room.settings.impostorCount, maxImpostors);

  const roles = assignRoles(room.players.length, room.settings.impostorCount);

  room.playerRoles = {};
  room.players.forEach((p, i) => {
    const isImpostor = roles[i];
    room.playerRoles[p.name] = {
      isImpostor,
      word: isImpostor ? null : room.currentWord.word,
      hint: isImpostor && room.settings.hintsEnabled ? room.currentWord.hints[Math.floor(Math.random() * room.currentWord.hints.length)] : null,
    };
  });

  return room.playerRoles;
}

// ── Access check helper ──
function checkAndEmitAccess(socket) {
  if (!socket.fingerprint) return true;
  const ip = socket.handshake?.headers?.['x-forwarded-for'] || socket.handshake?.address;
  const access = analytics.checkAccess(socket.fingerprint, ip);
  if (!access.allowed) {
    socket.emit('access-blocked');
    return false;
  }
  if (access.remainingMs !== null && access.remainingMs < 5 * 60 * 1000) {
    socket.emit('access-warning', { remainingMs: access.remainingMs });
  }
  return true;
}

// ── Voting results broadcast ──
function broadcastVotingResults(room) {
  room.gameState = 'results';

  // Tally votes
  const tallies = {};
  room.players.forEach(p => { tallies[p.name] = 0; });
  for (const targets of Object.values(room.votingPhase.votes)) {
    for (const t of targets) {
      tallies[t] = (tallies[t] || 0) + 1;
    }
  }

  // Sort by votes desc
  const sorted = Object.entries(tallies)
    .map(([name, votes]) => ({ name, votes }))
    .sort((a, b) => b.votes - a.votes);

  // Find impostors
  const impostors = [];
  if (room.playerRoles) {
    for (const [name, role] of Object.entries(room.playerRoles)) {
      if (role.isImpostor) impostors.push(name);
    }
  }

  // Check if group got it right: the most voted player(s) match impostors
  const maxVotes = sorted[0]?.votes || 0;
  const mostVoted = sorted.filter(s => s.votes === maxVotes).map(s => s.name);
  const gotItRight = impostors.length > 0 &&
    impostors.every(imp => mostVoted.includes(imp)) &&
    mostVoted.length === impostors.length;

  const resultData = {
    tallies: sorted,
    impostors,
    word: room.currentWord?.word || '???',
    gotItRight,
  };

  for (const p of room.players) {
    p.socket.emit('voting-results', {
      ...resultData,
      isHost: p.socket.id === room.host,
    });
  }

  room.votingPhase = null;
}

// ── Periodic access check for connected players (every 30s) ──
setInterval(() => {
  for (const [, s] of io.sockets.sockets) {
    if (s.fingerprint) {
      checkAndEmitAccess(s);
    }
  }
}, 30000);

// ── Socket.io ──
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  // ── Register visit with fingerprint ──
  socket.on('register', ({ fingerprint, meta }, cb) => {
    if (!fingerprint) return cb?.({ ok: false });

    socket.fingerprint = fingerprint;
    analytics.trackVisit(fingerprint, ip, meta || {});

    const access = analytics.checkAccess(fingerprint, ip);
    cb?.({
      ok: true,
      access: {
        allowed: access.allowed,
        remainingMs: access.remainingMs,
        paid: access.paid || false,
      },
    });

    if (!access.allowed) {
      socket.emit('access-blocked');
    }
  });

  // ── Reconnect ──
  socket.on('reconnect-session', ({ sessionId }, cb) => {
    const session = sessions.get(sessionId);
    if (!session) return cb({ ok: false });

    const room = rooms.get(session.roomId);
    if (!room) {
      sessions.delete(sessionId);
      return cb({ ok: false });
    }

    const existing = room.players.find(p => p.name === session.playerName);
    if (existing) {
      existing.socket = socket;
    } else {
      room.players.push({ socket, name: session.playerName });
    }

    socket.roomId = session.roomId;
    socket.playerName = session.playerName;
    socket.sessionId = sessionId;

    const isHost = room.host === '__disconnected_' + session.playerName;
    if (isHost) {
      room.host = socket.id;
    }

    if (room.players[0]?.socket.id === socket.id) {
      room.host = socket.id;
    }

    if (room.gameState === 'playing' && room.playerRoles && room.playerRoles[session.playerName]) {
      const role = room.playerRoles[session.playerName];
      cb({
        ok: true,
        screen: 'game',
        roomCode: formatRoomId(session.roomId),
        gameData: {
          playerName: session.playerName,
          isImpostor: role.isImpostor,
          word: role.word,
          hint: role.hint,
        },
        isHost: room.host === socket.id,
      });
    } else {
      cb({
        ok: true,
        screen: 'lobby',
        roomCode: formatRoomId(session.roomId),
      });
      broadcastLobby(session.roomId);
    }
  });

  socket.on('create-room', ({ playerName, password }, cb) => {
    if (!playerName || !password || password.length !== 4) {
      return cb({ error: 'Nome e senha de 4 dígitos são obrigatórios.' });
    }

    // Access check
    if (!checkAndEmitAccess(socket)) {
      return cb({ error: 'Seu tempo gratuito acabou.' });
    }

    const roomId = nextRoomId++;
    const sessionId = crypto.randomUUID();

    const room = {
      id: roomId,
      password,
      host: socket.id,
      players: [{ socket, name: playerName }],
      settings: { impostorCount: 1, hintsEnabled: false },
      gameState: 'lobby',
      currentWord: null,
      playerRoles: null,
    };
    rooms.set(roomId, room);

    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.sessionId = sessionId;

    sessions.set(sessionId, { roomId, playerName });

    // Analytics
    if (socket.fingerprint) {
      analytics.trackRoomCreated(socket.fingerprint);
      analytics.trackName(socket.fingerprint, playerName);
    }

    cb({ roomId, roomCode: formatRoomId(roomId), sessionId });
    broadcastLobby(roomId);
  });

  socket.on('join-room', ({ roomCode, playerName, password }, cb) => {
    const roomId = parseInt(roomCode, 10);
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'Sala não encontrada.' });
    if (room.password !== password) return cb({ error: 'Senha incorreta.' });
    if (room.players.some(p => p.name === playerName)) {
      return cb({ error: 'Já existe um jogador com esse nome na sala.' });
    }

    // Access check
    if (!checkAndEmitAccess(socket)) {
      return cb({ error: 'Seu tempo gratuito acabou.' });
    }

    const sessionId = crypto.randomUUID();

    room.players.push({ socket, name: playerName });
    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.sessionId = sessionId;

    sessions.set(sessionId, { roomId, playerName });

    // Analytics
    if (socket.fingerprint) {
      analytics.trackName(socket.fingerprint, playerName);
    }

    cb({ roomId, roomCode: formatRoomId(roomId), sessionId });
    broadcastLobby(roomId);
  });

  socket.on('update-settings', ({ impostorCount, hintsEnabled }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;

    const maxImpostors = Math.floor(room.players.length / 2) || 1;
    room.settings.impostorCount = Math.max(1, Math.min(maxImpostors, impostorCount));
    room.settings.hintsEnabled = hintsEnabled;
    broadcastLobby(socket.roomId);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) return;

    room.gameState = 'playing';
    room.currentWord = pickWord();

    const playerRoles = sendGameData(room);

    room.players.forEach((p) => {
      const role = playerRoles[p.name];
      // Analytics: track game for each player
      if (p.socket.fingerprint) {
        analytics.trackGamePlayed(p.socket.fingerprint);
      }
      p.socket.emit('game-started', {
        playerName: p.name,
        isImpostor: role.isImpostor,
        word: role.word,
        hint: role.hint,
      });
    });
  });

  socket.on('new-round', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;

    room.currentWord = pickWord();
    const playerRoles = sendGameData(room);

    for (const p of room.players) {
      p.socket.emit('countdown-start');
    }

    room.pendingRound = playerRoles;

    setTimeout(() => {
      if (!rooms.has(room.id)) return;
      room.players.forEach((p) => {
        const role = room.pendingRound?.[p.name];
        if (role) {
          // Analytics
          if (p.socket.fingerprint) {
            analytics.trackGamePlayed(p.socket.fingerprint);
          }
          p.socket.emit('game-started', {
            playerName: p.name,
            isImpostor: role.isImpostor,
            word: role.word,
            hint: role.hint,
          });
        }
      });
      room.pendingRound = null;
    }, 3500);
  });

  // ── Voting System ──
  socket.on('start-voting', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    if (room.gameState !== 'playing') return;

    room.gameState = 'voting';
    room.votingPhase = {
      votes: {},       // playerName -> [target1, target2]
      confirmed: [],   // playerNames who voted
    };

    const playerNames = room.players.map(p => p.name);
    const votesNeeded = room.settings.impostorCount;

    for (const p of room.players) {
      p.socket.emit('voting-started', {
        players: playerNames,
        votesNeeded,
        myName: p.name,
      });
    }
  });

  socket.on('cast-vote', ({ targets }, cb) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.gameState !== 'voting' || !room.votingPhase) return cb?.({ error: 'Votação não ativa.' });

    const playerName = socket.playerName;
    if (room.votingPhase.confirmed.includes(playerName)) return cb?.({ error: 'Você já votou.' });

    // Validate
    const votesNeeded = room.settings.impostorCount;
    if (!targets || targets.length !== votesNeeded) return cb?.({ error: `Selecione ${votesNeeded} jogador(es).` });
    if (targets.includes(playerName)) return cb?.({ error: 'Você não pode votar em si mesmo.' });

    const validNames = room.players.map(p => p.name);
    for (const t of targets) {
      if (!validNames.includes(t)) return cb?.({ error: 'Jogador inválido.' });
    }

    room.votingPhase.votes[playerName] = targets;
    room.votingPhase.confirmed.push(playerName);

    cb?.({ ok: true });

    // Broadcast progress
    for (const p of room.players) {
      p.socket.emit('voting-progress', {
        confirmed: room.votingPhase.confirmed.length,
        total: room.players.length,
      });
    }

    // Check if everyone voted
    if (room.votingPhase.confirmed.length >= room.players.length) {
      broadcastVotingResults(room);
    }
  });

  socket.on('end-voting', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    if (room.gameState !== 'voting') return;

    broadcastVotingResults(room);
  });

  socket.on('back-to-lobby', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;

    room.gameState = 'lobby';
    room.currentWord = null;
    room.playerRoles = null;

    for (const p of room.players) {
      p.socket.emit('go-to-lobby');
    }

    broadcastLobby(socket.roomId);
  });

  socket.on('close-room', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;

    for (const p of room.players) {
      p.socket.emit('room-closed');
      if (p.socket.sessionId) {
        sessions.delete(p.socket.sessionId);
      }
      p.socket.roomId = null;
    }

    rooms.delete(socket.roomId);
  });

  socket.on('leave-room', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    // Analytics: track disconnect
    if (socket.fingerprint) {
      analytics.trackDisconnect(socket.fingerprint);
    }

    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (room.host === socket.id) {
      room.host = '__disconnected_' + socket.playerName;
    }

    const playerName = socket.playerName;
    setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r) return;
      const player = r.players.find(p => p.name === playerName);
      if (player && player.socket.id === socket.id) {
        r.players = r.players.filter(p => p.name !== playerName);
        if (r.players.length === 0) {
          rooms.delete(roomId);
        } else {
          if (r.host === '__disconnected_' + playerName) {
            r.host = r.players[0].socket.id;
          }
          broadcastLobby(roomId);
        }
      }
      if (socket.sessionId) {
        const sess = sessions.get(socket.sessionId);
        if (sess && !r?.players.find(p => p.name === playerName)) {
          sessions.delete(socket.sessionId);
        }
      }
    }, 60000);
  });
});

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.socket.id !== socket.id);

  if (socket.sessionId) {
    sessions.delete(socket.sessionId);
  }

  socket.roomId = null;

  if (room.players.length === 0) {
    rooms.delete(roomId);
    return;
  }

  if (room.host === socket.id) {
    room.host = room.players[0].socket.id;
  }

  broadcastLobby(roomId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
  }
  console.log(`\n  IMPOSTOR Online rodando!\n`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Rede:    http://${localIp}:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin`);
  console.log(`  Login:   admin / admin1234 (padrão)\n`);
});
