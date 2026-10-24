# Court Side: live status

**Court Side replaces Ghost Coach for Vishal. Ghost Coach is paused.** Court Side: one short, real NBA moment rebuilt
at real size in passthrough; pause it, walk around the two players frozen mid-air with the ball, press play. Plan (when
approved): `docs/plans/court-side.md`. Updated Sat Oct 24, 5:15 AM EDT.

## Asks for Ojasva (newest first)

4. **Open.** Did `facebook/sam3` access come through on Hugging Face? SAM 3 is the first choice for cutting out the two
   players and the ball across the clip. Yes/no is enough.
3. **Open.** In 4DAnyone's `inference.py`, what is the real minimum frame count? Our code only warns under 121
   (`pipeline/lucid/prep_clip.py:70`). A real two-player moment is often 50-100 frames at 25 fps, so this decides
   which plays can be used.
2. **Open.** OK for Vishal to add a court scene to the WebXR viewer as new files only (`apps/webxr/src/court/`,
   `?mode=court`, like chess), using your `HandMenu` and `WorldLock`? Anything outside `src/court/` comes to you as an ask.
1. **Open.** Rough GPU and disk headroom for Court Side today until about 4 PM? First guess: two replays (each 1 B200
   for views, then a recon array) and about 10 GB on /blue. Exact job specs follow once the plan is approved.

## Now

Scoping, nothing built. Research agents are checking player tracking (SAM 3), 3D bodies from a broadcast camera,
court-line calibration, the crisp backdrop, Quest 3S budgets and candidate plays. Code recon is done.

## Verdict so far

**Still scoping.** A portrait clip of one player, cut out of the broadcast, can enter today's chain unchanged. Nothing
yet handles two people in one scene, court placement or tracking.

## Done (facts from the code, Sat 5:13 AM)

- Pipeline: a portrait clip skips the auto-crop; under 121 frames is only a warning in our code; export keeps each
  player's path across the floor but places it from frame 0 only (`pipeline/lucid/export.py:159-176`).
- WebXR: one dream per page, every frame resident, no LoD or fps settings; desktop emulation exists (`?emulate`,
  IWER 2.5.0). No fps has been measured on a Quest yet in either app.
- Quest app: SPZ costs 56 B per Gaussian per frame inside a shared 3 GB budget; two people are sorted separately
  (fine 1.5 m apart, wrong when a blocker overlaps a shooter).
- Avatars: LHM++ takes about 4 min on an L4; no path yet from a broadcast player to an avatar placed on a court.
- Spikes: none run yet.

## Next

1. Feasibility verdict with evidence (target about 6:15 AM).
2. Clip criteria and candidate plays for Vishal to supply; measure each file locally.
3. Throwaway spikes outside the repo: court calibration, tracking, a 4DAnyone-ready player clip, a two-person
   Spark scene at Quest budgets, the walkable spot in desktop emulation.

## Blocked on

- The NBA clip files (Vishal supplies them).
- SAM 3 access (ask 4).

## Decisions

- Court Side replaces Ghost Coach; Ghost Coach paused (Vishal, Sat 5:15 AM).
- Headset controls go on the palm-up left-hand menu; the court is pinned with a WebXR anchor; no gesture acts by
  itself (Ojasva, Sat 5:10 AM).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site (Vishal).
- Spikes run outside the repo and are never merged (Vishal).
