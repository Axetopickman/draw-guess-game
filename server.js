const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const DRAW_SECONDS = 90;
const DISCUSS_SECONDS = 60;
const RESULT_SECONDS = 4;

app.use(express.static(path.join(__dirname, 'public')));

const WORDS = [
  { word: '德玛西亚', hint: '4字口号' },
  { word: '我不做人类了', hint: '6字台词' },
  { word: '狂风绝息斩', hint: '5字技能' },
  { word: '无可匹敌的力量', hint: '7字台词' },
  { word: '我的刀盾', hint: '4字网络梗' },
  { word: '一库', hint: '2字台词' },
  { word: '你跑不过我你信吗', hint: '8字网络梗' },
  { word: '高原血统', hint: '4字技能' },
  { word: '这是说谎的味道', hint: '7字台词' },
  { word: '作者恐怖大鸡鸡', hint: '7字器官' },
  { word: '红温', hint: '2字网络梗' },
  { word: '原神启动', hint: '4字网络梗' },
  { word: '战斗爽', hint: '3字游戏台词' },
  { word: 'man', hint: '3字网络梗' }
];

const rooms = new Map();
const socketToRoom = new Map();

function makeRoom(code) {
  return {
    code,
    phase: 'lobby',
    players: new Map(),
    hostId: null,
    rounds: 0,
    gameOrder: [],
    turnIndex: 0,
    totalTurns: 0,
    usedWords: [],
    current: null,
    canvasHistory: [],
    chatHistory: [],
    timer: null,
    timerEndAt: null,
    resultText: ''
  };
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 12) || '无名玩家';
}

function sanitizeRoomCode(roomCode) {
  return String(roomCode || '')
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]/g, '')
    .trim()
    .slice(0, 12) || '8888';
}

function normalizeAnswer(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function getPlayerList(room) {
  return Array.from(room.players.values()).sort((a, b) => a.slot - b.slot);
}

function getSlots(room) {
  const slots = Array(MAX_PLAYERS).fill(null);
  for (const player of room.players.values()) {
    slots[player.slot] = publicPlayer(player, room.hostId);
  }
  return slots;
}

function publicPlayer(player, hostId) {
  return {
    id: player.id,
    name: player.name,
    slot: player.slot,
    score: player.score,
    ready: player.ready,
    isHost: player.id === hostId,
    connected: player.connected
  };
}

function addChat(room, type, name, text) {
  room.chatHistory.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    name: name || '',
    text: String(text || '').slice(0, 120),
    time: Date.now()
  });
  if (room.chatHistory.length > 80) room.chatHistory.shift();
}

function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function setRoomTimer(room, ms, fn) {
  clearRoomTimer(room);
  room.timerEndAt = Date.now() + ms;
  room.timer = setTimeout(() => {
    const freshRoom = rooms.get(room.code);
    if (freshRoom) fn(freshRoom);
  }, ms);
}

function buildStateFor(room, viewerId) {
  const viewer = room.players.get(viewerId);
  const isDrawer = !!(room.current && room.current.drawerId === viewerId);
  const playerCount = room.players.size;
  const maxRounds = Math.max(1, Math.floor(WORDS.length / Math.max(1, playerCount)));

  return {
    me: viewer ? publicPlayer(viewer, room.hostId) : null,
    roomCode: room.code,
    phase: room.phase,
    hostId: room.hostId,
    slots: getSlots(room),
    players: getPlayerList(room).map(p => publicPlayer(p, room.hostId)),
    allReady: room.players.size >= 2 && getPlayerList(room).every(p => p.ready),
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    rounds: room.rounds,
    maxRounds,
    totalTurns: room.totalTurns,
    turnIndex: room.turnIndex,
    timerEndAt: room.timerEndAt,
    resultText: room.resultText,
    chatHistory: room.chatHistory,
    current: room.current ? {
      drawerId: room.current.drawerId,
      drawerName: room.players.get(room.current.drawerId)?.name || '离线玩家',
      hint: room.current.wordItem.hint,
      word: isDrawer || room.current.revealed ? room.current.wordItem.word : '',
      revealed: room.current.revealed,
      isDrawer,
      canDraw: isDrawer && room.phase === 'drawing' && !room.current.revealed,
      canChat: !(isDrawer && room.phase === 'drawing'),
      cycle: Math.floor(room.turnIndex / Math.max(1, room.gameOrder.length)) + 1,
      turnInCycle: (room.turnIndex % Math.max(1, room.gameOrder.length)) + 1
    } : null,
    finalRanking: room.phase === 'gameOver'
      ? getPlayerList(room).map(p => publicPlayer(p, room.hostId)).sort((a, b) => b.score - a.score)
      : []
  };
}

