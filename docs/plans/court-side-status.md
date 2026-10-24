# Court Side: live status

**Court Side replaces Ghost Coach for Vishal. Ghost Coach is paused.** Court Side: one short, real NBA moment rebuilt
at real size in passthrough; pause it, walk around the two players frozen mid-air with the ball, press play. Plan (when
approved): `docs/plans/court-side.md`. Ojasva's bar (5:25 AM): if a real two-player clip can't pass the still-camera
and 121-frame rules by noon, ship one player on the court. Updated Sat 5:35 AM.

## Asks for Ojasva (newest first)

5. **Open (heads-up, about 7:30-8 AM).** One B200 for about 10 minutes: a **Turbo** views run on one player-only
   portrait clip (121 frames, 1080x1920, cut from the broadcast) to see whether 4DAnyone gives a usable person before
   any full-quality GPU hours. Exact command and clip path come with it.
4. **Done.** SAM 3? **No** (gated). Use SAM 2.1 (Apache-2.0, not gated).
3. **Done.** 4DAnyone needs **exactly 121 frames**, never padded.
2. **Done.** `apps/webxr/src/court/` + `?mode=court` + the route line in `src/main.ts`: approved, chess hand rules.
1. **Done.** GPUs free from about 5:50 AM; about 16 GB disk lab-wide, one run on disk at a time.

## Now

Throwaway spikes running outside the repo: a two-person Spark scene at Quest budgets, and the walkable spot in
desktop emulation (IWER). Waiting for Vishal's clip files to measure them and run the court and player spikes.

## Verdict so far

**Possible with cuts** (Sat 5:35 AM). Each broken assumption has a route:
- **Still camera:** a broadcast camera pans and zooms from a fixed spot, so undoing its rotation gives a true still
  camera (fixed-centre calibration reaches 2.4 px median error in published work). Handheld baseline cameras don't fit.
- **One person:** one 4DAnyone run per player, on a player-only portrait crop; the auto-crop is skipped for portrait.
- **121 frames:** about 2 s of real action from a 60 fps broadcast, or a 3-4x slow-motion replay.
- **Feet in metres:** court lines give the camera; feet on the floor fix takeoff and landing; gravity fixes the jump.

Cuts: 3D playback only for those 121 frames; at most 150k Gaussians per player per frame; the rest of the game is a
still image on a court plane, a stands backdrop and flat cut-outs. Fallbacks: one hero player (noon rule), then a
single frozen moment.

## Done (facts, Sat 5:35 AM)

- Spark 2.4: all splats are sorted together (overlapping players blend right); Quest default budget 500K visible.
- Quest 3S budget: about 150k splats per player per frame in the browser; 2-3 s of frames resident (0.5-0.7 GB);
  quad layers give the sharpest backdrop. No fps measured on a headset yet.
- A full-quality replay took about 2 h end to end tonight; Turbo views take minutes.
- Clip shortlist (plays only): Giannis vs Ayton block (2021 Finals), LeBron vs Iguodala chase-down (2016 Finals),
  Kawhi vs Embiid corner shot (2019), Steph vs LeBron three (2018 Finals).
- Clip measurement tool ready locally (frames, cuts, camera motion, player height, sharpness, overlap, ball, feet).
- Spikes: two running; none finished.

## Next

1. Measure Vishal's clip files; pick the moment.
2. Court calibration and player tracking spikes on a real frame; build one player-only clip for ask 5.
3. Write `docs/plans/court-side.md` (hour-by-hour, job specs, headset design options) once Vishal approves.

## Blocked on

- The NBA clip files (Vishal).

## Decisions

- Court Side replaces Ghost Coach; Ghost Coach paused (Vishal, 5:15 AM; OK'd by Ojasva 5:25 AM).
- SAM 2.1 instead of SAM 3; exactly 121 real frames, never padded; `apps/webxr/src/court/` approved; one run on disk at
  a time (Ojasva, 5:25 AM).
- Headset controls on the palm-up left-hand menu; the court pinned with a WebXR anchor; no gesture acts by itself
  (Ojasva, 5:10 AM; Quest app too, Ian 5:28 AM).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site (Vishal).
- Spikes run outside the repo and are never merged (Vishal).
