'use strict';

/* Game of Things — client. Renders whatever per-player VIEW the server pushes.
   The client trusts the server for all secrets; it only draws + sends actions. */

const app = document.getElementById('app');

// ---- identity (survives refresh) -----------------------------------------
let pid = localStorage.getItem('got_pid') || '';
let myName = localStorage.getItem('got_name') || '';
let es = null;

// ---- ephemeral UI state ----------------------------------------------------
const ui = { answerText: '', selAnswer: null, selSuspect: null };
let currentScreen = '';

// ---- helpers ---------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AVATAR_COLORS = ['#e8b23a', '#e0472f', '#7aa15b', '#d98a4e', '#c98fb0', '#6fa6b5', '#d6c27a', '#b57f5a'];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}
function avatar(name) {
  const initials = name.trim().slice(0, 2).toUpperCase();
  return `<span class="avatar" style="background:${avatarColor(name)}">${esc(initials)}</span>`;
}

async function act(type, extra = {}) {
  await fetch('/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, type, ...extra }),
  });
}

// ---- connection ------------------------------------------------------------
function connect() {
  es = new EventSource('/events?pid=' + encodeURIComponent(pid));
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'reset') {
      es.close();
      localStorage.removeItem('got_pid');
      pid = '';
      renderJoin();
      return;
    }
    if (msg.type === 'view') render(msg);
  };
  es.onerror = () => {}; // EventSource auto-retries
}

async function doJoin(name) {
  const res = await fetch('/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pid }),
  });
  const data = await res.json();
  if (!data.ok) return data.error || 'Could not join.';
  pid = data.pid;
  myName = data.name;
  localStorage.setItem('got_pid', pid);
  localStorage.setItem('got_name', myName);
  connect();
  return null;
}

// ===========================================================================
// Screens
// ===========================================================================

function renderJoin(errMsg) {
  currentScreen = 'join';
  app.className = 'app center-screen';
  app.innerHTML = `
    <div class="stack fade-in">
      <div>
        <div class="eyebrow">A party guessing game</div>
        <h1 class="logo">Game of<br /><em>Things</em></h1>
        <div class="title-underline"></div>
      </div>
      <p class="sub">No more handwriting tells. Type your answer, keep a straight face,
        and try not to get caught.</p>
      <input class="field" id="nameInput" placeholder="Your name" maxlength="24"
             value="${esc(myName)}" autocomplete="off" style="font-family:var(--font-ui)" />
      ${errMsg ? `<div class="error">${esc(errMsg)}</div>` : ''}
      <button class="btn" data-action="join">Join the table</button>
      <p class="note">Everyone on the same WiFi opens this page.</p>
    </div>`;
  const input = document.getElementById('nameInput');
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
}

async function submitJoin() {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return renderJoin('Please enter a name.');
  const err = await doJoin(name);
  if (err) renderJoin(err);
}

function rosterCard(view, { title } = {}) {
  const rows = view.players
    .map((p, i) => {
      const tags = [];
      if (p.isReader) tags.push('<span class="tag reader">Reader</span>');
      if (p.isCurrentGuesser) tags.push('<span class="tag turn">Guessing</span>');
      if (p.eliminated) tags.push('<span class="tag out">Out</span>');
      return `<div class="roster-row ${p.eliminated ? 'dim' : ''}">
          <span class="serial">${i + 1}</span>
          ${avatar(p.name)}
          <span class="name">${esc(p.name)}${p.id === view.you.id ? ' <small style="color:var(--muted)">(you)</small>' : ''}</span>
          ${tags.join(' ')}
          <span class="score">${p.score}</span>
        </div>`;
    })
    .join('');
  return `<div class="card">
      ${title ? `<div class="card-head"><span class="eyebrow dim">${title}</span></div>` : ''}
      <div class="roster">${rows}</div>
    </div>`;
}

function topbar(view) {
  return `<div class="topbar">
      <span class="eyebrow">Game of Things</span>
      <span class="round-chip">Round ${view.roundNumber}</span>
    </div>`;
}

// ---- Seating table (lobby + pick-reader) -----------------------------------
// One row per player in seat order (= serial no. = guessing order). Drag the
// ⠿ handle to move someone; tap Reader to designate. The "Guesses" column shows
// the resulting guessing order: the seat after the Reader goes 1st, and the
// Reader guesses last.
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function guessOrder(view) {
  const n = view.players.length;
  const r = view.players.findIndex((p) => p.isReader);
  if (r < 0) return null;
  return view.players.map((_, i) => ((i - r - 1 + n) % n) + 1);
}

