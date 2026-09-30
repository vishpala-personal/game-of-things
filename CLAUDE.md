# Game of Things — hybrid companion app

A small web app that removes the "I recognize your handwriting" problem from an
in-person round of the Game of Things. The topic card stays physical (the reader
reads it aloud); the app handles anonymous typed answers, guessing, and scoring
for ~4 colocated players on mixed iPhone/Android phones.

## Where things live

- **`REQUIREMENTS.md`** — what to build: the requirements as given + all
  product/gameplay decisions. Read this before changing behavior.
- **`ARCHITECTURE.md`** — how it's built: transport, state model, the privacy
  boundary, rendering, and known limitations. Read before changing structure.
- **`CHANGELOG.md`** — running build log; **append an entry for every change.**
- **`README.md`** — how to run it.

## Key conventions

- **Zero runtime dependencies** — server uses only Node built-ins. Do not add npm
  packages without a strong reason (it breaks offline `node server.js`).
- **The server is the privacy boundary** — never send a client data it shouldn't
  see and hide it in the UI. Filter per-player in `viewFor()` on the server.
- **Vanilla client, no build step** — plain HTML/CSS/JS served from `public/`.
- When you change behavior, keep `REQUIREMENTS.md` in sync and add a
  `CHANGELOG.md` entry.

## Run

```bash
node server.js          # port 80 (falls back to 3000); or: PORT=3100 node server.js
```

Phones on the same WiFi open `http://<mac-name>.local`, scan the QR code it
prints, or use the IP line. Only same-WiFi devices are allowed (ARCHITECTURE A10).

## Status

Implemented and verified end-to-end. Backlog (not built): internet hosting,
in-app topic cards, persistent history/leaderboard — see `REQUIREMENTS.md`.
