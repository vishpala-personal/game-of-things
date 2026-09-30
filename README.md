# Game of Things — hybrid party companion

A tiny web app that removes the "I recognize your handwriting" problem from a
physical round of [Game of Things](https://en.wikipedia.org/wiki/The_Game_of_Things).
The judge still reads the topic card out loud; everything else — anonymous
answer submission, guessing, and scoring — happens on everyone's phone.

Works on **any phone or laptop with a browser** (iPhone and Android alike) — no
app install, no accounts, no internet required.

## Run it

You need [Node.js](https://nodejs.org) (v16+) on a laptop. No `npm install` —
there are zero dependencies.

```bash
node server.js
```

The console prints how phones join, three ways (everyone must be on the **same
WiFi**):

- **Name URL** — `http://<your-mac-name>.local`, e.g. `http://gamenight.local`.
  It never changes, even when the laptop's IP address does. Set a short name
  once in **System Settings → General → Sharing → Local hostname → Edit**.
  Works on iPhones; some Android phones can't open `.local` names — they use the
  QR code instead.
- **QR code** — shown right in the Terminal; point a phone camera at it.
- **IP address** — e.g. `http://192.168.1.23` (changes from time to time).

The server uses the standard web port 80 so there's no `:3000` to type. If port 80
is busy it falls back to 3000 (the printed URLs will include `:3000`). On macOS
you may get a firewall prompt the first time — click **Allow**.

Only devices on the **same WiFi** as the laptop can connect — anyone else (the
internet, another network, a tunnel like ngrok) just sees "Sorry, you are not
allowed in." with no hint about the WiFi or how to get in.

> Tip: add it to your home screen ("Add to Home Screen") for an app-like icon.

## How a round flows

1. **Join** — everyone enters a name and is numbered **1, 2, 3, …** in join
   order and shown sitting around a drawn table. **Drag** people to where they
   really sit and **tap** whoever reads first (the badges show who guesses 1st,
   2nd, …) and set whether
   the last player standing scores **3** or **2** points, then **Start** (which
   commits the reader).
2. **Answer** — the reader reads the physical card aloud. Everyone (reader
   included) types an answer. Nothing shows until *all* answers are in, so no one
   can tell who finished first.
3. **Reveal** — all answers appear at once on the reader's board, numbered on
   paper slips, in a random order. The reader reads them aloud twice.
4. **Guess** — going around in serial-number order, starting with the **next
   number after the reader**, the active player's phone shows the slips. They pick
   a slip + a name.
   - **Correct** → that player is out for the round; the slip flashes their name
     on the reader's board for 30 seconds, then fades. The guesser scores 1 and
     goes again.
   - **Wrong** → nothing is revealed; the turn passes to the next player, and the
     slips move to *their* screen.
5. **Pay attention!** Solved answers are *not* marked for you — pick an
   already-caught slip (or name someone already out) and you waste your turn.
6. **Round end** — when one answer is left unclaimed, its author scores the
   last-standing points. Everything is revealed, scores update, and the next round
   begins with a fresh **Reader** designation.

## Design notes

> Full architecture record (transport, privacy model, trade-offs, limitations):
> see [`ARCHITECTURE.md`](ARCHITECTURE.md). Requirements and gameplay decisions:
> see [`REQUIREMENTS.md`](REQUIREMENTS.md). Build log: see
> [`CHANGELOG.md`](CHANGELOG.md).


- **Zero dependencies, single room, in-memory state.** Pure Node `http` +
  Server-Sent Events (server→client push) + `POST /action` (client→server).
- **The server is the privacy boundary.** Each phone is sent only the *view* it's
  allowed to see — a bystander's phone never receives the answer slips, and the
  true author of an answer is never sent to anyone until a correct guess (or the
  end-of-round reveal).
- Refreshing a phone rejoins the same seat. Restarting `server.js` resets the
  game (each phone will show the join screen again).

## Files

- `server.js` — HTTP server, game logic, per-player views, network guard.
- `qr.js` — tiny built-in QR encoder for the startup code (no dependencies).
- `public/index.html`, `public/styles.css`, `public/app.js` — the client.
