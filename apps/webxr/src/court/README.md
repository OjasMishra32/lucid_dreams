# Court Side (`?mode=court`)

> Being updated to the final plan's format (stacked live/plate/matte stream, cards.json, the light field):
> `format.ts` and `scripts/court/fixtures/court.json` are the current truth until this file catches up.

One real NBA moment at life size: watch it from a courtside seat, step into the frozen frame as 3D, walk around the
players, sit back down and watch the make. The plan is `docs/plans/court-side.md` (sections 0-6); this folder is the
WebXR module, `apps/webxr/scripts/court/` holds its tests, the stand-in bundle generator and the e2e harness.

## Commands (run from the repo root; no npm install needed beyond `apps/webxr/node_modules`)

| What | Command | Done means |
| --- | --- | --- |
| Stand-in bundle (~1 min, once per checkout) | `node apps/webxr/scripts/court/standin.mjs` | `STANDIN OK <dir>`; writes `apps/webxr/scripts/court/out/standin/` (git-ignored) |
| Unit tests | `node --experimental-transform-types --test 'apps/webxr/scripts/court/*.test.ts'` | `fail 0` (one file: `... --test apps/webxr/scripts/court/clock.test.ts`) |
| Build | `npm --prefix apps/webxr run build` | `tsc --noEmit` clean and `vite build` done |
| e2e (stepped capture) | `node apps/webxr/scripts/court/e2e.mjs [--only smoke,...]` | `E2E OK`; reports and PNGs in `apps/webxr/scripts/court/out/e2e/` |
| Timing pass (alone, never in parallel) | `node apps/webxr/scripts/court/e2e.mjs --timing` | `TIME` lines per phase (CPU and GPU ms); informational on desktop |
| Screenshot diff | `node apps/webxr/scripts/court/diff.mjs a.png b.png --px-per-deg 19.5 --max-deg 0.05 --min-psnr 30 --min-ssim 0.95 [--mask m.png]` | every line `PASS`; exit 0 |
| Demo server (the real bundle, 127.0.0.1 only; refuses a bundle inside any checkout; `--standin` serves the stand-in) | `npm --prefix apps/webxr run build && node apps/webxr/src/court/serve.mjs --bundle <bundle folder outside the repo>` | open `http://127.0.0.1:5185/?mode=court&bundle=/bundle/` (Quest: `adb reverse tcp:5185 tcp:5185`) |
| e2e on the real bundle | serve.mjs as above, then `node apps/webxr/scripts/court/e2e.mjs --bundle http://127.0.0.1:5185/bundle/court.json` | the bundle comes from serve.mjs (CORS for local pages only), never from vite |

Notes: Node 25 runs the `.ts` tests with `--experimental-transform-types`; a folder argument to `--test` does not
work there (it is loaded as a module), so quote the glob. The e2e uses Chrome (system) through an installed
playwright-core (`apps/webxr/node_modules`, `$PLAYWRIGHT_CORE`, or the npx cache); it never downloads a browser.

### How the e2e works

