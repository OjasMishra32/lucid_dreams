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

Captions float in front of the person when the bundle has `captions.vtt`. Reality check tints everything the camera
(or the photo) never saw blue.

## Chess

`?mode=chess` (also linked from the library): a real-size board on your table, an engine opponent from Club 1400 to
full strength, including Fischer's and Carlsen's peak ratings (labelled as the engine at that rating, not the players).
`?mode=chess&opponent=<avatar id>` stands a consenting teammate's avatar across the table.

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
| `src/xr/hands.ts` | Fingertip buttons and depth-only hand occluders, shared by the viewer and chess |
| `src/chess/` | Board, lathe-turned pieces, Stockfish 19 in a worker (GPL-3.0, separate file in `public/engine`) |
| `scripts/make_test_avatar.py` | A rigged test avatar from your local SMPL-X model (never committed) |
