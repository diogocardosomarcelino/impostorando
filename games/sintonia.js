// games/sintonia.js
// Cooperative card game - players play numbered cards in ascending order without verbal communication
// Original design (not derived from any specific copyrighted game)

const crypto = require('crypto');

const GRACE_GAME = 300000;   // 5 min during active game
const GRACE_LOBBY = 120000;  // 2 min in lobby
const STAR_REQUEST_TIMEOUT = 30000; // 30s to confirm star
const ERROR_FLASH_DELAY = 2500; // ms to show error before continuing
const LEVEL_TRANSITION_DELAY = 2500; // ms between levels

// Setup tables (depend on player count)
function getSetup(numPlayers) {
  const setups = {
    2: { lives: 2, stars: 1, totalLevels: 12 },
    3: { lives: 3, stars: 1, totalLevels: 10 },
    4: { lives: 4, stars: 1, totalLevels: 8 },
  };
  return setups[numPlayers] || setups[4];
}

// Reward levels
function lifeBonusAtLevel(level) { return [3, 6, 9].includes(level); }
function starBonusAtLevel(level) { return [2, 5, 8].includes(level); }

// Fisher-Yates shuffle with crypto random
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function init(io, analytics) {
  const ns = io.of('/sintonia');

  const rooms = new Map();      // roomId -> room object
  const sessions = new Map();   // sessionId -> { roomId, playerName }
  let nextRoomId = 1;

  function formatRoomId(id) { return String(id).padStart(4, '0'); }

  function broadcastLobby(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const playerNames = room.players.map(p => p.name);
    for (const p of room.players) {
      if (p.disconnected) continue;
      try {
        p.socket.emit('lobby-update', {
          players: playerNames,
          isHost: p.socket.id === room.host,
          roomCode: formatRoomId(roomId),
        });
      } catch (e) {}
    }
  }

  function broadcastState(room) {
    // Public state visible to everyone (no card hands)
    const handCounts = {};
    for (const name of Object.keys(room.hands || {})) {
      handCounts[name] = room.hands[name].length;
    }
    const publicState = {
      gameState: room.gameState,
      level: room.level,
      totalLevels: room.totalLevels,
      lives: room.lives,
      stars: room.stars,
      pile: room.pile,
      handCounts,
      players: room.players.map(p => ({ name: p.name, disconnected: !!p.disconnected })),
      starRequest: room.starRequest ? {
        from: room.starRequest.from,
        confirmed: [...room.starRequest.confirmed],
        rejected: [...room.starRequest.rejected],
        total: room.players.filter(p => !p.disconnected).length,
      } : null,
    };

    for (const p of room.players) {
      if (p.disconnected) continue;
      try {
        // Add per-player private hand
        p.socket.emit('state', {
          ...publicState,
          myHand: (room.hands && room.hands[p.name]) ? [...room.hands[p.name]].sort((a, b) => a - b) : [],
          myName: p.name,
        });
      } catch (e) {}
    }
  }

  function dealLevel(room) {
    // Build deck of 1..100, shuffle, take cards for each player
    const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
    room.hands = {};
    let idx = 0;
    for (const p of room.players) {
      room.hands[p.name] = deck.slice(idx, idx + room.level);
      idx += room.level;
    }
    room.pile = [];
    room.starRequest = null;
  }

  function checkLevelComplete(room) {
    return Object.values(room.hands || {}).every(h => h.length === 0);
  }

  function endGame(room, result) {
    room.gameState = result === 'win' ? 'won' : 'lost';

    // Track in analytics
    try {
      analytics.trackSintoniaSession({
        roomId: room.id,
        numPlayers: room.players.length,
        result,
        levelReached: room.level,
        totalLevels: room.totalLevels,
      }).catch(() => {});
    } catch (e) {}

    for (const p of room.players) {
      if (p.disconnected) continue;
      try {
        p.socket.emit('game-over', {
          result,
          levelReached: room.level,
          totalLevels: room.totalLevels,
        });
      } catch (e) {}
    }
  }

  function advanceLevel(room) {
    // Award bonuses
    let livesGained = 0;
    let starsGained = 0;
    if (lifeBonusAtLevel(room.level)) {
      const maxLives = room.players.length + 2;
      if (room.lives < maxLives) { room.lives++; livesGained = 1; }
    }
    if (starBonusAtLevel(room.level)) {
      room.stars++;
      starsGained = 1;
    }

    const completedLevel = room.level;

    // Check if last level
    if (room.level >= room.totalLevels) {
      // Tell clients level was completed first
      for (const p of room.players) {
        if (p.disconnected) continue;
        try {
          p.socket.emit('level-complete', {
            level: completedLevel,
            livesGained,
            starsGained,
            isLastLevel: true,
          });
        } catch (e) {}
      }
      setTimeout(() => endGame(room, 'win'), LEVEL_TRANSITION_DELAY);
      return;
    }

    // Show level-complete transition, then start next level
    for (const p of room.players) {
      if (p.disconnected) continue;
      try {
        p.socket.emit('level-complete', {
          level: completedLevel,
          livesGained,
          starsGained,
          isLastLevel: false,
        });
      } catch (e) {}
    }

    setTimeout(() => {
      if (!rooms.has(room.id)) return;
      room.level++;
      dealLevel(room);
      for (const p of room.players) {
        if (p.disconnected) continue;
        try {
          p.socket.emit('level-started', { level: room.level });
        } catch (e) {}
      }
      broadcastState(room);
    }, LEVEL_TRANSITION_DELAY);
  }

  function findHostPlayer(room) {
    let h = room.players.find(p => p.socket.id === room.host && !p.disconnected);
    if (!h) h = room.players.find(p => !p.disconnected);
    return h;
  }

  // ── Connection ──
  ns.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    socket.on('register', async ({ fingerprint, meta }, cb) => {
      if (!fingerprint) return cb?.({ ok: false });
      socket.fingerprint = fingerprint;
      try { await analytics.trackVisit(fingerprint, ip, meta || {}); } catch (e) {}

      // Geo (non-blocking)
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
      if (existing) { existing.socket = socket; existing.disconnected = false; }
      else { room.players.push({ socket, name: session.playerName }); }
      socket.roomId = session.roomId;
      socket.playerName = session.playerName;
      socket.sessionId = sessionId;

      if (room.host === '__disconnected_' + session.playerName) room.host = socket.id;
      if (room.players[0]?.socket.id === socket.id) room.host = socket.id;

      const screen = room.gameState === 'lobby' ? 'lobby'
                   : room.gameState === 'won' || room.gameState === 'lost' ? 'game-over'
                   : 'game';
      cb({ ok: true, screen, roomCode: formatRoomId(session.roomId) });

      if (screen === 'lobby') broadcastLobby(session.roomId);
      else broadcastState(room);
    });

    // ── Create room ──
    socket.on('create-room', async ({ playerName, password }, cb) => {
      if (!playerName || !password || password.length !== 4) return cb({ error: 'Nome e senha de 4 dígitos são obrigatórios.' });
      if (socket.fingerprint) {
        const access = await analytics.checkAccess(socket.fingerprint, ip);
        if (!access.allowed) { socket.emit('access-blocked'); return cb({ error: 'Seu tempo gratuito acabou.' }); }
      }
      const roomId = nextRoomId++;
      const sessionId = crypto.randomUUID();
      rooms.set(roomId, {
        id: roomId,
        password,
        host: socket.id,
        players: [{ socket, name: playerName }],
        gameState: 'lobby',
        level: 0,
        totalLevels: 0,
        lives: 0,
        stars: 0,
        pile: [],
        hands: {},
        starRequest: null,
      });
      socket.roomId = roomId;
      socket.playerName = playerName;
      socket.sessionId = sessionId;
      sessions.set(sessionId, { roomId, playerName });

      if (socket.fingerprint) {
        try { await analytics.trackRoomCreated(socket.fingerprint); } catch (e) {}
        try { await analytics.trackName(socket.fingerprint, playerName); } catch (e) {}
      }

      cb({ roomId, roomCode: formatRoomId(roomId), sessionId });
      broadcastLobby(roomId);
    });

    socket.on('join-room', async ({ roomCode, playerName, password }, cb) => {
      const roomId = parseInt(roomCode, 10);
      const room = rooms.get(roomId);
      if (!room) return cb({ error: 'Sala não encontrada.' });
      if (room.password !== password) return cb({ error: 'Senha incorreta.' });
      if (socket.fingerprint) {
        const access = await analytics.checkAccess(socket.fingerprint, ip);
        if (!access.allowed) { socket.emit('access-blocked'); return cb({ error: 'Seu tempo gratuito acabou.' }); }
      }

      const isGameActive = room.gameState !== 'lobby';
      const existing = room.players.find(p => p.name === playerName);

      if (!isGameActive) {
        if (existing) return cb({ error: 'Já existe um jogador com esse nome na sala.' });
        if (room.players.length >= 4) return cb({ error: 'Sala cheia (máx 4 jogadores).' });
        const sessionId = crypto.randomUUID();
        room.players.push({ socket, name: playerName });
        socket.roomId = roomId;
        socket.playerName = playerName;
        socket.sessionId = sessionId;
        sessions.set(sessionId, { roomId, playerName });
        if (socket.fingerprint) { try { await analytics.trackName(socket.fingerprint, playerName); } catch (e) {} }
        cb({ roomId, roomCode: formatRoomId(roomId), sessionId });
        broadcastLobby(roomId);
        return;
      }

      // Game active — request host approval
      cb({ pending: true, message: 'Aguardando aprovação do host...' });

      const hostPlayer = findHostPlayer(room);
      if (!hostPlayer) return socket.emit('join-rejected', { reason: 'Host não disponível.' });
      if (hostPlayer.socket.id !== room.host) room.host = hostPlayer.socket.id;

      const requestId = crypto.randomUUID();
      const isReconnect = !!existing;
      if (!room.pendingJoinRequests) room.pendingJoinRequests = new Map();
      room.pendingJoinRequests.set(requestId, { socket, playerName, isReconnect });

      try {
        hostPlayer.socket.emit('join-request', {
          requestId,
          playerName,
          isReconnect,
          message: isReconnect
            ? `${playerName} já estava na sala e está tentando voltar. Permitir reconexão?`
            : `${playerName} quer entrar. O jogo já está em andamento. Permitir entrada?`,
        });
      } catch (e) {}
    });

    socket.on('join-response', async ({ requestId, approved }) => {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      const isHostOrFirst = room.host === socket.id || room.players[0]?.socket.id === socket.id;
      if (!isHostOrFirst) return;
      if (!room.pendingJoinRequests) return;
      const request = room.pendingJoinRequests.get(requestId);
      if (!request) return;
      room.pendingJoinRequests.delete(requestId);

      if (!approved) {
        try { request.socket.emit('join-rejected', { reason: 'O host não aprovou sua entrada.' }); } catch (e) {}
        return;
      }

      const { playerName, isReconnect } = request;
      if (isReconnect) {
        const existing = room.players.find(p => p.name === playerName);
        if (existing) { existing.socket = request.socket; existing.disconnected = false; }
      } else {
        room.players.push({ socket: request.socket, name: playerName });
      }
      const sessionId = crypto.randomUUID();
      request.socket.roomId = room.id;
      request.socket.playerName = playerName;
      request.socket.sessionId = sessionId;
      sessions.set(sessionId, { roomId: room.id, playerName });
      if (request.socket.fingerprint) { try { await analytics.trackName(request.socket.fingerprint, playerName); } catch (e) {} }

      try {
        request.socket.emit('join-approved', {
          roomId: room.id,
          roomCode: formatRoomId(room.id),
          sessionId,
        });
      } catch (e) {}
      // Send current state
      broadcastState(room);
    });

    // ── Start game ──
    socket.on('start-game', async () => {
      const room = rooms.get(socket.roomId);
      if (!room || room.host !== socket.id) return;
      if (room.players.length < 2) return;
      if (room.players.length > 4) return;

      const setup = getSetup(room.players.length);
      room.gameState = 'playing';
      room.level = 1;
      room.totalLevels = setup.totalLevels;
      room.lives = setup.lives;
      room.stars = setup.stars;
      dealLevel(room);

      for (const p of room.players) {
        if (p.disconnected) continue;
        if (p.socket.fingerprint) { try { await analytics.trackGamePlayed(p.socket.fingerprint); } catch (e) {} }
        try { p.socket.emit('game-started', { level: 1, totalLevels: room.totalLevels }); } catch (e) {}
      }
      broadcastState(room);
    });

    // ── Play card ──
    socket.on('play-card', () => {
      const room = rooms.get(socket.roomId);
      if (!room || room.gameState !== 'playing') return;
      const playerName = socket.playerName;
      if (!playerName) return;
      const hand = room.hands[playerName];
      if (!hand || hand.length === 0) return;

      // Find the player's lowest card (auto-play lowest)
      const sorted = [...hand].sort((a, b) => a - b);
      const playedCard = sorted[0];

      // Check if there's any card in any other hand smaller than this one
      const lowerCards = []; // [{ name, cards: [n,n] }]
      let isError = false;
      for (const otherName of Object.keys(room.hands)) {
        if (otherName === playerName) continue;
        const otherHand = room.hands[otherName];
        const lowers = otherHand.filter(c => c < playedCard);
        if (lowers.length > 0) {
          isError = true;
          lowerCards.push({ name: otherName, cards: lowers.sort((a, b) => a - b) });
        }
      }

      // Remove the played card from the player's hand
      const idx = hand.indexOf(playedCard);
      if (idx !== -1) hand.splice(idx, 1);

      if (isError) {
        // Lose 1 life and discard all lower cards
        room.lives--;
        // Discard lowers from all hands
        for (const item of lowerCards) {
          const otherHand = room.hands[item.name];
          for (const c of item.cards) {
            const ix = otherHand.indexOf(c);
            if (ix !== -1) otherHand.splice(ix, 1);
          }
        }
        // Add played card to pile (it stays played)
        room.pile.push({ card: playedCard, by: playerName, error: true });

        // Broadcast error event with details
        for (const p of room.players) {
          if (p.disconnected) continue;
          try {
            p.socket.emit('error-flash', {
              playedBy: playerName,
              playedCard,
              lowerCards, // [{ name, cards }]
            });
          } catch (e) {}
        }

        if (room.lives <= 0) {
          // Game over
          setTimeout(() => endGame(room, 'lost'), ERROR_FLASH_DELAY);
          return;
        }

        setTimeout(() => {
          if (!rooms.has(room.id)) return;
          if (checkLevelComplete(room)) {
            advanceLevel(room);
          } else {
            broadcastState(room);
          }
        }, ERROR_FLASH_DELAY);
        return;
      }

      // Successful play
      room.pile.push({ card: playedCard, by: playerName, error: false });
      for (const p of room.players) {
        if (p.disconnected) continue;
        try {
          p.socket.emit('card-played', { card: playedCard, by: playerName });
        } catch (e) {}
      }

      if (checkLevelComplete(room)) {
        // Brief delay before advancing
        broadcastState(room);
        setTimeout(() => {
          if (!rooms.has(room.id)) return;
          advanceLevel(room);
        }, 800);
        return;
      }

      broadcastState(room);
    });

    // ── Star request ──
    socket.on('request-star', () => {
      const room = rooms.get(socket.roomId);
      if (!room || room.gameState !== 'playing') return;
      if (room.starRequest) return; // already pending
      if (room.stars <= 0) return;
      const playerName = socket.playerName;
      if (!playerName) return;
      // Check if requester has cards to discard
      if (!room.hands[playerName] || room.hands[playerName].length === 0) return;

      const activePlayers = room.players.filter(p => !p.disconnected);
      const confirmed = new Set([playerName]); // requester auto-confirms
      const rejected = new Set();

      const timeoutId = setTimeout(() => {
        if (!rooms.has(room.id) || !room.starRequest) return;
        // Cancel
        room.starRequest = null;
        for (const p of room.players) {
          if (p.disconnected) continue;
          try { p.socket.emit('star-cancelled', { reason: 'Tempo esgotado.' }); } catch (e) {}
        }
        broadcastState(room);
      }, STAR_REQUEST_TIMEOUT);

      room.starRequest = { from: playerName, confirmed, rejected, timeoutId };

      for (const p of room.players) {
        if (p.disconnected) continue;
        try {
          p.socket.emit('star-requested', {
            from: playerName,
            myConfirmed: p.name === playerName,
          });
        } catch (e) {}
      }

      // Auto-resolve if 1 player only (shouldn't happen, but safety)
      maybeResolveStar(room);
      broadcastState(room);
    });

    socket.on('confirm-star', () => {
      const room = rooms.get(socket.roomId);
      if (!room || !room.starRequest) return;
      const playerName = socket.playerName;
      if (!playerName) return;
      room.starRequest.confirmed.add(playerName);
      room.starRequest.rejected.delete(playerName);
      maybeResolveStar(room);
      broadcastState(room);
    });

    socket.on('reject-star', () => {
      const room = rooms.get(socket.roomId);
      if (!room || !room.starRequest) return;
      const playerName = socket.playerName;
      if (!playerName) return;
      room.starRequest.rejected.add(playerName);
      // Cancel
      clearTimeout(room.starRequest.timeoutId);
      room.starRequest = null;
      for (const p of room.players) {
        if (p.disconnected) continue;
        try { p.socket.emit('star-cancelled', { reason: `${playerName} recusou.` }); } catch (e) {}
      }
      broadcastState(room);
    });

    function maybeResolveStar(room) {
      if (!room.starRequest) return;
      const activePlayers = room.players.filter(p => !p.disconnected);
      // All active players must confirm (requester counts)
      const allConfirmed = activePlayers.every(p => room.starRequest.confirmed.has(p.name));
      if (!allConfirmed) return;

      clearTimeout(room.starRequest.timeoutId);

      // Discard each player's lowest card
      const discarded = []; // [{ name, card }]
      for (const p of room.players) {
        const hand = room.hands[p.name];
        if (!hand || hand.length === 0) continue;
        const sorted = [...hand].sort((a, b) => a - b);
        const card = sorted[0];
        const idx = hand.indexOf(card);
        if (idx !== -1) hand.splice(idx, 1);
        discarded.push({ name: p.name, card });
      }

      room.stars--;
      room.starRequest = null;

      // Broadcast star-used event with revealed cards
      for (const p of room.players) {
        if (p.disconnected) continue;
        try { p.socket.emit('star-used', { discarded }); } catch (e) {}
      }

      setTimeout(() => {
        if (!rooms.has(room.id)) return;
        if (checkLevelComplete(room)) {
          advanceLevel(room);
        } else {
          broadcastState(room);
        }
      }, ERROR_FLASH_DELAY);
    }

    // ── Lobby controls ──
    socket.on('back-to-lobby', () => {
      const room = rooms.get(socket.roomId);
      if (!room || room.host !== socket.id) return;
      room.gameState = 'lobby';
      room.level = 0;
      room.lives = 0;
      room.stars = 0;
      room.pile = [];
      room.hands = {};
      room.starRequest = null;
      for (const p of room.players) {
        if (p.disconnected) continue;
        try { p.socket.emit('go-to-lobby'); } catch (e) {}
      }
      broadcastLobby(room.id);
    });

    socket.on('close-room', () => {
      const room = rooms.get(socket.roomId);
      if (!room || room.host !== socket.id) return;
      for (const p of room.players) {
        try { p.socket.emit('room-closed'); } catch (e) {}
        if (p.socket.sessionId) sessions.delete(p.socket.sessionId);
        p.socket.roomId = null;
      }
      rooms.delete(room.id);
    });

    socket.on('leave-room', () => {
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
    });

    socket.on('disconnect', async () => {
      if (socket.fingerprint) { try { await analytics.trackDisconnect(socket.fingerprint); } catch (e) {} }
      const roomId = socket.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.host === socket.id) room.host = '__disconnected_' + socket.playerName;
      const playerName = socket.playerName;
      const isInGame = room.gameState !== 'lobby';
      const graceMs = isInGame ? GRACE_GAME : GRACE_LOBBY;

      setTimeout(() => {
        const r = rooms.get(roomId);
        if (!r) return;
        const player = r.players.find(p => p.name === playerName);
        if (player && player.socket.id === socket.id) {
          if (r.gameState !== 'lobby') {
            player.disconnected = true;
            return;
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

  return { ns, rooms, sessions };
}

module.exports = { init };
