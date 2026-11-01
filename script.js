/* NUMBER SNAKE — script.js
   Part 1: pure game logic (no DOM), also importable from Node for testing.
   Part 2: browser controller (canvas rendering, input, screens, high score). */

(function (root) {
  'use strict';

  /* =====================================================================
     Part 1 — Game logic
     ===================================================================== */

  var COLS = 16;
  var ROWS = 16;

  var MAX_QUEUE = 4;         // buffered turns between two moves (was 2)

  /* Game modes.
     walls         – false means the board wraps around (head re-enters on the opposite side)
     levelEvery    – points needed per level
     startInterval – ms per move at level 1
     intervalStep  – ms faster per level
     minInterval   – fastest allowed move interval
     growth        – segments gained per number eaten
     freezeLevel   – speed level the stopwatch power-up holds the game at */
  var MODES = {
    normal: {
      id: 'normal', label: 'Normal', walls: true,
      levelEvery: 5, startInterval: 150, intervalStep: 10, minInterval: 70,
      growth: 1, freezeLevel: 2
    },
    nowalls: {
      id: 'nowalls', label: 'No walls', walls: false,
      levelEvery: 3, startInterval: 140, intervalStep: 12, minInterval: 60,
      growth: 2, freezeLevel: 2
    }
  };

  /* Power-ups (all durations in game milliseconds, so pausing stops them). */
  var FREEZE_MS = 35000;       // stopwatch: how long the speed is held down
  var SHIELD_MS = 12000;       // plus: how long walls cannot hurt you
  var ITEM_LIFE = { bomb: 9000, freeze: 12000, shield: 12000 }; // time on the board before vanishing
  var SPAWN_MIN = 5000;        // gap between two power-up spawns
  var SPAWN_MAX = 9000;
  var FIRST_SPAWN_EXTRA = 3000;
  var MAX_BOMBS = 2;           // bombs on the board at once
  var BOMB_MIN_SCORE = 3;      // no bombs before this score
  var BOMB_SAFE_DIST = 4;      // bombs never appear this close to the head
  var WEIGHTS = { freeze: 3, shield: 3, bomb: 3 };

  var DIRS = {
    up:    { x: 0,  y: -1 },
    down:  { x: 0,  y: 1 },
    left:  { x: -1, y: 0 },
    right: { x: 1,  y: 0 }
  };

  function modeOf(id) {
    return MODES[id] || MODES.normal;
  }

  function levelFor(score, modeId) {
    return Math.floor(score / modeOf(modeId).levelEvery) + 1;
  }

  function intervalFor(score, modeId, frozen) {
    var m = modeOf(modeId);
    var level = levelFor(score, modeId);
    if (frozen) level = Math.min(level, m.freezeLevel);
    return Math.max(m.minInterval, m.startInterval - (level - 1) * m.intervalStep);
  }

  function markCells(occ, list, cols) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) occ[list[i].y * cols + list[i].x] = 1;
  }

  function freeList(occ) {
    var free = [];
    for (var i = 0; i < occ.length; i++) {
      if (!occ[i]) free.push(i);
    }
    return free;
  }

  /* Picks a random free cell for the next number. Returns null if the board is full. */
  function spawnFood(state, rng) {
    var cols = state.cols;
    var occ = new Uint8Array(cols * state.rows);
    markCells(occ, state.snake, cols);
    markCells(occ, state.items, cols);
    var free = freeList(occ);
    if (free.length === 0 && state.items && state.items.length) {
      // Power-ups must never be the reason the board looks full: drop them.
      state.items.length = 0;
      occ = new Uint8Array(cols * state.rows);
      markCells(occ, state.snake, cols);
      free = freeList(occ);
    }
    if (free.length === 0) return null;
    var pick = Math.min(free.length - 1, Math.floor(rng() * free.length));
    var idx = free[pick];
    return { x: idx % cols, y: Math.floor(idx / cols), n: state.nextNumber };
  }

  function createState(rng, modeId) {
    var mode = modeOf(modeId);
    var cx = Math.floor(COLS / 2);
    var cy = Math.floor(ROWS / 2);
    var state = {
      mode: mode.id,
      cols: COLS,
      rows: ROWS,
      snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }], // head first
      dir: { x: 1, y: 0 },
      score: 0,
      nextNumber: 1,
      food: null,
      pending: 0,                       // segments still to be added (multi-growth)
      items: [],                        // power-ups and bombs lying on the board
      effects: { freeze: 0, shield: 0 },// ms remaining
      time: 0,                          // game clock in ms (only runs while playing)
      nextSpawnAt: 0,
      pickup: null,                     // set by step(): type of power-up just collected
      wrapped: false                    // set by step(): head went through an edge
    };
    state.nextSpawnAt = SPAWN_MIN + FIRST_SPAWN_EXTRA + rng() * (SPAWN_MAX - SPAWN_MIN);
    state.food = spawnFood(state, rng);
    return state;
  }

  function itemAt(state, x, y) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].x === x && state.items[i].y === y) return state.items[i];
    }
    return null;
  }

  function removeItem(state, item) {
    var i = state.items.indexOf(item);
    if (i >= 0) state.items.splice(i, 1);
  }

  /* Shortest distance between two cells; wraps around the edges when the board does. */
  function distance(state, ax, ay, bx, by, wraps) {
    var dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    if (wraps) {
      dx = Math.min(dx, state.cols - dx);
      dy = Math.min(dy, state.rows - dy);
    }
    return dx + dy;
  }

  /* Puts a random power-up or bomb on a free cell. Returns the item, or null if nothing fits. */
  function spawnItem(state, rng) {
    var mode = modeOf(state.mode);
    var counts = { bomb: 0, freeze: 0, shield: 0 };
    var i;
    for (i = 0; i < state.items.length; i++) counts[state.items[i].type] += 1;

    var choices = [];
    // One of each power-up on the board at a time, and none while that effect is running.
    if (counts.freeze < 1 && state.effects.freeze <= 0) choices.push('freeze');
    // Walls cannot hurt you without walls, so the plus power-up would be useless there.
    if (mode.walls && counts.shield < 1 && state.effects.shield <= 0) choices.push('shield');
    if (counts.bomb < MAX_BOMBS && state.score >= BOMB_MIN_SCORE) choices.push('bomb');
    if (!choices.length) return null;

    var total = 0;
    for (i = 0; i < choices.length; i++) total += WEIGHTS[choices[i]];
    var roll = rng() * total;
    var type = choices[choices.length - 1];
    for (i = 0; i < choices.length; i++) {
      roll -= WEIGHTS[choices[i]];
      if (roll < 0) { type = choices[i]; break; }
    }

    var cols = state.cols;
    var occ = new Uint8Array(cols * state.rows);
    markCells(occ, state.snake, cols);
    markCells(occ, state.items, cols);
    markCells(occ, state.food ? [state.food] : null, cols);
    var free = freeList(occ);

    if (type === 'bomb') {
      var head = state.snake[0];
      free = free.filter(function (idx) {
        return distance(state, idx % cols, Math.floor(idx / cols), head.x, head.y, !mode.walls) >= BOMB_SAFE_DIST;
      });
    }
    if (!free.length) return null;

    var idx = free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
    var item = {
      type: type,
      x: idx % cols,
      y: Math.floor(idx / cols),
      born: state.time,
      expires: state.time + ITEM_LIFE[type]
    };
    state.items.push(item);
    return item;
  }

  /* Moves the game clock: counts down effects, removes old items, spawns new ones. */
  function advance(state, dt, rng) {
    state.time += dt;
    state.effects.freeze = Math.max(0, state.effects.freeze - dt);
    state.effects.shield = Math.max(0, state.effects.shield - dt);

    for (var i = state.items.length - 1; i >= 0; i--) {
      if (state.items[i].expires <= state.time) state.items.splice(i, 1);
    }

    if (state.time >= state.nextSpawnAt) {
      var made = spawnItem(state, rng);
      state.nextSpawnAt = state.time + (made ? SPAWN_MIN + rng() * (SPAWN_MAX - SPAWN_MIN) : 1500);
    }
  }

  /* Advances the snake one cell in state.dir.
     Returns 'moved' | 'ate' | 'won' | 'wall' | 'self' | 'bomb'.
     On 'wall' / 'self' the snake is left where it was; on 'bomb' the head sits on the bomb. */
  function step(state, rng) {
    var mode = modeOf(state.mode);
    state.pickup = null;
    state.wrapped = false;

    var head = state.snake[0];
    var nx = head.x + state.dir.x;
    var ny = head.y + state.dir.y;

    if (nx < 0 || ny < 0 || nx >= state.cols || ny >= state.rows) {
      // Walls kill, unless this mode has none or the shield is up: then the board wraps.
      if (mode.walls && !(state.effects.shield > 0)) return 'wall';
      nx = (nx + state.cols) % state.cols;
      ny = (ny + state.rows) % state.rows;
      state.wrapped = true;
    }

    var eating = !!state.food && state.food.x === nx && state.food.y === ny;
    var growing = eating || state.pending > 0;
    // When not growing, the tail cell is vacated this move, so it is safe to enter.
    var limit = growing ? state.snake.length : state.snake.length - 1;
    for (var i = 0; i < limit; i++) {
      if (state.snake[i].x === nx && state.snake[i].y === ny) return 'self';
    }

    var item = itemAt(state, nx, ny);

    state.snake.unshift({ x: nx, y: ny });
    if (eating) {
      state.score += 1;
      state.nextNumber += 1;
      state.pending += mode.growth - 1;   // the first segment is added right now
    } else if (state.pending > 0) {
      state.pending -= 1;                 // keep the tail: the snake grows
    } else {
      state.snake.pop();
    }

    if (item) {
      removeItem(state, item);
      if (item.type === 'bomb') return 'bomb';
      if (item.type === 'freeze') state.effects.freeze = FREEZE_MS;
      if (item.type === 'shield') state.effects.shield = SHIELD_MS;
      state.pickup = item.type;
    }

    if (eating) {
      state.food = spawnFood(state, rng);
      if (!state.food) return 'won';
    }
    if (state.snake.length >= state.cols * state.rows) return 'won';
    return eating ? 'ate' : 'moved';
  }

  /* Adds a turn to the input buffer. A turn is compared with the last buffered
     direction (or the current one), so reversing and duplicate presses are dropped
     and quick turns still apply on separate moves. */
  function queueDirection(queue, currentDir, newDir) {
    var last = queue.length ? queue[queue.length - 1] : currentDir;
    if (newDir.x === last.x && newDir.y === last.y) return false;
    if (newDir.x === -last.x && newDir.y === -last.y) return false;
    if (queue.length >= MAX_QUEUE) return false;
    queue.push(newDir);
    return true;
  }

  var Logic = {
    COLS: COLS,
    ROWS: ROWS,
    MAX_QUEUE: MAX_QUEUE,
    MODES: MODES,
    DIRS: DIRS,
    FREEZE_MS: FREEZE_MS,
    SHIELD_MS: SHIELD_MS,
    levelFor: levelFor,
    intervalFor: intervalFor,
    spawnFood: spawnFood,
    spawnItem: spawnItem,
    advance: advance,
    createState: createState,
    step: step,
    queueDirection: queueDirection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Logic;
  }

  if (typeof document === 'undefined') return;

  /* =====================================================================
     Part 2 — Browser controller
     ===================================================================== */

  var TAU = Math.PI * 2;
  var STORAGE_KEYS = { normal: 'numberSnake.highScore', nowalls: 'numberSnake.highScore.nowalls' };
  var MODE_KEY = 'numberSnake.mode';
  var START_HOLD = 450;    // ms before the first move after pressing Play
  var RESUME_HOLD = 350;   // ms grace after resuming
  var OVER_LOCK = 700;     // ms during which Play Again ignores input (stray key presses)
  var SWIPE_MIN = 24;      // px

  var COLORS = {
    cellA: '#111823',
    cellB: '#0e141d',
    snake: '#ff2e3e',
    snakeShine: '#ff6670',
    head: '#b80f20',
    headEdge: '#ff4a58',
    glow: 'rgba(255, 46, 62, 0.55)',
    foodTop: '#e4f9ff',
    foodBottom: '#b9efff',
    foodEdge: '#35e0ff',
    foodText: '#06222d',
    gold: '#ffb703',
    goldLight: '#ffe38a',
    green: '#34d985',
    greenLight: '#8dffc0'
  };

  function $(id) { return document.getElementById(id); }

  var gameEl = $('game');
  var canvas = $('board');
  var ctx = canvas.getContext('2d');

  var scoreEl = $('score');
  var nextEl = $('next');
  var bestEl = $('best');
  var levelEl = $('level');
  var speedEl = $('speed');
  var announceEl = $('announce');
  var pauseBtn = $('btn-pause');
  var restartBtn = $('btn-restart');
  var modePill = $('mode-pill');
  var modeBtns = Array.prototype.slice.call(document.querySelectorAll('.mode-btn'));
  var fxEls = {
    freeze: { chip: $('fx-freeze'), time: $('fx-freeze-t'), bar: $('fx-freeze-bar'), last: -1 },
    shield: { chip: $('fx-shield'), time: $('fx-shield-t'), bar: $('fx-shield-bar'), last: -1 }
  };

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var fontFamily = getComputedStyle(document.body).fontFamily;

  // Game state
  var modeId = loadMode();
  var bests = { normal: loadBest('normal'), nowalls: loadBest('nowalls') };
  var best = bests[modeId];
  var state = createState(rng, modeId);
  var prev = cloneSnake(state.snake);
  var status = 'start';            // 'start' | 'playing' | 'paused' | 'over'
  var dirQueue = [];
  var acc = 0;                     // ms accumulated towards the next move
  var interval = intervalFor(0, modeId, false);
  var holdUntil = 0;
  var lastTs = null;
  var bestAtStart = best;
  var overLockUntil = 0;
  var foodBornAt = 0;
  var particles = [];
  var floaters = [];
  var rings = [];
  var cell = 1;

  // Visual effects use their own tiny PRNG so Math.random is only used for gameplay.
  var fxSeed = 123456789;
  function fxRand() {
    fxSeed = (fxSeed + 0x6D2B79F5) | 0;
    var t = Math.imul(fxSeed ^ (fxSeed >>> 15), 1 | fxSeed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function rng() { return Math.random(); }

  function cloneSnake(snake) {
    return snake.map(function (s) { return { x: s.x, y: s.y }; });
  }

  function mod(a, n) { return ((a % n) + n) % n; }

  /* ---------- Saved data (high score per mode, last chosen mode) ---------- */

  function loadBest(id) {
    try {
      var v = parseInt(window.localStorage.getItem(STORAGE_KEYS[id]), 10);
      return isFinite(v) && v > 0 ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  function saveBest(id, v) {
    try { window.localStorage.setItem(STORAGE_KEYS[id], String(v)); } catch (e) { /* storage unavailable */ }
  }

  function setBest(v) {
    best = v;
    bests[modeId] = v;
    saveBest(modeId, v);
  }

  function loadMode() {
    try {
      var m = window.localStorage.getItem(MODE_KEY);
      return MODES[m] ? m : 'normal';
    } catch (e) {
      return 'normal';
    }
  }

  function saveMode(id) {
    try { window.localStorage.setItem(MODE_KEY, id); } catch (e) { /* storage unavailable */ }
  }

  /* ---------- HUD and screens ---------- */

  function bump(el) {
    if (reduceMotion) return;
    el.classList.remove('bump');
    void el.offsetWidth; // restart the animation
    el.classList.add('bump');
  }

  function updateHud() {
    scoreEl.textContent = state.score;
    nextEl.textContent = state.nextNumber;
    bestEl.textContent = best;
    levelEl.textContent = levelFor(state.score, modeId);
    speedEl.textContent = (1000 / interval).toFixed(1) + ' moves/s';
    speedEl.classList.toggle('is-slowed', state.effects.freeze > 0);
  }

  function updateButtons() {
    pauseBtn.disabled = !(status === 'playing' || status === 'paused');
    pauseBtn.textContent = status === 'paused' ? 'Resume' : 'Pause';
    restartBtn.disabled = status === 'start';
  }

  function setScreen(name) {
    status = name === 'playing' ? 'playing' : name;
    gameEl.setAttribute('data-screen', name);
    updateButtons();
  }

  function announce(text) {
    announceEl.textContent = text;
  }

  /* Power-up chips and board glow. Cheap enough to run every frame: the DOM is only
     touched when the visible number of seconds changes. */
  function updateEffects() {
    var live = status === 'playing' || status === 'paused';
    ['freeze', 'shield'].forEach(function (k) {
      var el = fxEls[k];
      var ms = live ? state.effects[k] : 0;
      var secs = ms > 0 ? Math.ceil(ms / 1000) : 0;
      if (secs !== el.last) {
        el.last = secs;
        el.chip.hidden = secs === 0;
        el.time.textContent = secs;
      }
      if (ms > 0) {
        var total = k === 'freeze' ? FREEZE_MS : SHIELD_MS;
        el.bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ms / total)).toFixed(3) + ')';
        el.chip.classList.toggle('ending', ms < 3000);
      }
      gameEl.classList.toggle('fx-' + k, ms > 0);
    });
  }

  function applyModeToUi() {
    var m = MODES[modeId];
    gameEl.setAttribute('data-mode', modeId);
    modePill.textContent = m.label;
    modePill.setAttribute('data-mode', modeId);
    modeBtns.forEach(function (b) {
      var on = b.getAttribute('data-mode') === modeId;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }

  /* Puts the board back into an empty, not-yet-started game of the chosen mode. */
  function resetIdle() {
    state = createState(rng, modeId);
    prev = cloneSnake(state.snake);
    dirQueue.length = 0;
    acc = 0;
    interval = intervalFor(0, modeId, false);
    particles = [];
    floaters = [];
    rings = [];
    gameEl.classList.remove('crash');
    best = bests[modeId];
    bestAtStart = best;
    updateHud();
    updateEffects();
  }

  function selectMode(id) {
    if (!MODES[id] || status !== 'start') return;
    modeId = id;
    saveMode(id);
    applyModeToUi();
    resetIdle();
    announce(MODES[id].label + ' mode selected.');
  }

  /* ---------- Game flow ---------- */

  function startGame() {
    resetIdle();
    foodBornAt = performance.now();
    holdUntil = performance.now() + START_HOLD;
    setScreen('playing');
    announce('Game started. ' + MODES[modeId].label + ' mode. Collect number 1.');
  }

  function toMenu() {
    resetIdle();
    setScreen('start');
  }

  function pauseGame() {
    if (status !== 'playing') return;
    setScreen('paused');
  }

  function resumeGame() {
    if (status !== 'paused') return;
    holdUntil = performance.now() + RESUME_HOLD;
    setScreen('playing');
  }

  function togglePause() {
    if (status === 'playing') pauseGame();
    else if (status === 'paused') resumeGame();
  }

  function playAgain() {
    if (performance.now() < overLockUntil) return;
    startGame();
  }

  function endGame(reason) {
    prev = cloneSnake(state.snake);
    acc = 0;
    state.effects.freeze = 0;   // the run is over: no more slow-down or shield
    state.effects.shield = 0;
    if (state.score > best) setBest(state.score);

    var won = reason === 'won';
    $('over-title').textContent = won ? 'YOU WIN' : 'GAME OVER';
    $('over-reason').textContent = won
      ? 'You filled the whole board. A perfect run.'
      : reason === 'wall' ? 'You hit the wall.'
      : reason === 'bomb' ? 'You ate a bomb.'
      : 'You ran into your own body.';
    $('final-score').textContent = state.score;
    $('final-best').textContent = best;
    $('over-mode').textContent = MODES[modeId].label + ' mode';
    $('new-record').hidden = !(state.score > 0 && state.score > bestAtStart);

    overLockUntil = performance.now() + OVER_LOCK;
    if (reason === 'bomb') {
      var h = state.snake[0];
      var now = lastTs === null ? performance.now() : lastTs;   // same clock the effects are drawn with
      burst(h.x, h.y, now, {
        count: 40, power: 2.4,
        colors: ['#ffd23f', '#ff7a1a', '#ff2e3e', '#ffffff']
      });
      ring(h.x, h.y, now, '#ff7a1a', 3.2, 650);
    }
    if (!won && !reduceMotion) {
      gameEl.classList.remove('crash');
      void gameEl.offsetWidth;
      gameEl.classList.add('crash');
    }
    updateHud();
    setScreen('over');
    updateEffects();
    announce((won ? 'You win. ' : 'Game over. ') + 'Final score ' + state.score + '.');
  }

  /* Re-reads the move interval (the stopwatch holds the speed down). The progress towards
     the next move is scaled so the snake does not jump when the speed changes. */
  function syncInterval() {
    var want = intervalFor(state.score, modeId, state.effects.freeze > 0);
    if (want !== interval) {
      acc = acc * want / interval;
      interval = want;
      updateHud();
    } else if (speedEl.classList.contains('is-slowed') !== (state.effects.freeze > 0)) {
      updateHud();
    }
  }

  function onEat(ts) {
    syncInterval();
    if (state.score > best) setBest(state.score);
    var head = state.snake[0];
    burst(head.x, head.y, ts, { text: '+1' });
    foodBornAt = ts;
    updateHud();
    bump(scoreEl);
    bump(nextEl);
    announce('Score ' + state.score + '. Next number ' + state.nextNumber + '.');
  }

  function onPickup(type, ts) {
    var head = state.snake[0];
    if (type === 'freeze') {
      syncInterval();
      burst(head.x, head.y, ts, { colors: [COLORS.gold, COLORS.goldLight, '#ffffff'], text: 'SLOW', textColor: COLORS.gold });
      ring(head.x, head.y, ts, COLORS.gold, 2.2, 550);
      announce('Stopwatch. The game is slowed down for ' + Math.round(FREEZE_MS / 1000) + ' seconds.');
    } else {
      burst(head.x, head.y, ts, { colors: [COLORS.green, COLORS.greenLight, '#ffffff'], text: 'SHIELD', textColor: COLORS.greenLight });
      ring(head.x, head.y, ts, COLORS.green, 2.2, 550);
      announce('Shield. Walls cannot hurt you for ' + Math.round(SHIELD_MS / 1000) + ' seconds.');
    }
    bump(speedEl);
  }

  function tick(ts) {
    prev = cloneSnake(state.snake);
    var turn = dirQueue.shift();
    if (turn) state.dir = turn;

    var result = step(state, rng);
    if (result === 'wall' || result === 'self' || result === 'bomb') {
      endGame(result);
      return;
    }
    if (state.pickup) onPickup(state.pickup, ts);
    if (state.wrapped && state.effects.shield > 0) {
      var h = state.snake[0];
      burst(h.x, h.y, ts, { count: 6, power: 0.9, colors: [COLORS.green, COLORS.greenLight] });
    }
    if (result === 'ate' || result === 'won') onEat(ts);
    if (result === 'won') endGame('won');
  }

  function steer(name) {
    if (status !== 'playing') return;
    queueDirection(dirQueue, state.dir, DIRS[name]);
  }

  /* ---------- Effects ---------- */

  var BURST_COLORS = [COLORS.snakeShine, COLORS.foodEdge, COLORS.foodTop];

  function burst(cx, cy, ts, o) {
    if (reduceMotion) return;
    o = o || {};
    var count = o.count || 12;
    var power = o.power || 1;
    var colors = o.colors || BURST_COLORS;
    for (var i = 0; i < count; i++) {
      var angle = fxRand() * TAU;
      var speed = (0.8 + fxRand() * 1.6) * power;
      particles.push({
        x: cx + 0.5, y: cy + 0.5,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        born: ts, life: 420 + fxRand() * 200,
        size: 0.07 + fxRand() * 0.08,
        color: colors[i % colors.length]
      });
    }
    if (o.text) {
      floaters.push({ x: cx + 0.5, y: cy + 0.5, born: ts, life: 800, text: o.text, color: o.textColor || COLORS.foodEdge });
    }
  }

  function ring(cx, cy, ts, color, maxR, life) {
    if (reduceMotion) return;
    rings.push({ x: cx + 0.5, y: cy + 0.5, born: ts, life: life, color: color, maxR: maxR });
  }

  /* ---------- Rendering ---------- */

  function resizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = Math.max(1, Math.round(rect.width * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    cell = size / COLS;
  }

  function roundRect(x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function easeOutBack(x) {
    var c1 = 1.70158, c3 = c1 + 1;
    var p = x - 1;
    return 1 + c3 * p * p * p + c1 * p * p;
  }

  function drawGrid() {
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        ctx.fillStyle = ((r + c) & 1) ? COLORS.cellA : COLORS.cellB;
        var x0 = Math.round(c * cell), y0 = Math.round(r * cell);
        ctx.fillRect(x0, y0, Math.round((c + 1) * cell) - x0, Math.round((r + 1) * cell) - y0);
      }
    }
  }

  function drawFood(ts) {
    var f = state.food;
    if (!f) return;

    var age = ts - foodBornAt;
    var pop = (reduceMotion || age >= 180) ? 1 : easeOutBack(Math.max(0, age) / 180);
    var pulse = reduceMotion ? 0 : 0.035 * Math.sin(ts / 260);
    var size = cell * 0.86 * pop * (1 + pulse);
    var cx = (f.x + 0.5) * cell;
    var cy = (f.y + 0.5) * cell;
    var x = cx - size / 2, y = cy - size / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(53, 224, 255, 0.75)';
    ctx.shadowBlur = cell * 0.55;
    var grad = ctx.createLinearGradient(0, y, 0, y + size);
    grad.addColorStop(0, COLORS.foodTop);
    grad.addColorStop(1, COLORS.foodBottom);
    ctx.fillStyle = grad;
    ctx.beginPath();
    roundRect(x, y, size, size, size * 0.26);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = Math.max(1.5, cell * 0.06);
    ctx.strokeStyle = COLORS.foodEdge;
    ctx.beginPath();
    roundRect(x, y, size, size, size * 0.26);
    ctx.stroke();

    var digits = String(f.n).length;
    var scale = digits === 1 ? 0.62 : digits === 2 ? 0.5 : digits === 3 ? 0.4 : 0.33;
    ctx.fillStyle = COLORS.foodText;
    ctx.font = '800 ' + Math.round(cell * scale * pop) + 'px ' + fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(f.n), cx, cy + cell * 0.035);
  }

  /* ----- Power-up and bomb icons (round, so they never look like the square number tiles) ----- */

  function drawClockIcon(cx, cy, r, ts) {
    var fcy = cy + r * 0.1;
    var fr = r * 0.8;

    ctx.save();
    ctx.shadowColor = 'rgba(255, 183, 3, 0.8)';
    ctx.shadowBlur = cell * 0.5;
    var grad = ctx.createLinearGradient(0, fcy - fr, 0, fcy + fr);
    grad.addColorStop(0, '#fffbe6');
    grad.addColorStop(1, COLORS.goldLight);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, fcy, fr, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = Math.max(2, cell * 0.075);
    ctx.strokeStyle = COLORS.gold;
    ctx.beginPath();
    ctx.arc(cx, fcy, fr, 0, TAU);
    ctx.stroke();

    // crown button on top
    ctx.fillStyle = COLORS.gold;
    ctx.beginPath();
    roundRect(cx - r * 0.2, cy - r * 0.98, r * 0.4, r * 0.24, r * 0.08);
    ctx.fill();

    // ticks at 12, 3, 6, 9
    ctx.strokeStyle = '#a56a00';
    ctx.lineWidth = Math.max(1, cell * 0.04);
    ctx.lineCap = 'round';
    for (var k = 0; k < 4; k++) {
      var a = k * TAU / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * fr * 0.72, fcy + Math.sin(a) * fr * 0.72);
      ctx.lineTo(cx + Math.cos(a) * fr * 0.88, fcy + Math.sin(a) * fr * 0.88);
      ctx.stroke();
    }

    // short fixed hand + sweeping hand
    ctx.strokeStyle = '#7a4b00';
    ctx.lineWidth = Math.max(1.5, cell * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx, fcy);
    ctx.lineTo(cx + fr * 0.28, fcy - fr * 0.3);
    ctx.stroke();

    var sweep = reduceMotion ? -0.6 : (ts / 1400) * TAU - Math.PI / 2;
    ctx.strokeStyle = '#d93a1f';
    ctx.lineWidth = Math.max(1, cell * 0.04);
    ctx.beginPath();
    ctx.moveTo(cx, fcy);
    ctx.lineTo(cx + Math.cos(sweep) * fr * 0.68, fcy + Math.sin(sweep) * fr * 0.68);
    ctx.stroke();

    ctx.fillStyle = '#7a4b00';
    ctx.beginPath();
    ctx.arc(cx, fcy, cell * 0.04, 0, TAU);
    ctx.fill();
    ctx.lineCap = 'butt';
  }

  function drawPlusIcon(cx, cy, r) {
    ctx.save();
    ctx.shadowColor = 'rgba(52, 217, 133, 0.85)';
    ctx.shadowBlur = cell * 0.5;
    var grad = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    grad.addColorStop(0, COLORS.greenLight);
    grad.addColorStop(1, COLORS.green);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.9, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = Math.max(2, cell * 0.06);
    ctx.strokeStyle = '#d9ffe9';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.9, 0, TAU);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(3, cell * 0.14);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.42, cy);
    ctx.lineTo(cx + r * 0.42, cy);
    ctx.moveTo(cx, cy - r * 0.42);
    ctx.lineTo(cx, cy + r * 0.42);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawBombIcon(cx, cy, r, ts) {
    var bcy = cy + r * 0.16;
    var br = r * 0.78;
    var throb = reduceMotion ? 0 : 0.5 + 0.5 * Math.sin(ts / 170);

    ctx.save();
    ctx.shadowColor = 'rgba(255, 90, 40, ' + (0.45 + throb * 0.4).toFixed(2) + ')';
    ctx.shadowBlur = cell * (0.35 + throb * 0.25);
    var grad = ctx.createRadialGradient(cx - br * 0.35, bcy - br * 0.4, br * 0.1, cx, bcy, br);
    grad.addColorStop(0, '#5a6378');
    grad.addColorStop(1, '#0c0f16');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, bcy, br, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    ctx.strokeStyle = 'rgba(255, 90, 54, ' + (0.65 + throb * 0.35).toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(cx, bcy, br, 0, TAU);
    ctx.stroke();

    // shine
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, bcy, br * 0.62, Math.PI * 1.08, Math.PI * 1.45);
    ctx.stroke();

    // cap
    ctx.fillStyle = '#2b3142';
    ctx.beginPath();
    roundRect(cx - r * 0.24, bcy - br - r * 0.14, r * 0.48, r * 0.28, r * 0.08);
    ctx.fill();

    // fuse
    var fx0 = cx, fy0 = bcy - br - r * 0.12;
    var fx1 = cx + r * 0.5, fy1 = cy - r * 0.98;
    ctx.strokeStyle = '#d2b26b';
    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    ctx.beginPath();
    ctx.moveTo(fx0, fy0);
    ctx.quadraticCurveTo(cx + r * 0.05, cy - r * 0.95, fx1, fy1);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // spark
    var flick = reduceMotion ? 1 : 0.75 + 0.25 * Math.sin(ts / 55) + 0.15 * Math.sin(ts / 23);
    ctx.save();
    ctx.shadowColor = '#ff9a1a';
    ctx.shadowBlur = cell * 0.35;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(fx1, fy1, cell * 0.075 * flick, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(fx1, fy1, cell * 0.032 * flick, 0, TAU);
    ctx.fill();
  }

  function drawItems(ts) {
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      var age = state.time - it.born;
      var left = it.expires - state.time;
      var pop = (reduceMotion || age >= 220) ? 1 : easeOutBack(Math.max(0, age) / 220);
      var bob = reduceMotion ? 0 : Math.sin(ts / 320 + it.x * 1.7 + it.y) * 0.025;
      var r = cell * 0.48 * pop * (1 + bob);
      var cx = (it.x + 0.5) * cell;
      var cy = (it.y + 0.5) * cell;

      // Blink during the last 3 seconds so the player knows it is about to vanish.
      var dim = left < 3000 && (reduceMotion ? true : (Math.floor(ts / 130) % 2 === 0));

      ctx.save();
      if (dim) ctx.globalAlpha = 0.4;
      if (it.type === 'freeze') drawClockIcon(cx, cy, r, ts);
      else if (it.type === 'shield') drawPlusIcon(cx, cy, r);
      else drawBombIcon(cx, cy, r, ts);
      ctx.restore();
    }
  }

  /* Draws a cell-sized thing at a (possibly fractional, possibly off-board) position and again
     on the opposite edge when it straddles one, so wrapping looks continuous. */
  function eachCopy(p, fn) {
    var x = mod(p.x, COLS), y = mod(p.y, ROWS);
    var ox = x > COLS - 1 ? -COLS : 0;
    var oy = y > ROWS - 1 ? -ROWS : 0;
    fn(x, y);
    if (ox) fn(x + ox, y);
    if (oy) fn(x, y + oy);
    if (ox && oy) fn(x + ox, y + oy);
  }

  function wrapDelta(d, size) {
    if (d > 1) return d - size;     // moved through the edge, the long way round
    if (d < -1) return d + size;
    return d;
  }

  function drawHead(hx, hy, look, ts) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 46, 62, 0.9)';
    ctx.shadowBlur = cell * 0.7;
    ctx.fillStyle = COLORS.head;
    ctx.beginPath();
    roundRect(hx + cell * 0.03, hy + cell * 0.03, cell * 0.94, cell * 0.94, cell * 0.32);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.strokeStyle = COLORS.headEdge;
    ctx.beginPath();
    roundRect(hx + cell * 0.03, hy + cell * 0.03, cell * 0.94, cell * 0.94, cell * 0.32);
    ctx.stroke();

    var fx = look.x, fy = look.y;
    var px = -fy, py = fx;
    var ecx = hx + cell / 2 + fx * cell * 0.16;
    var ecy = hy + cell / 2 + fy * cell * 0.16;
    for (var side = -1; side <= 1; side += 2) {
      var ex = ecx + px * side * cell * 0.2;
      var ey = ecy + py * side * cell * 0.2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, cell * 0.12, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#12060a';
      ctx.beginPath();
      ctx.arc(ex + fx * cell * 0.04, ey + fy * cell * 0.04, cell * 0.06, 0, TAU);
      ctx.fill();
    }

    // Shield aura around the head; flickers when it is about to run out.
    var sh = state.effects.shield;
    if (sh > 0 && !(sh < 2500 && !reduceMotion && Math.floor(ts / 120) % 2 === 0)) {
      var pulse = reduceMotion ? 0 : 0.5 + 0.5 * Math.sin(ts / 200);
      ctx.save();
      ctx.shadowColor = 'rgba(52, 217, 133, 0.9)';
      ctx.shadowBlur = cell * 0.5;
      ctx.lineWidth = Math.max(2, cell * 0.08);
      ctx.strokeStyle = 'rgba(141, 255, 192, ' + (0.7 + pulse * 0.3).toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(hx + cell / 2, hy + cell / 2, cell * (0.66 + pulse * 0.05), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawSnake(ts) {
    var t = Math.max(0, Math.min(1, acc / interval));
    var n = state.snake.length;
    var pos = new Array(n);
    var i;
    for (i = 0; i < n; i++) {
      var cur = state.snake[i];
      var old = prev[i] || cur;
      pos[i] = {
        x: old.x + wrapDelta(cur.x - old.x, COLS) * t,
        y: old.y + wrapDelta(cur.y - old.y, ROWS) * t
      };
    }

    // Body: one path for the glow, a second smaller one for the highlight.
    var inset = cell * 0.05;
    var size = cell - inset * 2;

    ctx.save();
    ctx.beginPath();
    for (i = n - 1; i >= 1; i--) {
      eachCopy(pos[i], function (x, y) {
        roundRect(x * cell + inset, y * cell + inset, size, size, cell * 0.28);
      });
    }
    ctx.fillStyle = COLORS.snake;
    ctx.shadowColor = COLORS.glow;
    ctx.shadowBlur = cell * 0.5;
    ctx.fill();
    ctx.restore();

    var inner = cell * 0.24;
    ctx.beginPath();
    for (i = n - 1; i >= 1; i--) {
      eachCopy(pos[i], function (x, y) {
        roundRect(x * cell + inner, y * cell + inner, cell - inner * 2, cell - inner * 2, cell * 0.14);
      });
    }
    ctx.fillStyle = COLORS.snakeShine;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Head: the eyes already turn towards the next buffered turn, so a key press gives instant feedback.
    var look = dirQueue.length ? dirQueue[0] : state.dir;
    eachCopy(pos[0], function (x, y) {
      drawHead(x * cell, y * cell, look, ts);
    });
  }

  function drawEffects(ts) {
    var i, p, age;
    for (i = rings.length - 1; i >= 0; i--) {
      p = rings[i];
      age = Math.max(0, (ts - p.born) / p.life);
      if (age >= 1) { rings.splice(i, 1); continue; }
      var e = 1 - Math.pow(1 - age, 3);
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(2, cell * 0.12 * (1 - age));
      ctx.beginPath();
      ctx.arc(p.x * cell, p.y * cell, p.maxR * cell * e, 0, TAU);
      ctx.stroke();
    }
    for (i = particles.length - 1; i >= 0; i--) {
      p = particles[i];
      age = Math.max(0, (ts - p.born) / p.life);
      if (age >= 1) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = p.color;
      var s = p.size * cell * (1 - age * 0.4);
      ctx.fillRect((p.x + p.vx * age) * cell - s / 2, (p.y + p.vy * age) * cell - s / 2, s, s);
    }
    for (i = floaters.length - 1; i >= 0; i--) {
      p = floaters[i];
      age = Math.max(0, (ts - p.born) / p.life);
      if (age >= 1) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age * age;
      ctx.fillStyle = p.color;
      ctx.font = '800 ' + Math.round(cell * (p.text.length > 3 ? 0.42 : 0.5)) + 'px ' + fontFamily;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var fx = Math.max(cell * 1.2, Math.min(COLS * cell - cell * 1.2, p.x * cell));
      ctx.fillText(p.text, fx, Math.max(cell * 0.5, (p.y - 0.7 - age * 0.9) * cell));
    }
    ctx.globalAlpha = 1;
  }

  function draw(ts) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    drawItems(ts);
    drawFood(ts);
    drawSnake(ts);
    drawEffects(ts);
  }

  function frame(ts) {
    window.requestAnimationFrame(frame);   // first, so one bad frame can never stop the loop
    var dt = lastTs === null ? 0 : Math.min(ts - lastTs, 250);
    lastTs = ts;

    if (status === 'playing' && ts >= holdUntil) {
      advance(state, dt, rng);
      syncInterval();
      acc += dt;
      var guard = 0;
      while (acc >= interval && status === 'playing' && guard++ < 5) {
        acc -= interval;
        tick(ts);
      }
    }

    updateEffects();
    draw(ts);
  }

  /* ---------- Input ---------- */

  var KEY_DIRS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right'
  };

  function primaryAction() {
    if (status === 'start') startGame();
    else if (status === 'paused') resumeGame();
    else if (status === 'over') playAgain();
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    var dirName = KEY_DIRS[e.code];
    if (dirName) {
      // Stop the page from scrolling while a game is in progress.
      if (status === 'playing' || status === 'paused') e.preventDefault();
      // On the start screen left / right flips between the two game modes.
      if (status === 'start' && (dirName === 'left' || dirName === 'right') && !e.repeat) {
        selectMode(modeId === 'normal' ? 'nowalls' : 'normal');
        return;
      }
      steer(dirName);
      return;
    }

    if (status === 'start' && !e.repeat) {
      if (e.code === 'Digit1' || e.code === 'Numpad1') { selectMode('normal'); return; }
      if (e.code === 'Digit2' || e.code === 'Numpad2') { selectMode('nowalls'); return; }
    }

    var onButton = e.target && e.target.closest && e.target.closest('button');

    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (onButton) return; // let the focused button handle it natively
      e.preventDefault();
      if (e.repeat) return;
      if (status === 'playing') {
        if (e.code === 'Space') pauseGame();
      } else {
        primaryAction();
      }
      return;
    }

    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (e.repeat) return;
      togglePause();
    }
  });

  function bindButton(btn, handler) {
    btn.addEventListener('click', function (e) {
      handler();
      // Mouse and touch clicks release focus so Space/Enter keep controlling the game.
      if (e.detail !== 0) btn.blur();
    });
  }

  bindButton($('btn-play'), startGame);
  bindButton($('btn-resume'), resumeGame);
  bindButton($('btn-pause-restart'), startGame);
  bindButton($('btn-pause-menu'), toMenu);
  bindButton($('btn-again'), playAgain);
  bindButton($('btn-menu'), toMenu);
  bindButton(pauseBtn, togglePause);
  bindButton(restartBtn, function () { if (status !== 'start') startGame(); });

  modeBtns.forEach(function (btn) {
    bindButton(btn, function () { selectMode(btn.getAttribute('data-mode')); });
  });

  // On-screen arrow pad
  Array.prototype.forEach.call(document.querySelectorAll('.dpad-btn'), function (btn) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      steer(btn.getAttribute('data-dir'));
    });
    btn.addEventListener('click', function (e) {
      if (e.detail === 0) steer(btn.getAttribute('data-dir')); // keyboard activation
    });
  });

  // Swipe on the board (touch and pen)
  var swipe = null;
  gameEl.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  gameEl.addEventListener('pointermove', function (e) {
    if (!swipe || swipe.id !== e.pointerId) return;
    var dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return;
    if (Math.abs(dx) > Math.abs(dy)) steer(dx > 0 ? 'right' : 'left');
    else steer(dy > 0 ? 'down' : 'up');
    swipe.x = e.clientX;
    swipe.y = e.clientY;
  });
  function endSwipe(e) {
    if (swipe && swipe.id === e.pointerId) swipe = null;
  }
  gameEl.addEventListener('pointerup', endSwipe);
  gameEl.addEventListener('pointercancel', endSwipe);

  // Pause automatically when the tab is hidden.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pauseGame();
  });

  /* ---------- Boot ---------- */

  window.addEventListener('resize', resizeCanvas);
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvas);

  // Small read-only handle that is handy for debugging in the browser console.
  window.NumberSnake = {
    getState: function () {
      return {
        status: status,
        mode: modeId,
        score: state.score,
        best: best,
        nextNumber: state.nextNumber,
        level: levelFor(state.score, modeId),
        interval: interval,
        dir: { x: state.dir.x, y: state.dir.y },
        snake: cloneSnake(state.snake),
        food: state.food ? { x: state.food.x, y: state.food.y, n: state.food.n } : null,
        items: state.items.map(function (it) { return { type: it.type, x: it.x, y: it.y }; }),
        effects: { freeze: state.effects.freeze, shield: state.effects.shield },
        cols: COLS,
        rows: ROWS
      };
    }
  };

  applyModeToUi();
  resizeCanvas();
  updateHud();
  updateButtons();
  window.requestAnimationFrame(frame);

})(typeof window !== 'undefined' ? window : globalThis);
