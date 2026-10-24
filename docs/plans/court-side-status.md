# Court Side: live status

**Court Side replaces Ghost Coach for Vishal. Ghost Coach is paused.** Court Side: one short, real NBA moment rebuilt
at real size in passthrough; pause it, walk around the two players frozen mid-air with the ball, press play. Plan (when
approved): `docs/plans/court-side.md`. Ojasva's bar (5:25 AM): a verdict by about 6:15 AM; if a real two-player clip
can't pass the still-camera and 121-frame rules by noon, ship one player on the court. Updated Sat 5:25 AM.

## Asks for Ojasva (newest first)

4. **Done.** SAM 3 access? **No** (gated, no HF token on HiPerGator). Use SAM 2.1 (`facebook/sam2.1-hiera-large`,
   Apache-2.0, not gated); switch if SAM 3 arrives.
3. **Done.** 4DAnyone's frame minimum? **Exactly 121, hard** (`fdanyone/config.py`, `VideoContractError`); no padding
   with held frames. So 4.84 s at 25 fps, about 2 s of real action from a 60 fps source re-timed to 25 fps, or a
   slow-motion replay.
2. **Done.** New files in `apps/webxr/src/court/` + `?mode=court` + the one-line route in `src/main.ts`: **approved**,
   chess hand rules (palm menu, anchor, a handle to move it).
1. **Done.** Headroom: GPUs free from about 5:50 AM (cap 24, B200 + RTX PRO 6000); disk **about 16 GB free
   lab-wide**, so one run on disk at a time, clips trimmed to the moment. Exact job specs come with the plan.

## Now

Writing the feasibility verdict. Code recon and the clip shortlist are done; three research reports (player tracking
and 3D bodies, court calibration and backdrop, Quest 3S budgets) are being collected.

## Verdict so far

**Still scoping; leaning "possible with cuts."** The two hard rules can be met: broadcast cameras pan and zoom from a
fixed spot, so undoing the rotation gives a true still camera; and a 60 fps clip or a slow-mo replay fills 121 frames.
Two overlapping people blend correctly in Spark (one global sort).

## Done (facts, Sat 5:25 AM)

- Pipeline: a portrait player clip skips the auto-crop; export keeps each player's path across the floor but places it
  from frame 0 only (`pipeline/lucid/export.py:159-176`), so Court Side needs its own court transform.
- Spark 2.4: splats from all meshes are sorted together; Quest's default splat budget is 500K visible; 16 B per splat;
  hidden frames keep memory but cost no sort time. WebXR plays one dream per page today; no fps measured on a Quest.
- Quest app: 56 B per Gaussian per frame (SPZ) in a shared 3 GB budget; two people are sorted separately, which is
  wrong when a blocker overlaps a shooter.
- Clip shortlist ready (top: Giannis vs Ayton block, 2021 Finals, every-angle replay; LeBron vs Iguodala chase-down,
  2016 Finals; Kawhi vs Embiid corner shot, 2019; Steph vs LeBron three, 2018 Finals). Files not supplied yet.
- Desktop emulation ready locally (IWER 2.5.0, `npm ci` done in `apps/webxr` and `apps/site`).
- Spikes: none run yet.

## Next

1. Verdict with evidence (about 6:15 AM).
2. Vishal supplies 2-3 candidate files; each is measured locally (frames, cuts, camera motion, player height,
   sharpness, ball, court lines).
3. Throwaway spikes outside the repo: court calibration, tracking, a 4DAnyone-ready player clip, a two-person Spark
   scene at Quest budgets, the walkable spot in desktop emulation.

## Blocked on

- The NBA clip files (Vishal).

## Decisions

- Court Side replaces Ghost Coach; Ghost Coach paused (Vishal, 5:15 AM). OK'd by Ojasva (5:25 AM).
- SAM 2.1 instead of SAM 3; exactly 121 real frames, never padded; `apps/webxr/src/court/` + `?mode=court` approved;
  one run on disk at a time (Ojasva, 5:25 AM).
- Headset controls go on the palm-up left-hand menu; the court is pinned with a WebXR anchor; no gesture acts by
  itself (Ojasva, 5:10 AM).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site (Vishal).
- Spikes run outside the repo and are never merged (Vishal).
