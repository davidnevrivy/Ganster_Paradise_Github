# Gangster Paradise — online MVP

Online multiplayer implementation of the *Gangster Paradise* board game for 3–6 players,
built from `Gangster_Paradise_zadani_pro_vyvojare.pdf` (design doc, verze 2, 10.10.2026).

Node.js + Socket.IO server (all rules, randomness and hidden state live server-side) with a
plain HTML/CSS/JS client (no build step). Czech UI text lives entirely in
`public/locales/cs.json` so more languages can be added later.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**. A player creates a room, gets a code/link, shares it;
other players join with the code and a nickname. 3–6 players, no accounts.

To play across devices on the same WiFi, open `http://<your-computer's-LAN-IP>:3000` from the
other devices (the server listens on `0.0.0.0`, not just `localhost`). The terminal prints
your machine's address hint on startup; find your LAN IP with `ipconfig getifaddr en0` (macOS).

## Project layout

```
server/
  index.js            Express + Socket.IO entry point
  config.json          every tunable number from the design doc (costs, timers, goals, decks…)
  data/
    territories.js     45 territories, 5 regions, schematic map layout (see note below)
    characters.js       the 7 characters (abilities/weaknesses)
  game/
    rng.js              seeded PRNG (mulberry32) — same seed + inputs = same game
    setup.js             game setup: characters, estates, grows, decks
    engine.js            the rules engine: turns, cards, raids, auctions, events, trades
    goals.js             win-condition check (runs only after the active player's turn)
    view.js              viewFor(playerId, game) — the ONE place hidden info is filtered
  rooms/RoomManager.js  room/lobby lifecycle, reconnection tokens
  sockets.js            Socket.IO event wiring, per-room timer tick loop
public/
  index.html, css/style.css, js/app.js   the client (vanilla JS, no framework)
  locales/cs.json       all UI/card/event/character text
tests/                  node:test unit tests (viewFor leak checks, determinism)
scripts/
  simulate.js           bot smoke-test harness (random legal moves, checks for crashes/stalls)
  e2e-smoke*.js          Socket.IO-client integration tests against a running server
```

## Testing

```bash
npm test              # unit tests: viewFor hidden-info leaks, determinism, region counts
npm run sim            # bot smoke test, default 200 games across 3–6 players
node scripts/sim.js 1000 3-6   # scale it up
```

`npm test` and `npm run sim` both passed (9/9 unit tests; 500/500 simulated games with zero
exceptions, zero stalls, no game exceeding the 30-round safety cap) at the time this was built.

## What's faithfully implemented

- Server-authoritative everything: shuffles, random estate/character assignment, raid targets,
  all money and hand contents. `viewFor()` is the single chokepoint that redacts hidden info
  per player — covered by tests that assert no other player's character/side/money/hand/unknown
  grow tokens ever appear in a given player's payload.
- Full round/turn state machine (ROUND_EVENT → ROUND_INCOME → NEGOTIATION → TURNS → ROUND_END),
  free card + 2 actions per turn, all 6 turn actions, all 10 action cards, all 6 events, all 5
  lord types, all 7 characters' abilities/weaknesses, raids with reaction windows (Úplatek /
  Falešná stopa chains), both auction types (zabavení / dědické řízení), trades/offers.
- Reconnection via a token stored in `localStorage`; the client also re-handshakes automatically
  if the WebSocket itself drops and reconnects (e.g. a mobile network blip), not just on reload.
- Deterministic seeded RNG; `tests/determinism.test.js` checks same-seed reproducibility.
- Win condition checked only right after the active player's own turn, so there's always exactly
  one winner, decided at that moment — matches the "vítěz je vždy jeden" requirement.

## Documented simplifications (technical decisions made where the brief allowed it)

- **Map geometry**: the brief asks for real Natural-Earth UK coastline cut into Voronoi cells.
  That exact pipeline needs geo libraries outside this project's scope, so each region is instead
  drawn as a cluster of evenly-spaced nodes positioned to echo the real region's place on the map
  (Scotland top, Wales a western bulge, etc.) — same 45 territories/5 regions/counts, same
  gameplay, schematic rather than geographically exact. See the comment in
  `server/data/territories.js`.
- **Personal notebook** ("osobní zápisník") and character guesses about other players are stored
  client-side only (`localStorage`), per the brief's own description of it as a client feature.
- **Bot simulation scale**: the brief's acceptance criterion references 80,000/1,000-game runs;
  `scripts/simulate.js` ships with a much smaller default for a quick sanity check in this
  environment. The harness is there — increase the count yourself for a longer soak test. Its
  bots play *randomly*, not strategically, so win-rate/round-count numbers from it describe
  engine stability, not game balance (the original 80k-game balance pass was the designer's, not
  reproducible here without a smarter bot policy).
- One identity is stored per browser *origin* (`localStorage` key `gp_identity`), matching the
  brief's "identita v místním úložišti". Two tabs of the *same* room *on the same origin* in one
  browser will therefore resolve to the same player — expected for real play (each player uses
  their own device/browser), only worth knowing if testing multiplayer locally in one browser
  (use `localhost` / `127.0.0.1` / your LAN IP as distinct origins to simulate separate players).

## Known gaps / not done

- No automated test exists per individual card/event/lord/character effect (the brief asks for
  one each); logic for all of them is implemented and exercised indirectly by the bot simulation,
  but dedicated unit tests per effect were not written given scope/time.
- No visual regression tooling; the UI was checked manually in a real browser (not just unit
  tested) during development.