function broadcastState(room) {
  for (const player of room.players.values()) {
    io.to(player.id).emit('game:state', buildStateFor(room, player.id));
  }
}

function broadcastCanvasHistory(room) {
  io.to(room.code).emit('draw:history', room.canvasHistory);
}

function nextFreeSlot(room) {
  const used = new Set(Array.from(room.players.values()).map(p => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i += 1) {
    if (!used.has(i)) return i;
  }
  return -1;
}

function pickUnusedWord(room) {
  const used = new Set(room.usedWords);
  const available = WORDS.filter(item => !used.has(item.word));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function startNextTurn(room) {
  clearRoomTimer(room);
  room.resultText = '';
  room.canvasHistory = [];

  if (room.turnIndex >= room.totalTurns) {
    room.phase = 'gameOver';
    room.current = null;
    room.timerEndAt = null;
    addChat(room, 'system', '', '游戏结束！');
    broadcastState(room);
    broadcastCanvasHistory(room);
    return;
  }

  if (room.players.size < 2) {
    room.phase = 'gameOver';
    room.current = null;
    addChat(room, 'system', '', '玩家不足，游戏提前结束。');
    broadcastState(room);
    return;
  }

  let guard = 0;
  let drawerId = room.gameOrder[room.turnIndex % room.gameOrder.length];
  while (!room.players.has(drawerId) && guard < room.gameOrder.length) {
    room.turnIndex += 1;
    drawerId = room.gameOrder[room.turnIndex % room.gameOrder.length];
    guard += 1;
  }

  const wordItem = pickUnusedWord(room);
  if (!wordItem) {
    room.phase = 'gameOver';
    room.current = null;
    addChat(room, 'system', '', '词条已经用完，游戏结束。');
    broadcastState(room);
    return;
  }

  room.usedWords.push(wordItem.word);
  room.phase = 'drawing';
  room.current = {
    drawerId,
    wordItem,
    revealed: false,
    startedAt: Date.now()
  };

  const drawerName = room.players.get(drawerId)?.name || '玩家';
  addChat(room, 'system', '', `第 ${room.turnIndex + 1}/${room.totalTurns} 次作画开始：${drawerName} 正在画。`);
  broadcastState(room);
  broadcastCanvasHistory(room);

  setRoomTimer(room, DRAW_SECONDS * 1000, endDrawingTime);
}

function endDrawingTime(room) {
  if (room.phase !== 'drawing' || !room.current) return;
  room.phase = 'discussion';
  room.current.revealed = true;
  room.resultText = `时间到！词条是：${room.current.wordItem.word}`;
  addChat(room, 'system', '', `时间到！词条是：${room.current.wordItem.word}。现在有 1 分钟讨论时间。`);
  broadcastState(room);

  setRoomTimer(room, DISCUSS_SECONDS * 1000, finishTurn);
}

function finishTurn(room) {
  room.turnIndex += 1;
  startNextTurn(room);
}

function handleCorrectGuess(room, guesser) {
  if (room.phase !== 'drawing' || !room.current || room.current.revealed) return;
  const drawer = room.players.get(room.current.drawerId);
  guesser.score += 2;
  if (drawer) drawer.score += 1;
  room.phase = 'result';
  room.current.revealed = true;
  room.resultText = `猜者${guesser.name}答对！！！词条：${room.current.wordItem.word}`;
  addChat(room, 'system', '', room.resultText);
  broadcastState(room);

  setRoomTimer(room, RESULT_SECONDS * 1000, finishTurn);
}

function resetRoomToLobby(room) {
  clearRoomTimer(room);
  room.phase = 'lobby';
  room.rounds = 0;
  room.gameOrder = [];
  room.turnIndex = 0;
  room.totalTurns = 0;
  room.usedWords = [];
  room.current = null;
  room.canvasHistory = [];
  room.timerEndAt = null;
  room.resultText = '';
  for (const player of room.players.values()) player.ready = false;
  addChat(room, 'system', '', '房间已回到准备大厅。');
  broadcastState(room);
  broadcastCanvasHistory(room);
}

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomCode, name }, reply) => {
    const cleanName = sanitizeName(name);
    const cleanCode = sanitizeRoomCode(roomCode);
    let room = rooms.get(cleanCode);
    if (!room) {
      room = makeRoom(cleanCode);
      rooms.set(cleanCode, room);
    }

    if (room.phase !== 'lobby') {
      reply?.({ ok: false, message: '这个房间已经开始游戏了，请换一个房间号。' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      reply?.({ ok: false, message: '这个房间已经满 6 人了。' });
      return;
    }

    const slot = nextFreeSlot(room);
    const player = {
      id: socket.id,
      name: cleanName,
      slot,
      score: 0,
      ready: false,
      connected: true
    };

    room.players.set(socket.id, player);
    socketToRoom.set(socket.id, cleanCode);
    socket.join(cleanCode);
    if (!room.hostId) room.hostId = socket.id;
    addChat(room, 'system', '', `${cleanName} 加入了房间。`);
    reply?.({ ok: true, roomCode: cleanCode });
    broadcastState(room);
  });

  socket.on('player:toggleReady', (reply) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.phase !== 'lobby') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.ready = !player.ready;
    reply?.({ ok: true, ready: player.ready });
    broadcastState(room);
  });

  socket.on('host:openRoundSetup', (reply) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.phase !== 'lobby') return;
    if (socket.id !== room.hostId) {
      reply?.({ ok: false, message: '只有房主可以进入轮数设置。' });
      return;
    }
    const players = getPlayerList(room);
    if (players.length < 2) {
      reply?.({ ok: false, message: '至少需要 2 名玩家才能开始。' });
      return;
    }
    if (!players.every(p => p.ready)) {
      reply?.({ ok: false, message: '所有玩家都必须是“已就绪”状态。' });
      return;
    }
    room.phase = 'roundSetup';
    addChat(room, 'system', '', '所有玩家已就绪，房主正在设置轮数。');
    reply?.({ ok: true });
    broadcastState(room);
  });

  socket.on('host:startGame', ({ rounds }, reply) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.phase !== 'roundSetup') return;
    if (socket.id !== room.hostId) {
      reply?.({ ok: false, message: '只有房主可以设置轮数。' });
      return;
    }
    const roundCount = Math.max(1, Math.floor(Number(rounds || 1)));
    const players = getPlayerList(room);
    const maxRounds = Math.floor(WORDS.length / Math.max(1, players.length));
    if (roundCount > maxRounds) {
      reply?.({ ok: false, message: `词条不重复使用，当前人数最多只能玩 ${maxRounds} 轮。` });
      return;
    }

    room.rounds = roundCount;
    room.gameOrder = players.map(p => p.id);
    room.turnIndex = 0;
    room.totalTurns = roundCount * players.length;
    room.usedWords = [];
    room.canvasHistory = [];
    room.chatHistory = [];
    for (const player of room.players.values()) {
      player.score = 0;
      player.ready = false;
    }
    reply?.({ ok: true });
    startNextTurn(room);
  });

  socket.on('chat:send', ({ text }, reply) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || !room.players.has(socket.id)) return;
    const player = room.players.get(socket.id);
    const cleanText = String(text || '').trim().slice(0, 80);
    if (!cleanText) return;

    const isDrawer = room.current && room.current.drawerId === socket.id;
    if (isDrawer && room.phase === 'drawing') {
      reply?.({ ok: false, message: '画者绘画时不能在聊天框打字。' });
      return;
    }

    if (room.phase === 'drawing' && room.current && !isDrawer) {
      const answer = room.current.wordItem.word;
      if (normalizeAnswer(cleanText) === normalizeAnswer(answer)) {
        handleCorrectGuess(room, player);
        reply?.({ ok: true, correct: true });
        return;
      }
    }

    addChat(room, 'player', player.name, cleanText);
    reply?.({ ok: true });
    broadcastState(room);
  });

  socket.on('draw:segment', (segment) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.phase !== 'drawing' || !room.current) return;
    if (room.current.drawerId !== socket.id || room.current.revealed) return;

    const cleanSegment = {
      strokeId: String(segment.strokeId || `${socket.id}-${Date.now()}`).slice(0, 80),
      playerId: socket.id,
      color: String(segment.color || '#111111').slice(0, 20),
      size: Math.max(1, Math.min(60, Number(segment.size || 4))),
      tool: segment.tool === 'eraser' ? 'eraser' : 'pen',
      from: {
        x: Math.max(0, Math.min(1, Number(segment.from?.x || 0))),
        y: Math.max(0, Math.min(1, Number(segment.from?.y || 0)))
      },
      to: {
        x: Math.max(0, Math.min(1, Number(segment.to?.x || 0))),
        y: Math.max(0, Math.min(1, Number(segment.to?.y || 0)))
      }
    };

    let stroke = room.canvasHistory.find(s => s.strokeId === cleanSegment.strokeId);
    if (!stroke) {
      stroke = {
        strokeId: cleanSegment.strokeId,
        playerId: socket.id,
        color: cleanSegment.color,
        size: cleanSegment.size,
        tool: cleanSegment.tool,
        segments: []
      };
      room.canvasHistory.push(stroke);
    }
    stroke.segments.push(cleanSegment);
    socket.to(room.code).emit('draw:segment', cleanSegment);
  });

  socket.on('draw:undo', () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.phase !== 'drawing' || !room.current) return;
    if (room.current.drawerId !== socket.id || room.current.revealed) return;
    for (let i = room.canvasHistory.length - 1; i >= 0; i -= 1) {
      if (room.canvasHistory[i].playerId === socket.id) {
        room.canvasHistory.splice(i, 1);
        break;
      }
    }
    broadcastCanvasHistory(room);
  });

  socket.on('host:backToLobby', () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || socket.id !== room.hostId) return;
    resetRoomToLobby(room);
  });

  socket.on('disconnect', () => {
    const roomCode = socketToRoom.get(socket.id);
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) addChat(room, 'system', '', `${player.name} 离开了房间。`);
    room.players.delete(socket.id);
    socketToRoom.delete(socket.id);

    if (room.hostId === socket.id) {
      const nextHost = getPlayerList(room)[0];
      room.hostId = nextHost ? nextHost.id : null;
      if (nextHost) addChat(room, 'system', '', `${nextHost.name} 成为了新的房主。`);
    }

    if (room.players.size === 0) {
      clearRoomTimer(room);
      rooms.delete(roomCode);
      return;
    }

    if (room.phase !== 'lobby' && room.players.size < 2) {
      room.phase = 'gameOver';
      room.current = null;
      clearRoomTimer(room);
      addChat(room, 'system', '', '玩家不足，游戏结束。');
    }
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`你画我猜服务器已启动：http://localhost:${PORT}`);
});
