# Court Side: live status

**Court Side replaces Ghost Coach for Vishal. Ghost Coach is paused.** (Ojasva, Sat 5:25 AM: OK, it's your call in
your area; one feasibility verdict by about 6:15 AM, and if a real two-player clip can't pass the camera and
121-frame rules by noon, ship one player on the court rather than nothing. Biggest risk to check first: broadcast cameras pan, zoom and cut,
and 4DAnyone wants a still camera (AGENTS.md, "Clips that work"); pick a moment from a fixed baseline or replay
angle, or stabilise to the court lines before views.) Court Side: one short, real NBA moment rebuilt
at real size in passthrough; pause it, walk around the two players frozen mid-air with the ball, press play. Plan (when
approved): `docs/plans/court-side.md`. Updated Sat Oct 24, 5:15 AM EDT.

## Asks for Ojasva (newest first)

4. **Answered.** Did `facebook/sam3` access come through on Hugging Face? SAM 3 is the first choice for cutting out the two
   players and the ball across the clip. Yes/no is enough.
   **Ojasva (Sat 5:25 AM): no.** `facebook/sam3` is gated (manual approval) and there is no Hugging Face token on
   HiPerGator; the request has to come from a person's own HF account. Don't wait on it: start with **SAM 2.1**
   (`facebook/sam2.1-hiera-large`, Apache-2.0, not gated), which tracks objects through video; switch if SAM 3 arrives.
3. **Answered.** In 4DAnyone's `inference.py`, what is the real minimum frame count? Our code only warns under 121
   (`pipeline/lucid/prep_clip.py:70`). A real two-player moment is often 50-100 frames at 25 fps, so this decides
   which plays can be used.
   **Ojasva (Sat 5:25 AM): exactly 121, hard.** `fdanyone/config.py` `num_frames = 121`, and `fdanyone/video.py`
   raises `VideoContractError` when the clip can't fill 121 frames at the target rate (`target_fps=auto` keeps 24, 25
   or 30; our prep resamples to 25). So the moment must last 4.84 s at 25 fps (4.03 s at 30). For short plays use the
   broadcast's **slow-motion replay** (often 60 fps or slowed): a 2 s dunk in slow-mo covers 121 frames on its own.
   Padding with held frames would freeze the person in 4DAnyone's views, so don't.
2. **Answered.** OK for Vishal to add a court scene to the WebXR viewer as new files only (`apps/webxr/src/court/`,
   `?mode=court`, like chess), using your `HandMenu` and `WorldLock`? Anything outside `src/court/` comes to you as an ask.
   **Ojasva (Sat 5:25 AM): yes.** New files in `apps/webxr/src/court/` with `?mode=court`, using `HandMenu` and
   `WorldLock`; the one-line route in `src/main.ts` is approved too. Same hand rules as chess: nothing acts on a
   gesture, the court is pinned by its anchor and moves only by a handle you pinch.
1. **Answered.** Rough GPU and disk headroom for Court Side today until about 4 PM? First guess: two replays (each 1 B200
   for views, then a recon array) and about 10 GB on /blue. Exact job specs follow once the plan is approved.
   **Ojasva (Sat 5:25 AM): yes, with care on disk.** GPUs: our cap is 24 (B200 + RTX PRO 6000); tonight's jobs
   (guitar, the jump-shot ball reruns) end about 5:50 AM, then the queue is yours, after any demo fix. Disk: the lab's
   whole 5 TB is shared and has only about 16 GB free, so 10 GB is fine if runs go one at a time on disk, the
   reconstruction frames are deleted at export (they are) and input clips are trimmed to the moment. Send exact specs.

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
