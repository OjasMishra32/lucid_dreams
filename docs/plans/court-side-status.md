# Court Side: live status

**Court Side replaces Ghost Coach for Vishal (Ghost Coach paused).** In full-immersion VR you watch one real NBA play
as immersive courtside video from where the low camera stood; "Step into the court" eases it to a stop and **that
one frame becomes 3D** (same pixels at the hand-off, then the world opens up); you stand and walk around the frozen
moment, every player on court a solid 3D person; "Back to my seat" eases back into the video. Ojasva's bar: if the
two main players aren't passing by noon, ship the main player alone.
Updated Sat 10:02 AM. Vishal is up and runs HiPerGator himself now (his account).

**Clip (decided by Vishal, 7:34 AM):** Luka Dončić's game-winning step-back three over Rudy Gobert, 2024 West finals
Game 2, from the low courtside camera in the team's own all-angles upload. Kept
private, outside the repo.

## Asks for Ojasva (newest first)

18. **Two quality hooks, before gate 2 if you can (Vishal will submit Court Side's HiPerGator grid himself, so
    your session doesn't have to):** (a) can 4DAnyone take our own body motion (SMPL-X per frame, e.g. from GEM-X)
    instead of its built-in GVHMR, in case GVHMR gets the mid-closeout pose wrong? (b) recon with more than one
    extra real view of the freeze frame (the second low angle and the high broadcast angle at the same instant, each
    with its own camera, mask and focal), your 10(c): is it wired, and what file layout do you want?
    **(a) Yes, through 4DAnyone's own reuse path (Ojasva, 10:25 AM).** `fdanyone/pipeline.py` loads an existing
    motion result instead of running GVHMR ("Reusing GVHMR motion from …") when the output's motion dir exists.
    - Let 4DAnyone run its motion step once, so its `MotionResult` (JSON + safetensors) is written with the right
      metadata: GVHMR revision, frame indices, source size and mtime, `K_fullimg`.
    - Replace only the tensors in `smpl_params_global` and `smpl_params_incam`: `body_pose` [121,63], `betas`
      [121,10], `global_orient` [121,3], `transl` [121,3].
    - GVHMR's body pose is already SMPL-X's 21 body joints, so GEM-X's values go in without conversion.
    - `incam` must be in the clip's own camera (`K_fullimg`); `global` must be gravity-aligned, y up (4DAnyone
      derives its canonical world from it).
    - Leave every metadata field and `observed_keypoints_2d` as they are. Delete only the generated views, then
      re-run: the log line tells you it took yours.
    - Check the skeleton overlay before trusting it.
    **(b) Wired (Ojasva, 10:50 AM): `lucid.recon --extra-sources extra.json`**, alongside `--source-video`:
    ```json
    [{"video": "release-angle.mp4", "offset": 0, "masks": "masks-release", "ignore": "ignore-release",
      "focal": 4100.0, "weight": 1.0},
     {"video": "broadcast.mp4", "offset": 0, "masks": "masks-bc", "focal": 6200.0, "weight": 0.7}]
    ```
    - `offset`: that video's frame = recon frame + offset. For a one-frame freeze, make each video start on the
      freeze instant (offset 0), or point offset at it.
    - `masks` / `ignore`: the same per-frame PNGs as the main camera's (named by that video's own frame index).
    - `focal`: in that video's own pixels.
    - Each angle is solved on its own against the same Gaussians, so no shared calibration is needed. If the main
      camera fails to solve, the others still can.
    - Each angle trains like the main real view (`--source-agree` too), scaled by its `weight`.
    - The log prints `[source] <name>: solved, IoU …`, `sourcePsnr.<name>` per frame, and
      `peek-source-<name>-<frame>.jpg` / `source-camera-<name>-<frame>.json` in recon/.

    Tested on a B200 (two frames, both modes). Not in stage-recon's job.json yet: call `lucid.recon` directly, or
    ask and I'll add an `extraSources` key.
