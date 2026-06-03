const socket = io();

const pages = {
  home: document.getElementById('homePage'),
  name: document.getElementById('namePage'),
  room: document.getElementById('roomPage'),
  lobby: document.getElementById('lobbyPage'),
  round: document.getElementById('roundPage'),
  game: document.getElementById('gamePage'),
  over: document.getElementById('overPage')
};

const els = {
  toast: document.getElementById('toast'),
  modeBtn: document.getElementById('modeBtn'),
  nameInput: document.getElementById('nameInput'),
  nameConfirmBtn: document.getElementById('nameConfirmBtn'),
  roomInput: document.getElementById('roomInput'),
  joinRoomBtn: document.getElementById('joinRoomBtn'),
  backNameBtn: document.getElementById('backNameBtn'),
  lobbyRoomCode: document.getElementById('lobbyRoomCode'),
  lobbyTip: document.getElementById('lobbyTip'),
  copyRoomBtn: document.getElementById('copyRoomBtn'),
  lobbySlots: document.getElementById('lobbySlots'),
  toggleReadyBtn: document.getElementById('toggleReadyBtn'),
  hostRoundSetupBtn: document.getElementById('hostRoundSetupBtn'),
  hostStartTip: document.getElementById('hostStartTip'),
  roundHelp: document.getElementById('roundHelp'),
  roundInput: document.getElementById('roundInput'),
  startGameBtn: document.getElementById('startGameBtn'),
  roundWaitText: document.getElementById('roundWaitText'),
  phaseText: document.getElementById('phaseText'),
  timerText: document.getElementById('timerText'),
  wordBox: document.getElementById('wordBox'),
  colorPalette: document.getElementById('colorPalette'),
  brushSize: document.getElementById('brushSize'),
  penBtn: document.getElementById('penBtn'),
  eraserBtn: document.getElementById('eraserBtn'),
  undoBtn: document.getElementById('undoBtn'),
  drawCanvas: document.getElementById('drawCanvas'),
  canvasLock: document.getElementById('canvasLock'),
  resultOverlay: document.getElementById('resultOverlay'),
  chatMessages: document.getElementById('chatMessages'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  gamePlayers: document.getElementById('gamePlayers'),
  rankingBox: document.getElementById('rankingBox'),
  backLobbyBtn: document.getElementById('backLobbyBtn'),
  newGameBtn: document.getElementById('newGameBtn')
};

let myName = '';
let currentState = null;
let currentColor = '#111111';
let currentTool = 'pen';
let drawing = false;
let lastPoint = null;
let currentStrokeId = '';
let drawingHistory = [];
let timerInterval = null;

const ctx = els.drawCanvas.getContext('2d');
const paletteColors = ['#111111', '#e74c3c', '#f39c12', '#f1c40f', '#2ecc71', '#3498db', '#8e44ad', '#ffffff'];

function showPage(name) {
  Object.values(pages).forEach(page => page.classList.add('hidden'));
  pages[name].classList.remove('hidden');
  if (name === 'game') {
    setTimeout(resizeCanvas, 60);
  }
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(els.toast._timer);
  els.toast._timer = setTimeout(() => els.toast.classList.add('hidden'), 2200);
}

function firstChar(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

function escapeHTML(text) {
  return String(text || '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

function renderPlayerCard(player, options = {}) {
  if (!player) {
    return `
      <div class="player-card empty-slot">
        <div class="player-avatar">+</div>
        <div class="player-name">空位</div>
        <div class="player-score">等待加入</div>
      </div>`;
  }

  const badges = [];
  if (player.isHost) badges.push('<span class="badge host">房主</span>');
  if (player.ready) badges.push('<span class="badge ready">已就绪</span>');
  if (options.drawerId === player.id) badges.push('<span class="badge drawer">画者</span>');

  return `
    <div class="player-card">
      <div class="player-avatar">${escapeHTML(firstChar(player.name))}</div>
      <div class="player-name">${escapeHTML(player.name)}</div>
      <div class="player-score">分数：${player.score ?? 0}</div>
      <div>${badges.join('')}</div>
    </div>`;
}

function renderLobby() {
  const state = currentState;
  if (!state) return;
  els.lobbyRoomCode.textContent = state.roomCode;
  els.lobbyTip.textContent = `当前 ${state.players.length}/${state.maxPlayers} 人。第一个位置是房主，所有玩家已就绪后，房主才能进入轮数设置。`;
  els.lobbySlots.innerHTML = state.slots.map(player => renderPlayerCard(player)).join('');
  els.toggleReadyBtn.textContent = state.me?.ready ? '已就绪' : '准备就绪';
  els.toggleReadyBtn.className = state.me?.ready ? 'secondary' : 'primary';

  const isHost = !!state.me?.isHost;
  const canOpen = isHost && state.allReady;
  els.hostRoundSetupBtn.classList.toggle('hidden', !isHost);
  els.hostRoundSetupBtn.disabled = !canOpen;

  if (!isHost) {
    els.hostStartTip.textContent = '等待房主开始。';
  } else if (state.players.length < state.minPlayers) {
    els.hostStartTip.textContent = '至少需要 2 名玩家才能开始。';
  } else if (!state.allReady) {
    els.hostStartTip.textContent = '所有玩家都点击“准备就绪”并显示“已就绪”后，房主按钮才会亮起。';
  } else {
    els.hostStartTip.textContent = '所有玩家已就绪，房主可以进入轮数设置。';
  }
}

function renderRoundSetup() {
  const state = currentState;
  if (!state) return;
  const isHost = !!state.me?.isHost;
  els.roundHelp.textContent = `当前 ${state.players.length} 名玩家。词条不可重复使用，所以最多可设置 ${state.maxRounds} 轮。每一轮中每个玩家都会画一次。`;
  els.roundInput.max = state.maxRounds;
  els.roundInput.disabled = !isHost;
  els.startGameBtn.classList.toggle('hidden', !isHost);
  els.roundWaitText.classList.toggle('hidden', isHost);
}

function renderGame() {
  const state = currentState;
  if (!state || !state.current) return;

  const phaseTextMap = {
    drawing: '绘画抢答中',
    discussion: '讨论时间',
    result: '答对啦',
    gameOver: '游戏结束'
  };

  els.phaseText.textContent = `${phaseTextMap[state.phase] || state.phase} · 第 ${state.turnIndex + 1}/${state.totalTurns} 次作画 · 画者：${state.current.drawerName}`;

  if (state.current.isDrawer || state.current.revealed) {
    els.wordBox.textContent = `词条：${state.current.word || '--'} | 提示：${state.current.hint}`;
  } else {
    els.wordBox.textContent = `词条：？？？ | 提示：${state.current.hint}`;
  }

  const canDraw = !!state.current.canDraw;
  els.canvasLock.classList.toggle('hidden', canDraw);
  els.penBtn.disabled = !canDraw;
  els.eraserBtn.disabled = !canDraw;
  els.undoBtn.disabled = !canDraw;
  els.brushSize.disabled = !canDraw;
  els.chatInput.disabled = !state.current.canChat;
  els.chatInput.placeholder = state.current.canChat ? '输入答案或聊天内容' : '画者绘画时不能打字';

  els.resultOverlay.textContent = state.resultText || '';
  els.resultOverlay.classList.toggle('hidden', !state.resultText);

  els.chatMessages.innerHTML = state.chatHistory.map(msg => {
    if (msg.type === 'system') {
      return `<p class="msg system">${escapeHTML(msg.text)}</p>`;
    }
    return `<p class="msg"><span class="msg-name">${escapeHTML(msg.name)}：</span>${escapeHTML(msg.text)}</p>`;
  }).join('');
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

  els.gamePlayers.innerHTML = state.slots.map(player => renderPlayerCard(player, { drawerId: state.current.drawerId })).join('');
  updateTimer();
}

function renderOver() {
  const state = currentState;
  if (!state) return;
  els.rankingBox.innerHTML = state.finalRanking.map((player, index) => `
    <div class="rank-row">
      <strong>第 ${index + 1} 名：${escapeHTML(player.name)}</strong>
      <span>${player.score} 分</span>
    </div>
  `).join('');
  els.backLobbyBtn.classList.toggle('hidden', !state.me?.isHost);
}

function routeByState() {
  const state = currentState;
  if (!state) return;
  if (state.phase === 'lobby') {
    showPage('lobby');
    renderLobby();
  } else if (state.phase === 'roundSetup') {
    showPage('round');
    renderRoundSetup();
  } else if (['drawing', 'discussion', 'result'].includes(state.phase)) {
    showPage('game');
    renderGame();
  } else if (state.phase === 'gameOver') {
    showPage('over');
    renderOver();
  }
}

function startTimerLoop() {
  if (timerInterval) return;
  timerInterval = setInterval(updateTimer, 500);
}

function updateTimer() {
  if (!currentState || !currentState.timerEndAt) {
    els.timerText.textContent = '--';
    return;
  }
  const left = Math.max(0, Math.ceil((currentState.timerEndAt - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  els.timerText.textContent = `${mm}:${ss}`;
}

function setupPalette() {
  els.colorPalette.innerHTML = paletteColors.map(color => `
    <div class="color-dot ${color === currentColor ? 'active' : ''}" data-color="${color}" style="background:${color}"></div>
  `).join('');

  els.colorPalette.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      currentColor = dot.dataset.color;
      currentTool = 'pen';
      updateToolUI();
    });
  });
}

function updateToolUI() {
  els.penBtn.classList.toggle('active', currentTool === 'pen');
  els.eraserBtn.classList.toggle('active', currentTool === 'eraser');
  els.colorPalette.querySelectorAll('.color-dot').forEach(dot => {
    dot.classList.toggle('active', dot.dataset.color === currentColor && currentTool === 'pen');
  });
}

function resizeCanvas() {
  const canvas = els.drawCanvas;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  redrawHistory();
}

function getPoint(event) {
  const rect = els.drawCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  };
}

function drawSegment(segment) {
  const canvas = els.drawCanvas;
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = segment.size * dpr;
  if (segment.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = segment.color;
  }
  ctx.beginPath();
  ctx.moveTo(segment.from.x * canvas.width, segment.from.y * canvas.height);
  ctx.lineTo(segment.to.x * canvas.width, segment.to.y * canvas.height);
  ctx.stroke();
  ctx.restore();
}

function addSegmentToHistory(segment) {
  let stroke = drawingHistory.find(item => item.strokeId === segment.strokeId);
  if (!stroke) {
    stroke = {
      strokeId: segment.strokeId,
      playerId: segment.playerId,
      color: segment.color,
      size: segment.size,
      tool: segment.tool,
      segments: []
    };
    drawingHistory.push(stroke);
  }
  stroke.segments.push(segment);
}

function redrawHistory() {
  ctx.clearRect(0, 0, els.drawCanvas.width, els.drawCanvas.height);
  drawingHistory.forEach(stroke => stroke.segments.forEach(drawSegment));
}

function canDrawNow() {
  return !!(currentState?.current?.canDraw);
}

function pointerDown(event) {
  if (!canDrawNow()) return;
  drawing = true;
  els.drawCanvas.setPointerCapture?.(event.pointerId);
  lastPoint = getPoint(event);
  currentStrokeId = `${socket.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pointerMove(event) {
  if (!drawing || !lastPoint || !canDrawNow()) return;
  const nextPoint = getPoint(event);
  const segment = {
    strokeId: currentStrokeId,
    playerId: socket.id,
    color: currentColor,
    size: Number(els.brushSize.value),
    tool: currentTool,
    from: lastPoint,
    to: nextPoint
  };
  addSegmentToHistory(segment);
  drawSegment(segment);
  socket.emit('draw:segment', segment);
  lastPoint = nextPoint;
}

function pointerUp(event) {
  drawing = false;
  lastPoint = null;
  currentStrokeId = '';
  try {
    els.drawCanvas.releasePointerCapture?.(event.pointerId);
  } catch (_) {}
}

els.modeBtn.addEventListener('click', () => showPage('name'));

document.querySelectorAll('.backHomeBtn').forEach(btn => btn.addEventListener('click', () => showPage('home')));

els.nameConfirmBtn.addEventListener('click', () => {
  const name = els.nameInput.value.trim();
  if (!name) return toast('先输入名字。');
  myName = name.slice(0, 12);
  showPage('room');
});

els.nameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') els.nameConfirmBtn.click();
});

els.backNameBtn.addEventListener('click', () => showPage('name'));

els.joinRoomBtn.addEventListener('click', () => {
  const roomCode = els.roomInput.value.trim();
  if (!roomCode) return toast('请输入房间号。');
  socket.emit('room:join', { roomCode, name: myName }, response => {
    if (!response?.ok) return toast(response?.message || '加入失败。');
    toast(`已加入房间 ${response.roomCode}`);
  });
});

els.roomInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') els.joinRoomBtn.click();
});

els.copyRoomBtn.addEventListener('click', async () => {
  const code = currentState?.roomCode || '';
  const link = `${location.origin}`;
  try {
    await navigator.clipboard.writeText(`房间号：${code}\n网址：${link}`);
    toast('已复制房间号和网址。');
  } catch (_) {
    toast(`房间号：${code}`);
  }
});

els.toggleReadyBtn.addEventListener('click', () => {
  socket.emit('player:toggleReady', response => {
    if (!response?.ok) toast(response?.message || '操作失败。');
  });
});

els.hostRoundSetupBtn.addEventListener('click', () => {
  socket.emit('host:openRoundSetup', response => {
    if (!response?.ok) toast(response?.message || '现在还不能进入轮数设置。');
  });
});

els.startGameBtn.addEventListener('click', () => {
  const rounds = Number(els.roundInput.value || 1);
  socket.emit('host:startGame', { rounds }, response => {
    if (!response?.ok) toast(response?.message || '开始失败。');
  });
});

els.penBtn.addEventListener('click', () => {
  currentTool = 'pen';
  updateToolUI();
});

els.eraserBtn.addEventListener('click', () => {
  currentTool = 'eraser';
  updateToolUI();
});

els.undoBtn.addEventListener('click', () => {
  if (!canDrawNow()) return;
  socket.emit('draw:undo');
});

els.chatForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text }, response => {
    if (!response?.ok) toast(response?.message || '发送失败。');
  });
  els.chatInput.value = '';
});

els.backLobbyBtn.addEventListener('click', () => socket.emit('host:backToLobby'));
els.newGameBtn.addEventListener('click', () => location.reload());

els.drawCanvas.addEventListener('pointerdown', pointerDown);
els.drawCanvas.addEventListener('pointermove', pointerMove);
els.drawCanvas.addEventListener('pointerup', pointerUp);
els.drawCanvas.addEventListener('pointercancel', pointerUp);
els.drawCanvas.addEventListener('pointerleave', pointerUp);
window.addEventListener('resize', resizeCanvas);

socket.on('game:state', state => {
  currentState = state;
  routeByState();
  startTimerLoop();
});

socket.on('draw:segment', segment => {
  addSegmentToHistory(segment);
  drawSegment(segment);
});

socket.on('draw:history', history => {
  drawingHistory = Array.isArray(history) ? history : [];
  redrawHistory();
});

socket.on('disconnect', () => toast('和服务器断开连接，刷新页面可重新进入。'));

setupPalette();
updateToolUI();
showPage('home');
