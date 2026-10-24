# Court Side: live status

**Court Side replaces Ghost Coach for Vishal (Ghost Coach paused).** One play only: **Steph's three over LeBron, 2018
Finals G4**, from the best low, fixed courtside camera that exists. **New shape (Vishal, 6:55 AM):** in full-immersion
VR you watch the real broadcast as immersive courtside video from where that camera stood (life-size, edges falling
off into a dark arena); "Step into the court" on the palm menu eases the video to a stop at the release and **that one
frame becomes 3D** (same pixels at the hand-off, then the world opens up); you stand and walk a ring ~1.5 m around
the frozen pair; "Back to my seat" eases back into the video and the game plays on. Only the freeze has to be 3D (a
second of 3D motion is a stretch goal). Ojasva's bar: if two players aren't passing by noon, ship Steph alone.
Updated Sat 7:02 AM.

## Asks for Ojasva (newest first)

9. **Smaller GPU ask than before (supersedes the 100k playback part of 6):** per player, 50-step views on the
   121-frame clip as before, then reconstruction of **only the freeze frame**, cold, at the highest density the Quest
   holds (250k planned, up to 400k if ask 7 says so) with more iterations; no 121-frame recon needed. That's about
   30-45 min of one B200 per player instead of ~2 h, and a few MB on the headset instead of ~0.8 GB. Exact commands
   to follow with the clip. OK?
8. **Please confirm (yes/no): Court Side runs in immersive VR, for `?mode=court` only** (Vishal, 6:50 AM): WebXR
   `immersive-vr` with `local-floor` (court floor exactly on the real floor, safe to walk), the arena from the
   footage where the camera saw it, darkness beyond the court lights elsewhere. An exception to your passthrough-only
   rule (Sat 3:30 AM) for court mode alone; every other mode stays passthrough. Players lit like the footage's arena.
7. **Ready now: the first real Quest 3S number (Ian or Ojasva, ~20 min).** Vishal sends `dropin.zip` (28 MB,
   throwaway, never commit). Copy `court-quest.html` into `apps/webxr/` and `src/spike6/` into `apps/webxr/src/`;
   set a roomscale boundary of at least 3.5 x 3.5 m; open `/court-quest.html?a=<replay id>&b=<another replay id>`
   (your two best replays; only their middle frames load) or plain `/court-quest.html` (synthetic). Press "Enter at
   0.5x", stand still: five phases run by themselves (immersive 720p60 video, 3D freeze 2x250k, 2x400k, walk round,
   video-to-3D hand-off), then a results table. Photo it, exit, repeat at 0.75x and 1x (and once `&vw=1920`). Send
   the photos plus anything odd (tab reload, flicker, Hz), then delete the files. Full steps in its `HOW-TO.md`.
6. **Yes (Ojasva, 6:05 AM):** 100k playback + a 250k freeze frame; keep `aniso`, `sourceView`, 50-step views.
5. **Approved (Ojasva, 5:50 AM):** one B200 ~10 min for a **Turbo** views run on one player-only portrait clip.
1-4. **Done:** GPUs free; ~16 GB lab disk, one run at a time; `apps/webxr/src/court/` + `?mode=court` approved;
   4DAnyone needs exactly 121 frames; SAM 2.1 (SAM 3 gated).

## Now

Re-planning around the video-first shape (6:55 AM). Running: the angle research (first answer: no public copy of this
play is above 720p30, and the low angles exist only inside broadcast replays; checking a NextVR courtside VR camera
at 4K60 and the best alternative play), VR immersion research, a prototype rig for 3 hand-off directions, a VR
Quest test page, and spikes for calibration, smooth slow-down + video-to-3D hand-off, shadows + floor reflections.

## Verdict so far

**More feasible than before:** GPU drops to ~1-1.5 h for both players, headset memory is no longer a constraint, and
the splat budget goes into one sharp frozen moment. Biggest risks now: the angle (no 60 fps public copy found yet;
fixed vs handheld unverified), the video-to-3D hand-off matching to the pixel (calibration), and how sharp a 720p
player can be in 3D up close.

## Done

- 5:47 AM, S4 PASS (desktop): two players + freeze + court + backdrop in one Spark scene, 10 ms on a laptop.
- 5:57 AM, S5 PASS except one field-of-view rule (desktop, AR): anchor 0 mm drift, palm menu works, pinches do
  nothing, ring ~1.5 m. Being re-run in VR.
- 6:43 AM, S6 Quest stereo test page built and proven on desktop (0 errors); VR version in progress.

## Next

1. The angle: exact video + timestamps for Vishal. 2. Prototypes (seat view, the hand-off and walk) for Vishal to
pick. 3. The Quest number (ask 7). 4. When the clip lands: gate 1, calibration, masks, player clips, Turbo (ask 5).
5. `docs/plans/court-side.md`, broken by reviewers before any build.

## Blocked on

- The clip file (Vishal), after the angle pick.

## Decisions

- Video-first: watch the real footage immersively; only the freeze frame becomes 3D (Vishal, 6:55 AM).
- Full immersion: `immersive-vr` + `local-floor`, `?mode=court` only (Vishal, 6:50 AM; Ojasva to confirm, ask 8).
- Code: a clean, self-contained `apps/webxr/src/court/` module with a simple documented data format (cameras,
  players, freeze frame, video, audio); nothing generalised beyond this demo (Vishal, 6:55 AM).
- One play from a low, fixed courtside camera; the seat sits where it stood (Vishal, 6:20 AM). Plan and prototype
  only until Vishal approves the plan. Target the WebXR viewer (Quest app only an ask to Ian).
- Fixed crop per player in the stabilised frame; SAM 2.1 masks on Vishal's PC (Vishal, 5:45 AM).
- Controls on the left-palm menu, the court locked to the room, no gesture acts by itself (Ojasva).
- Public figures: only what really happened, no voices, labelled "Real footage, rebuilt in 3D. Not affiliated with
  the NBA or the players.", source credited; the clip and its 3D stay out of the public repo and site (Vishal).