`e2e.mjs` starts Vite on plain http, opens `/?mode=court&emulate&probe=capture` in headless Chrome, clicks Enter (a
real click) and drives the page through `window.__court` (`probe.ts`): `seatHere()`, `press(action)`,
`frames(n)`, `until(phase, max)`, `save(name)`, `snapshot()`, plus `ctx.device(fn)` for IWER's `XRDevice` (head
and hand poses, `updateVisibilityState`). With `?probe` every XR frame advances the show by exactly 1/72 s (IWER runs
on the host's ~120 Hz rAF, so e2e never measures timing) and in capture mode every frame is read back in the page
right after `renderer.render` (`readPixels` on IWER's default framebuffer): alpha min/mean, mean luma and a 16 x 9
luma grid per frame, full frames as PNG on `save()`. `--timing` swaps the read-back for CPU ms per frame and GPU ms
per `renderer.render` (`EXT_disjoint_timer_query_webgl2`). A scenario is one entry in `SCENARIOS` in `e2e.mjs`; add
yours there (`cadence`, `ease`, `handoff`, `room`, `controls`, `walk`, `arrival` per the plan's section 6).

## The court bundle format

The only new data format, read only by `?mode=court`; additive to every other contract. **`format.ts` is the source of
truth**: every field has its JSDoc (units, frames, coordinate space) and `validateCourt` / `validateFrames` name every
bad field in one readable line (`seat.distance: expected a distance inside distanceRange [4, 7], got 9`).
`loadCourt(url, { fallback })` fetches court.json and the chosen stream's frames.json, validates both, and returns
`{ base, court, frames, file(path) }`; `fallback` (`"p1080"` for `?show=1080`, `"hz90"` for `?hz=90`) swaps that
pre-built stream into `court.video` (`chooseStream`), so every module reads one view of the show.

Where it lives: the real bundle outside the repo, never under `dreams/` (vite
and the tunnel serve that folder); only `serve.mjs` serves it, on 127.0.0.1. The synthetic stand-in lives in
`apps/webxr/scripts/court/out/standin/` (git-ignored, no broadcast data) and the dev page loads it by default.

### Conventions

- **Court space:** metres; origin at centre court on the floor; +Y up; +X toward the basket the play attacks; +Z to
  the right when facing +X (right-handed). glTF files in the bundle use the same axes.
- **Show frames:** the baked stream's frames, 0-based; show frame i is displayed at t = i / `video.displayHz`.
  Segments are inclusive ranges, never overlap, and each starts with an IDR.
- **Source frames:** the source clip's own numbering (`src`, fractional for an in-between). One second of real action
  is `sourceFps x slow` source frames; `captureFps` is the capture's own rate, which says which display frames can be
  real.
- **Cameras:** OpenCV axes (+x right, +y down, +z forward); `q` is world-from-camera; `f`, `cx`, `cy` in source
  pixels (`camera.width` x `camera.height`), pixel centres at whole numbers; one fixed `camera.centre`. For an image
  of width w, s = w / camera.width and u' = (u + 0.5) s - 0.5 (`camera.ts` `scaled`). k1 is 0 (the bake undistorts).
- **Paths** are relative to court.json's folder: no leading slash, no `..`, no URL.
- **Unknown fields are ignored**, so the format can grow.

### Files

```
court.json
video/show.h264            the whole show at displayHz: raw H.264 Annex B, -bf 0, AUD per frame, IDR per segment
video/show-1080.h264       fallbacks.p1080 (same frames); show-90.h264 + its own frames.json for fallbacks.hz90
video/frames.json          per show frame: { src, interp, q, f }
video/freeze.png           frame F; freeze-clean.png (players and watermark painted out); stands-mask.png; inpaint-mask.png
players/<id>/freeze.ply    the freeze Gaussians (3DGS PLY, SH1, court space); reality.ply (same order, unseen in blue)
players/<id>/proxy.glb     the splat-depth proxy (depth mesh of the splats from camera F); shadow.png, reflection.png
others/<id>/...            extras: freeze.ply | body.ply | relief.glb, reality, shadow, reflection
stands/<id>.png            depth cards (front row, photographers, the ref)
court/floor.jpg            the floor from above (the whole court); floor-seen.png (white where the camera filmed it)
audio/bed.m4a              the crowd bed (looped, -23 LUFS); swell.m4a (one-shot); sfx/*.m4a (only with approval)
```

### court.json, a worked example (the stand-in's, trimmed)

```jsonc
{
  "version": 1,
  "title": "Court Side stand-in",
  "caption": "Stand-in · the defender closes out as the shooter gathers",
  "label": "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.", // exactly this (P22)
  "credit": "Synthetic stand-in bundle: no broadcast footage.",
  "court": { "length": 28.65, "width": 15.24, "rim": [12.73, 3.05, 0],
             "floor": "court/floor.jpg", "floorSeen": "court/floor-seen.png", "hardwood": [0.71, 0.52, 0.33] },
  "camera": { "centre": [-22, 1, -9], "width": 3840, "height": 2160, "cx": 1919.5, "cy": 1079.5, "k1": 0,
              "sourceFps": 120, "captureFps": 120, "slow": 1 },
  "video": {
    "file": "video/show.h264", "codec": "avc1.640034", "width": 2560, "height": 1440, "displayHz": 72,
    "fallbacks": { "p1080": { "file": "video/show-1080.h264", "codec": "avc1.640032", "width": 1920, "height": 1080 } },
    "frames": "video/frames.json",
    "segments": { "pass1": [0, 194], "pass2": [195, 495], "resume": [712, 896],
                  "eases": [{ "start": 296, "frames": [496, 581], "seconds": 1.1944 },   // 86 frames from 0.6x to F
                            { "start": 303, "frames": [582, 653], "seconds": 1 },
                            { "start": 310, "frames": [654, 711], "seconds": 0.8056 }] },
    "cutoff": 310,                       // the last ease start: a later press stops on the next pass
    "freezeSource": 600, "makeSource": 780,
    "freeze": "video/freeze.png", "freezeClean": "video/freeze-clean.png",
    "standsMask": "video/stands-mask.png", "inpaintMask": "video/inpaint-mask.png"
  },
  "seat": { "ray": "freeze", "distance": 5, "distanceRange": [4, 7], "pairCentre": [6, 0, 1], "closer": 2.5,
            "clear": 1, "spots": [[4.446, 0, 0.445], [4.742, 0, 2.068], [5.704, 0, -0.623]], "ringArea": [4.5, 5.5] },
  "freeze": {
    "players": [{ "id": "shooter", "name": "Shooter (stand-in)",
                  "splats": "players/shooter/freeze.ply", "reality": "players/shooter/reality.ply",
                  "proxy": "players/shooter/proxy.glb",
                  "bounds": { "min": [5.5692, 0, 0.4469], "max": [6.0339, 1.7993, 1.0037] }, "seenFraction": 0.496,
                  "capsules": [{ "a": [5.8016, 0.9951, 0.6637], "b": [5.8016, 1.4418, 0.6637], "r": 0.1574 },  // torso
                               { "a": [5.8119, 1.6855, 0.6812], "b": [5.8119, 1.6855, 0.6812], "r": 0.1137 }], // head
                  "shadow": { "image": "players/shooter/shadow.png", "rect": [4.92, 0.07, 6.52, 1.67] },
                  "reflection": { "image": "players/shooter/reflection.png", "rect": [4.92, 0.07, 6.52, 1.67] } } /* , defender */],
    "ball": { "centre": [5.803, 0.9951, 0.9458], "radius": 0.1195, "erase": [{ "player": "shooter", "radius": 0.15 }] },
    "others": [{ "id": "ref", "kind": "splats", "file": "others/ref/freeze.ply", "reality": "others/ref/reality.ply",
                 "pose": "A", "foot": [10.6, 0, 4.8], "height": 1.85, "maxRayAngle": 25.21,
                 "shadow": { "image": "others/ref/shadow.png", "rect": [9.8, 4, 11.4, 5.6] },
                 "reflection": { "image": "others/ref/reflection.png", "rect": [9.8, 4, 11.4, 5.6] } }],
    "stands": { "proxy": [{ "kind": "plane", "points": [[16, 0, -16], [16, 0, 16], [16, 9, 16], [16, 9, -16]] }],
                "cards": [{ "id": "front-row", "image": "stands/front-row.png",
                            "quad": [[15.2, 0, -4], [15.2, 0, 10], [15.2, 1.35, 10], [15.2, 1.35, -4]] }] }
  },
  "audio": { "bed": "audio/bed.m4a", "lufs": -23,
             "sources": [{ "at": [16, 3, -8], "offsetS": 0 } /* , 4 or more (P31) */],
             "oneShots": [{ "file": "audio/swell.m4a", "at": "make", "gainDb": 0 }, { "file": "audio/swell.m4a", "at": "stepIn", "gainDb": -12 }],
             "events": [] },
  "metrics": { "reprojDeg": { "median": 0, "p95": 0 }, "heldOutPsnrVsGenerated": {}, "seatPsnr": {}, "interpShare": 0.33 }
}
```

`video/frames.json` (one entry per show frame): `[{ "src": 956, "interp": false, "q": [0.6012, 0.0021, 0.7991, -0.0016], "f": 25988.4 }, ...]`.
`q`, `f` are that frame's own solved camera (never smoothed; an in-between gets the slerp of its two real frames').
A display frame shows the real frame when one lies within 0.1 frame of its real-time position, else an in-between
(`interp: true`). Every ease's last frame is F (`src == freezeSource`, `interp: false`, one camera).

### What the validator enforces (besides types, ranges and paths)

The exact label; rim at 3.05 +/- 0.03 m; k1 = 0; principal point inside the image; codec strings `avc1.xxxxxx`;
segments ordered, non-overlapping, eases inside pass 2 in order of start, each ease's `seconds` within one frame of
its frame count; `cutoff` inside pass 2 and no later than the last ease start; `seat.distance` inside
`distanceRange`; `pairCentre` on the floor; unique ids across players and others; `ball.erase` names a real player;
a relief only below 15 deg (`maxRayAngle`, P16); at least 4 crowd sources (P31); `video.makeSource` present when a
one-shot is cued on the make; frames.json long enough for every segment, unit quaternions, whole `src` for real
frames, and every ease ending on F with camera F.

### Changes from the plan's sketch (4.2)

- `video.fallbacks.p1080` and `.hz90` are objects, not paths: the 1080p copy needs its own codec (High 5.0) and the
  90 Hz bake has its own frames.json, segments and cutoff (its show frames differ).
- Added `video.makeSource` (when the `make` one-shot fires) and `video.inpaintMask` (the Reality check's "inpainted
  plate behind the players").
- `loadCourt` returns the bundle (`{ base, court, frames, file(path) }`), since every module needs frames.json and
  file URLs, not only court.json; it takes `{ fallback }` and returns that stream's view (`chooseStream`).
- Every stream keeps the source's aspect (checked), metrics may be `null` until measured, and the JSDoc states which
  numbers turn real time into source frames.

## The modules (4.3) and who builds them

Each module exports `BUILT` (false while it is a stub); the e2e report lists them. Stubs called every frame are
no-ops; one-off actions that aren't built throw `"<what> is not built yet (stream X)"`.

| File | Stream | What it owns | Status |
| --- | --- | --- | --- |
| `format.ts` | integrator | court.json / frames.json types, validator, `loadCourt` | built, tested |
| `camera.ts` | integrator | pinhole maths for the bundle's cameras (project, rays, scaling) | built, tested |
| `annexb.ts` | integrator | H.264 Annex B access units, IDRs, SPS codec string | built, tested |
| `types.ts` | integrator | `Phase`, `Head`, `WorldPose`, `Polygon` | built |
| `clock.ts` | C `core` | the show clock (`ClockState.nextJump` is what the second decoder primes); its curve functions are the bake's contract | curves built and tested; `Clock` stub |
| `seat.ts` | C `core` | seat on F's ray, Seat here, Walk closer, spots, ring, bounds, anchor; the only writer of the world group | `toRoom`/`toCourt`, `update`/`apply` built; rest stub |
| `ui.ts` | C `core` | caption, label, palm menu, Seat here hold, presenter keys; `on`/`press` dispatch | dispatch built; rest stub |
| `vrhands.ts` | C `core` | drawn hands in the arena | stub |
| `video.ts` | D `handoff` | two-decoder WebCodecs player, `show`, `prime`, `feather`, `depth`, `wipe`, `opacity` | stub |
| `proxies.ts` | D `handoff` | projection surfaces, `project(camera)`, `depth`, `dimStands`; owns the video texture | stub |
| `handoff.ts` | D `handoff` | `handoff(p, parts: HandoffParts)`, the chosen direction (3.3a) | stub |
| `world.ts` | E `look` | floor, darkness, pools, dome, `arrive`, `open`, `pools`, `room`, `edge`, `reality`, `frustum` | stub (opaque dome only) |
| `freeze.ts` | E `look` | splats, extras, ball, shadows, reflections, capsule fade, Reality | stub |
| `sound.ts` | F `sound` | HRTF crowd, arrival swell, time stop, room murmur, one-shots, events | stub |
| `court.ts` | integrator | `renderCourt`, the phase machine, the session, the frame loop | skeleton |
| `probe.ts`, `stats.ts` | integrator | the e2e's in-page half; the frame log (`?stats`) | built |
| `serve.mjs`, `sw.js` | integrator | the 127.0.0.1 demo server; the Service Worker (cable-off reload) | built (untested on the Quest) |

Rules: every button, presenter key and probe action is queued to the top of the next XR frame (anchors need the
XRFrame). Seat is the only writer of the world group. `ShowVideo.opacity` is the video layer's opacity (it reaches
the proxies); Depth Grows calls `video.depth(p)`. Pure modules (`format`, `camera`, `annexb`, `clock`, `seat`'s maths, `handoff`) use `import type` for siblings
and never import `xr/quality.ts` (it reads `location`), so `node --test` can load them. A stream changes only its own
files; `format.ts`, `court.ts`, `types.ts` and `main.ts` change through the integrator. Test first.

## What each stream reads first

- **C `core`:** plan 3.1-3.6 and section 6's clock and seat rows; `clock.ts` (the curve functions and `ClockState`),
  `seat.ts` (`toRoom`/`toCourt`, the constants), `types.ts`, `court.ts` (how the machine calls you), `clock.test.ts`;
  `xr/menu.ts` and `xr/hands.ts` for the menu.
- **D `handoff`:** plan 3.2-3.3a, P4-P10; `video.ts`, `proxies.ts`, `handoff.ts`, `camera.ts`, `annexb.ts`;
  `court-spikes/s6-quest/spike6/webcodecs.ts` (the decoder and layer); the stand-in's `video/` and `players/*/proxy.glb`.
- **E `look`:** plan 3.3 step 3, 3.4-3.6, P11-P17, P23, P30, P33-P35; `world.ts` (the dome note), `freeze.ts`,
  `court-spikes/ground/`; the stand-in's `players/`, `others/`, `court/`, `stands/`.
- **F `sound`:** plan 2 (Sound), 3.2, 3.3, 3.5, P19-P20, P31; `sound.ts`; the stand-in's `audio/`.
- **G `assemble`:** this README's format section and `format.ts` (write what `validateCourt` accepts);
  `scripts/court/standin.mjs` is a complete writer of every file to copy from.
