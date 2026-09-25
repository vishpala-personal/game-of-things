# Architecture & technical decisions

The *how-it's-built* record for the Game of Things companion app. For *what* to
build (requirements and gameplay decisions) see `REQUIREMENTS.md`; for how to run
it see `README.md`; for the running build log see `CHANGELOG.md`.

## Overview

A single Node process serves the static client and holds all game state in
memory. There is one game/room.

```
  Phone (browser)                          Laptop (node server.js)
  ┌───────────────────┐                    ┌────────────────────────────┐
  │ public/index.html │  GET / , /*.css,js │  serveStatic (public/)     │
  │ public/app.js     │◀───────────────────│                            │
  │  · localStorage   │                    │  Game state (in memory)    │
  │    pid            │  GET /events?pid=   │  · players, order, scores  │
  │  · ui: selection, │◀───────SSE─────────│  · round: answers/elimin\  │
  │    answer draft   │  (server pushes a   │    ated/currentGuesser…    │
  │                   │   per-player VIEW)  │                            │
  │                   │                    │  viewFor(pid): filters      │
  │                   │  POST /join         │  secrets per player        │
  │                   │───────────────────▶│  POST /action → mutate →    │
  │                   │  POST /action       │  broadcast() re-pushes      │
  └───────────────────┘                    └────────────────────────────┘
```

Flow: client sends an **action** (`POST /action`); the server mutates the single
state object, then `broadcast()` recomputes a **per-player view** and pushes it to
every open SSE connection. Clients never mutate state directly — they only render
whatever view they receive.

## Decisions

Rationale and trade-offs are recorded so future changes are made with eyes open.

### A1. Vanilla stack, no build step

Plain HTML/CSS/JS client + a single `server.js`; no framework, bundler, or
transpiler. **Why:** the app is small and the toolchain cost isn't worth it —
files are served as-is and edited directly. **Trade-off:** manual DOM rendering
(no reactivity library); acceptable at this size.

### A2. Zero runtime dependencies (pure Node core only)

The server uses only Node built-ins (`http`, `fs`, `crypto`, `os`). **Why:**
`node server.js` runs with nothing to install, so it works on a laptop with no
internet and no `npm install` step — important for LAN/offline game night.
**Trade-off:** we hand-roll a little plumbing (SSE framing, static serving,
JSON body parsing) instead of using Express/ws.

### A3. Transport — SSE (server→client) + `POST /action` (client→server)

Real-time updates are pushed over **Server-Sent Events**; client actions are
plain `POST /action` requests. **Why not WebSocket:** the data flow is
broadcast-shaped — the server owns the state and pushes authoritative per-player
views; clients only fire discrete actions. SSE fits that, needs no dependency
(WebSocket would pull in `ws`), and `EventSource` auto-reconnects for free.
**Trade-off:** two channels instead of one duplex socket; negligible here.

### A4. Server-authoritative state; per-player views are the privacy boundary

The server holds the single source of truth and computes a **separate view
object per connected player**, containing only what that player may see. Secrets
(answer authorship; who submitted and when) are **never serialized to a client
that shouldn't have them** — e.g. a bystander's `slips` are `null`, and an
answer's true author is omitted until a correct guess or the end-of-round reveal.
**Why:** privacy must not depend on the client hiding data it already received.
This is the most important decision in the codebase; preserve it — never move
secret filtering into the client.

### A5. In-memory, single-room state

One global game object in memory; no database, no rooms. **Why:** 4 colocated
friends, one game at a time, ephemeral rounds — persistence adds no value.
**Trade-offs:** restarting `server.js` wipes the game; only one concurrent game
can run. If multi-room or history is ever needed, this is the thing to revisit.

### A6. Identity & reconnect

On join the server issues a UUID (`crypto.randomUUID`); the client stores it in
`localStorage` and reconnects with it. **Why:** a phone refresh rejoins the same
seat. If the server restarted (pid unknown), `/events` returns a `reset` signal
and the client clears identity and shows the join screen.

### A7. Client rendering — full re-render from each pushed view

On every pushed view the client re-renders the relevant screen from scratch;
ephemeral UI (current selection, in-progress answer text) lives in a small local
`ui` object and is re-applied. One guard: **do not re-render the answer textarea
while the player is still typing** (other players submitting would otherwise wipe
their draft). **Why:** simplest correct model for an app this size.

### A8. 30-second banner — server timer + monotonic token

A resolved guess is flashed on the reader's board for 30s, then cleared by a
server-side timer that re-broadcasts. Each guess carries a monotonically
increasing token; the clear only fires if the current banner still matches that
token, so a newer guess within the window is never clobbered by an older timer.

### A9. Static serving

Files under `public/` are served directly, with a path-traversal guard
(resolved path must stay within `public/`) and `Cache-Control: no-store` so
clients always load the latest build.

## Known limitations / non-goals (current)

- **No auth / trust model.** Anyone on the LAN who knows a pid can act as that
  player. Acceptable for friends in one room; revisit before any public hosting.
- **No persistence** across server restart.
- **Single game/room** only.
- **No forced round termination** if every player keeps guessing wrong — the
  round loops until someone is correct (mirrors the physical game).
- **Fonts load from Google Fonts CDN** with local fallbacks; fully offline play
  falls back to Courier/Georgia.
