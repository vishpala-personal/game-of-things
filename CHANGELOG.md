# Changelog

Running build log, newest first. Each entry: what changed and why. Requirements
live in `REQUIREMENTS.md`; architecture in `ARCHITECTURE.md`.

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
