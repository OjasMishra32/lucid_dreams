# Court Side: live status

**Court Side replaces Ghost Coach for Vishal. Ghost Coach is paused.** One clip only: **Steph's three over LeBron,
2018 Finals G4**, from the best low, fixed courtside angle that exists. You start in a courtside seat where that camera
stood, about 2 s plays in real 3D, you pause on the palm menu and it eases into a freeze at the release, then you stand
up and walk a ring about 1.5 m around the pair; it plays on or replays. **Full immersion in VR, not passthrough**
(Vishal, 6:50 AM): headset on, your room is gone and you're courtside in the arena. Ojasva's bar: if two players
aren't passing by noon, ship Steph alone. Updated Sat 6:49 AM.

## Asks for Ojasva (newest first)

8. **Please confirm (yes/no): Court Side runs in immersive VR, for `?mode=court` only.** Vishal (6:50 AM) wants full
   immersion, like Apple Vision Pro's courtside NBA view: WebXR `immersive-vr` with `local-floor` (the court floor
   exactly on the real floor, safe to walk), the arena where the camera saw it and darkness beyond the court lights
   where it didn't. This is an exception to your passthrough-only rule (Sat 3:30 AM) for court mode alone; every other
   mode stays passthrough. The players are lit like the footage's arena, not matched to the room.
7. **Ready now (Ian or Ojasva, ~15 min on the Quest 3S): the first real headset number for Court Side.** Vishal
   sends you `dropin.zip` (a throwaway test page, never commit it). (1) Unzip it: put `court-quest.html` in
   `apps/webxr/` and `src/spike6/` in `apps/webxr/src/`. (2) On the Quest, open your usual dev server or tunnel at
   `/court-quest.html?a=<replay id>&b=<another replay id>` with your two biggest finished replays (for example the
   jump shot and LeBron); it loads up to 121 frames of each. (3) Press "Enter at 0.5x" and stand still: four 12 s
   phases run by themselves (play, freeze, walk around while playing, walk around frozen), then a results table
   appears. Photo it. (4) Exit from the palm menu and repeat with 0.75x and 1x. Add `&hz=90` once at the best scale.
   (5) Then once more with `?per=100000` (synthetic people at the planned 100k/250k budget). (6) Send the photos and
   anything odd (tab reload, black flicker), then delete both files. Desktop proof: it runs end to end, 0 errors.
   **Update 6:55 AM:** a VR version (immersive-vr, full arena drawn) replaces it within ~30 min; use that one.
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

Adopting full-immersion VR (6:50 AM): the prototypes, the shadow spike and the Quest test page are being switched to
immersive-vr, and S5's walk checks re-run in VR. Also running: the angle research (exact video + timestamps for
Vishal), VR immersion research (arrival, arena light, sound, boundary), spikes for low-camera calibration, smooth
slow-down into the freeze, and contact shadows + floor reflections. Waiting for the clip file.

## Verdict so far

**Feasible with cuts** (5:50 AM), now planned around **121 even native 60 fps frames** around the release (about 2 s
from the seat; Vishal, 6:20 AM). Prep has no 60 fps flag and 4DAnyone accepts only 24/25/30 fps, so the 121 frames
are re-timed to a 25 fps clip (2.4x slow) for 4DAnyone and played back at 60 fps in the headset. Biggest risks:
player size in a 720p broadcast, LeBron's hand overlapping Steph at the freeze, and two full-quality runs in a day.

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

1. Find the angle: which low, fixed courtside cameras exist for this play (exact video and timestamps for Vishal).
2. Prototypes of the seat view and the freeze-and-walk transition for Vishal to pick; the Quest budget test (ask 7).
3. When the clip lands: gate 1, calibration, masks, two fixed-crop player clips, then the Turbo run (ask 5).
4. `docs/plans/court-side.md`, reviewed and broken before any build.

## Blocked on

- The clip file (Vishal).

## Decisions

- Full immersion: `immersive-vr` + `local-floor` for `?mode=court` only; the arena from the footage where the camera
  saw it, darkness beyond the court lights elsewhere; players lit like the footage's arena (Vishal, 6:50 AM; Ojasva to
  confirm, ask 8).
- One clip: Steph's three over LeBron, 2018 Finals G4, from a low, fixed courtside camera; the seat sits where it
  stood; 121 native 60 fps frames (Vishal, 6:20 AM). Plan and prototype only until Vishal approves the plan.
- Target the WebXR viewer; the Quest app is only an ask to Ian (Vishal, 5:45 AM).
- Each player's crop is a fixed window in the stabilised frame covering their whole 5 s path, never a moving crop
  (Vishal, 5:45 AM).
- SAM 2.1 masks run on Vishal's PC first (Vishal, 5:45 AM).
- Court Side replaces Ghost Coach (Vishal 5:15 AM, OK'd by Ojasva 5:25 AM). SAM 2.1 not SAM 3; 121 real frames;
  `apps/webxr/src/court/` approved; one run on disk at a time (Ojasva, 5:25 AM).
- Controls on the palm-up left-hand menu, the court pinned by a WebXR anchor, no gesture acts by itself (Ojasva).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site (Vishal).
