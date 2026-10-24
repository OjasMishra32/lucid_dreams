# Court Side (`?mode=court`)

One real NBA moment at life size: watch it from a courtside seat, step into the frozen frame as 3D, walk around the
players, sit back down and watch the make. The plan is `docs/plans/court-side.md`. This folder is the WebXR module;
`apps/webxr/scripts/court/` holds its tests, the stand-in bundle generator and the e2e harness. Everything committed
here is synthetic: no frames, masks, 3D, calibration or numbers from the broadcast.

## Commands (from the repo root; nothing to install beyond `apps/webxr/node_modules`)

| What | Command | Done means |
| --- | --- | --- |
| Stand-in bundle (~1.5 min, once per checkout) | `node apps/webxr/scripts/court/standin.mjs` | `STANDIN OK <dir>`: writes `apps/webxr/scripts/court/out/standin/` (git-ignored) and checks it (validator, AU count, IDRs, SPS codec) |
| The committed fixture | `node apps/webxr/scripts/court/standin.mjs --fixture` | rewrites `scripts/court/fixtures/court.json` (the stand-in's court.json) |
| Unit tests | `npm --prefix apps/webxr run test:court` | `fail 0` (one file: `node --experimental-transform-types --test apps/webxr/scripts/court/clock.test.ts`) |
| Build | `npm --prefix apps/webxr run build` | `tsc --noEmit` clean and `vite build` done |
| e2e | `node apps/webxr/scripts/court/e2e.mjs [--only smoke,arrival,...\|all]` | `E2E OK`; reports and PNGs in `scripts/court/out/e2e/` |
| e2e of a scenario whose modules aren't built yet | `... e2e.mjs --only layers --force` | runs it against the stubs (it skips otherwise) |
| e2e on a real bundle | `node apps/webxr/scripts/court/e2e.mjs --bundle <bundle folder outside the repo>` | the bundle comes from `serve.mjs`, never from vite |
| Timing pass (alone, never in parallel) | `node apps/webxr/scripts/court/e2e.mjs --timing` | `TIME` lines per phase (CPU and GPU ms); informational on desktop |
| Screenshot diff | `node apps/webxr/scripts/court/diff.mjs a.png b.png --px-per-deg 19.5 --max-deg 0.05 --min-psnr 30 --min-ssim 0.95 [--mask m.png]` | every line `PASS`; exit 0 |
| Demo server (127.0.0.1 only) | `npm --prefix apps/webxr run build && node apps/webxr/src/court/serve.mjs --bundle <bundle folder outside the repo>` | open `http://127.0.0.1:5185/?mode=court&bundle=/bundle/` (Quest: `adb reverse tcp:5185 tcp:5185`) |
| Dev server with IWER (127.0.0.1 only) | `node apps/webxr/src/court/serve.mjs --dev --bundle apps/webxr/scripts/court/out/standin --standin` | open the printed URL (`...&emulate`); vite runs as middleware, HMR on the same port |

Notes: Node 25 runs the `.ts` tests with `--experimental-transform-types`; a folder argument to `--test` doesn't work
there (it is loaded as a module), so the glob is quoted in the script. `serve.mjs` refuses a bundle inside this
checkout or the main one (vite and the tunnel serve those folders); only the synthetic stand-in passes, with
`--standin`. `--port 0` takes a free port and the first line printed names it. The e2e drives system Chrome through
an installed playwright-core (`apps/webxr/node_modules`, `$PLAYWRIGHT_CORE`, or the npx cache); it never downloads a
browser.

## The e2e

`e2e.mjs` starts `serve.mjs --dev` (the page from vite in dev, so IWER's `?emulate` loads; the bundle at `/bundle/`),
opens `/?mode=court&emulate&probe=capture&bundle=/bundle/` in headless Chrome, clicks Enter (a real click) and drives
the page through `window.__court` (`probe.ts`). With `?probe` every XR frame is one period of the session's frameRate,
as on a headset (court.ts asks the session for the show's 72 Hz; `snapshot().xr` says what it offers and runs at; IWER
runs on the host's rAF, so the e2e never measures wall-clock timing) and in capture mode every frame is read
back in the page right after `renderer.render`: alpha min/mean, mean luma, a 16 x 9 luma grid, the phase machine's
clocks (`still`, `lightsUp`, `tF`, `roomP`), the show frame handed to the video and the proxies (`fed`), the light
field's beat and time (`lightBeat`, `lightT`) and the **view** it was drawn from, as a pinhole camera in court space
(OpenCV axes, the same convention as the bundle's cameras). `--timing` swaps the read-back for CPU ms per frame and
GPU ms per `renderer.render` (`EXT_disjoint_timer_query_webgl2`).

**Scenarios are files**, one per check family, each owned by one stream: `scripts/court/scenarios/<name>.mjs`
exports `owner`, `needs` (the court.ts modules whose `BUILT` must be true; until then the scenario prints `SKIP` and
runs nothing) and a default `async (ctx) => {}`. Change only your own scenario file; the runner is the integrator's.
Exit 0 when every check that ran passed, 1 on a failure, 3 when every scenario asked for was skipped.

| Scenario | Owner | Checks | State |
| --- | --- | --- | --- |
| `smoke` | integrator | loads, Seat here, reaches the watch, opaque (P33), the view is logged, clean console (P25) | runs on the stubs |
| `arrival` | integrator | P27: black while hidden, standing or moving; the lights-up within 1.1 s of a still, seated head | runs on the stubs |
| `cadence` | D | P4: no held or skipped show frames through both passes; P5: on screen = asked for | written; waits on clock, video |
| `ease` | C | a press in pass 2 lands on F (`freezeSource`); no change spike (max/median <= 2.5) | written; waits on clock, video |
| `layers` | D | P43 on the stand-in: no doubled or torn body > 0.1 deg; P9's held frame | captures frames + their truth; the judge is D's to write |
| `handoff` | D | P8 per eye, P9 mid-fade SSIM, P10 rise, P44 light steps | drives to the open world; the checks are D's |
| `room` | E | P33-P35: fades 0.6 s out / 0.8 s back, the room shows, opaque again; the edge | timing and alpha written; P35 is E's |
| `controls` | C | P21, P32 through IWER's hands | C's to write |
| `walk` | C (P17: E) | no drift over a 17-pose walk; P17 once the freeze is built | drift written |
| `wiring` | integrator | court.ts's wiring of C: seat.arrival, PersistentLock, the hands' light and draw order, seat.update's dt | written |
| `rate` | integrator | the session runs at the show's rate when it offers it (court.ts asks for it); the show keeps the headset's time within one show frame over 10 s; run as is, `--query xrhz=90` and `--query "xrhz=90&xrrates=90,120"` (IWER's rate and offer) | written |
| `reseat` | integrator | Change seat: a 2 s hold goes back to the setup page, the show stops, the world stays on its anchor; Seat here again takes a new seat, waits for the hand-over, starts from the top | written |
| `ball` | integrator | one ball at F: with `freeze.ballInBody` the holder's splats (no card, no sphere), else the 3D's sphere; the ball's card goes with the holder's through the resume; run on the stand-in and on `standin.mjs --ball-in-body --out <dir outside the checkout>` with `--bundle <dir>` | written |
| `freezehold` | integrator | the clock's frame reaches the video and the proxies every frame after F, See my room's jump lands the picture on F, a rushed fade never rushes the light (P44) | written; waits on video, proxies, handoff |

`ctx` (see the top of `e2e.mjs`): `nextFrame()`, `frames(n)`, `until(phase, max)`, `save(name)` (the next frame as a
PNG; resolves with its log, view included), `pressFrames(action, n)` (press and the next n frames in one go: frames
run freely, so time anything that starts at a press this way), `seatHere()`, `press(action)`, `snapshot()` (the
world's placement and the head included), `device(fn, arg)` (IWER's `XRDevice`: `position`, `quaternion`, hands,
`updateVisibilityState`), `court` and `showFrames` (the bundle's JSON), `modules`, and on the stand-in
`truth(view, showFrame)`: the true scene from that exact view (`standin.mjs` `truthAt`: RGB plus a kind per pixel,
10 + i for person i, 6 the ball), the ground truth for P8 and P43; `writePng(name, image)` saves it beside the capture.

## The court bundle format

The only new data format, read only by `?mode=court`; additive to every other contract. **`format.ts` is the source of
truth**: every field has its JSDoc (units, frames, coordinate space) and the validators name every bad field in one
readable line (`seat.distance: expected a distance inside distanceRange [4, 7], got 9`). `loadCourt(url, { fallback })`
fetches court.json, the chosen stream's frames.json and cards.json, validates all three and returns
`{ base, court, frames, cards, file(path) }`; `fallback` (`"small"` for `?show=small`, `"hz90"` for `?hz=90`) swaps that
pre-built stream into `court.video` (`chooseStream`), so every module reads one view of the show.

Where it lives: the real bundle outside the repo, never under `dreams/` (vite and the tunnel serve that folder); only
`serve.mjs` serves it, on 127.0.0.1. The synthetic stand-in lives in `apps/webxr/scripts/court/out/standin/`
(git-ignored) and the dev page loads it by default.

### Conventions

- **Court space:** metres; origin at centre court on the floor; +Y up; +X toward the basket the play attacks; +Z to
  the right when facing +X (right-handed). glTF files in the bundle use the same axes.
- **Show frames:** the baked stream's frames, 0-based; show frame i is displayed at t = i / `video.displayHz`.
  Segments are inclusive ranges, never overlap, and each starts with an IDR.
- **Source frames:** the source clip's own numbering (`src`, fractional for an in-between). One second of real action
  is `sourceFps x slow` source frames; `captureFps` says which display frames can be real.
- **Cameras:** OpenCV axes (+x right, +y down, +z forward); `q` is world-from-camera; `f`, `cx`, `cy` in source
  pixels (`camera.width` x `camera.height`), pixel centres at whole numbers; one fixed `camera.centre`. For an image
  of width w (the live or plate region, freeze.png), s = w / camera.width and u' = (u + 0.5) s - 0.5
  (`camera.ts` `scaled`). k1 is 0 (the bake undistorts).
- **The stacked stream:** every show frame is one picture of three regions (`video.regions`, stream pixels
  `[x, y, width, height]`): `live` (what the camera filmed, at the source's aspect), `plate` (the same frame with
  every person replaced from a fixed-centre pan mosaic, the live region's size) and `mattes` (the matte atlas: each
  card's matte, white = the person, in its own tile). A fallback stream keeps the layout, scaled by its width.
- **Cards** (`video/cards.json`, one entry per show frame): every person in the lit region gets a card (`kind:
  "person"`) standing at their foot point `at` (court space, y = 0), cut from the frame by `box` (source pixel edges
  `[x0, y0, x1, y1]`, `camera.width` x `camera.height`) and matted by `tile` (`[u0, v0, u1, v1]`, 0-1 inside the mattes
  region from its top left; the box maps linearly onto it; tiles keep >= 4 px apart), drawn front to back by `order`.
  The ball gets the card `{ id: "ball", kind: "ball" }` from the release to the make, anchored at its centre. Cards
  are resolution-free, so the small copy uses the same file. The plate is what shows between and behind the cards, so
  nobody shows twice through a gap (P43).
- **Paths** are relative to court.json's folder: no leading slash, no `..`, no URL. **Unknown fields are ignored**, so
  the format can grow.

### Files

```
court.json
video/show.h264          the whole show at displayHz: raw H.264 Annex B, avc1.640033, stacked live + plate + mattes,
                         -bf 0, an AUD per frame, an IDR at every segment start
video/show-small.h264    fallbacks.small (the same frames, smaller); fallbacks.hz90 has its own stream, frames.json and
                         cards.json; fallbacks.element is pass 1 as an MP4 for a <video> element
video/frames.json        per show frame: { src, interp, q, f }
video/cards.json         per show frame: { cards: [{ id, kind, at, box, tile, order }] }
video/freeze.png         frame F; freeze-clean.png (F's plate); stands-mask.png; inpaint-mask.png (optional)
players/<id>/freeze.ply  the freeze Gaussians (3DGS PLY, SH1, court space); reality.ply (same order, unseen in blue)
players/<id>/proxy.glb   the splat-depth proxy (depth mesh of the splats from camera F); shadow.png, reflection.png
others/<id>/...          other players: freeze.ply | body.ply | relief.glb, reality, shadow, reflection
stands/<id>.png          depth cards (front row, photographers, the ref)
court/floor.jpg          the floor from above (the whole court); floor-seen.png (white where the camera filmed it)
audio/bed.m4a            the crowd bed (looped, -23 LUFS); swell.m4a (one-shot); sfx/*.m4a (only with approval)
```

### court.json, a worked example (the stand-in's, trimmed; synthetic numbers)

```jsonc
{
  "version": 1,
  "title": "Court Side stand-in",
  "caption": "Stand-in · the defender closes out as the shooter gathers",
  "label": "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.", // exactly this (P22)
  "credit": "Synthetic stand-in bundle: no broadcast footage.",
  "court": { "length": 28.65, "width": 15.24, "rim": [12.73, 3.05, 0],
             "backboard": [[13.105, 2.9, -0.915], [13.105, 2.9, 0.915], [13.105, 3.97, 0.915], [13.105, 3.97, -0.915]],
             "floor": "court/floor.jpg", "floorSeen": "court/floor-seen.png", "hardwood": [0.71, 0.52, 0.33] },
  "camera": { "centre": [-14, 1.35, -10.5], "width": 3840, "height": 2160, "cx": 1919.5, "cy": 1079.5, "k1": 0,
              "sourceFps": 180, "captureFps": 180, "slow": 1 },
  "video": {
    "file": "video/show.h264", "codec": "avc1.640033", "width": 1536, "height": 2160,
    "regions": { "live": [0, 0, 1536, 864], "plate": [0, 864, 1536, 864], "mattes": [0, 1728, 1536, 432] },
    "displayHz": 72, "pass2Speed": 0.4,
    "fallbacks": { "small": { "file": "video/show-small.h264", "codec": "avc1.640033", "width": 1280, "height": 1800 } },
    "frames": "video/frames.json", "cards": "video/cards.json",
    "segments": { "pass1": [0, 194], "pass2": [195, 645], "resume": [862, 1124],
                  "eases": [{ "start": 368, "frames": [646, 731], "seconds": 1.1944 },   // pass2Speed -> 0, ends on F
                            { "start": 375, "frames": [732, 803], "seconds": 1 },
                            { "start": 382, "frames": [804, 861], "seconds": 0.8056 }] },
    "cutoff": 382,                       // the last ease start: a later press stops on the next pass
    "freezeSource": 600, "makeSource": 780,
    "freeze": "video/freeze.png", "freezeClean": "video/freeze-clean.png", "standsMask": "video/stands-mask.png"
  },
  "light": { "crowd": 0.45, "floor": 0.3, "pair": 1, "stands": 0.6, "penumbra": 1.5,
             "alternative": { "crowd": 0.16, "floor": 0.14 } },
  "seat": { "ray": "freeze", "distance": 5, "distanceRange": [4, 7], "pairCentre": [6, 0, 1], "clear": 1 },
  "freeze": {
    "players": [{ "id": "shooter", "name": "Shooter (stand-in)",
                  "splats": "players/shooter/freeze.ply", "reality": "players/shooter/reality.ply",
                  "proxy": "players/shooter/proxy.glb",
                  "bounds": { "min": [5.7307, 0, 0.3419], "max": [6.2546, 1.7993, 0.8279] }, "seenFraction": 0.491,
                  "capsules": [{ "a": [5.9926, 0.9951, 0.5113], "b": [5.9926, 1.4418, 0.5113], "r": 0.1574 },  // torso
                               { "a": [5.9929, 1.6855, 0.5316], "b": [5.9929, 1.6855, 0.5316], "r": 0.1137 }], // head
                  "shadow": { "image": "players/shooter/shadow.png", "rect": [5.193, -0.289, 6.793, 1.311] },
                  "reflection": { "image": "players/shooter/reflection.png", "rect": [5.193, -0.289, 6.793, 1.311] } }
                /* , the defender */],
    "ball": { "centre": [5.8542, 0.9951, 0.7571], "radius": 0.1195, "erase": [{ "player": "shooter", "radius": 0.15 }] },
    "others": [{ "id": "trailer", "name": "Trailer (stand-in)", "kind": "splats", "file": "others/trailer/freeze.ply",
                 "reality": "others/trailer/reality.ply", "pose": "A", "foot": [8.4566, 0, 0.7399], "height": 2.05,
                 "maxRayAngle": 42.82 /* , shadow and reflection as the players' */ }],
    "stands": { "proxy": [{ "kind": "plane", "points": [[16, 0, -16], [16, 0, 16], [16, 9, 16], [16, 9, -16]] }],
                "cards": [{ "id": "front-row", "image": "stands/front-row.png",
                            "quad": [[15.2, 0, -4], [15.2, 0, 10], [15.2, 1.35, 10], [15.2, 1.35, -4]] }] }
  },
  "audio": { "bed": "audio/bed.m4a", "lufs": -23,
             "sources": [{ "at": [16, 3, -8], "offsetS": 0 } /* , 4 or more (P31) */],
             "oneShots": [{ "file": "audio/swell.m4a", "at": "make", "gainDb": 0 }, { "file": "audio/swell.m4a", "at": "stepIn", "gainDb": -12 }],
             "events": [] },
  "metrics": { "reprojDeg": { "median": null, "p95": null }, "heldOutPsnrVsGenerated": {}, "seatPsnr": {}, "interpShare": 0.2338 }
}
```

`video/frames.json` (one entry per show frame): `[{ "src": 168, "interp": false, "q": [0.5349, -0.0034, 0.8449, 0.0022], "f": 20790.7 }, ...]`.
`q`, `f` are that frame's own camera (never smoothed; an in-between gets the slerp of its two real frames'). Every
ease's last frame is F (`src == freezeSource`, `interp: false`).

`video/cards.json` (one entry per show frame):
`[..., { "cards": [{ "id": "shooter", "kind": "person", "at": [5.9926, 0, 0.5113], "box": [1710, 1065, 2149, 2160], "tile": [0.0013021, 0.0046296, 0.1132813, 0.9953704], "order": 0 },`
`{ "id": "ball", "kind": "ball", "at": [7.4916, 3.4324, 0.5161], "box": [1283, 50, 1453, 221], "tile": [0.7513021, 0.0046296, 0.9986979, 0.8888889], "order": 2 }, ...] }, ...]`
(the stand-in's show frame 500).

The stand-in's people at F: the shooter and the defender with ~0.5 m of clear floor between their bodies (the
defender's arm reaches across the gap), and a third person trailing behind and to the left: the layered watch must
show nobody twice through the gap and tear nobody at a card's edge (P43).

### What the validator enforces (besides types, ranges and paths)

The exact label; rim at 3.05 +/- 0.03 m; the backboard a quad; k1 = 0; principal point inside the image; codec
strings `avc1.xxxxxx`; the regions inside the stream, not overlapping, live and plate the same size, live at the
source's aspect; a fallback's shape the main stream's; `pass2Speed` in (0, 1); the light levels in 0-1 and the
penumbra >= 1.5 m; segments ordered, non-overlapping, eases inside pass 2 in order of start, each ease's `seconds`
within one frame of its frame count; `cutoff` inside pass 2 and no later than the last ease start; `seat.distance`
inside `distanceRange`; `pairCentre` on the floor; unique ids across players and others, none of them `"ball"`;
`fallbacks.hz90.pass2Speed`, when given, in (0, 1);
`ball.erase` names a real player; a relief only below 15 deg (`maxRayAngle`, P16); at least 4 crowd sources (P31);
`video.makeSource` present when a one-shot is cued on the make. frames.json: long enough for every segment, unit
quaternions, whole `src` for real frames, every ease ending on F. cards.json: one entry per show frame, ids unique
per frame, each order once per frame, tiles not overlapping, `kind` "person" or "ball", every box inside the source
frame, every tile inside 0-1, every person's `at` on the floor.

### Changes from the plan's sketch (4.2, 4.3)

- `video.fallbacks.small`, `.hz90`, `.element` are objects (or a path for `element`), not paths: the 90 Hz bake has
  its own frames.json, cards.json, segments, cutoff and optionally `pass2Speed` (0.75 keeps every pass-2 frame real at
  90 Hz); `chooseStream` swaps one in.
- `video.pass2Speed` is in the bundle (the bake's choice, not a constant in code); `video.makeSource` (when the make
  one-shot fires) and `video.inpaintMask` (the Reality check's inpainted plate) are optional.
- `seat` keeps only Decision W's watch seat and `clear`: the walking layout is derived (`seatmath.ts`, 3.4).
- `loadCourt` returns the bundle (`{ base, court, frames, cards, file(path) }`), not only court.json.
- `ClockState.nextJump` is what the second decoder primes; `handback(t, parts)` is the hand-back beside `handoff`.
- `ui.ts`'s `HoldButton` extends `xr/hands.ts`'s `XrButton` (Seat here's 2 s hold); `xr/hands.ts` is unchanged.
- court.ts requests the immersive-ar session itself (not through `SparkXr`, which ends a session on
  `visible-blurred`), with the viewer's `XR_QUALITY` scale and foveation.
- `serve.mjs` listens on 5185 by default (5190 is `apps/site`).

## The modules (4.3) and who builds them

Each module exports `BUILT` (false while it is a stub); the e2e report lists them and the scenarios wait on them.
Stubs called every frame are no-ops; one-off actions that aren't built throw `"<what> is not built yet (stream X)"`.

| File | Stream | What it owns |
| --- | --- | --- |
| `format.ts` | integrator | court.json / frames.json / cards.json types, validators, `chooseStream`, `loadCourt` (built, tested) |
| `camera.ts` | integrator | pinhole maths for the bundle's cameras (built, tested) |
| `annexb.ts` | integrator | H.264 Annex B access units, IDRs, SPS codec string (built, tested) |
| `types.ts` | integrator | `Phase`, `Head`, `WorldPose`, `Polygon` |
| `court.ts` | integrator | `renderCourt`, the phase machine, the session, the frame loop |
| `probe.ts`, `stats.ts` | integrator | the e2e's in-page half (`viewOf`); the frame log (`?stats`) |
| `serve.mjs`, `sw.js` | integrator | the 127.0.0.1 demo server (`--dev` for the e2e); the Service Worker (cable-off reload) |
| `clock.ts` | C `core` | the show clock (curve functions built and tested: the bake's contract) |
| `seatmath.ts` | C `core` | the pure seat maths: seat on F's ray, the walking anchoring, Next view, ring, bounds (`toRoom`/`toCourt` built) |
| `seat.ts` | C `core` | Seat here, the fade-jumps, chair, anchor; the only writer of the world group (`update`/`apply` built) |
| `ui.ts` | C `core` | caption, label, palm menu, `HoldButton`; `on`/`press` dispatch built |
| `vrhands.ts` | C `core` | drawn hands in the arena |
| `video.ts` | D `handoff` | two-decoder WebCodecs player, `regions` (mipmapped textures), `show`, `prime`, `mask(p)`, `opacity` |
| `proxies.ts` | D `handoff` | the plate, cards, ball card, backboard and stands proxies, `project(frame)`, `dim(p)`, `reality(on)` |
| `handoff.ts` | D `handoff` | `handoff(t, parts)` and `handback(t, parts)`, the beats as functions of time |
| `lightfield.ts` | E `look` | the world-space light field: `set(beat, t)`, `levels`, `glsl`, `modifier()`, `at(x, z, part)` |
| `world.ts` | E `look` | floor, rendered court, the hoop (`props.ts` `standaloneHoop` at `court.rim`), darkness, dome, `room`, `edge` |
| `freeze.ts` | E `look` | splats, extras, ball, shadows, reflections, capsule fade, Reality |
| `sound.ts` | F `sound` | HRTF crowd, arrival, time stop, room murmur, one-shots, events |

Rules: every button, presenter key and probe action is queued to the next XR frame, right after its head pose is
read (anchors need the XRFrame; Seat here takes that head); one action's throw is logged once and never costs the
frame its step. Seat is the only writer of the world group. `ShowVideo` owns the region textures and the video
layer's `opacity`; `Proxies` reads them. Pure modules (`format`, `camera`, `annexb`, `clock`, `seatmath`, `handoff`,
`lightfield`'s maths) use `import type` for siblings and never import `xr/quality.ts` (it reads `location`), so
`node --test` can load them. A stream changes only its own files; `format.ts`, `court.ts`, `types.ts`, `main.ts`,
`e2e.mjs` and `standin.mjs` change through the integrator. Test first.

## What each stream reads first

- **C `core`:** plan 3.1-3.6 and section 6's clock and seat rows; `clock.ts`, `seatmath.ts` (the constants, the
  WorldPose convention), `seat.ts`, `types.ts`, `court.ts` (how the machine calls you), `clock.test.ts`; `xr/menu.ts`
  and `xr/hands.ts` for the menu; your scenarios `ease`, `controls`, `walk`.
- **D `handoff`:** plan 3.2-3.3a, 3.5, P4-P10, P43, P44; `video.ts`, `proxies.ts`, `handoff.ts`, `camera.ts`,
  `annexb.ts`, `format.ts` (regions, cards); the stand-in's `video/` and `players/*/proxy.glb`; your scenarios
  `cadence`, `layers` (with `truth()`), `handoff`.
- **E `look`:** plan 3.3, 3.4-3.6, P11-P17, P23, P28, P30, P33-P35, P44; `lightfield.ts`, `world.ts` (the dome note),
  `freeze.ts`; the stand-in's `players/`, `others/`, `court/`, `stands/`; your scenario `room` (and P17 in `walk`).
- **F `sound`:** plan 2 (Sound), 3.2, 3.3, 3.5, P19-P20, P31; `sound.ts`; the stand-in's `audio/`.
- **G `assemble`:** this format section and `format.ts` (write what the validators accept);
  `scripts/court/standin.mjs` writes every file and is the reference writer.