17. **Your replay cleanup on our freeze frames:** `lucid.clean_support` reads `views/videos`, which our cleanup
    job deletes, and `clean_check` assumes bundle frame i = clip frame i (ours is the single freeze frame from
    its own 4K source). We'll keep views until the clean runs (`KEEP_VIEWS=1` in our scripts). Could `clean_check`
    take a frame map (bundle frame -> source video + frame), or do you prefer we run it differently?
    **(Ojasva, 10:25 AM): skip the cleanup; it doesn't earn its place.** On every replay it changed the real-frame
    PSNR by 0.01 dB. The ghosts it was meant for come from the generated views and the real frame disagreeing by a
    few cm, and that's now a reconstruction choice (166d41b). Train the freeze frame both ways and pick in the
    headset:
    - **default** (the real frame counts everywhere): pixel-true from the broadcast camera, best for a seamless
      hand-off, but a faint second limb can show from other angles;
    - **`--source-agree`**: one solid person from every side, a few cm off the broadcast pixels. Your hand-off
      projects the video on proxies anyway, so this is likely the better one for the walk.

    A few B200 minutes each.
16. **Your noon rule ("two players passing by noon, else ship the main player alone"):** the Turbo views
    (gate 2) land ~11 AM-noon and the full-quality freeze frames after ~1 PM. Apply the rule at gate 2 (both
    players' Turbo views not mush), or name a later time for the full runs?
    **(Ojasva, 9:35 AM): two checkpoints.** At gate 2 (~noon), if both players' Turbo views aren't mush, run both at
    full quality; if the second player's are, he becomes an LHM++ body (or drops out) and only the main player gets
    the full run. Then **4 PM today** for the full-quality freeze frames: whoever isn't passing by then ships as their
    Turbo freeze frame, so nothing new is still training on Sunday (feature freeze is 10 AM Sun).
15. **Court Side's tests outside `src/` (your lane):** `apps/webxr/scripts/court/` (run with
    `node --experimental-transform-types --test`), because `tsc` includes `src/` and the repo has no test runner or
    Node types; putting them in `src/court/` would break `npm run build`. Nothing else outside `src/court/` changes
    except the one route line in `src/main.ts`. OK?
    **Yes (Ojasva, 9:05 AM).** `apps/webxr/scripts/court/` is the right place (`scripts/check_look.ts` and
    `scripts/tennis_motion/` already live beside it). Add a one-line `npm run test:court` in apps/webxr's package.json
    so anyone can run it.
14. **GPU, one addition to 9:** each main player's freeze frame trained at three caps up front (300k, 250k, 200k)
    from the same views, so the headset can drop a rung on the night without a re-train: 4 B200 reconstructions
    per player instead of 1 (freeze frame only, minutes each). OK?
    **Yes (Ojasva, 9:05 AM).** Train the three caps from one set of views and delete the views afterwards. Keep only
    the rung the headset test (ask 7) picks plus one rung below it; delete the third once the test is in.
12. **The demo floor (Ojasva or Ian, for the venue):** Court Side needs about **4.5 x 5.5 m** of clear floor with
    the Quest boundary set to it (a chair centred on a short side, the walk ring around the pair). In 3.5 x 3.5 m it
    still works, with three fade-jump viewing spots instead of a full ring. Which floor can we get at Newell / Reitz?
    **(Ojasva, 8:45 AM): build for 3.5 x 3.5 m** (the three viewing spots) as the default: that's what we can count on
    at a table in Newell and on a finals stage. The full ring is a bonus Ojasva tries to get on site (he asks for a
    clear corner at check-in); make the ring vs spots choice automatic from the boundary size, not a setting.
13. **Your conditions on 8, our design (please check):** the session is `immersive-ar` drawn fully opaque, so it
    reads as full VR; "See my room" fades the arena and darkness out to passthrough while the frozen players stay.
    The boundary stays on. Gate: the new Quest test page (ask 7) checks that the boundary still shows in an AR
    session we paint over; if it doesn't, we add our own: the room fades in when the head is within 0.5 m of it.
    **Yes (Ojasva, 8:45 AM), with one change: the room fade-in near the edge is always on, not only if the boundary
    test fails.** An opaque AR session may hide the guardian on some firmware even when the test passes. Use the
    `bounded-floor` bounds if the session gives them, else the play area you set at the start. Fade the room in from
    0.6 m out, fully visible at 0.3 m. Test it by walking toward a wall in the headset before anyone else wears it.
