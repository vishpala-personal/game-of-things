'use strict';

/**
 * Game of Things — hybrid party game companion.
 *
 * Zero dependencies: pure Node.js http + Server-Sent Events (server -> client
 * push) + POST /action (client -> server). State lives in memory; a single
 * game/room. Run with `node server.js` and open http://<laptop-ip>:3000 on
 * every phone connected to the same WiFi.
 *
 * The server is the source of truth AND the privacy boundary: each connected
 * client is sent a per-player VIEW that contains only what that player is
 * allowed to see. Secret data (answer authorship, who submitted when) never
 * leaves the server for a client that shouldn't have it.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BANNER_MS = 30000; // how long a resolved guess flashes / feedback lingers

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

function freshGame() {
  return {
    phase: 'lobby', // lobby | answering | guessing | roundEnd
    players: [], // ordered: {id, name} — array order IS the seating/turn order
    scores: {}, // pid -> total points
    lastStandingPoints: 3, // 3 or 2
    readerId: null,
    roundNumber: 0,
    round: null, // see freshRound()
    lastRoundSummary: null, // populated at roundEnd
  };
}

function freshRound() {
  return {
    answers: [], // {id, playerId (author, secret), text, solved}
    displayOrder: [], // [answerId, ...] shuffled, stable for the round
    submitted: new Set(), // pids that have submitted
    currentGuesserId: null,
    eliminated: new Set(), // pids whose answer was correctly guessed (out)
    correctGuessesBy: {}, // pid -> correct guesses this round (scoring)
    lastGuess: null, // {token, guesserId, answerId, num, suspectId, correct, revealName}
    bannerToken: 0,
  };
}

let game = freshGame();
const connections = new Map(); // pid -> Set(res)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const player = (pid) => game.players.find((p) => p.id === pid);
const playerName = (pid) => (player(pid) ? player(pid).name : '???');
const idxOf = (pid) => game.players.findIndex((p) => p.id === pid);
const solvedCount = () => game.round.answers.filter((a) => a.solved).length;

// Next non-eliminated player after `pid` in seating order.
function nextActive(pid) {
  const n = game.players.length;
  const start = idxOf(pid);
  for (let k = 1; k <= n; k++) {
    const cand = game.players[(start + k) % n];
    if (!game.round.eliminated.has(cand.id)) return cand.id;
  }
  return pid; // shouldn't happen
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function slipNumberOf(answerId) {
  return game.round.displayOrder.indexOf(answerId) + 1;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

// Round 1: the Reader is chosen in the lobby; pressing Start commits it.
function startGame() {
  if (game.phase !== 'lobby' || game.players.length < 2 || !game.readerId) return;
  game.scores = {};
  game.players.forEach((p) => (game.scores[p.id] = 0));
  game.roundNumber = 0;
  startAnswering();
}

// Reader is already designated — open the answering phase for a new round.
function startAnswering() {
  game.roundNumber += 1;
  game.round = freshRound();
  game.phase = 'answering';
}

// Rounds after the first: clear the Reader and go to the designation screen.
function goToPickReader() {
  game.readerId = null;
  game.round = null;
  game.lastRoundSummary = null;
  game.phase = 'pickReader';
}

// Any player may press a Reader button, in the lobby or on the pick-reader screen.
function setReader(pid) {
  if ((game.phase !== 'lobby' && game.phase !== 'pickReader') || !player(pid)) return;
  game.readerId = pid;
}

function beginRound() {
  if (game.phase !== 'pickReader' || !game.readerId) return;
  startAnswering();
}

function submitAnswer(pid, text) {
  if (game.phase !== 'answering') return;
  if (game.round.submitted.has(pid)) return;
  const clean = String(text || '').trim();
  if (!clean) return;
  game.round.answers.push({ id: crypto.randomUUID(), playerId: pid, text: clean, solved: false });
  game.round.submitted.add(pid);
  if (game.round.submitted.size === game.players.length) beginGuessing();
}

function beginGuessing() {
  game.round.displayOrder = shuffle(game.round.answers.map((a) => a.id));
  game.round.currentGuesserId = nextActive(game.readerId); // player left of reader
  game.phase = 'guessing';
}

function scheduleBannerClear(token) {
  setTimeout(() => {
    if (game.round && game.round.lastGuess && game.round.lastGuess.token === token) {
      game.round.lastGuess = null;
      broadcast();
    }
  }, BANNER_MS);
}

function handleGuess(pid, answerId, suspectId) {
  const r = game.round;
  if (game.phase !== 'guessing' || pid !== r.currentGuesserId) return;
  const answer = r.answers.find((a) => a.id === answerId);
  if (!answer || !suspectId) return;

  const correct = !answer.solved && answer.playerId === suspectId;
  const token = ++r.bannerToken;

  if (correct) {
    answer.solved = true;
    r.eliminated.add(answer.playerId);
    r.correctGuessesBy[pid] = (r.correctGuessesBy[pid] || 0) + 1;
    game.scores[pid] = (game.scores[pid] || 0) + 1;
    r.lastGuess = {
      token,
      guesserId: pid,
      answerId,
      num: slipNumberOf(answerId),
      suspectId,
      correct: true,
      revealName: playerName(answer.playerId),
    };

    if (solvedCount() === game.players.length - 1) {
      endRound();
      return;
    }
    // Correct guessers go again — unless they somehow eliminated themselves.
    if (r.eliminated.has(pid)) r.currentGuesserId = nextActive(pid);
  } else {
    r.lastGuess = {
      token,
      guesserId: pid,
      answerId,
      num: slipNumberOf(answerId),
      suspectId,
      correct: false,
      // No revealName on a wrong guess — the true author stays hidden.
    };
    r.currentGuesserId = nextActive(pid);
  }

  scheduleBannerClear(token);
}

function endRound() {
  const remaining = game.round.answers.find((a) => !a.solved);
  const winnerId = remaining ? remaining.playerId : null;
  if (winnerId) game.scores[winnerId] = (game.scores[winnerId] || 0) + game.lastStandingPoints;

  const deltas = {};
  game.players.forEach((p) => {
    const guessed = game.round.correctGuessesBy[p.id] || 0;
    const standing = p.id === winnerId ? game.lastStandingPoints : 0;
    deltas[p.id] = guessed + standing;
  });

  game.lastRoundSummary = {
    winnerId,
    deltas,
    reveal: game.round.displayOrder.map((aid, i) => {
      const a = game.round.answers.find((x) => x.id === aid);
      return { num: i + 1, text: a.text, authorId: a.playerId, authorName: playerName(a.playerId) };
    }),
    readerId: game.readerId,
  };
  game.phase = 'roundEnd';
}

function nextRound() {
  if (game.phase !== 'roundEnd') return;
  goToPickReader();
}

// ---------------------------------------------------------------------------
// Per-player views  (the privacy boundary)
// ---------------------------------------------------------------------------

function roster() {
  return game.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: game.scores[p.id] || 0,
    isReader: p.id === game.readerId,
    eliminated: game.round ? game.round.eliminated.has(p.id) : false,
    isCurrentGuesser: game.round ? p.id === game.round.currentGuesserId : false,
  }));
}

function viewFor(pid) {
  const me = player(pid);
  if (!me) return { type: 'reset' };

  const base = {
    type: 'view',
    phase: game.phase,
    roundNumber: game.roundNumber,
    lastStandingPoints: game.lastStandingPoints,
    you: { id: me.id, name: me.name, isReader: me.id === game.readerId },
    reader: game.readerId ? { id: game.readerId, name: playerName(game.readerId) } : null,
    players: roster(),
  };

  if (game.phase === 'lobby') {
    return {
      ...base,
      players: game.players.map((p) => ({ id: p.id, name: p.name, isReader: p.id === game.readerId })),
      canStart: game.players.length >= 2 && !!game.readerId,
    };
  }

  if (game.phase === 'pickReader') {
    // Any player may designate the Reader; the round can't begin until one is set.
    return { ...base, canBegin: !!game.readerId };
  }

  if (game.phase === 'answering') {
    return {
      ...base,
      you: { ...base.you, submitted: game.round.submitted.has(pid) },
      submittedCount: game.round.submitted.size, // count only — never who
      totalCount: game.players.length,
    };
  }

  if (game.phase === 'guessing') {
    const r = game.round;
    const isReader = me.id === game.readerId;
    const isTurn = me.id === r.currentGuesserId;

    // Only the reader (board) and the active guesser see the slips.
    const canSeeSlips = isReader || isTurn;
    const slips = canSeeSlips
      ? r.displayOrder.map((aid, i) => {
          const a = r.answers.find((x) => x.id === aid);
          return { id: a.id, num: i + 1, text: a.text };
        })
      : null;

    // 30s flash on the reader's board only.
    let banner = null;
    if (isReader && r.lastGuess) {
      banner = {
        correct: r.lastGuess.correct,
        guesserName: playerName(r.lastGuess.guesserId),
        num: r.lastGuess.num,
        answerId: r.lastGuess.answerId,
        suspectName: playerName(r.lastGuess.suspectId),
        revealName: r.lastGuess.revealName || null,
      };
    }

    // Personal feedback for whoever just guessed (right or wrong).
    let yourLastGuess = null;
    if (r.lastGuess && r.lastGuess.guesserId === pid) {
      yourLastGuess = {
        correct: r.lastGuess.correct,
        num: r.lastGuess.num,
        suspectName: playerName(r.lastGuess.suspectId),
        revealName: r.lastGuess.revealName || null, // only present when correct
      };
    }

    return {
      ...base,
      you: { ...base.you, isCurrentGuesser: isTurn },
      currentGuesser: { id: r.currentGuesserId, name: playerName(r.currentGuesserId) },
      slips,
      canGuess: isTurn,
      // Guess targets: everyone, including eliminated players (picking one = wrong).
      guessTargets: game.players.map((p) => ({ id: p.id, name: p.name })),
      banner,
      yourLastGuess,
    };
  }

  if (game.phase === 'roundEnd') {
    const s = game.lastRoundSummary;
    return {
      ...base,
      reveal: s.reveal,
      winner: s.winnerId ? { id: s.winnerId, name: playerName(s.winnerId) } : null,
      roundScores: game.players.map((p) => ({ name: p.name, delta: s.deltas[p.id] || 0 })),
    };
  }

  return base;
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

function sendTo(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast() {
  for (const [pid, set] of connections) {
    const v = viewFor(pid);
    for (const res of set) sendTo(res, v);
  }
}

function addConnection(pid, res) {
  if (!connections.has(pid)) connections.set(pid, new Set());
  connections.get(pid).add(res);
}

function removeConnection(pid, res) {
  const set = connections.get(pid);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) connections.delete(pid);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function handleAction(pid, body) {
  if (!player(pid) && body.type !== 'reset') return;
  switch (body.type) {
    case 'setPoints':
      if (game.phase === 'lobby' && (body.points === 2 || body.points === 3)) {
        game.lastStandingPoints = body.points;
      }
      break;
    case 'startGame':
      startGame();
      break;
    case 'setReader':
      setReader(body.readerId);
      break;
    case 'beginRound':
      beginRound();
      break;
    case 'submitAnswer':
      submitAnswer(pid, body.text);
      break;
    case 'guess':
      handleGuess(pid, body.answerId, body.suspectId);
      break;
    case 'nextRound':
      nextRound();
      break;
    case 'newGame': // wipe everything back to a fresh lobby, keep players
      {
        const players = game.players;
        game = freshGame();
        game.players = players;
      }
      break;
    default:
      return;
  }
  broadcast();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

function serveStatic(req, res) {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store', // dev: always serve the latest client files
    });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Realtime stream ---------------------------------------------------------
  if (url.pathname === '/events') {
    const pid = url.searchParams.get('pid');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (!pid || !player(pid)) {
      sendTo(res, { type: 'reset' });
      res.end();
      return;
    }
    addConnection(pid, res);
    sendTo(res, viewFor(pid));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      removeConnection(pid, res);
    });
    return;
  }

  // Join --------------------------------------------------------------------
  if (url.pathname === '/join' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim().slice(0, 24);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (body.pid && player(body.pid)) {
      res.end(JSON.stringify({ ok: true, pid: body.pid, name: playerName(body.pid) }));
      return;
    }
    if (game.phase !== 'lobby') {
      res.end(JSON.stringify({ ok: false, error: 'A game is already in progress.' }));
      return;
    }
    if (!name) {
      res.end(JSON.stringify({ ok: false, error: 'Please enter a name.' }));
      return;
    }
    const pid = crypto.randomUUID();
    game.players.push({ id: pid, name });
    game.scores[pid] = 0;
    res.end(JSON.stringify({ ok: true, pid, name }));
    broadcast();
    return;
  }

  // Actions -----------------------------------------------------------------
  if (url.pathname === '/action' && req.method === 'POST') {
    const body = await readJsonBody(req);
    handleAction(body.pid, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('\n  🎭  Game of Things is running.\n');
  console.log(`  On this laptop:   http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  On phones (WiFi): http://${ip}:${PORT}`));
  console.log('\n  Everyone must be on the same WiFi. Ctrl+C to stop.\n');
});