function seatingCard(view, noteHtml) {
  const order = guessOrder(view);
  const rows = view.players
    .map(
      (p, i) => `<div class="seat-row ${p.isReader ? 'is-reader' : ''}" data-seat-id="${p.id}">
        <span class="drag-handle" data-drag-handle aria-label="Drag to reorder ${esc(p.name)}" title="Drag to reorder">⠿</span>
        <span class="seat-no">${i + 1}</span>
        <span class="seat-player">${avatar(p.name)}<span class="name">${esc(p.name)}${
          p.id === view.you.id ? '<small>you</small>' : ''
        }<small class="guess-inline">${order ? `guesses ${ordinal(order[i])}` : ''}</small></span></span>
        <span class="seat-guess">${order ? ordinal(order[i]) : '—'}</span>
        <button class="btn small seat-reader ${p.isReader ? 'gold' : 'ghost'}" data-action="setReader" data-id="${p.id}">
          ${p.isReader ? 'Reader ✓' : 'Reader'}
        </button>
      </div>`
    )
    .join('');
  let flow = '<p class="seat-flow muted">Pick a Reader to see the guessing order.</p>';
  if (order) {
    const seq = view.players
      .map((p, i) => ({ p, k: order[i] }))
      .sort((a, b) => a.k - b.k)
      .map(({ p }) => `<span class="${p.isReader ? 'flow-reader' : ''}">${esc(p.name)}${p.isReader ? ' (reader)' : ''}</span>`)
      .join(' <span class="flow-arrow">→</span> ');
    flow = `<p class="seat-flow"><span class="eyebrow dim">Guessing order</span><br />${seq}</p>`;
  }
  return `<div class="card">
      <div class="seat-table" id="seatTable">
        <div class="seat-head"><span></span><span>#</span><span>Player</span><span>Guesses</span><span></span></div>
        ${rows}
      </div>
      ${flow}
      ${noteHtml ? `<p class="note" style="margin-top:10px">${noteHtml}</p>` : ''}
    </div>`;
}

// ---- Lobby -----------------------------------------------------------------
function renderLobby(view) {
  currentScreen = 'lobby';
  app.className = 'app';
  const readerNo = view.players.findIndex((p) => p.isReader) + 1;
  const startLabel =
    view.players.length < 2
      ? 'Need at least 2 players'
      : !readerNo
      ? 'Pick a reader to start'
      : `Start the game → #${readerNo} reads`;
  app.innerHTML = `
    <div class="stack fade-in">
      <div>
        <div class="eyebrow">Waiting to start</div>
        <h1 class="logo" style="font-size:clamp(2rem,10vw,3rem)">The <em>Table</em></h1>
        <div class="title-underline"></div>
      </div>
      ${seatingCard(
        view,
        'Drag <strong>⠿</strong> to match where people sit. Tap <strong>Reader</strong> for whoever reads first — the next seat guesses first.'
      )}
      <div>
        <div class="eyebrow dim" style="margin-bottom:8px">Last player standing scores</div>
        <div class="pill-row">
          <button class="pill ${view.lastStandingPoints === 3 ? 'active' : ''}" data-action="points" data-p="3">3 points</button>
          <button class="pill ${view.lastStandingPoints === 2 ? 'active' : ''}" data-action="points" data-p="2">2 points</button>
        </div>
      </div>
      <button class="btn gold" data-action="start" ${view.canStart ? '' : 'disabled'}>${startLabel}</button>
      <p class="note">Others join at <strong>${esc(location.host)}</strong></p>
    </div>`;
}

// ---- Pick reader (start of every round) ------------------------------------
function renderPickReader(view) {
  currentScreen = 'pickReader';
  app.className = 'app';
  app.innerHTML = `
    <div class="stack fade-in">
      <div class="topbar">
        <span class="eyebrow">Game of Things</span>
        <span class="round-chip">Round ${view.roundNumber + 1}</span>
      </div>
      <div>
        <div class="eyebrow">New round</div>
        <h2 class="section">Who's the reader?</h2>
        <p class="sub" style="margin-top:4px">Anyone can pick. The reader reads the card aloud, then everyone — reader included — answers. The next number guesses first.</p>
      </div>
      ${seatingCard(view, 'Drag <strong>⠿</strong> if anyone changed seats.')}
      <button class="btn gold" data-action="beginRound" ${view.canBegin ? '' : 'disabled'}>
        ${view.canBegin ? `Start round → ${esc(view.reader.name)} reads` : 'Pick a reader to start'}
      </button>
    </div>`;
}

