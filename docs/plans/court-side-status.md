# Court Side: live status

**Court Side replaces Ghost Coach for Vishal. Ghost Coach is paused.** One clip only: **Steph's three over LeBron,
2018 Finals, main side camera** (Vishal, 5:45 AM). The play runs about 5 s in real time, slows smoothly to a freeze
at Steph's release with LeBron contesting, you walk about 1 m around them, then it plays on or replays; never a cut.
Ojasva's bar: if two players can't pass by noon, ship one player on the court. Updated Sat 5:57 AM.

## Asks for Ojasva (newest first)

6. **Yes (Ojasva, Sat 6:05 AM).** 100k per player per frame for playback and the freeze frame alone at 250k is right for the
   Quest browser; keep `aniso`, the real-frame view (`sourceView`) and 50-step views for the final run. Original ask: playback frames with `recon.py --cap 100000`, plus the
   freeze frame trained again on its own at `--cap 250000` (one frame, one GPU, minutes). Both are existing flags
   (`pipeline/lucid/recon.py:37`, `--end`), so this is a yes/no. Why: 5 s of two players must fit the Quest browser.
5. **Approved (Ojasva, 5:50 AM).** One B200 for about 10 minutes, about 7:30-8 AM: a **Turbo** views run on one
   player-only portrait clip (121 frames, 1080x1920) before any full-quality GPU hours. Command and path to follow.
4. **Done.** SAM 3: no (gated). SAM 2.1 instead.
3. **Done.** 4DAnyone needs exactly 121 frames, never padded.
2. **Done.** `apps/webxr/src/court/` + `?mode=court` + the route line in `src/main.ts`: approved.
1. **Done.** GPUs free from about 5:50 AM; about 16 GB disk lab-wide, one run on disk at a time.

## Now

Waiting for the clip file. Desktop spikes S4 and S5 are done; S1-S3 start when the clip lands.

## Verdict so far

**Feasible with cuts** (5:50 AM), for exactly this version:
- **The whole 5 s can be real 3D:** our prep resamples every clip to 25 fps (`pipeline/lucid/prep_clip.py:21,74`),
  so 121 frames are 4.84 s of real time. No broadcast-video hand-off is needed.
- **Smooth slow-down:** the last stretch before the release uses denser real frames from the 60 fps source (a speed
  ramp inside the 121 frames), and the player cross-fades adjacent frames at low speed. Fallback: even 25 fps plus
  cross-fades.
- **Cuts:** about 100k Gaussians per player per frame in playback and 250k in the freeze frame; the rest of the game
  is a still court, stands and flat cut-outs; walkable ring 0.9-1.5 m around the pair. Target: the WebXR viewer.
- **Biggest risks:** player size in the broadcast (soft faces up close), LeBron's hand overlapping Steph at the freeze,
  and two full-quality runs inside the day.

## Done

- 5:47 AM, **S4 PASS (desktop):** two overlapping 150k-splat people x 60 frames + 225k freeze each + ball + 4K court
  + 4K backdrop + 3 cut-outs in one Spark scene: 300k visible in playback, 450k frozen, 590 MB resident, 91 MB
  textures, 10 ms median frame on a laptop. Quest fps not measured yet.
- 5:57 AM, **S5 PASS except one field-of-view rule (desktop emulation):** passthrough session on local-floor, the court
  pinned by a WebXR anchor (0 mm drift over a full 17-pose walk), palm menu pause / play / slow-mo / courtside spot
  (moves 1.9 m), bare pinches and grabs change nothing. Walkable ring: about 1.5 m from the pair's midpoint (about
  1 m clear of each body); a tighter ring walks into them. From 3 of 17 spots LeBron is too close to fit whole in
  the Quest's view, so you look up at him, as in real life.
- Spark sorts both players together; the Quest app sorts each person separately (wrong when they overlap).
- Clip measurement tool ready (frames, cuts, camera motion, player height, sharpness, overlap, ball, feet).

## Next

1. Measure the clip; pick the 121 frames (ramp ending at the release).
2. Court calibration, SAM 2.1 masks for both players (Vishal's PC), the stabilised still camera, one fixed crop per
   player; then ask 5.
3. `docs/plans/court-side.md` with the hour-by-hour build and exact job specs, once Vishal approves.

## Blocked on

- The clip file (Vishal).

## Decisions

- One clip: Steph's three over LeBron, 2018 Finals, main side camera, 60p; no backups for now (Vishal, 5:45 AM).
- Target the WebXR viewer; the Quest app is only an ask to Ian (Vishal, 5:45 AM).
- Each player's crop is a fixed window in the stabilised frame covering their whole 5 s path, never a moving crop
  (Vishal, 5:45 AM).
- SAM 2.1 masks run on Vishal's PC first (Vishal, 5:45 AM).
- Court Side replaces Ghost Coach (Vishal 5:15 AM, OK'd by Ojasva 5:25 AM). SAM 2.1 not SAM 3; 121 real frames;
  `apps/webxr/src/court/` approved; one run on disk at a time (Ojasva, 5:25 AM).
- Controls on the palm-up left-hand menu, the court pinned by a WebXR anchor, no gesture acts by itself (Ojasva).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site (Vishal).
