const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const analytics = require('./analytics');
const wordBank = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 15000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin Auth ──
const adminTokens = new Map();

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

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Preencha usuário e senha.' });
  const result = await analytics.authenticateAdmin(username, password);
  if (!result) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  adminTokens.set(result.token, { user: result.user, expiresAt: Date.now() + 86400000 });
  res.json({ ok: true, token: result.token, user: result.user });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Admin Routes (all protected + async) ──
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  res.json(await analytics.getStats());
});

app.post('/api/admin/grant-access', verifyAdmin, async (req, res) => {
  const { fingerprint, hours } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint obrigatório' });
  await analytics.grantAccess(fingerprint, hours || 24);
  for (const [, s] of io.sockets.sockets) {
    if (s.fingerprint === fingerprint) s.emit('access-granted');
  }
  res.json({ ok: true });
});

app.post('/api/admin/revoke-access', verifyAdmin, async (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint obrigatório' });
  await analytics.revokeAccess(fingerprint);
  res.json({ ok: true });
});

app.post('/api/admin/monetization', verifyAdmin, async (req, res) => {
  const { enabled } = req.body;
  await analytics.setMonetization(enabled);
  res.json({ ok: true, monetizationEnabled: await analytics.isMonetizationEnabled() });
});

app.post('/api/admin/config', verifyAdmin, async (req, res) => {
  await analytics.setConfig(req.body);
  res.json({ ok: true, ...(await analytics.getConfig()) });
});

app.post('/api/admin/vip-ip', verifyAdmin, async (req, res) => {
  const { ip, action } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP obrigatório' });
  if (action === 'add') await analytics.addVipIp(ip);
  else if (action === 'remove') await analytics.removeVipIp(ip);
  res.json({ ok: true, vipIps: await analytics.getVipIps() });
});

app.post('/api/admin/vip-fp', verifyAdmin, async (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) return res.status(400).json({ error: 'Fingerprint obrigatório' });
  await analytics.addVipFingerprint(fingerprint);
  res.json({ ok: true });
});

// ── Admin Users CRUD ──
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  res.json(await analytics.getAdminUsers());
});