// ---- Answering -------------------------------------------------------------
function renderAnswering(view) {
  app.className = 'app';
  const reader = view.reader ? view.reader.name : '';
  if (!view.you.submitted) {
    currentScreen = 'answerInput';
    app.innerHTML = `
      <div class="stack fade-in">
        ${topbar(view)}
        <div>
          <div class="eyebrow">${view.you.isReader ? "You're the Reader — read the card aloud" : `${esc(reader)} is reading the card`}</div>
          <h2 class="section">Write your answer</h2>
          <p class="sub" style="margin-top:6px">Make it funny. Make it hard to pin on you.</p>
        </div>
        <textarea class="field" id="answerInput" placeholder="Type your thing…" maxlength="240">${esc(ui.answerText)}</textarea>
        <button class="btn" data-action="submitAnswer">Submit answer</button>
        <p class="note">Everyone's answers appear at once — no one sees who finished first.</p>
      </div>`;
    const ta = document.getElementById('answerInput');
    ta.focus();
    ta.addEventListener('input', () => (ui.answerText = ta.value));
    return;
  }
  currentScreen = 'answerWait';
  app.innerHTML = `
    <div class="stack fade-in">
      ${topbar(view)}
      <div class="spacer"></div>
      <div class="status-hero">
        <div class="pulse-dot"></div>
        <div class="counter">${view.submittedCount}<small> / ${view.totalCount}</small></div>
        <div class="big">Answers are<br /><em>coming in…</em></div>
        <p class="sub">Sit tight. The reader reveals everything together.</p>
      </div>
      <div class="spacer"></div>
    </div>`;
}

// ---- Guessing --------------------------------------------------------------
function feedbackBlock(fb) {
  if (!fb) return '';
  if (fb.correct) {
    return `<div class="banner correct" style="margin-bottom:4px">
        <div class="verdict">Correct!</div>
        <div class="detail">Slip #${fb.num} was <strong>${esc(fb.revealName)}</strong> — guess again.</div>
      </div>`;
  }
  return `<div class="banner wrong" style="margin-bottom:4px">
      <div class="verdict">Wrong</div>
      <div class="detail">Slip #${fb.num} wasn't ${esc(fb.suspectName)}. Turn passes.</div>
    </div>`;
}

function slipList(view, { selectable }) {
  const bannerId = view.banner && view.banner.correct ? view.banner.answerId : null;
  return `<div class="slips">${view.slips
    .map((s, i) => {
      const tilt = (i % 2 === 0 ? -1 : 1) * (0.4 + (i % 3) * 0.35);
      const flashed = s.id === bannerId;
      const sel = selectable && ui.selAnswer === s.id;
      return `<div class="slip ${selectable ? 'selectable' : ''} ${sel ? 'selected' : ''} ${flashed ? 'revealed' : ''}"
           style="--tilt:${tilt}deg;--delay:${i * 0.05}s" data-num="${s.num}"
           ${selectable ? `data-action="pickAnswer" data-id="${s.id}"` : ''}>
          ${esc(s.text)}
          ${flashed ? `<span class="stamp">✓ ${esc(view.banner.revealName)}</span>` : ''}
        </div>`;
    })
    .join('')}</div>`;
}

function guessControls(view) {
  const names = view.guessTargets
    .map(
      (t) => `<button class="name-chip ${ui.selSuspect === t.id ? 'selected' : ''}" data-action="pickSuspect" data-id="${t.id}">
        ${avatar(t.name)}<span>${esc(t.name)}</span>
      </button>`
    )
    .join('');
  const ready = ui.selAnswer && ui.selSuspect;
  return `
    <div>
      <div class="eyebrow dim" style="margin:14px 0 8px">Who wrote it?</div>
      <div class="name-grid">${names}</div>
    </div>
    <button class="btn" data-action="submitGuess" ${ready ? '' : 'disabled'}>
      ${ready ? 'Lock in guess' : 'Pick a slip and a name'}
    </button>`;
}

