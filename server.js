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
const net = require('net');
const os = require('os');

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
// Same-WiFi guard  (the network boundary)
//
// Only devices on the laptop's own local network may load the app or play.
// Every request must pass three checks (failures get a generic "not allowed"
// page that gives no hint about WiFi or how to get in):
//   1. The connecting IP is loopback, or inside one of the laptop's local
//      subnets (IPv4 must also be a private/link-local range).
//   2. No proxy/tunnel forwarding headers (ngrok, Cloudflare Tunnel, reverse
//      proxies relay internet traffic from 127.0.0.1 and add these).
//   3. The Host header is an IP literal, `localhost`, a bare machine name, or an
//      mDNS `*.local` name — never a public domain (blocks tunnels + DNS rebinding).
// Subnets are re-read on each request, so switching WiFi networks just works.
// ---------------------------------------------------------------------------

const FORWARD_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
];

// IPv4/IPv6 string -> array of 4 or 16 bytes (IPv4-mapped IPv6 -> 4 bytes), or null.
function ipToBytes(ip) {
  ip = String(ip || '').split('%')[0]; // drop IPv6 zone id, e.g. fe80::1%en0
  if (net.isIPv4(ip)) return ip.split('.').map(Number);
  if (!net.isIPv6(ip)) return null;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1].split('.').map(Number);
  const [head, tail] = ip.split('::');
  const expand = (str) =>
    (str ? str.split(':') : []).flatMap((g) => {
      if (!g.includes('.')) return [g];
      const b = g.split('.').map(Number); // embedded IPv4 tail
      return [((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)];
    });
  const h = expand(head);
  const t = tail === undefined ? [] : expand(tail);
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

function inSubnet(addr, netAddr, prefix) {
  if (addr.length !== netAddr.length) return false;
  for (let i = 0; i < addr.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    if (bits === 0) return true;
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((addr[i] & mask) !== (netAddr[i] & mask)) return false;
  }
  return true;
}

const isLoopback = (b) => (b.length === 4 ? b[0] === 127 : b.every((x, i) => x === (i === 15 ? 1 : 0)));

// RFC 1918 private + 169.254/16 link-local.
const isPrivateV4 = (b) =>
  b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254);

// The laptop's own (non-loopback) networks, from its network interfaces.
function localSubnets(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces)) {
    for (const n of list || []) {
      if (n.internal || !n.cidr) continue;
      const [addr, prefix] = n.cidr.split('/');
      const bytes = ipToBytes(addr);
      if (bytes) out.push({ bytes, prefix: Number(prefix) });
    }
  }
  return out;
}

function isSameNetwork(remoteIp, subnets = localSubnets()) {
  const b = ipToBytes(remoteIp);
  if (!b) return false;
  if (isLoopback(b)) return true;
  if (b.length === 4 && !isPrivateV4(b)) return false;
  return subnets.some(
    (s) => s.bytes.length === b.length && (b.length === 4 || s.prefix >= 64) && inSubnet(b, s.bytes, s.prefix)
  );
}

function isAllowedHost(hostHeader) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']')); // [ipv6]:port
  else host = host.replace(/:\d+$/, '');
  if (net.isIP(host.split('%')[0])) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  return /^[a-z0-9-]+$/.test(host); // bare machine name (no public domain)
}

function isRequestAllowed(req, subnets) {
  if (FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  if (!isAllowedHost(req.headers.host)) return false;
  return isSameNetwork(req.socket.remoteAddress, subnets);
}

const warnedIps = new Set();
function rejectOffNetwork(req, res) {
  const ip = req.socket.remoteAddress;
  if (!warnedIps.has(ip)) {
    warnedIps.add(ip);
    console.log(`  ⛔  Blocked a device that isn't on this WiFi (${ip}, host "${req.headers.host || ''}").`);
  }
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  // Deliberately generic: no mention of WiFi, the game, or how to get in, so a
  // blocked visitor learns nothing useful about the network or the app.
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Not allowed</title>' +
      '<body style="font-family:system-ui,sans-serif;background:#1a1420;color:#f3e9d2;padding:2rem;line-height:1.5">' +
      '<h1>Sorry, you are not allowed in.</h1></body>'
  );
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
  if (!isRequestAllowed(req)) {
    rejectOffNetwork(req, res);
    return;
  }
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

if (require.main === module) {
  server.listen(PORT, () => {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const n of nets[name]) {
        if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
      }
    }
    console.log('\n  🎭  Game of Things is running.\n');
    console.log(`  On this laptop:   http://localhost:${PORT}`);
    ips.forEach((ip) => console.log(`  On phones (WiFi): http://${ip}:${PORT}`));
    console.log('\n  Only devices on this WiFi can connect. Ctrl+C to stop.\n');
  });
}

// Exported for tests only.
module.exports = { server, ipToBytes, inSubnet, localSubnets, isSameNetwork, isAllowedHost, isRequestAllowed };