app.post('/api/admin/users', verifyAdmin, async (req, res) => {
  if (req.adminUser.role !== 'superadmin') return res.status(403).json({ error: 'Apenas superadmin pode criar usuários.' });
  const { username, name, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e senha obrigatórios.' });
  const result = await analytics.createAdminUser(username, name || username, password, role || 'admin');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/admin/users/:id', verifyAdmin, async (req, res) => {
  if (req.adminUser.role !== 'superadmin') return res.status(403).json({ error: 'Apenas superadmin pode remover usuários.' });
  const result = await analytics.deleteAdminUser(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/admin/users/:id/password', verifyAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha obrigatória.' });
  if (req.adminUser.id !== req.params.id && req.adminUser.role !== 'superadmin') {
    return res.status(403).json({ error: 'Sem permissão.' });
  }
  const result = await analytics.changeAdminPassword(req.params.id, password);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ── Words CRUD ──
app.get('/api/admin/words', verifyAdmin, async (req, res) => {
  const { search, limit, offset } = req.query;
  res.json(await analytics.getWords(search || '', parseInt(limit) || 50, parseInt(offset) || 0));
});

app.post('/api/admin/words', verifyAdmin, async (req, res) => {
  const { word, hints, category } = req.body;
  if (!word || !hints || !Array.isArray(hints) || hints.length === 0) return res.status(400).json({ error: 'Palavra e pelo menos 1 dica obrigatórios.' });
  const result = await analytics.addWord(word.trim(), hints.map(h => h.trim()).filter(Boolean), category || '');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.put('/api/admin/words/:id', verifyAdmin, async (req, res) => {
  const { word, hints, category } = req.body;
  if (!word || !hints || !Array.isArray(hints) || hints.length === 0) return res.status(400).json({ error: 'Palavra e pelo menos 1 dica obrigatórios.' });
  const result = await analytics.updateWord(parseInt(req.params.id), word.trim(), hints.map(h => h.trim()).filter(Boolean), category || '');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/admin/words/:id', verifyAdmin, async (req, res) => {
  res.json(await analytics.deleteWord(parseInt(req.params.id)));
});

// ── Room State ──
const rooms = new Map();
let nextRoomId = 1;
const sessions = new Map();

function formatRoomId(id) { return String(id).padStart(4, '0'); }
async function pickWord() {
  const dbWord = await analytics.getRandomWord();
  if (dbWord) return dbWord;
  // Fallback to file if DB empty
  return wordBank[Math.floor(Math.random() * wordBank.length)];
}

function assignRoles(playerCount, impostorCount, previousImpostorIndices = []) {
  // Use crypto.randomInt for true randomness
  const allIndices = Array.from({ length: playerCount }, (_, i) => i);

  // Fisher-Yates shuffle with crypto random
  for (let i = allIndices.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [allIndices[i], allIndices[j]] = [allIndices[j], allIndices[i]];
  }

  // Pick impostors, avoiding previous ones if possible
  let candidates = allIndices.filter(idx => !previousImpostorIndices.includes(idx));

  // If not enough non-previous candidates, use all
  if (candidates.length < impostorCount) {
    candidates = allIndices;
  }

  // Shuffle candidates again for extra randomness
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const roles = Array(playerCount).fill(false);
  const newImpostorIndices = [];
  for (let i = 0; i < impostorCount; i++) {
    roles[candidates[i]] = true;
    newImpostorIndices.push(candidates[i]);
  }

  return { roles, impostorIndices: newImpostorIndices };
}

function broadcastLobby(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const playerNames = room.players.map(p => p.name);
  for (const p of room.players) {
    p.socket.emit('lobby-update', {
      players: playerNames, isHost: p.socket.id === room.host,
      settings: room.settings, roomName: `Sala ${formatRoomId(roomId)}`, roomCode: formatRoomId(roomId),
    });
  }
}

function sendGameData(room) {
  const maxImpostors = Math.floor(room.players.length / 2) || 1;
  room.settings.impostorCount = Math.min(room.settings.impostorCount, maxImpostors);
  const { roles, impostorIndices } = assignRoles(
    room.players.length,
    room.settings.impostorCount,
    room.previousImpostorIndices || []
  );
  room.previousImpostorIndices = impostorIndices;
  room.playerRoles = {};
  room.players.forEach((p, i) => {
    const isImpostor = roles[i];
    room.playerRoles[p.name] = {
      isImpostor, word: isImpostor ? null : room.currentWord.word,
      hint: isImpostor && room.settings.hintsEnabled ? room.currentWord.hints[crypto.randomInt(0, room.currentWord.hints.length)] : null,
    };
  });
  return room.playerRoles;
}

// ── Access check (async) ──
async function checkAndEmitAccess(socket) {
  if (!socket.fingerprint) return true;
  const ip = socket.handshake?.headers?.['x-forwarded-for'] || socket.handshake?.address;
  const access = await analytics.checkAccess(socket.fingerprint, ip);
  if (!access.allowed) { socket.emit('access-blocked'); return false; }
  if (access.remainingMs !== null && access.remainingMs < 5 * 60 * 1000) {
    socket.emit('access-warning', { remainingMs: access.remainingMs });
  }
  return true;
}

// ── Voting results ──
function broadcastVotingResults(room) {
  room.gameState = 'results';
  const tallies = {};
  room.players.forEach(p => { tallies[p.name] = 0; });
  for (const targets of Object.values(room.votingPhase.votes)) {
    for (const t of targets) { tallies[t] = (tallies[t] || 0) + 1; }
  }
  const sorted = Object.entries(tallies).map(([name, votes]) => ({ name, votes })).sort((a, b) => b.votes - a.votes);
  const impostors = [];
  if (room.playerRoles) {
    for (const [name, role] of Object.entries(room.playerRoles)) {
      if (role.isImpostor) impostors.push(name);
    }
  }
  const maxVotes = sorted[0]?.votes || 0;
  const mostVoted = sorted.filter(s => s.votes === maxVotes).map(s => s.name);
  const gotItRight = impostors.length > 0 && impostors.every(imp => mostVoted.includes(imp)) && mostVoted.length === impostors.length;
  const resultData = { tallies: sorted, impostors, word: room.currentWord?.word || '???', gotItRight };
  for (const p of room.players) {
    if (!p.disconnected) {
      try { p.socket.emit('voting-results', { ...resultData, isHost: p.socket.id === room.host }); } catch (e) {}
    }
  }
  room.votingPhase = null;
}

// ── Periodic access check (async) ──
setInterval(async () => {
  for (const [, s] of io.sockets.sockets) {
    if (s.fingerprint) { await checkAndEmitAccess(s); }
  }
}, 30000);

// ── Socket.io ──
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  socket.on('register', async ({ fingerprint, meta }, cb) => {
    if (!fingerprint) return cb?.({ ok: false });
    socket.fingerprint = fingerprint;
    await analytics.trackVisit(fingerprint, ip, meta || {});

    // Geolocation (non-blocking)
    if (ip && ip !== '::1' && ip !== '127.0.0.1') {
      const cleanIp = ip.includes(',') ? ip.split(',')[0].trim() : ip;
      const httpMod = require('http');
      httpMod.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,regionName,city`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const geo = JSON.parse(data);
            if (geo.status === 'success') {
              analytics.trackGeo(fingerprint, { city: geo.city, state: geo.regionName, country: geo.country });
            }
          } catch (e) {}
        });
      }).on('error', () => {});
    }

    const access = await analytics.checkAccess(fingerprint, ip);
    cb?.({ ok: true, access: { allowed: access.allowed, remainingMs: access.remainingMs, paid: access.paid || false } });
    if (!access.allowed) socket.emit('access-blocked');
  });

  socket.on('reconnect-session', ({ sessionId }, cb) => {
    const session = sessions.get(sessionId);
    if (!session) return cb({ ok: false });
    const room = rooms.get(session.roomId);
    if (!room) { sessions.delete(sessionId); return cb({ ok: false }); }
    const existing = room.players.find(p => p.name === session.playerName);
    if (existing) { existing.socket = socket; existing.disconnected = false; } else { room.players.push({ socket, name: session.playerName }); }
    socket.roomId = session.roomId; socket.playerName = session.playerName; socket.sessionId = sessionId;
    if (room.host === '__disconnected_' + session.playerName) room.host = socket.id;
    if (room.players[0]?.socket.id === socket.id) room.host = socket.id;
    const amHost = room.host === socket.id;

    // Restore to correct game state
    if ((room.gameState === 'playing' || room.gameState === 'voting' || room.gameState === 'results') && room.playerRoles?.[session.playerName]) {
      const role = room.playerRoles[session.playerName];
      cb({ ok: true, screen: 'game', roomCode: formatRoomId(session.roomId),
        gameData: { playerName: session.playerName, isImpostor: role.isImpostor, word: role.word, hint: role.hint },
        isHost: amHost });

      // If voting is active, re-send voting state
      if (room.gameState === 'voting' && room.votingPhase) {
        const playerNames = room.players.map(p => p.name);
        socket.emit('voting-started', {
          players: playerNames,
          votesNeeded: room.settings.impostorCount,
          myName: session.playerName,
        });
        // Send current progress
        socket.emit('voting-progress', {
          confirmed: room.votingPhase.confirmed.length,
          total: room.players.length,
        });
      }
    } else {
      cb({ ok: true, screen: 'lobby', roomCode: formatRoomId(session.roomId) });
      broadcastLobby(session.roomId);
    }
  });

  socket.on('create-room', async ({ playerName, password }, cb) => {
    if (!playerName || !password || password.length !== 4) return cb({ error: 'Nome e senha de 4 dígitos são obrigatórios.' });
    if (!(await checkAndEmitAccess(socket))) return cb({ error: 'Seu tempo gratuito acabou.' });
    const roomId = nextRoomId++;
    const sessionId = crypto.randomUUID();
    rooms.set(roomId, { id: roomId, password, host: socket.id, players: [{ socket, name: playerName }],
      settings: { impostorCount: 1, hintsEnabled: false }, gameState: 'lobby', currentWord: null, playerRoles: null });
    socket.roomId = roomId; socket.playerName = playerName; socket.sessionId = sessionId;
    sessions.set(sessionId, { roomId, playerName });
    if (socket.fingerprint) { await analytics.trackRoomCreated(socket.fingerprint); await analytics.trackName(socket.fingerprint, playerName); }
    cb({ roomId, roomCode: formatRoomId(roomId), sessionId });
    broadcastLobby(roomId);
  });

  socket.on('join-room', async ({ roomCode, playerName, password }, cb) => {
    const roomId = parseInt(roomCode, 10);
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'Sala não encontrada.' });
    if (room.password !== password) return cb({ error: 'Senha incorreta.' });
    if (!(await checkAndEmitAccess(socket))) return cb({ error: 'Seu tempo gratuito acabou.' });

    const isGameActive = room.gameState === 'playing' || room.gameState === 'voting' || room.gameState === 'results';
    const existingPlayer = room.players.find(p => p.name === playerName);

    // If game is in lobby, join directly
    if (!isGameActive) {
      if (existingPlayer) return cb({ error: 'Já existe um jogador com esse nome na sala.' });
      const sessionId = crypto.randomUUID();
      room.players.push({ socket, name: playerName });
      socket.roomId = roomId; socket.playerName = playerName; socket.sessionId = sessionId;
      sessions.set(sessionId, { roomId, playerName });
      if (socket.fingerprint) { await analytics.trackName(socket.fingerprint, playerName); }
      cb({ roomId, roomCode: formatRoomId(roomId), sessionId });
      broadcastLobby(roomId);
      return;
    }

    // Game is active — need host approval
    cb({ pending: true, message: 'Aguardando aprovação do host...' });

    // Find host socket (try by host id, then by first active player)
    let hostPlayer = room.players.find(p => p.socket.id === room.host && !p.disconnected);
    if (!hostPlayer) hostPlayer = room.players.find(p => !p.disconnected);
    if (!hostPlayer) return socket.emit('join-rejected', { reason: 'Host não disponível. Tente novamente.' });

    // Fix host reference if it was stale
    if (hostPlayer.socket.id !== room.host) {
      room.host = hostPlayer.socket.id;
    }

    // Build request info
    const isReconnect = !!existingPlayer;
    const requestId = crypto.randomUUID();

    // Store pending request
    if (!room.pendingJoinRequests) room.pendingJoinRequests = new Map();
    room.pendingJoinRequests.set(requestId, { socket, playerName, isReconnect });

    // Send to host
    hostPlayer.socket.emit('join-request', {
      requestId,
      playerName,
      isReconnect,
      message: isReconnect
        ? `${playerName} já estava na sala e está tentando voltar. Permitir reconexão?`
        : `${playerName} quer entrar na sala. O jogo já está em andamento. Permitir entrada?`,
    });
  });

  // Host approves/rejects join request
  socket.on('join-response', async ({ requestId, approved }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    // Allow response from current host or first player (in case host reference is stale)
    const isHostOrFirst = room.host === socket.id || room.players[0]?.socket.id === socket.id;
    if (!isHostOrFirst) return;
    if (!room.pendingJoinRequests) return;

    const request = room.pendingJoinRequests.get(requestId);
    if (!request) return;
    room.pendingJoinRequests.delete(requestId);

    if (!approved) {
      request.socket.emit('join-rejected', { reason: 'O host não aprovou sua entrada.' });
      return;
    }

    // Approved — add or reconnect player
    const { playerName, isReconnect } = request;

    if (isReconnect) {
      // Replace socket of existing player
      const existing = room.players.find(p => p.name === playerName);
      if (existing) {
        existing.socket = request.socket;
        existing.disconnected = false;
      }
    } else {
      // Add new player
      room.players.push({ socket: request.socket, name: playerName });
    }

    const sessionId = crypto.randomUUID();
    request.socket.roomId = room.id;
    request.socket.playerName = playerName;
    request.socket.sessionId = sessionId;
    sessions.set(sessionId, { roomId: room.id, playerName });

    if (request.socket.fingerprint) { await analytics.trackName(request.socket.fingerprint, playerName); }

    // Send room info to the joining player
    request.socket.emit('join-approved', { roomId: room.id, roomCode: formatRoomId(room.id), sessionId });

    // If game is active and player has roles, send game data
    if (room.playerRoles?.[playerName]) {
      const role = room.playerRoles[playerName];
      request.socket.emit('game-started', {
        playerName, isImpostor: role.isImpostor, word: role.word, hint: role.hint,
      });
    }
  });

  socket.on('update-settings', ({ impostorCount, hintsEnabled }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    const maxImpostors = Math.floor(room.players.length / 2) || 1;
    room.settings.impostorCount = Math.max(1, Math.min(maxImpostors, impostorCount));
    room.settings.hintsEnabled = hintsEnabled;
    broadcastLobby(socket.roomId);
  });

  socket.on('start-game', async () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id || room.players.length < 3) return;
    room.gameState = 'playing'; room.currentWord = await pickWord();
    const playerRoles = sendGameData(room);
    for (const p of room.players) {
      const role = playerRoles[p.name];
      if (p.socket.fingerprint) await analytics.trackGamePlayed(p.socket.fingerprint);
      if (!p.disconnected) {
        try { p.socket.emit('game-started', { playerName: p.name, isImpostor: role.isImpostor, word: role.word, hint: role.hint }); } catch (e) {}
      }
    }
  });

  socket.on('new-round', async () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    room.gameState = 'playing';
    room.currentWord = await pickWord();
    const playerRoles = sendGameData(room);
    for (const p of room.players) { if (!p.disconnected) { try { p.socket.emit('countdown-start'); } catch (e) {} } }
    room.pendingRound = playerRoles;
    setTimeout(async () => {
      if (!rooms.has(room.id)) return;
      for (const p of room.players) {
        const role = room.pendingRound?.[p.name];
        if (role) {
          if (p.socket.fingerprint) await analytics.trackGamePlayed(p.socket.fingerprint);
          p.socket.emit('game-started', { playerName: p.name, isImpostor: role.isImpostor, word: role.word, hint: role.hint });
        }
      }
      room.pendingRound = null;
    }, 3500);
  });

  // Voting
  socket.on('start-voting', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id || room.gameState !== 'playing') return;
    room.gameState = 'voting';
    room.votingPhase = { votes: {}, confirmed: [] };
    const playerNames = room.players.filter(p => !p.disconnected).map(p => p.name);
    for (const p of room.players) {
      if (!p.disconnected) {
        try { p.socket.emit('voting-started', { players: playerNames, votesNeeded: room.settings.impostorCount, myName: p.name }); } catch (e) {}
      }
    }
  });

  socket.on('cast-vote', ({ targets }, cb) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.gameState !== 'voting' || !room.votingPhase) return cb?.({ error: 'Votação não ativa.' });
    const playerName = socket.playerName;
    if (room.votingPhase.confirmed.includes(playerName)) return cb?.({ error: 'Você já votou.' });
    const votesNeeded = room.settings.impostorCount;
    if (!targets || targets.length !== votesNeeded) return cb?.({ error: `Selecione ${votesNeeded} jogador(es).` });
    if (targets.includes(playerName)) return cb?.({ error: 'Você não pode votar em si mesmo.' });
    const validNames = room.players.map(p => p.name);
    for (const t of targets) { if (!validNames.includes(t)) return cb?.({ error: 'Jogador inválido.' }); }
    room.votingPhase.votes[playerName] = targets;
    room.votingPhase.confirmed.push(playerName);
    cb?.({ ok: true });
    const activePlayers = room.players.filter(p => !p.disconnected);
    for (const p of activePlayers) p.socket.emit('voting-progress', { confirmed: room.votingPhase.confirmed.length, total: activePlayers.length });
    if (room.votingPhase.confirmed.length >= activePlayers.length) broadcastVotingResults(room);
  });

  socket.on('end-voting', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id || room.gameState !== 'voting') return;
    broadcastVotingResults(room);
  });

  socket.on('back-to-lobby', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    room.gameState = 'lobby'; room.currentWord = null; room.playerRoles = null;
    for (const p of room.players) p.socket.emit('go-to-lobby');
    broadcastLobby(socket.roomId);
  });

  socket.on('close-room', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.host !== socket.id) return;
    for (const p of room.players) { p.socket.emit('room-closed'); if (p.socket.sessionId) sessions.delete(p.socket.sessionId); p.socket.roomId = null; }
    rooms.delete(socket.roomId);
  });

  socket.on('leave-room', () => { handleLeave(socket); });

  socket.on('disconnect', async () => {
    if (socket.fingerprint) await analytics.trackDisconnect(socket.fingerprint);
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.host === socket.id) room.host = '__disconnected_' + socket.playerName;
    const playerName = socket.playerName;

    // During active game (playing/voting/results), keep player for 5 minutes
    // During lobby, keep for 2 minutes
    const isInGame = room.gameState === 'playing' || room.gameState === 'voting' || room.gameState === 'results';
    const graceMs = isInGame ? 300000 : 120000; // 5min in game, 2min in lobby

    setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r) return;
      const player = r.players.find(p => p.name === playerName);
      // Only remove if the socket is STILL the old disconnected one (not replaced by reconnect)
      if (player && player.socket.id === socket.id) {
        // In game, don't remove — just mark as disconnected
        if (r.gameState === 'playing' || r.gameState === 'voting' || r.gameState === 'results') {
          player.disconnected = true;
          return; // Keep in player list for game continuity
        }
        r.players = r.players.filter(p => p.name !== playerName);
        if (r.players.length === 0) { rooms.delete(roomId); }
        else {
          if (r.host === '__disconnected_' + playerName) r.host = r.players[0].socket.id;
          broadcastLobby(roomId);
        }
      }
      if (socket.sessionId) {
        const sess = sessions.get(socket.sessionId);
        if (sess && !r?.players.find(p => p.name === playerName)) sessions.delete(socket.sessionId);
      }
    }, graceMs);
  });
});

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.players = room.players.filter(p => p.socket.id !== socket.id);
  if (socket.sessionId) sessions.delete(socket.sessionId);
  socket.roomId = null;
  if (room.players.length === 0) { rooms.delete(roomId); return; }
  if (room.host === socket.id) room.host = room.players[0].socket.id;
  broadcastLobby(roomId);
}

// ── Start server with DB init ──
const PORT = process.env.PORT || 3000;

async function start() {
  await analytics.initDB();
  server.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
      }
    }
    console.log(`\n  IMPOSTOR Online rodando!\n`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Rede:    http://${localIp}:${PORT}`);
    console.log(`  Admin:   http://localhost:${PORT}/admin`);
    console.log(`  Login:   admin / admin1234 (padrão)\n`);
  });
}

start().catch(err => { console.error('Erro ao iniciar:', err); process.exit(1); });
