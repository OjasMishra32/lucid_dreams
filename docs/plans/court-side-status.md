# Court Side: live status

**Court Side replaces Ghost Coach for Vishal (Ghost Coach paused).** In full-immersion VR you watch one real NBA play
as immersive courtside video from where the low camera stood; "Step into the court" eases it to a stop and **that
one frame becomes 3D** (same pixels at the hand-off, then the world opens up); you stand and walk around the frozen
moment, every player on court a solid 3D person; "Back to my seat" eases back into the video. Ojasva's bar: if the
two main players aren't passing by noon, ship the main player alone.
Updated Sat 7:56 AM. Vishal is asleep until ~10:45; a fresh planning session is working through his standing orders.

**Clip (decided by Vishal, 7:34 AM):** Luka Dončić's game-winning step-back three over Rudy Gobert, 2024 West finals
Game 2, from the low courtside camera in the Mavericks' all-angles upload (`fqSTGIgHabI`, 2160p60) at 6:15. Kept
private, outside the repo.

## Asks for Ojasva (newest first)

8. **Yes (Ojasva, 8:10 AM): immersive VR for `?mode=court` only**, `immersive-vr` + `local-floor`, court floor on
   the real floor. Two conditions: the Quest boundary stays on (never ask people to turn it off), and the palm menu
   has a "See my room" toggle that drops to passthrough with the frozen players still standing there (comfort and
   safety while walking). Every other mode stays passthrough.
7. **The first real Quest 3S number (Ian or Ojasva, ~20 min).** Vishal sends `dropin.zip` (throwaway, never
   commit): copy `court-quest.html` into `apps/webxr/` and `src/spike6/` into `apps/webxr/src/`, open
   `/court-quest.html`, press "Enter at 0.5x", stand still; photo the results table; repeat at 0.75x and 1x. Steps
   in its `HOW-TO.md`.
   **(Ojasva, 8:10 AM): waiting on a person in the headset; Ojasva runs it when he's up, unless Ian gets to it first.**
9. **GPU, new shape:** (a) each main player: 50-step views on its 121-frame clip, then **only the freeze frame**
   reconstructed cold at 250-300k with more iterations (~30-45 min of one B200 each); (b) up to 8 other players:
   Turbo views + freeze frame at 40-80k (~15 min each, parallel), or LHM++ on an L4. Views deleted after each recon
   to stay inside ~16 GB. Exact commands follow the calibration. OK?
   **Yes (Ojasva, 8:10 AM), both (a) and (b), LHM++ on L4s welcome for the far players.** Before each batch check
   the group's free space (`df -h /blue/iruchkin` and the quota), delete views right after each recon, and keep
   everything under `$L/runs/court-*`. Put the exact commands here; my session submits them as soon as they appear.
10. **(a) and (b) done, (c) yes next (Ojasva, 8:30 AM).** In a run's `job.json`:
    - `"sourceMasks": "masks"` and `"sourceIgnore": "ignore"`: folders inside the run, one PNG per frame of
      `prepped.mp4` named by its index (`000123.png`); white means the player in masks and the other player in
      ignore. Ignored pixels never pull on the Gaussians, and `sourcePsnr` counts only the rest.
    - `"sourceFocal": 5352.2`: in `prepped.mp4` pixels, which is your lens focal in source pixels, times 1920/crop
      height if prep upscaled (`prep.json` says so).

    The same switches exist on `lucid.recon` (`--source-masks/--source-ignore/--source-focal`) and the debug solve
    (`python -m lucid.source_view ... --masks --ignore --focal`). Tested on a B200 against jump-shot-hq:
    - given masks with a sixth of the person ignored solve as well as the model's masks (silhouette IoU 0.973);
    - holding the solved focal gives 0.972;
    - a 1.6x wrong focal drops to 0.901, so the focal has to be right;
    - a one-frame reconstruction with all three runs clean.

    (c) Each extra angle becomes its own real view, solved against the same Gaussians. Send that angle's frame at the
    freeze moment, its player mask and its focal, and I'll wire it.
11. **`pipeline/court/`, code only (Ojasva, 8:10 AM).** No frames, masks, calibration numbers or anything else
    derived from the broadcast in git (it's a public repo): data stays under `$L/runs/court-*` and outside the
    repo; add a `.gitignore` there to be safe. Credit the footage in demo/credits.md, demo use only, players labelled
    "Not affiliated".
6. **Yes (6:05 AM):** 100k playback + 250k freeze; keep `aniso`, `sourceView`, 50-step views. 5. **Approved:**
   one B200 Turbo run. 1-4. **Done.**

## Now

- Plan `docs/plans/court-side.md` being finished (definition of perfect, footage, smoothness results, frame budget,
  shot list); then break-it reviews and one independent review; then the build on branch `court-side`.
- Three hand-off directions being prototyped in parallel on the VR rig: "Same Pixels", "House Lights",
  "Depth Grows". The session picks one by ~8:45 and logs why here.
- Court calibration of the chosen angle running (the tool is proven on a synthetic bench: ~0.2 px, ~0.3 cm).

## Verdict so far

Feasible. The footage is far better than the 2018 options: players ~900 px tall at 1080p, real high-speed, no cut.
Biggest risks: the video-to-3D hand-off matching to the pixel (calibration), Luka seen mostly from behind (ask
10c), and the Quest frame rate (ask 7).

## Done

- 7:34 AM clip decided; gate 1 7/9, a pass in substance (the two misses: camera pans, ball detector).
- 7:42 AM smoothness spike: ease = baked flow in-betweens at 72 Hz via WebCodecs; hand-off = frozen frame projected
  onto proxies, 3D drawn under it, video faded out over 1 s; <= 1.08 px p95 for head moves up to 10-15 cm.
- 7:50 AM VR prototype rig with projected proxies (0 console errors, timeline tests 7/7); crowd audio separated
  (commentary-free bed from the release angle).
- Earlier: S4 budget, S5 walk (anchor 0 mm drift, palm menu), S6 Quest test page, shadows/reflections/light match.

## Next

1. Pick the hand-off direction. 2. Finish the plan + reviews. 3. Build on `court-side` against stand-in data.
4. With calibration: player clips, masks, then the GPU commands (ask 9).

## Blocked on

- The Quest number (ask 7) for the final splat budget; Ojasva's yes on 8 before the build ships to main.

## Decisions

- Video-first: only the freeze frame becomes 3D (Vishal, 6:55 AM). Full immersion, `?mode=court` only (6:50 AM).
- Overnight (Vishal's standing orders): build on branch `court-side`, pushed for Ojasva to see; nothing merged to
  main until Vishal is back; choices he'd normally make are made here and logged with the reason.
- Crowd sound: the clip's own crowd with commentary removed (no CC0 downloads until Vishal approves).
- Code: a clean, self-contained `apps/webxr/src/court/` module with a documented data format; nothing generalised.
- Controls on the left-palm menu; the court locked to the room; no gesture acts by itself (Ojasva).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site.