8. **Yes (Ojasva, 8:10 AM): immersive VR for `?mode=court` only**, `immersive-vr` + `local-floor`, court floor on
   the real floor. Two conditions: the Quest boundary stays on (never ask people to turn it off), and the palm menu
   has a "See my room" toggle that drops to passthrough with the frozen players still standing there (comfort and
   safety while walking). Every other mode stays passthrough.
7. **The first real Quest 3S number: ready now on branch `court-side-q0`** (throwaway, never merge; code only, a
   script makes the test videos). On your Mac: `git fetch && git worktree add ../q0 origin/court-side-q0`, symlink
   `apps/webxr/node_modules` from your checkout, run `apps/webxr/src/spike6/make-assets.sh` (~1 min), start the dev
   server your usual way, open `/court-quest.html` on the Quest. Steps and safety in `apps/webxr/src/spike6/HOW-TO.md`
   (boundary >= 3.5 x 3.5 m kept on; Enter VR, then Enter AR-opaque; photo the two tables; answer the boundary and
   edge-fade questions; headset off/on). It measures WebCodecs 1440p72 + the decoder switch, 2x250k and 2x400k
   splats, sort lag, AR-opaque vs VR cost, See my room, your always-on edge fade, anchors and bounded-floor.
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

- **Build running on `court-side`:** interfaces frozen and pushed (107 unit tests, build, stand-in bundle and an
  emulator run all green); four streams build in parallel worktrees (core, video + hand-off, world + light,
  sound), each reviewed before it's merged into `court-side`. The redacted plan is on the branch.
- **GPU:** Vishal is logged in and submits. The group quota has ~13 GB free, so every job now runs inside one node's
  local scratch and copies back only small results (nothing on /blue is deleted). First: the other-players
  prototype (Edwards), then Luka and Gobert's views at Turbo and full quality together, then the freeze A/B grid
  (default vs `--source-agree`, as you suggested).
- Waiting on: the two players' masks (landing now), the backboard-square scan that pins the camera's depth.

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

- **Hand-off direction (planning session, 9:20 AM): "House Lights", held as a pool.** As time stops the crowd
  dims and a pool of light holds the frozen pair; the 3D comes up under the picture, the picture fades over the
  identical 3D, then the pool grows across the floor to your feet. One light field multiplies footage and 3D alike,
  so the hand-off stays pixel-identical, and the darkness hides how small the filmed region is. Judged against
  "Same Pixels" and "Depth Grows" on recordings (no measured pops; 0.20/255 at the hand-off).
- **Where you sit (planning session, 9:10 AM):** the low camera stood ~25 m from the players on a very long lens,
  so from its own spot the play is a postcard. The seat sits on that camera's line of sight ~5 m from the pair;
  the footage is projected in layers (court, stands, a card per person) so it still lines up, and the 3D takes
  over exactly at the freeze.
- **Plan in git:** the full plan (with numbers measured from the broadcast) stays private; the branch gets a
  redacted copy, per your "nothing derived from the broadcast in git".
- **Made overnight by the planning session (Vishal can change any):** the watch is the play at real speed, then
  its own real slow motion from the seat with "Step into the court" live, so any press lands on the freeze; the
  splat budget is 500k visible until the Quest number says more; the main camera stays on the ball until it drops
  through the net (no cut: the "cuts" were single-frame arena strobes, replaced in the bake), so "Back to my seat"
  plays on through the make; the freeze is the frame of Gobert's contest as Luka rises (the last sharp frame
  before the camera tilts up); the court bundle is served only over USB
  from 127.0.0.1, never through a tunnel.
- Video-first: only the freeze frame becomes 3D (Vishal, 6:55 AM). Full immersion, `?mode=court` only (6:50 AM).
- Overnight (Vishal's standing orders): build on branch `court-side`, pushed for Ojasva to see; nothing merged to
  main until Vishal is back; choices he'd normally make are made here and logged with the reason.
- Crowd sound: the clip's own crowd with commentary removed (no CC0 downloads until Vishal approves).
- Code: a clean, self-contained `apps/webxr/src/court/` module with a documented data format; nothing generalised.
- Controls on the left-palm menu; the court locked to the room; no gesture acts by itself (Ojasva).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site.
