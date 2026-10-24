# Lucid Dreams in WebXR

The person from any video, life size on your real floor, in the Quest browser's passthrough. The same app runs on a
laptop with a mouse. Three.js and [Spark](https://sparkjs.dev) render the Gaussians; avatars are skinned on the GPU.

## Run it

```bash
npm --prefix apps/webxr install
npm --prefix apps/webxr run dev          # https://<this Mac's IP>:5180 (self-signed, for the Quest)
LUCID_HTTP=1 npm --prefix apps/webxr run dev -- --port 5181   # plain http://localhost:5181 for a laptop browser
```

Dreams come from `dreams/` at the repo root (the autopilot fetches them there). `?base=` points at another server.

## On the Quest

1. Same Wi-Fi as the Mac. In the Quest browser open `https://<Mac IP>:5180` (the Mac's IP: `ipconfig getifaddr en0`).
2. The certificate is self-signed: Advanced, then Proceed. Once per server start.
3. Pick a dream, then **View in your room**. Allow passthrough and hand tracking when asked.
4. Put the controllers down. Everything works with bare hands.

| In the room | Does |
| --- | --- |
| Quick pinch | Pause / play |
| Hold a pinch (about a second) | Brings the person 1.8 m in front of you, facing you |
| Push a fingertip through a button | Pause, speed (1x, 0.5x, 0.25x), Reality check, Bring here |
| Reach toward them | Your real hand stays in front of them |
| Fingertip "Place" button | Swaps your room for a 360-degree place around them: concert hall, court, gym, ring, studio, mountains (and back) |
| Fingertip "Ask" button (lessons) | Ask the coach about the step on screen, out loud; push again to stop |

A lesson (`experience.json`, or just the sentence you gave) adds a step card and Back / Again / Next buttons: each
step plays slowed down, then they freeze for your turn. **Ask** (beside Place in your room, "Ask about this step" on
the laptop's step card, or the A key) opens a Gemini Live session about that step: the teacher pauses, you ask
("how should my wrist be here?"), and the answer shows on the step card and is read in the device's own voice, never
the person's. It stops, and releases the mic, when the step changes or you leave the room. The token comes from the
bridge (apps/web, `/api/live/token`) through this server (`vite.config.ts` passes `/api/live` to
`http://localhost:5170`, or `LUCID_BRIDGE`), so the https page never calls http and the Gemini key never leaves the
Mac. No key on the bridge, or no bridge: no Ask button, and the lesson runs as before. Basketball dreams come with the real ball and a regulation
hoop where the shooter aims (`props.json`). Captions float in front of the person when the bundle has `captions.vtt`. Reality check tints everything the camera
(or the photo) never saw blue.

## Chess

`?mode=chess` (also linked from the library): a real-size board on your table, an engine opponent from Club 1400 to
full strength, including Fischer's and Carlsen's peak ratings (labelled as the engine at that rating, not the players).
`?mode=chess&opponent=<avatar id>` (or picking Fischer or Carlsen) seats an avatar across the table: it thinks with its
chin on its fist, reaches over and moves its own pieces, taps the chess clock, tips its king when it loses and offers a
handshake you can meet with your hand.

| In the room | Does |
| --- | --- |
| Pinch a piece, move, release | Moves it (legal squares show as blue dots) |
| Hold a pinch on empty space | Moves the board there (pinch your real table) |
| Fingertip buttons by the board | New game, Undo, strength, Move board |

## Code

| File | What |
| --- | --- |
| `src/viewer.ts` | Playback, room placement, positional voice, reality check, captions |
| `src/avatar.ts` | Live GPU skinning of avatar bundles (matches `avatars/lucid_avatars/skinning.py`) |
| `src/look.ts` | Eye contact: in `companion` / `play` an avatar turns its head toward you (head 70%, neck 30%, ±35° yaw, ±20° pitch, 300 ms); `node scripts/check_look.ts` checks it |
| `src/coach.ts` | Ask: the Gemini Live coach (mic as 16 kHz PCM over a WebSocket, text answers in the device's voice) |
| `src/xr/hands.ts` | Fingertip buttons and depth-only hand occluders, shared by the viewer and chess |
| `src/chess/` | Board, lathe-turned pieces, Stockfish 19 in a worker (GPL-3.0, separate file in `public/engine`) |
| `scripts/make_test_avatar.py` | A rigged test avatar from your local SMPL-X model (never committed) |

## Credits for the chess legends

Their avatars are made from freely licensed photos, never committed to this repo, carry no voice, and are always
labelled as the engine at that player's peak rating, not the player.

- Magnus Carlsen: "Magnus Carlsen (2012)" by Wikimedia Commons user Autopilot, CC BY-SA 3.0,
  https://commons.wikimedia.org/wiki/File:Magnus_Carlsen_(2012).jpg
- Juice WRLD: "Juice WRLD - Les Ardentes 2019" by Lexiou WesCudi, CC BY-SA 2.0,
  https://commons.wikimedia.org/wiki/File:Juice_WRLD_-_Les_Ardentes_2019.jpg
- Bobby Fischer: W. Punt for Anefo, Nationaal Archief (Dutch National Archives), 1972, CC0,
  https://commons.wikimedia.org/wiki/File:Bobby_Fischer_in_Amsterdam_voor_besprekingen_met_FIDE-voorzitter_Max_Euwe_over_d,_Bestanddeelnr_925-3509.jpg
