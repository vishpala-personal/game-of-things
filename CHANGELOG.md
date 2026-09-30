# Changelog

Running build log, newest first. Each entry: what changed and why. Requirements
live in `REQUIREMENTS.md`; architecture in `ARCHITECTURE.md`.

## 2026-09-29

### Changed — seating table with drag-and-drop order
- Lobby and pick-reader screens now show a **seating table** (⠿ handle, seat #,
  player, Guesses column, Reader button) instead of a plain list, plus a
  "Guessing order: A → B → C (reader)" line.
- **Drag ⠿ to change seats** — any player, lobby or between rounds; locked
  during a round. Seat numbers and the Guesses column preview live while
  dragging. New server action `movePlayer {playerId, toIndex}`.
- Phones ≤430px wide hide avatars and show "guesses Nth" under the name, so long
  names aren't cut off or split.
- Reverses the earlier "no manual reordering" decision (see `REQUIREMENTS.md`).
- **Verified** with real-browser tests (Playwright/Chromium) emulating iPhone 13,
  Pixel 7, Galaxy S8 (360px) and desktop, against **Node 22 and Node 24**: mouse
  drag, iPhone + Android touch drag, no page scroll while dragging, live
  preview, drop-in-place = no change, all phones update, a reader change
  arriving mid-drag doesn't break it, no truncated/split names, new order used
  for first guesser, moves ignored mid-round (19 checks). Guard (21) + gameplay
  (7) tests still pass.

### Added — simple phone URL + QR code
- Server now defaults to **port 80** (no `:3000` in URLs), falling back to 3000
  if 80 is busy/not permitted; `PORT` env still overrides.
- Startup banner leads with a stable **name URL** (`http://<mac-name>.local`,
  from macOS's Local hostname) that survives IP changes, then the IP URL(s), and
  prints a scannable **QR code** of the IP URL in the Terminal. Warns if the
  laptop isn't on a network. Until the Mac is renamed, the banner shows a hint
  under the name URL on how to change it to `gamenight.local`.
- New `qr.js`: zero-dependency QR encoder (byte mode, ECC M, v1–6).
- **Verified on Node 22.23.2:** QR output identical to Python `qrcode` for 6 URLs
  × 8 masks; decoded by OpenCV and zbar; port fallback; guard (21) and gameplay
  (7) tests still pass. Also re-run on **Node 24.21.0** (the host Mac's version):
  same results, and port 80 confirmed serving. Fixed during testing: format-area reservation was
  overwriting two timing-pattern modules.

### Added — same-WiFi guardrail
- The server now rejects (403 page: "Sorry, you are not allowed in." — no
  mention of WiFi or how to get access, to avoid inviting intrusion attempts)
  any request that isn't
  from the laptop itself or a device on one of its local subnets, carries
  proxy/tunnel forwarding headers, or uses a non-local Host name. Applies to the
  page, static files, `/join`, `/events` and `/action`. Blocked IPs are logged
  once to the console. See `ARCHITECTURE.md` A10, `REQUIREMENTS.md` guardrail.
- `server.js` only calls `listen()` when run directly and exports the guard
  helpers, so they can be tested without starting the game.
- **Verified on Node 22.23.2:** 21 guard assertions (same/other subnet, public
  IP, VPN peer, loopback, IPv4-mapped + IPv6 link-local/global, forwarding
  headers, foreign Host, live 403s on page/join/SSE) and the 7-assertion
  gameplay smoke test. All passed. (Test harness not kept in the repo.)

## 2026-08-28

### Fixed
- Static client files (`index.html`, `app.js`, `styles.css`) are now served with
  `Cache-Control: no-store` so a browser refresh always loads the latest build.
  (Previously no cache header was sent, so refreshes could reuse a stale
  `app.js` — e.g. serial numbers not appearing after an update.)

### Changed — serial numbers + reader-on-start
- Simplified the turn model to plain **serial numbers (1..N by join order)**;
  removed the ▲▼ manual reordering and the "top→bottom / left of the reader /
  rotates each round" wording.
- Each player row now has a **Reader** button any player can toggle. The Reader
  is **committed when Start is pressed** — in the **lobby** for round 1 (no
  separate screen) and on the **pick-reader screen** for later rounds. Start is
  disabled until a Reader is selected.
- **Guessing starts with the next serial number after the Reader**, wrapping
  around. (Behavior unchanged; just described/enforced by number.)

### Changed — reader is designated each round
- Finalized the **Game → Round → Turn** hierarchy in `REQUIREMENTS.md`.
- **Removed the auto-assigned Reader** (previously the first joiner became Reader
  and it auto-rotated). A new `pickReader` phase now precedes every round's
  answering: any player designates the Reader, and the round can't start until one
  is chosen. Applies to the first round (after lobby Start) and every subsequent
  round (after Next round). Guessing still starts with the next player after the
  Reader in serial order.

### Docs
- Split documentation into focused files: `REQUIREMENTS.md` (spec + gameplay
  decisions), `ARCHITECTURE.md` (technical decisions + system overview),
  `CHANGELOG.md` (this log). `CLAUDE.md` slimmed to a short, stable index so it
  stays lightweight for per-session auto-load.

### Added — initial working build
- **Server** (`server.js`): zero-dependency Node (`http` + Server-Sent Events +
  `POST /action`). In-memory single-room state; server-authoritative with
  per-player view filtering as the privacy boundary.
- **Client** (`public/`): vanilla HTML/CSS/JS single page, mobile-first
  "parlor / paper-slip" theme; answers render in a uniform typewriter font.
- **Game flow implemented end-to-end:** join + lobby (turn order, 3/2 points),
  simultaneous answer reveal, rotating reader, per-turn guessing on each player's
  own phone, correct → eliminate + score + guess-again, wrong → hide author +
  pass turn (list moves to next player), 30s reader-board flash then hide,
  see-all/wasted-turn memory mechanic, last-standing scoring, round rotation.
- **Verified**: 26-assertion end-to-end check over the real HTTP + SSE API
  (phase transitions, privacy boundary, correct/wrong resolution, eliminated-skip,
  wasted turns, reader-also-guesses, scoring, reader rotation). All passed.
  (Throwaway test harness not kept in the repo.)
- **Docs**: `README.md` (run instructions), and the spec/decisions captured.