function renderGuessing(view) {
  app.className = 'app';
  if (!view.canGuess) {
    ui.selAnswer = null;
    ui.selSuspect = null;
  }
  const isReader = view.you.isReader;
  const isTurn = view.canGuess;

  // Reader board (always sees slips) — may also be their turn.
  if (isReader) {
    currentScreen = 'guessReader';
    const banner = view.banner
      ? `<div class="banner ${view.banner.correct ? 'correct' : 'wrong'}">
            <div class="verdict">${view.banner.correct ? 'Correct!' : 'Wrong'}</div>
            <div class="detail">${esc(view.banner.guesserName)} guessed slip #${view.banner.num}${
          view.banner.correct
            ? ` — that was <strong>${esc(view.banner.revealName)}</strong>`
            : ` was ${esc(view.banner.suspectName)}`
        }.</div>
            <div class="ttl"></div>
          </div>`
      : '';
    app.innerHTML = `
      <div class="stack fade-in">
        ${topbar(view)}
        <div>
          <div class="eyebrow">Reader's board</div>
          <h2 class="section">${isTurn ? 'Your turn to guess' : `${esc(view.currentGuesser.name)} is guessing`}</h2>
          <p class="sub" style="margin-top:4px">Read each slip aloud. Guesses flash here for 30s, then fade — after that it's all memory.</p>
        </div>
        ${banner}
        ${isTurn ? feedbackBlock(view.yourLastGuess) : ''}
        ${slipList(view, { selectable: isTurn })}
        ${isTurn ? guessControls(view) : ''}
        ${rosterCard(view, { title: 'Scores' })}
      </div>`;
    return;
  }

  // Active guesser (non-reader)
  if (isTurn) {
    currentScreen = 'guessTurn';
    app.innerHTML = `
      <div class="stack fade-in">
        ${topbar(view)}
        <div>
          <div class="eyebrow">Your turn</div>
          <h2 class="section">Pin down a slip</h2>
          <p class="sub" style="margin-top:4px">Some slips may already be solved — pick a wrong one and you waste your turn.</p>
        </div>
        ${feedbackBlock(view.yourLastGuess)}
        ${slipList(view, { selectable: true })}
        ${guessControls(view)}
      </div>`;
    return;
  }

  // Bystander — no slips shown
  currentScreen = 'guessWait';
  app.innerHTML = `
    <div class="stack fade-in">
      ${topbar(view)}
      ${feedbackBlock(view.yourLastGuess)}
      <div class="status-hero">
        <div class="pulse-dot"></div>
        <div class="big">${esc(view.currentGuesser.name)} is<br /><em>guessing…</em></div>
        <p class="sub">Answers are hidden on your screen. Remember who's already been caught — you'll need it on your turn.</p>
      </div>
      ${rosterCard(view, { title: 'Scores' })}
    </div>`;
}

// ---- Round end -------------------------------------------------------------
function renderRoundEnd(view) {
  currentScreen = 'roundEnd';
  app.className = 'app';
  const reveal = view.reveal
    .map(
      (r) => `<div class="reveal-slip slip ${view.winner && r.authorId === view.winner.id ? 'win' : 'revealed'}"
         style="--tilt:0deg" data-num="${r.num}">
        <span>${esc(r.text)}</span>
        <span class="by">— ${esc(r.authorName)}</span>
      </div>`
    )
    .join('');
  const scores = view.roundScores
    .filter((s) => s.delta > 0)
    .map((s) => `<div class="roster-row"><span class="name">${esc(s.name)}</span><span class="score">+${s.delta}</span></div>`)
    .join('');
  app.innerHTML = `
    <div class="stack fade-in">
      ${topbar(view)}
      <div class="winner-crown">
        <div class="eyebrow">Last one standing</div>
        <div class="who">${view.winner ? esc(view.winner.name) : '—'}</div>
        <p class="note">+${view.lastStandingPoints} points for never getting caught</p>
      </div>
      <div class="card">
        <div class="card-head"><span class="eyebrow dim">The reveal</span></div>
        <div class="slips">${reveal}</div>
      </div>
      ${scores ? `<div class="card"><div class="card-head"><span class="eyebrow dim">Points this round</span></div><div class="roster">${scores}</div></div>` : ''}
      ${rosterCard(view, { title: 'Total scores' })}
      <button class="btn gold" data-action="nextRound">Next round → pick a reader</button>
    </div>`;
}

// ===========================================================================
// Router
// ===========================================================================
let lastView = null;
function render(view) {
  lastView = view;
  // Mid-drag: hold the update and apply it on drop (re-rendering would cancel the drag).
  if (drag) return;
  // Don't blow away the answer textarea while the player is still typing.
  if (view.phase === 'answering' && !view.you.submitted && currentScreen === 'answerInput') return;

  if (view.phase === 'lobby') return renderLobby(view);
  if (view.phase === 'pickReader') return renderPickReader(view);
  if (view.phase === 'answering') return renderAnswering(view);
  if (view.phase === 'guessing') return renderGuessing(view);
  if (view.phase === 'roundEnd') return renderRoundEnd(view);
}

