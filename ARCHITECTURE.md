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

### A7a. Drag-to-reorder seating

Custom drag built on **Pointer Events** (one code path for mouse, iPhone and
Android — HTML5 drag-and-drop doesn't work on touch). The handle has
`touch-action: none` so a finger drags the row instead of scrolling the page.
While a drag is in progress, incoming server views are **held** (re-rendering
would cancel the drag) and applied on drop. The client sends a single
`movePlayer {playerId, toIndex}` action, not a whole new order, so a join or
another player's move that happens at the same time isn't overwritten. The
server only accepts it in `lobby`/`pickReader`. The dropped order is shown
immediately; the broadcast confirms it.

### A8. 30-second banner — server timer + monotonic token

A resolved guess is flashed on the reader's board for 30s, then cleared by a
server-side timer that re-broadcasts. Each guess carries a monotonically
increasing token; the clear only fires if the current banner still matches that
token, so a newer guess within the window is never clobbered by an older timer.

### A9. Static serving

Files under `public/` are served directly, with a path-traversal guard
(resolved path must stay within `public/`) and `Cache-Control: no-store` so
clients always load the latest build.

### A10. Same-WiFi network guard

Every HTTP request (page, static files, `/join`, `/events`, `/action`) passes
`isRequestAllowed()` first, or gets a 403 page reading only "Sorry, you are not
allowed in." — no mention of WiFi, the app, or how to get access, so a blocked
visitor learns nothing useful for an intrusion attempt. Three checks:

1. **Source IP on a local subnet.** The socket's remote address must be
   loopback, or inside a subnet of one of the laptop's non-internal network
   interfaces (`os.networkInterfaces()` `cidr`). IPv4 must additionally be a
   private/link-local range (10/8, 172.16/12, 192.168/16, 169.254/16), so a
   laptop with a public-IP interface doesn't admit its ISP neighbours; IPv6 only
   matches subnets of /64 or narrower. IPv4-mapped IPv6 and zone ids are handled.
   Subnets are re-read per request, so changing WiFi needs no restart.
2. **No forwarding headers** (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
   `CF-Connecting-IP`, `True-Client-IP`). Tunnels relay internet traffic from
   `127.0.0.1`, which would otherwise pass check 1.
3. **Host header is local-looking** — an IP literal, `localhost`, a bare machine
   name, or an mDNS `*.local` name. Public domains (e.g. `*.ngrok-free.app`) are
   rejected; this also blocks DNS-rebinding attacks from web pages.

**Why at the server:** it's the only place that sees the real socket address.
**Trade-offs / limits:** a determined user on the laptop could run a tunnel that
strips headers and rewrites Host — the guard stops accidental or casual exposure,
not the host themselves. VPN interfaces with broad subnets on the laptop could
admit peers on that VPN. Guest-network client isolation is the router's concern.
Pure helpers are exported (`module.exports`) for tests; `listen()` only runs when
`server.js` is executed directly.

### A11. Startup URL — Bonjour name, port 80, terminal QR

IP addresses change, so the banner leads with `http://<LocalHostName>.local`
(read via `scutil --get LocalHostName` on macOS; `os.hostname()` elsewhere).
macOS's own mDNS responder already advertises that name, so we add no mDNS code.
Port **80** by default (macOS allows unprivileged binds since 10.14) so the URL
has no port; on `EACCES`/`EADDRINUSE` it falls back to 3000. An explicit `PORT`
env disables the fallback. A QR code of the current IP URL is printed with
half-block characters (forced black-on-white ANSI colours so it scans on dark
terminals) for phones that can't resolve `.local` (some Androids).

**QR encoder (`qr.js`):** hand-written, zero-dependency (consistent with A2) —
byte mode, ECC level M, versions 1–6 (≤106 bytes), all 8 masks scored by the
standard penalty rules. Verified bit-for-bit against the Python `qrcode`
library and decoded by OpenCV and zbar. `child_process` (for `scutil`) is a Node
built-in, so A2 still holds.

## Known limitations / non-goals (current)

- **No auth / trust model.** Anyone on the LAN who knows a pid can act as that
  player. Acceptable for friends in one room; revisit before any public hosting.
  (Off-network devices are blocked entirely — see A10.)
- **No persistence** across server restart.
- **Single game/room** only.
- **No forced round termination** if every player keeps guessing wrong — the
  round loops until someone is correct (mirrors the physical game).
- **Fonts load from Google Fonts CDN** with local fallbacks; fully offline play
  falls back to Courier/Georgia.
