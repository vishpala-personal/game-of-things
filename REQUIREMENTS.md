# Requirements & gameplay decisions

The *what-to-build* spec: the requirements as given, and every product/gameplay
decision that was made. Keep in sync when scope changes. For *how* it's built see
`ARCHITECTURE.md`; for the running build log see `CHANGELOG.md`.

## Context

The Game of Things is an in-person party game. A designated **Reader** draws a
physical topic card and reads it aloud (e.g. "Things you shouldn't say to your
boss"). Every player — including the Reader — writes an answer. The Reader
shuffles and reads all answers aloud twice. Then, going around the table
starting to the Reader's left, players guess who wrote which answer:

- **Correct guess** → the guessed player is eliminated for the round; the active
  player scores 1 point and guesses again.
- **Wrong guess** → the turn passes to the next player on the left.
- The round ends when only one answer is left unidentified; that author scores
  the last-standing points (3 or 2 depending on edition).

**We play with 4 people, all colocated**, and we let the Reader guess too. The
topic card stays physical — the Reader reads it aloud, so the app does **not**
need to manage questions/cards.

**The problem this app solves:** because we all recognize each other's
handwriting, written slips give away the author. The app replaces the paper
slips with anonymous typed submission (and handles guessing + scoring).

## Game structure (hierarchy)

Three nested levels — this is the canonical vocabulary used everywhere:

- **Game** — the whole session. Scores accumulate across all rounds (no reset
  between rounds); the group ends the game whenever they like.
- **Round** — one **Reader** reads one physical **card** (prompt) aloud, and every
  player *including the Reader* submits one answer. A Reader is **designated at
  the start of each round** (see the Reader-designation decision). Points are
  scored within the round. **One card = one round = one answer-and-guessing
  cycle.**
- **Turn** — during a round's guessing phase, each player *including the Reader*
  takes a turn guessing. Players are numbered **1–N by join order**; guessing
  starts with the **next serial number after the Reader** and passes around
  1 → 2 → 3 → …, skipping players already caught. A correct guesser takes another
  turn; a wrong guess ends theirs.

## Requirements (as given)

1. Each player can **join by entering their name**.
2. After the Reader reads the question, each player can **type an answer and
   submit** it.
3. The Reader must **see all answers at the same time** — otherwise timing (who
   finishes typing when) reveals authorship.
4. Initially the Reader sees **only the answers, not the names** of who submitted
   them.
5. There is a control (e.g. a button) per player name for the Reader to **submit
   a guess**. A correct guess **grays out and reveals the actual name**.
6. A **wrong guess does not reveal** the actual answer/author.
7. **Correct answers are not shown to all players.** Each player guesses in turn
   and must remember who has already been correctly guessed — so an inattentive
   player loses their turn/points.

**Devices:** 2 players on iPhone, 2 on Android.

## Decisions

### Platform — web app (not native apps)

Build a **mobile web app**, not native iOS/Android apps. Reasoning: one codebase
serves both platforms and laptops; distribution is just a link (no App Store /
Play Store, dev accounts, installs, or updates); real-time multiplayer is trivial
over the web; and no native-only device features are needed. Optionally
installable as a PWA ("Add to Home Screen").

### Hosting — local laptop over WiFi (for v1)

Run on a laptop on the home WiFi; phones connect to `http://<laptop-ip>:<port>`.
No internet or hosting dependency for now. **Internet hosting (join-by-link, no
laptop) is a possible future step, not built yet.**

### Guardrail — same-WiFi devices only

Only devices on the **same WiFi (local network) as the host laptop** can load
the app, join, or play. Anyone else — reaching the laptop from the internet, a
different network, a VPN, or through a tunnel/port-forward (ngrok, Cloudflare
Tunnel, etc.) — gets a plain **"Sorry, you are not allowed in."** page and
cannot interact with the game. The page deliberately gives **no hint** about
WiFi, the game, or how to get in, so it doesn't invite attempts to break into
the network. The laptop itself (`localhost`) is always allowed. No setting turns this
off; internet hosting (backlog) would need to revisit it deliberately.

### Joining — simple, stable URL + QR code

The laptop's IP address changes, so phones shouldn't depend on it. At startup
the server prints:

- a **name URL** from the Mac's Bonjour name, e.g. `http://gamenight.local` —
  stable across IP changes (set once in macOS Sharing settings);
- a **QR code** in the Terminal (encoding the current IP URL) for phones that
  can't open `.local` names (some Androids) or to skip typing;
- the raw **IP URL** as a last resort.

It runs on port **80** so URLs have no `:port`; if 80 is unavailable it falls
back to 3000.

### Guessing model — each player guesses on their own phone

Players guess on **their own phones**, not via the Reader operating a shared
board. Specifics:

- **Players are numbered 1–N by join order (serial no.)**; guessing follows that
  order.
- On a player's turn, the anonymized answer list appears **on that player's
  screen**. When their guess is **wrong**, the list moves to the **next player's
  screen**. Non-active players see no answers.
- The Reader keeps a **board view** of the slips (they read them aloud).

### Reader designation — chosen each round (not auto-assigned)

- Players join in order (serial 1, 2, 3…) and are shown **sitting around a
  drawn round table**, clockwise from the top — a picture of the real table.
  **Any player can drag a person to the seat where they actually sit** (lobby
  or pick-reader screen; locked during a round). Seat order = guessing order.
  *Supersedes the earlier "no manual reordering" decision, and the interim
  list/table version — the order is far easier to see on a picture.*
- **Tap a person to make them the Reader** (replaces per-row Reader buttons).
- The picture shows the guessing flow: **clockwise arrows** on the table top
  (the arrow leaving the Reader is gold — that's where guessing starts), a gold
  **number badge** on each person (1 = guesses first … Reader = last), and the
  table centre says who reads and who guesses first. A one-line "Guessing
  order: Dan → Ann → Bob → Cat (reader)" sits below. Everything previews live
  while dragging.
- Clockwise on screen = to each person's left at the real table, matching the
  physical rule.
- Each player row shows a **Reader** button that **any player** can press to
  select who reads. The selection is **committed when the round is started**:
  - **Round 1** — the Reader is chosen in the **lobby**; pressing **Start the
    game** commits it and begins the round (no separate screen).
  - **Later rounds** — the Reader is chosen on the **pick-reader screen**;
    pressing **Start round** commits it.
- Choosing a Reader is **required** — Start stays disabled until one is selected.
  There is **no automatic or default Reader** (the old first-joiner /
  auto-rotate behavior is removed).
- The Reader **also takes a guessing turn**.
- **Guessing starts with the next serial number after the Reader** and goes
  around 1 → 2 → 3 → …, **skipping players already caught**.

### Reader's board persistence — everything hides after 30 seconds

After a guess resolves, the Reader's board shows the outcome for **30 seconds,
then hides it** — including correct guesses (the slip flashes the revealed name,
then reverts to a plain anonymized slip). Even the Reader plays largely from
memory; the board stays minimal. (The server still tracks elimination truth
underneath for turn order and the win condition — only the *display* hides.)

This refines requirement 5/6: the gray-out + name reveal on a correct guess is
**transient (30s)**, not permanent. Wrong guesses never reveal the true author.

### Memory mechanic — see all, wrong = wasted turn

When it's a player's turn, they see the **full anonymized list including
already-solved slips**, and can pick **any slip + any name** (including
eliminated players). Picking an already-solved slip or an eliminated player
counts as a **wrong guess and passes the turn**. Maximum memory pressure — this
implements requirement 7.

### Scoring

- +1 per correct guess to the guesser.
- Last player standing (only unclaimed answer) scores the last-standing points,
  configurable at game start as **3 or 2**.
- Running scoreboard is tracked across rounds within a game session.

## Not yet built (backlog)

- Internet hosting (join-by-link, no laptop).
- In-app topic cards.
- Persistent history / leaderboard across sessions.