// ===========================================================================
// Delegated events
// ===========================================================================
app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;

  switch (a) {
    case 'join':
      return submitJoin();
    case 'points':
      return act('setPoints', { points: Number(t.dataset.p) });
    case 'start':
      return act('startGame');
    case 'setReader':
      return act('setReader', { readerId: t.dataset.id });
    case 'beginRound':
      return act('beginRound');
    case 'submitAnswer': {
      const text = document.getElementById('answerInput').value.trim();
      if (!text) return;
      ui.answerText = '';
      return act('submitAnswer', { text });
    }
    case 'pickAnswer':
      ui.selAnswer = t.dataset.id;
      return reflectGuessSelection();
    case 'pickSuspect':
      ui.selSuspect = t.dataset.id;
      return reflectGuessSelection();
    case 'submitGuess': {
      if (!ui.selAnswer || !ui.selSuspect) return;
      const payload = { answerId: ui.selAnswer, suspectId: ui.selSuspect };
      ui.selAnswer = null;
      ui.selSuspect = null;
      return act('guess', payload);
    }
    case 'nextRound':
      return act('nextRound');
  }
});

// Update selection styling locally without waiting for a server round-trip.
function reflectGuessSelection() {
  document.querySelectorAll('.slip.selectable').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === ui.selAnswer);
  });
  document.querySelectorAll('.name-chip').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === ui.selSuspect);
  });
  const btn = document.querySelector('[data-action="submitGuess"]');
  if (btn) {
    const ready = ui.selAnswer && ui.selSuspect;
    btn.disabled = !ready;
    btn.textContent = ready ? 'Lock in guess' : 'Pick a slip and a name';
  }
}

// ===========================================================================
// Drag-and-drop seating (Pointer Events: works with mouse, iPhone and Android)
// ===========================================================================
let drag = null;

app.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag-handle]');
  if (!handle || drag) return;
  const row = handle.closest('.seat-row');
  const rows = [...document.querySelectorAll('#seatTable .seat-row')];
  if (rows.length < 2) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const rects = rows.map((r) => r.getBoundingClientRect());
  drag = {
    pointerId: e.pointerId,
    handle,
    row,
    rows,
    mids: rects.map((r) => r.top + r.height / 2),
    rowH: rects[1].top - rects[0].top,
    from: rows.indexOf(row),
    to: rows.indexOf(row),
    startY: e.clientY,
  };
  row.classList.add('dragging');
  document.getElementById('seatTable').classList.add('is-sorting');
});

app.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  const dy = e.clientY - drag.startY;
  drag.row.style.transform = `translateY(${dy}px)`;
  const center = drag.mids[drag.from] + dy;
  let to = drag.from;
  while (to < drag.rows.length - 1 && center > drag.mids[to + 1]) to++;
  while (to > 0 && center < drag.mids[to - 1]) to--;
  if (to !== drag.to) previewOrder(drag.from, to);
  drag.to = to;
  drag.rows.forEach((r, i) => {
    if (r === drag.row) return;
    let shift = 0;
    if (drag.from < to && i > drag.from && i <= to) shift = -drag.rowH;
    if (drag.from > to && i < drag.from && i >= to) shift = drag.rowH;
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
});

// While dragging, renumber seats and recompute the Guesses column as if dropped here.
function previewOrder(from, to) {
  if (!lastView) return;
  const players = lastView.players.slice();
  const [p] = players.splice(from, 1);
  players.splice(to, 0, p);
  const order = guessOrder({ players });
  drag.rows.forEach((row) => {
    const i = players.findIndex((x) => x.id === row.dataset.seatId);
    row.querySelector('.seat-no').textContent = i + 1;
    row.querySelector('.seat-guess').textContent = order ? ordinal(order[i]) : '—';
    row.querySelector('.guess-inline').textContent = order ? `guesses ${ordinal(order[i])}` : '';
  });
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { row, from, to } = drag;
  const id = row.dataset.seatId;
  drag = null;
  if (to !== from && lastView) {
    // Show the new order immediately; the server's broadcast confirms it.
    const players = lastView.players.slice();
    const [p] = players.splice(from, 1);
    players.splice(to, 0, p);
    render({ ...lastView, players });
    act('movePlayer', { playerId: id, toIndex: to });
  } else if (lastView) {
    render(lastView); // also applies any update that arrived mid-drag
  }
}
app.addEventListener('pointerup', endDrag);
app.addEventListener('pointercancel', endDrag);

// ===========================================================================
// Boot
// ===========================================================================
if (pid) connect();
else renderJoin();
