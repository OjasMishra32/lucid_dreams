# Court Side: the plan

DRAFT (Sat Oct 24, from 7:05 AM; break-it findings folded in at 8:30 and 8:45 AM, section 12). Never committed to
main; the build goes on branch `court-side`. Live status: `docs/plans/court-side-status.md`. Source of truth:
`~/.handoffs/lucid_dreams/2026-10-24-courtside-full-prompt.md`. TBD marks what waits on the hand-off pick (3.3a),
calib-real's final solve of angle A, or the first Quest number (Q0, ask 7).

## 0. Definition of perfect (the build passes every line, or it isn't done)

Every check runs on the stand-in bundle first and on the real bundle at the end.
- **e2e** = the IWER desktop run (`node apps/webxr/test/court/e2e.mjs`): the page is stepped at a fixed dt of 1/72 s and
  each display frame is read back in the page (`readPixels`), so every frame is captured. IWER runs on the host's
  ~120 Hz rAF, so e2e never measures timing.
- **timing pass** = a separate e2e run, one at a time, logging CPU ms and GPU ms (`EXT_disjoint_timer_query_webgl2`);
  desktop numbers are compared with S6 per phase, never used as the bar.
- **Q** = a Quest 3S checkpoint (section 5): `stats.ts` frame log in `court.ts` plus OVR Metrics Tool for GPU %.
- **Alignment is in degrees of view.** 0.05 deg is the smooth spike's invisible 1 px at the Quest's centre (19.5 px/deg);
  in A's source pixels, 1 px is ~0.002 deg (f ~28.7k px at F, calib-real's v9 solve, provisional). P27-P42 were added
  by the break-it review; P1-P26 keep their numbers.

| # | Must be true | Check | Pass |
| --- | --- | --- | --- |
| **Seat and arrival** | | | |
| P1 | Seat on camera F's optical ray at D' from the pair (Decision W, 3.2): its floor point under the seated head, court yaw = camera yaw, eye at the judge's own seated height | `seat.test.ts`; e2e seat pose log | floor point within 0.10 m of the ray point at D' (default 5 m, `?seat=` 4-7 m), yaw error <= 0.5 deg; eye height logged (camera ~1.0 m, seated eye ~1.15 m: inside the tested 15 cm) |
| P2 | Life-size and in place: the projected footage lands on the 3D court lines and rim | `check_align.py` (rulebook court re-projected into each calibrated frame); e2e seat overlay | court points <= 0.02 deg median, <= 0.05 deg p95; the rendered lines continue the filmed ones across the frustum edge within 0.05 deg; rim 3.05 +/- 0.03 m |
| P3 | Edges fall into the rendered court and the dark arena, never a hard video edge; the lit region follows the pan | e2e at 6 head yaws (0, +/-60, +/-120, 180 deg) and looking up, through a pan | brightness step across the frustum edge <= 3 grey levels per pixel; the lit footage region tracks each frame's frustum |
| P27 | Arrival waits for the judge; no menu first | e2e with a simulated `visibilitychange` and head poses | black + room tone while hidden, standing or moving; the lights-up starts within 1.1 s of a still, seated head after Seat here |
| P32 | Setup can't be hit by accident | e2e | Seat here acts only after a 2.0 s hold; a 1 s press changes nothing |
| **Playback** | | | |
| P4 | One frame per display frame at exact display times | e2e capture + `smooth_metrics.py` | 0 held frames in pass 1 and pass 2; judder CV <= 0.15 (spike 0.11); 0 skipped show frames |
| P5 | Decode never shows | e2e decode log; Q0, Q1 | `VideoDecoder.isConfigSupported` true for `avc1.640034` 2560x1440 on the headset; queue never empty, never over 4; decode p99 <= 3 ms on the Quest (desktop 0.95 ms); no decoder reset or seek at a press |
| P39 | No flashes | `smooth_metrics.py --flash` on the baked show | no single-frame luma spike > 8 grey levels against both neighbours; 0 WCAG 2.3.1 general flashes (A's strobes at 1326-1327 and 1336 replaced) |
| P40 | No broadcast branding | contact sheet of the show and plates; diff inside the watermark's box | the semi-transparent Mavs watermark (x ~20-195, y ~10-185 at 4K) is gone from every show frame and plate; no NBA or team marks in our UI (the arena's own boards stay) |
| **Ease into the freeze** | | | |
| P6 | Lands exactly on F, C2 speed curve, no step | `clock.test.ts`; e2e | every press before the cutoff lands on F (0 frames off): in pass 1, early in pass 2, at and between ease starts; a later press stops on the next pass; the e2e press at 0:09 lands on F; speed change <= 0.02 per display frame (every ease starts at 0.6x; one from 1x would need >= 1.31 s); motion max/median <= 2.5; clock step = round(dt x displayHz) |
| P7 | In-betweens honest and clean | contact sheet of every interpolated run by eye (the last 0.3 s first); Reality check | no ghost hands or ball; each listed in `frames.json`; the Reality check shows "In-between frames interpolated" and their share |
| P28 | The time stop looks like one | e2e capture through the ease | stands and crowd dim 10-20% over the ease; the players' pixels change <= 1 grey level |
| **Hand-off** | | | |
| P8 | Same pixels **at the dolly seat**: the 3D under the video layer is the video layer | `handoff_check.py`: mono non-XR renders from the seated eye at the dolly seat, video layer (F on its proxies) vs the 3D underneath; plus the 3D rendered at camera F's own pose and intrinsics vs `video/freeze.png`; IWER per-eye check at head offsets of 2-10 cm from the seat | at the seat: alignment <= 0.05 deg p95 (players and background), PSNR >= 30 dB on the players, >= 32 dB elsewhere; per eye: <= 0.055 deg p95; at camera F: the same PSNR bars |
| P9 | No jump in light, colour or sharpness | e2e capture through the fade | mid-fade SSIM >= 0.95 (the one SSIM bar); <= 1.5 grey levels change per display frame; player mean colour Delta-E <= 2; Laplacian variance 3D/video 0.8-1.25 |
| P10 | The video layer fades out over fully drawn, sorted 3D (never splat opacity in) | `handoff.test.ts` on `handoff(p)`; e2e | splats drawn under the opaque video from the ease start, first sort done before the fade (sort ms and lag logged); fade 1.0 s +/- 1 frame; splat opacity constant; a head rise > 10 cm mid-fade finishes the fade in 0.3 s |
| **The 3D freeze** | | | |
| P11 | Sharp players, faces and hands; no floaters | `freeze_check.py`: renders at 6 ring poses and 1.5 m; floater count; held-out PSNR | sharpness >= 0.7x the source crop on each body, on Gobert's face and on both players' hands; 0 visible floaters (> 5 cm off the body); Luka's front (A and B both film his back) signed off by eye or kept off the shot list; held-out PSNR vs generated views reported |
| P12 | Feet on the floor, real size | `foot_check.py`; scale from the calibrated court | every sole in contact within 1.5 cm of y = 0; body scale within 3% of listed heights |
| P13 | Lit like the arena: contact shadows, soft reflections, one grade | `estimate_light.py`; e2e | shadow under every contact foot; court/pools chroma error vs the players' white <= 0.02 (spike 0.014-0.018) |
| P42 | The real view really trained the freeze | each freeze run's `recon-*/recon-*.json` and `peek-source-*.jpg` | `focalHeld` true, `focal` = FOCAL, silhouette `iou` >= 0.95 (a 1.6x wrong focal still scores 0.90, above the solver's 0.8 floor: `source_view.py:190`); the real-frame peek matches by eye |
| **Walking** | | | |
| P14 | Zero drift | e2e 17-pose walk (our maths only: IWER always grants anchors); Q2 tape check at a floor mark | 0 mm in e2e; <= 1 cm after a 2-minute walk on the Quest |
| P15 | Full frame rate while walking and leaning in | Q1-Q3 `stats.ts` + OVR Metrics Tool | 0 dropped frames in a 60 s walk; GPU p95 <= 85% of 13.9 ms; AR (opaque) vs VR frame time logged at Q0 |
| P16 | Every other player reads as a solid 3D person from every reachable spot | e2e contact sheet: every viewing spot (and the 17 ring poses when the ring is on) | no card seen edge-on (a relief only where the largest angle between its camera ray and any walk-spot ray is < 15 deg; visible width >= 30% of frontal), no holes, feet on the floor, a contact shadow; signed off by eye |
| P17 | You never enter a body, and leaning in never fades one | e2e poses | eye 0.2 m from a torso or head capsule: that player fades to 30% within 300 ms; eye 0.3 m from the ball or a hand: no fade |
| P29 | Every viewing place keeps 1 m clear of each body | `seat.test.ts` | each viewing spot, and every ring point when the ring is on, >= 1.0 m from both players' body bounds |
| P30 | The courtside plate never reads as a poster | e2e contact sheet at every viewing spot (and the ring poses), by eye | the plate dims steadily with the angle off the camera ray (to dark by ~45 deg, tuned by eye); front row, photographers and the ref sit on their own depth cards |
| **Back to the seat** | | | |
| P18 | 3D folds back into the footage, then the play runs on through the make | e2e capture; `clock.test.ts` | P8 and P9 in reverse from the seated eye; resume speed eases 0 -> 0.6x over 0.8 s (<= 0.02 per frame); the ball drops through the net (~1602) before the window dims (~1614) |
| **Sound** | | | |
| P19 | No commentary, no voices | VAD on the final mix, then Whisper, then one listen | 0 voiced frames, 0 words; -23 LUFS +/- 1, <= -1 dBTP |
| P20 | The time stop: hush as time slows, rush back on play | `sound.test.ts` (OfflineAudioContext render) | low-pass and -12 dB over the 1.2 s ease; no discontinuity clicks |
| P31 | The crowd is around you | audio graph check in e2e; by ear at Q1 | >= 4 HRTF sources at the stands, none head-locked |
| **UI and honesty** | | | |
| P21 | Palm menu only; no gesture acts by itself | e2e controls run | Step in / Back / Walk closer / Next view / Reality / Replay / See my room work; pinches, grabs, swipes change nothing |
| P22 | Caption, honesty label and credit always there | e2e text check | caption names who, which game and the moment ("Gobert closes out as Luka gathers"); label text exact: "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players." |
| P23 | Reality check marks everything the camera never saw | e2e on/off | unseen splats, the rendered court outside the camera's frustum (not filmed), floor and stands, the inpainted plate behind the players, the filled holes in a player's input, and extras placed from C tinted blue; seen % per player; interpolated share shown |
| **See my room and safety** | | | |
| P33 | Arena mode is fully opaque | e2e alpha read-back | alpha 255 at every pixel of every frame, except where the edge fade (P35) opens the room |
| P34 | See my room works everywhere | e2e toggle in all 9 phases, alpha read-back | works in each phase; fades 0.6 s out and 0.8 s back +/- 1 frame; player-matte pixels identical through the toggle; alpha 0 on room pixels, > 0 on players and contact shadows; extras outside the bounds hidden; Walk closer and Next view hidden |
| P35 | The room always opens near the edge | e2e with a simulated bounds polygon; Q0/Q1 at a wall; a wall-walk in the headset before anyone else wears it | always on: the room starts fading in 0.6 m from the bounds (`bounded-floor`, else the play area set at Seat here) and is fully visible at 0.3 m; the Quest boundary still draws in the opaque AR session |
| P24 | Nothing moves the world but you | e2e: world transform per phase | constant, except Walk closer, Next view and re-seats, each behind a <= 0.3 s fade |
| **Reliability** | | | |
| P25 | Zero errors | e2e console; Q1-Q3 remote devtools | 0 console errors or warnings from court code; 10 full runs in a row without a reload at Q3 |
| P26 | Starts fast, fits in memory | Q1 | cold start from cache <= 10 s; every asset in memory before the cable comes off; tab memory <= the Q0 ceiling minus 30% |
| P36 | The court bundle is never public | `curl` against the vite dev server and the tunnel URL; the demo server's bind address | 404 for the bundle on vite and any tunnel (it isn't under `dreams/`); the demo server answers only on 127.0.0.1 |
| P37 | A reload works with the cable off | Q1: unplug, reload, play | back to a seated arrival from the Service Worker cache within 45 s (reload, Enter, Seat here) |
| P38 | The hand-over keeps the session | Q1: headset off, then on | the session survives; the arrival starts on visible |
| P41 | Every fallback is tested | Q2: each fallback flag of section 9 | recorded against its own P-rows, and still passes them |

## 1. One screen

**What the judge lives through.** Headset on: darkness, then the court lights come up and the crowd swells. You're
sitting courtside on the line of a real low broadcast camera, ~5 m from the play, watching one hype NBA moment as real
footage at life size, its edges falling off into a rendered court and a dark arena: first at real speed, then in the replay's real slow
motion. You press **Step into the court** on your left palm: the play eases to a stop on one frame, and that frame
**becomes 3D**, pixel for pixel. The world opens: the court runs under your feet, the arena lights pool on the floor.
**Walk closer** carries you (one fade) to the pair; you stand and see Gobert's closeout from three sides, his arm over
Luka's head, and lean in to the ball and the hands. **See my room** shows them standing in your real room. **Back to my
seat**: you walk to your chair, sit, the 3D folds back into the footage, and the play runs on through the make, the
crowd roaring.

**The play (Vishal, 7:34 AM).** Luka Dončić's game-winning step-back three over Rudy Gobert, 2024 West finals Game 2,
from a low courtside replay camera in the Mavericks' all-angles upload: 4K, real high-speed (a ~120 fps capture played
2.67x slow), uncut through the make, players ~1750 px tall at the freeze. A second low fixed camera (B) sees the same
instant from ~10 deg away (section 2).

**How.** That one camera gives the video, the calibrated camera (one centre, per-frame rotation and zoom) and the 121
frames around the freeze. Each main player goes through 4DAnyone on their own (a fixed 9:16 crop, composited onto a
plain background); only the **freeze frame** is reconstructed, trained against the real native-4K frame (and B's) so
the seat view matches the footage. The footage is baked into one H.264 stream at the headset's exact 72 Hz display
times, decoded with WebCodecs and projected from each frame's own solved camera onto proxies at true depth (at the
freeze, a depth mesh of each player's own splats). At the hand-off the 3D is already drawn underneath and the video
layer fades out over 1.0 s. A self-contained `apps/webxr/src/court/` module plays it in an `immersive-ar` session drawn
fully opaque (it reads as full VR; See my room opens the real room, and the room always opens near the edge), from a
small documented bundle (`court.json`) that could move to Unity or visionOS. Splat budget: 500k visible until the
Quest says more. Built on branch `court-side` by parallel Claude agents in worktrees against a stand-in bundle
(section 5).

**Why it wins.** Presence (real footage, real scale, your own feet), a moment no broadcast can give (walking into a
frozen playoff moment), honest (every invented pixel marked), and frontier tech (4DAnyone, Aug 2026).

## 2. The footage (decided: Vishal, 7:34 AM)

**The play.** Luka Dončić's game-winning step-back three over Rudy Gobert, 2024 West finals Game 2 (at Minnesota),
from the Mavericks' all-angles upload (YouTube `fqSTGIgHabI`, 2160p60, AV1 format 401). Private copies outside the
repo, in `~/court-side-data/luka/`; the clip, its frames, masks, calibration and 3D never go in git, the site or the
status file.

| File | YouTube time | What it is |
| --- | --- | --- |
| `A-main-615.mp4` | 5:55-6:25 | **The build angle.** A low courtside replay camera behind Luka (he faces away, Gobert faces the camera), operated from one spot (pans, tilts, zooms; it pans widely around 921-1244, where the players swap sides ~1000-1080). **Uncut from frame 191 (5:58.2) to ~1614 (6:21.9)**; the ball drops through the net at ~1602. The "cuts" gate 1 saw at 22.12 s are single-frame arena strobes (1326-1327, 1336). |
| `B-release-455.mp4` | 4:45-5:05 | **A second real view of F.** A low camera at the far end, on the same side as A, ~10 deg from it; fixed (pans, tilts, zooms; the zoom drifts +4%/-3%), real time 60p, players ~750 px at 4K, sharp. No hard cut before ~800 (the "cut" at 10.4 s is flash frames). It does not show Luka's front. B620-621 is the release head to toe. |
| `C-broadcast.mp4` | 0:00-0:15 | The high main camera, real time. Used only to place the other players (3.4b), never shown. |

**Sync** (shot clock and flashes agree): B = 626 + (A - 1336) / 2.667, C = B + 8. At F: B592 and C600 (the clock reads
5.1 in both); B592 is within ~4 ms of A1244.

**Gate 1 on A: 7/9, a pass in substance** (`work/gate1-A.json`, on a 1080p copy, measured on frames ~503-624):
- Players ~900 px tall at 1080p there (~1750 px in the 4K source at F; bar 600), head to toe, apart, ankles visible,
  sharp (Laplacian median 219, bar 100).
- The two misses are expected: "steady camera" (it pans; calibration undoes the rotation) and the ball detector
  (26% of frames; the ball is placed by hand at the freeze).
- **Real high-speed, not AI slow motion.** Every 4th frame is an exact repeat (indices 4k+3, one phase from 191 to
  1326); the rest are distinct, with no interpolation-ghosting dips. The shot clock (4.5/4.4/4.3 at 1330/1346/1362)
  moves 0.1 s every 16 frames: **2.67x slow, a ~120 fps capture** (45 unique frames per video second).

**The freeze frame F = A1244 (6:15.8): Gobert's closeout** (main session, 8:25 AM; Vishal can change it). Gobert's
right arm is stretched over Luka's head; the ball is in Luka's hand at his hip, ~60% visible; both are head to toe
(lowest shoe at y ~2115 of 2160) and sharp. The caption says it plainly: "Gobert closes out as Luka gathers".
- Why 1244: Vishal's rule (make that one frame as sharp and real as possible) outranks the exact release. 1242 is the
  sharpest but the ball is a sliver; 1246 shows the whole ball but the tilt blur starts. The tilt starts ~1244, blurs
  from 1248, and the feet clip from ~1252. Luka lifts the ball 1257-1310 and releases ~1322-1326, when A has both cut
  at the waist. 1244 is unique (1243 is the repeat).
- The only overlap at F: Gobert's fingers behind the top of Luka's head.
- The ball is placed by hand (a 23.9 cm sphere at its 2D position and the hand's depth); its unseen part is
  Reality-marked.
- **Release variant (stream A2, tested in parallel at Turbo):** freeze at B620 (~A1322), from B's own 121-frame window
  (B500-620, real time 60p), with A~1322 (upper bodies, high-speed, sharp) and B620 as real views. The seat stays at
  A's camera; the legs outside A's tilted frame show only as the world opens. Vishal picks by eye.

**The 121-frame window** (4DAnyone needs exactly 121; Ojasva: `fdanyone/config.py` `num_frames = 121`):
- Unique frames only, on an even stride grid anchored on F (u = A1244; A1245 u+1, A1246 u+2, A1248 u+3, A1249 u+4,
  A1250 u+5, A1252 u+6). **By default the window runs a few frames past F**, so GVHMR has context on both sides of the
  frame that matters most; the frames after F are head to toe, the only ones with tilt blur, and stay inside 1252.
- **Stride 2 (default):** A929-1249, ending at u+4 with **F at K = 118** (tail A1246, A1249); ~2.0 s of real action
  (dribble, step-back, gather), 2.4x slow in the 25 fps container (milder for GVHMR). **Stride 1:** A1088-1248, ending
  at u+3 with **F at K = 117** (tail A1245, A1246, A1248); ~1.0 s, 4.8x slow. Both keep even capture spacing. Gate 2
  compares both on Luka and keeps the one whose GVHMR pose at K matches the frame (2D keypoints, foot contact).
- **Gate-2 alternative: the window ends at F, K = 120** (A924-1244 at stride 2, A1084-1244 at stride 1; the main
  session's A921/A1083, exact on the unique grid): no tilt-blurred frames, but no frames after F for GVHMR.
- The metrics run trains frame K only (section 7), so any K <= 120 stays inside the clip (`frames.py:103-115`
  zero-fills past the end without a check; the old K-1..K+1 metrics needed K <= 119).
- **Each player has their own window.** Each crop is one fixed 9:16 window (1216x2160, the full 4K height) in the
  stabilised canvas; measure each player's union box over the window first, and use stride 1 if it doesn't fit.
  Luka covers Gobert's body around A1020-1120 (A1097: over his torso), so Gobert's window (`court-def`) is picked to
  cover the fewest such frames (likely stride 1: about 28 of 121 samples vs ~38 at stride 2).
- 4DAnyone crops to the union of its BiRefNet masks + 4% (`fdanyone/geometry/crop.py:51-68`) and GVHMR keeps one
  track (`fdanyone/motion/gvhmr.py:196`), so each player is **composited onto a plain background with their SAM 2.1
  mask**. Where the other player is in front, the hole is filled neutrally (never with the other player's pixels) and
  the Reality check marks it.
- Re-timed into a **25 fps container**: `setpts=N/25/TB` plus `-r 25` (without `-r` the stream keeps `r_frame_rate`
  60000/1001). Prep's `fps=25` (`pipeline/lucid/prep_clip.py:74`) then changes nothing, and portrait clips pass
  through at their own size (`:77-98` crop and scale only landscape clips). `framemd5` of our `input.mp4` shows 121
  distinct frames in order; prep re-encodes at CRF 14, so `check_prepped.py` checks the Turbo run's `prepped.mp4` frame
  by frame instead (121 frames, each frame's best match is its own source frame, >= 40 dB).
- The bundle stores real timing (each show frame's source frame index, 59.94 fps, capture 120 fps), never 25 fps.

**What the slow motion means for watching.**
- **Pass 1, real speed:** frames 191-1252, ~6.6 s of real action (the dribble, the step-back, Gobert closing out);
  the window dims as the camera starts to tilt.
- **Pass 2, the replay's real slow motion:** from the step-back (~2.5 s of real time before F, ~A844) at **0.6x**, the
  slowest speed where every 72 Hz display frame is a real captured frame (120 fps x 0.6 = 72). A's own 0.375x would
  need 3 interpolated frames in every 8. Step into the court is live; unpressed, pass 2 plays on through the make and
  repeats.
- **Resume:** F to ~1614 at 0.6x (~3.9 s): Luka lifts the ball, the camera tilts up to the rim, the release, the ball
  through the net at ~1602, the crowd's swell on the make; the window dims before the next cut.
- The possession before 5:58 exists only from the high camera; we don't use it (it would break the seat).

**Sound** (Demucs at `~/.local/bin/demucs`, local weights, offline):
- A has no usable audio (3.8 s of mono shouting, then silence).
- **The bed is B's crowd:** its Demucs "no vocals" stem is clean (Whisper finds no speech, 0% voiced frames):
  `~/court-side-data/luka/audio/crowd-loop.wav`, 19 s with a 1 s equal-power seam, -23 LUFS, -1.5 dBTP.
- B's crowd swell at ~12 s (+4.8 dB) would repeat every loop: cut it out and fire it once, on the make (and softly at
  Step in).
- C carries the play-by-play in its vocal stem and possible residue at 3-5 s: not used.
- Shoe squeaks, the bounce and the release need separate sounds; none are in our clips. CC0 sounds wait on Vishal's OK.

**Branding and public figures.** A, B and C carry a semi-transparent Mavs watermark (x ~20-195, y ~10-185 at 4K): it
is inpainted out of the show and every plate. The Sprite LED behind both heads in A (x 1290-2460, y 245-555 at F) and
the TISSOT clock (it changes every 0.1 s) get ignore boxes in calibration's feature tracking; they stay in the picture
(the real arena). C's TNT score bug and stanchion LEDs never show (C is never shown). Our UI shows no NBA or team marks.

**Still to verify on A (calib-real):** the camera centre stays fixed across 191-1614 (residual), its height and
distance, the zoom range and lens distortion (today's fits hold k1 at 0). **The v9 numbers used in this plan are
provisional until calib-real's final solve:** camera ~1.0 m high, f ~28.7k px at F (a 7.6 x 4.3 deg window), the pair
~29-32 m away (`calib_v9_snap.json`, 08:43, click p95 2.1 px). Decision W (3.2) places the seat the same way whatever
the final distance.

**Dead ends (don't retry):** Steph over LeBron 2018 G4 (no copy above 720p30; the best low angle is handheld with
LeBron between it and Curry); Giannis's block (the all-angles video is behind an NBA sign-in; public copies 720p, no
low fixed angle); the Phantom-camera, Olympic, FIBA, EuroLeague and NCAA hunts (720p, 30 fps, handheld or sign-in).
Backups if A fails calibration: Curry's record three (`mYe0U3e1kPA`, 1080p60, low courtside 0:49-0:53), Lillard over
George 2019 (`i_jRh-Bwf94`, 1080p60, court level 0:47-0:51, real time).

## 3. The experience, beat by beat

Numbers from the research (Apple Immersive guidance, 9to5Mac/UploadVR reviews, Meta comfort guidance). Chosen hand-off
direction: open (3.3a).

### 3.1 Setup (presenter, before the judge)
- **The floor (Ojasva, binding):** built for **3.5 x 3.5 m** with the Quest boundary set to it: a real chair centred on
  one side, 0.6 m from the edge, and three viewing spots (3.4). The full walk ring is a bonus Ojasva tries to get on
  site (about 4.5 x 5.5 m); it turns on by itself when `bounded-floor` reports room for it, never as a setting.
- **The room near the edge, always:** the room fades in from 0.6 m out from the bounds and is fully visible at 0.3 m
  (`bounded-floor` bounds if granted, else the play area set at Seat here: the 3.5 x 3.5 m square from the chair). The
  presenter walks toward a wall in the headset to check it before anyone else wears it.
- **Served from the Mac:** `vite build` plus a static server (`apps/webxr/src/court/serve.mjs`) bound to 127.0.0.1,
  reached over USB with `adb reverse`; never through the tunnel. A Service Worker precaches the page and the bundle,
  every asset is loaded into memory, then the cable comes off.
- **Chair:** a normal chair. The eye stays at the judge's own seated height (~1.15 m); the camera's ~1.0 m is within
  the 15 cm the smooth spike tested, and the splat-depth proxy (3.3) keeps the hand-off exact off the ray.
- **Seat here:** the presenter sits, taps Enter on the page (`requestSession` needs a tap), and holds **Seat here**
  for 2 s on the palm menu's setup page. The court is placed so the seat point (on camera F's optical ray, D' ~5 m from
  the pair's centre; Decision W) is under their head and F's view direction is their forward; a courtside chair is drawn in room space over the real chair; the play area is
  set; the court is pinned with a WebXR anchor (the old persistent handle is deleted first: 8 per site).
- **Hand-over:** the session stays live. Headset off hides the page; the judge putting it on makes it visible, which
  starts the arrival (3.2).

### 3.2 Arrival and watching
| t (s) | What happens |
| --- | --- |
| hold | Black, room tone only (never dead silence), until the page is visible and the head is seated and still for ~1 s. |
| 0.0-2.5 | Crowd swells from -30 to -12 dB; court light pools ignite in sequence; the lit footage region rises out of black. The presenter coaches "turn your left palm up" here. |
| 2.5-9.1 | **Pass 1**, the play at real speed (~6.6 s), over B's crowd bed, seen from the dolly seat (Decision W). Each frame is **projected from its own calibrated camera** (pose and zoom, never a smoothed path: the smoothness lives in the solve's priors, `calibrate.py:37-39`) onto the court plane (exact: it's planar), the stands proxy, and one card per player at that frame's foot depth: life-size, correct depth in each eye. Outside the camera's frustum the rendered rulebook court (hardwood matched to the footage's floor colour, lines, light pools) fades to darkness; the lit footage region follows the camera's pan and zoom, its edges feathered over ~10%. A small caption and the honesty label sit low in front of you. |
| 9.1-9.5 | The window dims like a replay wipe. |
| 9.5- | **Pass 2**, the replay's real slow motion at 0.6x from the step-back; Step into the court is live. Unpressed, it plays on through the make, dims and repeats. |

**DECISION W: the watch geometry (main session, 8:50 AM; Vishal can change it).** A is a long lens ~29-32 m from the
pair (v9, provisional): from the camera's own position the play would be a ~4 deg postcard, so that seat is rejected.
- **The seat** sits on camera F's optical ray, **D' ~5 m from the pair's centre** (tunable 4-7 m by eye in the
  headset: `?seat=`), with the eye at the judge's real seated height (the camera is ~1.0 m high, a seated eye ~1.15 m:
  within the 15 cm the spike tested). If the final calibration lands nearer (~11-12 m), the same rule holds.
- **During the watch** each frame's footage is projected from its own calibrated camera onto the court plane (exact:
  planar), the stands proxy and one card per player. At D' = 5 m a body's 0.5 m of depth gives only ~0.07 deg of
  stereo disparity and ~0.06 deg of parallax for a 5 cm head move, so the cards read as solid; the cards misplace limbs
  by up to ~0.6 deg, invisible in motion and gone at F.
- **At F** each player's card becomes the depth mesh of their own freeze splats (the splat-depth proxy), so the
  hand-off is exact from any viewpoint, and P8 runs at the dolly seat.
- **The footage covers only ~4 x 2.25 m around the pair** (plus the stands behind them). Outside the camera's frustum,
  the rendered rulebook court (hardwood matched to the footage's floor colour, lines, light pools) fades to darkness;
  the lit footage region follows the camera's pan. The Reality check marks the rendered court as not filmed.
- Walk closer and Next view fade-jumps re-anchor the world for the 3.5 x 3.5 m floor (3.4).

### 3.3 Step into the court (the moment)
Shared by every hand-off direction; proven on desktop by the smooth spike (`court-spikes/smooth/`: `out/*.json`,
`media/`), on synthetic broadcast frames at 19.5 px/deg (about the Quest 3S centre).
1. **Ease to a stop on F.** Speed follows a C2 curve (1 - smootherstep) from 0.6x to 0, landing exactly on F.
   - **When the press lands.** The eases are baked, each its own segment: 1.2 s (starting 0.36 s of real time before
     F), 1.0 s (0.30 s) and 0.8 s (0.24 s); from 0.6x their steepest change is 0.013-0.0195 per frame, under the 0.02
     bar. (An ease from 1x would need >= 1.31 s, so none starts in pass 1.) A press in pass 1 arms the stop: pass 1
     plays out, pass 2 takes the 1.2 s ease. A press in pass 2 takes the next ease start still ahead. After the last
     start (the cutoff, in `clock.ts`), pass 2 plays on through the make and the next pass stops by itself.
   - **One frame per display frame, at the exact display times:** WebCodecs `VideoDecoder` on a raw H.264 (Annex B)
     stream, `avc1.640034` (High, level 5.2: 2560x1440 at 72 fps is 1.04 M macroblocks/s, over level 5.1's 983k),
     encoded with `-bf 0` (decode order = display order) and an IDR at every segment start. The queue stays <= 4
     frames, and each `VideoFrame` is closed after the next one is uploaded through
     `THREE.VideoFrameTexture.setFrame()` (three 0.186.1). A **second decoder** is primed with the next ease (and the
     resume), so a press needs no reset or seek. The clock steps `round(dt x displayHz)` show frames per XR frame.
     Never `playbackRate` ramps. Desktop: 130 of 130 frames in order, decode 0.95 ms, upload and draw 1.4 ms (960x720
     Baseline, batch-decoded: the streaming 1440p72 test is in S6 v2, before Q0).
   - **The whole show is baked offline at the display times** (pass 1, pass 2, each ease, the resume; a 90 Hz and a
     1080p copy too), undistorted, so the runtime is a pure pinhole projection. Each display frame shows A's real frame
     when one lies within +/- 0.1 frame of its real-time position (always at 0.6x, one in three at 1x), else a RIFE
     in-between of the two real frames around it (8.3 ms apart at 1x; below 0.6x in the eases). RIFE also replaces the
     three strobe frames. Spike, per method: real 3X + flow judder CV 0.11 (ground truth 0.10), 0 motion spikes,
     moving-pixel SSIM 0.99; nearest frame at 59.94 fps (today's viewer) 0.47; cross-dissolves ghost (23 spikes).
   - Every interpolated frame is listed in `frames.json` and counted by the Reality check; the last 0.3 s is checked
     by eye for ghosting at the hands and the ball.
   - **The time stop:** the crowd low-passes 18 kHz -> ~700 Hz and drops 12 dB over the ease; room tone stays. The
     stands and crowd dim 10-20% while the players stay crisp (one stands mask, applied to the video and the 3D
     alike).
   - The players' splats are drawn under the opaque video from the ease start, so Spark's first sort is done before
     the fade (sort ms and lag logged at Q0).
2. **Hand-off: same pixels, then the video layer fades.**
   - Frame F is projected from its own solved camera onto: the court plane; the stands proxy, with the front row,
     photographers and the ref on their own depth cards; and, for each main player, the **splat-depth proxy**: a
     depth mesh of that player's own freeze splats seen from camera F, carrying the player's matte. Because the mesh
     sits on the 3D surface, the projection stays right from the dolly seat ~25 m in front of the camera and from any
     head offset there. Court and stands use the same proxies in both layers, so they match by construction. Court and
     stands get an **inpainted clean plate** (F with the players and the watermark painted out); without it a player's
     colour smears onto the stands behind (up to 11.7 px p95 in the spike, ~0.6 deg).
   - The 3D (splats, court, stands) is fully drawn underneath, and the video layer fades out on top over **1.0 s**: an
     exact blend. Never fade splat opacity in. If the head rises > 10 cm mid-fade (standing up early), the fade
     finishes in 0.3 s so no double image follows you up.
   - Tolerance: up to ~0.05 deg of misalignment is invisible (mid-fade SSIM 0.978); 0.1 deg shows a soft double edge
     (0.936). With the plate, the spike's flat cards held the players <= 0.055 deg p95 and the background <= 0.035 deg
     for head offsets of 2, 5 and 10 cm sideways and 15 cm up from the camera. The dolly seat is far further off the
     camera than that, which is why the splat-depth proxy replaces the flat cards at F and P8 is measured at the seat.
   - What's left is the reconstruction looking different from the video (mid-fade SSIM 0.955 at every head position):
     that is why 1.0 s beats 0.6 s (1.1 vs 1.8 grey levels per frame), and why P8/P9 test PSNR and colour too.
   - **Projection domes and spheres fail:** a 5 m dome misaligns the background by 0.16-1.2 deg across those
     offsets; a 20 m dome misaligns the players by 0.16-1.2 deg. So the footage is always on the proxies.
3. **The world opens** (~2 s): the rendered court outside the camera's frustum brightens from dark and runs under your
   feet (Reality-marked as not filmed), light pools and soft fixture glows come up, the glossy hardwood picks up soft reflections and contact shadows. The other players in A's
   frame (Reid, the baseline ref) hand off like the pair: their video card fades out over their drawn 3D. Players and
   ball never change in light, colour or sharpness.

### 3.3a The hand-off direction (chosen after the prototypes: OPEN)
Recorded in the prototype rig (`court-spikes/proto/webxr`, `src/proto/directions/`, `?dir=<id>`; baseline
`out/baseline.mp4`; the three runs in `court-spikes/proto-same-pixels/`, `proto-house-lights/`, `proto-depth-grows/`),
picked by eye, the pick and why written in the status file. All three keep 3.3 steps 1-2 exactly; they differ only in
`handoff.ts`, which drives one typed `HandoffParts` (4.3). Each has its hook frozen at T0:
- **Same Pixels:** the invisible swap, then the window's feather widens to reveal the world as the house lights rise
  (`ShowVideo.feather(p)`).
- **House Lights:** the house dims, a light pool on the pair spreads toward you and lays the court under your feet
  (`CourtWorld.pools(p)`).
- **Depth Grows:** the frozen frame inflates from flat to true depth along the camera rays (the seat view unchanged),
  then the court rolls out (`ShowVideo.depth(p)`, which moves the proxies from one plane to the splat-depth proxy).

### 3.4 Walk closer, stand up and look around
- **Walk closer (the normal path):** the seat is D' ~5 m from the pair, beyond the 3.5 m floor, so after the world
  opens one press does a 0.3 s fade-jump along camera F's ray, re-anchoring the world so the pair's centre is 2.5 m in
  front of the chair. Stand up and step forward: you're 1.5 m from them, on the camera's side.
- **3.5 x 3.5 m (default): three viewing spots** on the camera's side of the pair: front, and 60 deg to either side.
  **Next view** on the palm menu does a 0.3 s fade-jump that turns the world about the pair, so the next spot is where
  you stand; small steps and leaning in work at each. Nothing else ever moves the world.
- **The full ring (automatic):** when `bounded-floor` reports room for it (about 4.5 x 5.5 m), the ring replaces the
  spots and Next view hides: every walk target >= 0.7 m inside the boundary, the lit court ends at the boundary inset.
  The choice is made from the bounds alone, and is unit-tested only (IWER has no `bounded-floor`).
- **Standing** is detected when the head rises > 0.25 m. Spots show as faint floor marks; the ring as a chalk-white
  ring (2 cm line, 25% opacity) that fades in over 0.8 s and out after ~45 degrees of walking. Every spot and ring
  point keeps 1 m clear of each body (about 1.5 m from the pair's centre).
- **Lean in close:** a player fades to 30% over 300 ms only when your eye comes within 0.2 m of their torso or head
  capsules. Hands, arms and the ball never trigger it, so you can put your face by the ball and Gobert's hand.
- **The courtside plate** (crowd, photographers, the ref's stand) dims toward dark as your view leaves the camera ray,
  so it never reads as a poster; the front row, photographers and ref sit on their own depth cards.
- **Where to look:** Gobert's face and his arm over Luka's head, both players' hands, the ball at Luka's hip. Luka's
  front is what no camera saw (A and B both film his back): it stays off the shot list unless it passes by eye.

### 3.4b The other players on court (Vishal, 7:00 AM)
Everyone except the main player and the main defender must read as a solid 3D person from every spot you can walk to:
never a flat cut-out or a card seen edge-on; soft faces are fine at their distance, but never cheap or uncanny; same
arena light, feet on the floor, real size, their **real** frozen pose. Never a guessed pose.

At F, A's frame holds only **#11 Naz Reid** (head to toe) and **the baseline ref**. C at C600 sees the rest: Kyrie #11
(330 px), a DAL big (380), two DAL wings (345 each), Reid (490), Edwards #5 (505), MIN #3 (435), a bearded MIN player
(455), three refs (290, 515 cut off, 310).

| Option | How | For |
| --- | --- | --- |
| **Build** | that player's own fixed crop -> **Turbo** 4DAnyone views -> recon of the freeze frame only at 60k | Reid, and the baseline ref if head to toe; their video card fades over their drawn 3D at the hand-off |
| **Body** | calibrate C; that player's pose at C600 from GVHMR on C; 8-16 crops of them across C -> LHM++ (installed) -> posed to it | C-only players near the viewing spots, if time allows; Reality-marked (A never saw them) |
| **Relief** | metric depth of that player in A's frame (MoGe / Depth Anything 3, ask before download) -> a relief mesh textured from the frame | only a player whose largest angle between its camera ray and any walk-spot ray is < ~15 deg |
| **Leave out** | the floor beyond the lit pair falls to dark where they would stand | anyone the three above can't make right (the default for C-only players) |

- Every placed extra gets a baked contact shadow and a reflection (the same bake as the pair) and passes
  `foot_check.py`. `freeze.ts` owns them.
- **Pick by test:** Build on Reid first; Body on one C-only player only if time allows; render each from every viewing
  spot plus the seat, pick by eye.
- **Budget:** inside the 500k (section 8): extras at 60k each, down the cut ladder first.
- On HiPerGator, extras run as many at a time as the group quota allows (Ojasva's rule), never a fixed batch.
- Reality check: extras are mostly imagined (tinted blue except what A really saw).

### 3.5 Back to my seat
- **Always through the room:** Back to my seat fades the arena to your room (as See my room), with the drawn chair over
  the real one. You walk to it and sit; the presenter spots the sit. Once seated (head within 0.35 m of the seat,
  0.25 m lower than standing, still for 0.5 s), the world re-seats the chair at the dolly seat behind the fade (undoing Walk closer and
  Next view), the arena fades in, and the hand-back runs from the seated eye: the 3D hands back to frame F (P18).
- **Resume:** the footage eases from 0 to 0.6x over 0.8 s while the filter opens and the crowd rushes back; Luka lifts
  the ball, the camera tilts up to the rim, the release, the ball drops through the net (~1602) and B's swell fires on
  the make. The window dims at ~1614, before A's next cut. We never cut to another camera.
- After the footage ends: arena darkness and **Replay** on the palm menu.

### 3.6 Always
- **Palm menu only** (left palm up, right index; `HandMenu`, 2 columns, first row on top: `xr/menu.ts:54-61`):
  - top row: **Step into the court / Back to my seat** (one slot), **Reality check**;
  - bottom row, nearest the palm: **Replay**, **See my room** (never moves or hides);
  - **Walk closer**, then **Next view** (spots only), on their own row above while they apply (world open, not in the
    room); the bottom row never moves;
  - **Seat here** on the setup page behind a 2 s hold.
  The menu opens after 220 ms palm-up (`xr/menu.ts:91`). No gesture acts by itself.
- **Hands:** in the arena your hands are drawn softly, lit by the arena (`vrhands.ts`). In See my room your real
  hands show in passthrough and depth-only occluders (`handOccluder`, `xr/hands.ts:24-36`) keep them in front of the
  players; the drawn hands fade as the real ones appear.
- **Presenter override:** a paired Bluetooth keyboard, Space = the top-left button (verify at Q1 that key events reach
  an immersive page; if not, the presenter coaches palm-up).
- **See my room** (Ojasva's condition, ask 8): label flips to "Back to the arena", stays lit, window icon, no "AR/VR"
  words; works in every phase including arrival.
  - Out (0.6 s eased): darkness and stands 0-0.4 s, then the floor plate, lines, pools and reflections 0.2-0.6 s; a 50%
    black veil over the room eases to 0 over 1.5 s; players, ball, contact shadows, caption and label unchanged;
    crowd to a -18 dB low-passed murmur. Back (0.8 s): the reverse, floor first, the crowd swells.
  - In the room: the pair, the ball, contact shadows, the spots or ring as a floor guide; extras only if their feet
    are inside the boundary; reflections off; the arena grade checked by eye against room light.
  - Per phase: in arrival, back replays the lights-up. Watching or easing: the video fades with the arena and the
    clock holds; back restarts the watch from pass 1. Mid-ease or mid-hand-off: jump to F and finish the hand-off under
    the fade. Walking is the main use; Walk closer and Next view hide in the room. Reality check and Replay work in
    both.
- **The edge (Ojasva, binding):** the Quest boundary stays on (ask 8), and our room fade near the edge is always on
  (3.1: from 0.6 m, fully open at 0.3 m). It is a safety fade, not a gesture. Q0 also checks that the Quest's own
  boundary still draws in an opaque AR session (Meta documents boundary hiding only for native passthrough apps).
- **Reality check:** everything the camera never saw is tinted blue (players' hidden sides, floor and stands outside
  the camera's view, the inpainted plate behind the players, filled holes in a player's input, the ball's far side,
  extras placed from C), with the seen % per player and the interpolated share of the show.
- Label "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players." and the source credit, always.
- Real size; court locked to the room (`local-floor` + anchor); zero drift; full frame rate.

## 4. Architecture

### 4.1 Data flow
```
clip (Vishal, ~/court-side-data/luka/) ── gate 1 ── calibrate A (one centre, per-frame R, f, k1) ── stabilise
   │        (still camera = camera F: R_F, f_F, undistorted, so F's own pixels are frame K; stabilize.py --ref-frame)
   ├── masks (SAM 2.1 on the Mac, MPS, isolated venv, Meta's weights; corrective clicks), warped like the frames ──┐
   │                                                                                                              ▼
   │   per player, own window: fixed 1216x2160 crop, composited onto a plain background (holes filled neutrally),
   │   121 unique frames, A929-1249 (stride 2, F at K = 118) or A1088-1248 (stride 1, K = 117), re-timed to 25 fps
   │   (-r 25) = input.mp4; F's lossless crop as frame K of source-4k.mkv; masks/ + ignore/ 000118.png (or 000117.png);
   │   B592's crop, mask, ignore and focal (ask 10c)
   │                                                                                                              ▼
   │   HiPerGator (Ojasva's session, section 7): preflight ─► 4DAnyone views (BASE24, 24 steps) ─► freeze recon of
   │   frame K at 300k / 250k / 200k + metrics recon ─► export (full PLY) ─► cleanup (views, then frames)
   │                                                                                                              ▼
   ├── show bake (Mac; RIFE via forge on Vishal's PC): pass 1, pass 2, the eases, the resume at 72 Hz display times,
   │   undistorted, strobes replaced, watermark inpainted ─► show.h264 (+ show-90.h264, show-1080.h264)
   ├── B at B592 (calib-real: focal and pose; stream A: SAM 2.1 masks of both players) and C (other players' poses at C600)
   └── assembly on the Mac: place each freeze player on the court, splat-depth proxies from camera F, reality.ply from
       export's .reality.spz, ball, floor and stands plates, clean plate, depth cards, shadows, reflections, audio,
       metrics ─► ~/court-side-data/luka/court-side/ (court.json + files; outside the repo, never under dreams/)
                                                                                                                  ▼
                     apps/webxr/src/court/ (?mode=court), immersive-ar drawn opaque, on the Quest 3S
```
- Stream A2 (the release variant) runs the same chain at Turbo on B500-620, freeze at B620.

### 4.2 The court bundle (the only new data format; additive, read only by `?mode=court`)
- **Where:** the real bundle lives outside the repo (`~/court-side-data/luka/court-side/`), never under `dreams/`:
  the vite dev server serves anything there (`apps/webxr/vite.config.ts:8,43-44`) and Ojasva tunnels it. Only
  `src/court/serve.mjs` serves it, on 127.0.0.1. The synthetic stand-in lives in git-ignored
  `dreams/court-side-standin/` (it holds no broadcast data).
```
court.json
video/show.h264          the whole show at 72 Hz display times: raw H.264 Annex B, avc1.640034, 2560x1440, -bf 0,
                         an IDR at every segment start, undistorted, no audio
video/show-90.h264, show-1080.h264, pass1.mp4    pre-built fallbacks (section 9): 90 Hz bake, 1080p, <video> pass 1
video/frames.json        per show frame: source frame (fractional for in-betweens), interp flag, that frame's camera
video/freeze.png         frame F, lossless; freeze-clean.png: players and watermark painted out; stands-mask.png
players/<id>/freeze.ply  the freeze-frame Gaussians (3DGS PLY, SH1), in court coordinates
players/<id>/reality.ply the same Gaussians, unseen ones tinted blue (from export's .reality.spz, same order)
players/<id>/proxy.glb   the splat-depth proxy: a depth mesh of the splats seen from camera F
players/<id>/shadow.png, reflection.png   floor maps baked from the Gaussians
others/<id>/…            other players (3.4b): freeze.ply | body.ply | relief.glb, reality, shadow, reflection
stands/<id>.png          depth cards: front row, photographers, the ref
court/floor.jpg + floor-seen.png          top-down floor from the footage, and where the camera really saw it
audio/bed.m4a            B's crowd, Demucs no-vocals stem, looped seamlessly, swell cut out (-23 LUFS)
audio/swell.m4a          B's crowd swell, a one-shot on the make
audio/sfx/*.m4a          squeak, bounce, release (only if Vishal approves CC0 sounds)
```
`court.json` (all positions in court metres: origin centre court on the floor, +Y up, +X toward the basket in play):
```json
{
  "version": 1,
  "title": "…", "caption": "… · Gobert closes out as Luka gathers",
  "label": "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.", "credit": "Source: …",
  "court": { "length": 28.65, "width": 15.24, "rim": [12.73, 3.05, 0], "floor": "court/floor.jpg", "floorSeen": "court/floor-seen.png",
             "hardwood": [0, 0, 0] },
  "camera": { "centre": [0, 0, 0], "width": 3840, "height": 2160, "cx": 1919.5, "cy": 1079.5, "k1": 0,
              "sourceFps": 59.94, "captureFps": 120, "slow": 2.67 },
  "video": {
    "file": "video/show.h264", "codec": "avc1.640034", "width": 2560, "height": 1440, "displayHz": 72,
    "fallbacks": { "hz90": "video/show-90.h264", "p1080": "video/show-1080.h264", "element": "video/pass1.mp4" },
    "frames": "video/frames.json",
    "segments": { "pass1": [0, 0], "pass2": [0, 0], "resume": [0, 0],
                  "eases": [{ "start": 0, "frames": [0, 0], "seconds": 1.2 }] },
    "cutoff": 0, "freezeSource": 1244,
    "freeze": "video/freeze.png", "freezeClean": "video/freeze-clean.png", "standsMask": "video/stands-mask.png"
  },
  "seat": { "ray": "freeze", "distance": 5.0, "distanceRange": [4, 7], "pairCentre": [0, 0, 0], "closer": 2.5,
            "clear": 1.0, "spots": [[0, 0, 0], [0, 0, 0], [0, 0, 0]], "ringArea": [4.5, 5.5] },
  "freeze": {
    "players": [{ "id": "…", "name": "…", "splats": "players/…/freeze.ply", "reality": "players/…/reality.ply",
                  "proxy": "players/…/proxy.glb", "bounds": { "min": [0, 0, 0], "max": [0, 0, 0] }, "seenFraction": 0,
                  "capsules": [{ "a": [0, 0, 0], "b": [0, 0, 0], "r": 0 }],
                  "shadow": { "image": "players/…/shadow.png", "rect": [0, 0, 0, 0] },
                  "reflection": { "image": "players/…/reflection.png", "rect": [0, 0, 0, 0] } }],
    "ball": { "centre": [0, 0, 0], "radius": 0.1195, "erase": [{ "player": "…", "radius": 0.15 }] },
    "others": [{ "id": "…", "kind": "splats | body | relief", "file": "…", "reality": "…", "pose": "A | C",
                 "foot": [0, 0, 0], "height": 0, "maxRayAngle": 0, "shadow": {}, "reflection": {} }],
    "stands": { "proxy": [{ "kind": "plane", "points": [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] }],
                "cards": [{ "id": "front-row", "image": "stands/front-row.png", "quad": [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] }] }
  },
  "audio": { "bed": "audio/bed.m4a", "lufs": -23, "sources": [{ "at": [0, 0, 0], "offsetS": 0 }],
             "oneShots": [{ "file": "audio/swell.m4a", "at": "make", "gainDb": 0 }],
             "events": [{ "frame": 0, "kind": "release", "at": [0, 0, 0], "file": "audio/sfx/release.m4a" }] },
  "metrics": { "reprojDeg": { "median": 0, "p95": 0 }, "heldOutPsnrVsGenerated": {}, "seatPsnr": {}, "interpShare": 0 }
}
```
- `video/frames.json`: one entry per show frame, `{ "src": 1243.5, "interp": true, "q": [0, 0, 0, 1], "f": 10400 }`.
  `src` is the frame index in the source clip (fractional for an in-between; `interp` marks RIFE frames, strobe
  replacements included); `q`, `f` are **the solve's own camera for that frame**, never smoothed (an in-between gets
  the slerp and interpolation of its two real frames' cameras).
- Segments are inclusive show-frame ranges. Each ease is its own segment (starting with an IDR), entered from pass-2
  show frame `start`, and ends on F; `cutoff` is the last pass-2 frame a press can still stop on. Show frame i of the
  stream is shown at t = i / displayHz.
- Camera convention: `q` is world-from-camera with OpenCV camera axes (+x right, +y down, +z forward); `f`, `cx`, `cy`
  in source pixels (scale by the stream's width); one fixed `centre`. The bake undistorts every frame with the solve's
  per-frame k1 (`export_webxr.py:39` writes it), so `k1` is 0 in the bundle.
- `seat` (Decision W): the seat's floor point is under camera F's optical ray (`ray: "freeze"`, the camera of the show
  frame equal to F) at `distance` metres from `pairCentre`; `?seat=` overrides it within `distanceRange`. The eye is
  the judge's own seated height, so none is stored. `closer` is the pair's distance from the chair after Walk closer,
  `spots` the three viewing places, `ringArea` the bounds that turn the ring on.
- `court.hardwood` is the rendered floor's colour, matched to the footage's floor; `court/floor-seen.png` marks where
  the camera filmed it (everything else is the rendered rulebook court, Reality-marked).
- Documented in `src/court/README.md` with a worked example, so Unity or visionOS can read it.

**Contract changes.** None to the dream bundle, job API or coordinates. New: the court bundle (above), read only by
`?mode=court`. Tell Ojasva (owner of `apps/webxr` and the pipeline) in the status file; Ian needs nothing.

### 4.3 The WebXR module (`apps/webxr/src/court/`, plus one route line in `src/main.ts`)
| File | Owns | Interface (frozen first) |
| --- | --- | --- |
| `format.ts` | `court.json` types, `loadCourt(base)`, validation (DOM-free) | `Court`, `loadCourt(url): Promise<Court>` |
| `clock.ts` | the show clock in show frames: passes, the ease ladder, the cutoff, the armed stop, resume; `step = round(dt x displayHz)` (DOM-free) | `Clock.update(dt)`, `press()`, `resume()`, `state` (`frame`, `segment`, `speed`, `nextEase`) |
| `video.ts` | the show stream: two WebCodecs `VideoDecoder`s on `show.h264` (one playing, one primed with the next ease or the resume), queue <= 4, each `VideoFrame` closed after the next upload, `THREE.VideoFrameTexture.setFrame()`; the feathered edge of the lit footage region, following each frame's frustum; `?video=element` fallback for pass 1 | `ShowVideo.load()`, `show(frame)`, `feather(p)`, `depth(p)`, `opacity` |
| `proxies.ts` | everything the footage is projected onto, with each frame's own camera: court plane, stands proxy, depth cards, one matte card per player during the watch, the splat-depth proxy at F, the clean plate, the stands dim; the flat-to-true-depth blend behind `depth(p)` | `Proxies.load()`, `project(camera)`, `depth(p)`, `dimStands(p)` |
| `world.ts` | court floor (footage plate inside the frustum + the rendered rulebook court outside it, hardwood matched to the footage, fading to dark during the watch and brightening as the world opens; writes no depth so reflections show), structured darkness, light pools, glows, the plate's dimming off the camera ray; the black `BackSide` dome; the edge fade; colours graded to the players' white point | `CourtWorld.open(p)`, `pools(p)`, `room(p)`, `edge(distance)`, `reality(on)` |
| `freeze.ts` | the pair's and the other players' freeze splats, ball (and erasing it inside the splats), shadows, reflections (mirrored proxy of ~7% of splats via a Spark `worldModifier`, Schlick f0 0.06; `court-spikes/ground/`), capsule proximity fade, Reality check | `Freeze.load()`, `reveal(p)`, `reality(on)`, `update(head)` |
| `handoff.ts` | the chosen direction's choreography (3.3a): one function of progress | `handoff(p, parts: HandoffParts)`; `HandoffParts = { video, proxies, world, freeze, sound }` |
| `seat.ts` | seat placement on camera F's optical ray at D' (`?seat=` 4-7 m), the room-space chair, the play area, Walk closer, the three spots and Next view, the automatic ring when the bounds allow, distance to the bounds, `WorldLock`, persistent anchor (old handle deleted first), re-seat fade; its maths DOM-free | `Seat.place(head, yaw)`, `restore()`, `closer()`, `nextView()`, `layout()`, `boundsDistance(head)`, `seated(head)` |
| `sound.ts` | the crowd bed as >= 4 HRTF sources at the stands, time-stop filter and gain, the room murmur, one-shots, events at 3D positions | `Sound.start()`, `timeStop(p)`, `room(p)`, `oneShot(id)`, `event(kind, at)` |
| `vrhands.ts` | drawn hands in the arena (soft, arena-lit), faded out in See my room | `VrHands.update()`, `fade(p)` |
| `ui.ts` | caption, label, the palm menu pages and the See my room toggle (uses `xr/menu.ts` `HandMenu`, `xr/hands.ts` `XrButton`), Seat here's 2 s hold, presenter keys | `Ui.setPhase(phase)`, `onToggleRoom` |
| `court.ts` | `renderCourt(root)`: the phase machine, the XR session, arrival trigger, the edge fade every frame, desktop preview, `stats.ts` frame log (`?stats`) | phases: arrival, watching, easing, handoff, open, walking, returning, resume, ended |
| `serve.mjs`, `sw.js` | the demo server (127.0.0.1 only: the build and the bundle) and the Service Worker it serves at `/court-sw.js`; plain JS, so `tsc` (no `allowJs`) and the vite build leave them alone | `node apps/webxr/src/court/serve.mjs --bundle <dir>` |

- **Session:** `immersive-ar`, required `local-floor`, optional `anchors`, `hand-tracking`, `bounded-floor`, through
  `SparkXr` with `mode: "ar"` as the viewer does (`src/viewer.ts:657-668`). It reads as full VR because every pixel is
  covered: three 0.186 clears to (0, 0, 0, 0) in alpha-blend (`three.module.js:1379-1381`), so clear alpha is no
  lever; instead a black `BackSide` dome is drawn first (no depth test or write), opacity 1 -> 0 for See my room and
  near the edge, with the renderer's `alpha: true` (`src/viewer.ts:87`). Alpha is premultiplied, so a half-faded dome
  dims the room (the 50% veil). Anchors are Meta's documented path in AR.
- three.js renderer `antialias: false` (a known Quest hang with MSAA + Spark), `NoToneMapping` (Spark's splat shader
  isn't tone-mapped, so arena and players share one grade), no live shadow maps, no full-screen post-processing (it
  breaks foveation); bloom by glow sprites.
- Eye buffer and foveation reuse the viewer's `XR_QUALITY` (`src/xr/quality.ts:12`: `res` 1.0, `fov` 0, `?res=`/`?fov=`
  from the URL), passed as `frameBufferScaleFactor`/`fixedFoveation` exactly as `src/viewer.ts:666-667` does.
- Refresh: `session.updateTargetFrameRate(72)` where offered; if it's refused, `?hz=90` plays the 90 Hz bake.
- **Tests** live in `apps/webxr/test/court/`, outside `tsconfig.json`'s `include: ["src"]`, so `npm run build`
  (`tsc --noEmit && vite build`) stays green: under `src/` they break it (no `@types/node`; TS2307 on `node:test`,
  TS5097 on `.ts` imports). Run them with `node --experimental-transform-types --test apps/webxr/test/court/*.test.ts`
  (checked on Node 25.2.1; plain type stripping fails on parameter properties). The e2e runner and `standin.mjs` live
  there too. Tested modules (`format.ts`, `clock.ts`, `seat.ts`'s maths) import siblings with `import type` only and
  never import `xr/quality.ts`, which reads `location` at import (`src/xr/quality.ts:6`).

## 5. Build streams (T0 ~9:15 AM Sat, once the independent review's findings are folded in)

Vishal approved the build overnight on that condition. Rules:
- **Branch `court-side`** off `origin/main`, pushed so Ojasva can see it. Never merged into main until Vishal is back.
  The status file still goes to main alone (`git commit -- docs/plans/court-side-status.md`).
- **One stream = one Claude subagent in its own git worktree** off `court-side` (`isolation: worktree`), owning only
  the files listed. Tests first; each reports with its check output. At most 3 build agents at once. No Codex.
- **Worktree start, every stream:** `ln -s "<main checkout>/apps/webxr/node_modules" apps/webxr/node_modules` (or
  `npm ci` in `apps/webxr`), then `node apps/webxr/test/court/standin.mjs` (writes the git-ignored stand-in bundle;
  `dreams/` is git-ignored and vite serves `../../dreams` relative to the checkout: `vite.config.ts:8`).
- **Interfaces frozen first (T0 -> T0+0:45, the integrator)**, committed on `court-side` before any stream starts:
  `format.ts` (court.json types and validator); every module of 4.3 as a typed stub that compiles, including
  `HandoffParts`, `ShowVideo.depth(p)`, `CourtWorld.pools(p)`, `CourtWorld.room(p)` and `CourtWorld.edge(d)`; the test
  harness in `test/court/` (`node --experimental-transform-types --test`, the e2e runner with its stepped capture and
  alpha read-back, the timing pass, the screenshot diff); `test/court/standin.mjs` (two synthetic frozen players with
  proxies and capsules, a synthetic panning show stream at 72 Hz with known cameras, passes, eases and a resume, a
  crowd-like bed, a 3.5 x 3.5 m play area); `src/court/serve.mjs` and `sw.js`; `pipeline/court/.gitignore`.
- **One integrator: the main session.** It owns `src/main.ts` (one route line, beside the chess one at
  `src/main.ts:20`), `src/court/court.ts`, `src/court/format.ts`, `src/court/serve.mjs`, `src/court/sw.js`,
  `test/court/{e2e,standin}.mjs`, and every merge (rebase the stream onto `court-side`, run every check, merge, push).
  It runs every timing pass itself, one at a time (parallel headless-Metal runs skew timing).
- **Clip tools in `pipeline/court/`, code only** (Ojasva, ask 11), with a `.gitignore` that admits only `*.py`,
  `*.sbatch`, `*.sh`, `*.md` and itself. Data stays in `~/court-side-data/luka/` and `$L/runs/court-*`.
- **Stream A starts before T0:** calibration, masks and the player clips are plan-time work on the clip.

| Tool (`pipeline/court/`) | Owner | Starts from |
| --- | --- | --- |
| `calibrate.py` (A, and B at B592: calib-real; C at C600: stream A; ignore boxes on the Sprite LED and TISSOT clock), `check_align.py` | A (calib-real for A and B) | `court-spikes/calib/` (`calibrate.py`, `overlay.py`) |
| `stabilize.py` with `--ref-frame` (the still camera = that frame's R and f, instead of the mean rotation and max focal: `stabilize.py:64-70`) | A | `calib/stabilize.py` |
| `masks.py` (SAM 2.1 on the Mac; masks warped like the frames; also both players in B around B592 for ask 10c) | A | `calib/make_masks.py` |
| `player_clip.py` (own window, union box, composite and neutral fill, re-time, `framemd5`, `source-4k.mkv`, masks and ignore, B592 view), `check_prepped.py` | A | new |
| `clean_plate.py` (players and watermark), `bake_show.py` (passes, eases, resume, undistort, strobes, 90 Hz and 1080p copies) | A | `smooth/py/video_ramp.py` |
| `court-submit.sh`, `court-freeze.sbatch`, `court-export.sbatch`, `court-clean.sbatch` | A (Ojasva's session submits) | section 7 |
| `smooth_metrics.py` (incl. `--flash`), `handoff_check.py` (mono render vs F) | D | `smooth/py/analyze.py`, `handoff.py` |
| `foot_check.py`, `estimate_light.py`, `freeze_check.py` | E | `court-spikes/ground/` |
| `assemble.py` (`--validate`, `--report`: placement, proxies, reality.ply, extras, budget) | G | new |

| Stream | Agent | Owns | T0 -> T0+2 | T0+2 -> T0+5 | T0+5 -> T0+8 |
| --- | --- | --- | --- | --- | --- |
| A. Footage and geometry | Opus `geo` (+ Vishal's clicks) | A's tools above | calibration of A (P2); stabilise on F; masks; union boxes; Luka and Gobert clips at strides 1 and 2 -> Turbo (gate 2); `check_prepped.py` on the Turbo run | full-quality run folders (input, source-4k, masks, ignore, B592 with calib-real's B focal and our B masks) -> HPG; Reid and ref clips; calibrate C; clean plate; the show baked (all segments and copies) | seat-match check (P8) on real data |
| A2. Release variant | Opus `geo` (after A's gate 2) | its run folders | B500-620 clips at Turbo, freeze at B620 with A~1322 and B620 as real views | by-eye side-by-side with F = A1244 for Vishal | |
| B. HiPerGator | Ojasva's session (section 7) | `$L/runs/court-*` | Turbo views, Luka, both strides | full views + 3 caps + metrics per main player; extras by quota | fetch; cleanup |
| C. Court core | Sonnet `core` | `clock.ts`, `seat.ts`, `ui.ts`, `vrhands.ts` + tests | clock (passes, ladder, cutoff, step rounding), seat maths (placement, chair, play area, Walk closer, spots, Next view, automatic ring, bounds), ui: unit tests green | phase machine wired in `court.ts` (with the integrator); e2e green | persistent anchor (handle deletion), edge-fade input, presenter keys |
| D. Video and hand-off | Opus `handoff` | `video.ts`, `proxies.ts`, `handoff.ts` + tests, D's tools | two-decoder WebCodecs player + proxies on the stand-in; cadence (P4, P5) | the chosen direction (3.3a); splat-depth proxy; P8-P10 | polish on real data |
| E. World and look | Opus `look` | `world.ts`, `freeze.ts` + tests, E's tools | floor + lines, darkness, pools, glows, dome, `room(p)`, `edge(d)` (P33-P35) | freeze splats, extras, ball + erase, shadows, reflections, capsule fade, Reality check | grade to the players' white point (P13); plate dimming (P30) |
| F. Sound | Sonnet `sound` | `sound.ts`; audio assets outside git | spatial bed + time stop (P20, P31) | swell on the make; room murmur; events if CC0 is approved | final mix (P19) |
| G. Assembly | Opus `assemble` | `assemble.py` | place / ball / floor / proxies on stand-in data | real data as each run lands; extras test (3.4b) | bundle complete, validator green |

Order of agents (3 at once): C, D, E at T0; F and G as the first of those merge. Quest checkpoints (Ian or Ojasva wear
it, casting to a laptop):
- **Q0 now** (S6 v2 on branch `court-side-q0`, ask 7): streaming WebCodecs 1440p72 and `isConfigSupported`, the opaque
  AR mode with See my room, the Quest boundary at the edge, AR vs VR frame time, splat sort lag, headset off/on, the
  tab memory ceiling. Q0 is the go/no-go on the splat budget before caps are final (all three are trained either way).
- **Q1 T0+3** (court module on the stand-in): frame time, decode, menu, anchor, comfort; the wall-walk (P35);
  unplug-reload-play (P37); headset off/on (P38); presenter keys.
- **Q2 T0+6** (real data): the hand-off; each fallback flag recorded against its P-rows (P41).
- **Q3 Sat ~10 PM** (full run, 10 times) and **Q4 Sun 8 AM** (final rehearsal before the 10 AM freeze). Every
  session starts with the presenter's wall-walk.

## 6. Test-first tasks (each: check command, done means)

`T=node --experimental-transform-types --test apps/webxr/test/court`; `E2E=node apps/webxr/test/court/e2e.mjs`.

| Task | Check | Done means |
| --- | --- | --- |
| `clock.ts` ease-to-frame | `$T/clock.test.ts` | every press before the cutoff lands exactly on F (pass 1, pass 2 early, at and between ease starts); after it, the next pass stops; speed C2 (1 - smootherstep); no step > 0.02 per display frame (eases from 0.6x at 1.2, 1.0, 0.8 s; resume 0.8 s); step = round(dt x displayHz) at 72 and 90 Hz |
| `format.ts` | `$T/format.test.ts` | the sample `court.json` validates; every bad field is named in the error |
| `seat.ts` maths | `$T/seat.test.ts` | seat under the head, on camera F's ray at D' from the pair (5 m, and 4 and 7 m via `?seat=`), camera yaw = head yaw; Walk closer leaves the pair 2.5 m ahead; the three spots fit a 3.5 x 3.5 m play area; the ring turns on only for bounds >= `ringArea`, with 0.7 m inset; every spot and ring point >= 1.0 m from both bodies (P29); `boundsDistance` exact |
| Immersive video alignment | `python3 -I pipeline/court/check_align.py` | P2: court points <= 0.02 deg median, <= 0.05 deg p95, in every calibrated frame |
| Cadence | `$E2E --only cadence` + `smooth_metrics.py` | P4, P5: 0 held frames, CV <= 0.15, queue 1-4, no reset at a press |
| Hand-off match | `handoff_check.py` (mono renders at the dolly seat: video layer vs 3D; and the 3D at camera F vs `freeze.png`) + `$E2E --only handoff` (per eye at the seat) | P8 (<= 0.05 deg p95 mono, <= 0.055 deg per eye, PSNR bars); mid-fade SSIM >= 0.95 per display frame (P9) |
| Ease smoothness | `$E2E --only ease` + `smooth_metrics.py` | no per-display-frame change spike (max/median <= 2.5) through the eases and the resume |
| Flash and branding | `smooth_metrics.py --flash` on `show.h264`; contact sheet | P39, P40 |
| Opaque, See my room, edge | `$E2E --only room` | P33, P34 (alpha read-back, all 9 phases), P35 (room from 0.6 m, fully open at 0.3 m, on a simulated polygon) |
| Controls lock | `$E2E --only controls` | menu opens only palm-up; every button works; Seat here only after 2 s; pinches, grabs, swipes change nothing |
| Drift | `$E2E --only walk` | court moves 0 mm over the 17-pose walk |
| Proximity | `$E2E --only walk` | P17: torso/head capsule at 0.2 m fades; ball and hands at 0.3 m don't |
| Arrival | `$E2E --only arrival` | P27 |
| Never public | `curl -sk -o /dev/null -w '%{http_code}' https://localhost:5180/dreams/court-side/court.json` | 404; `serve.mjs` refuses the LAN address (P36) |
| Real view used | `grep -o '"\(iou\|focal\|focalHeld\)": [^,}]*' recon-*/recon-*.json` on each fetched run; `peek-source-*.jpg` | P42 |
| Frame time | timing pass (desktop, informational) then Quest (Q1-Q3) | desktop logged and within 20% of S6 per phase; Quest: 0 drops in each 60 s phase run, GPU p95 <= 85% of the interval |
| Feet | `foot_check.py` per placed player | every sole within 1.5 cm of y = 0 when in contact |
| Splat budget | `assemble.py --report` | total visible at the worst pose <= 500k (or the Q0 number) |
| Bundle | `assemble.py --validate` | every file present, sizes, coordinates sane, metrics filled |

## 7. HiPerGator: job specs and messages

Four new files in `pipeline/court/` on branch `court-side` (bash, not `--wrap`: `--wrap` runs under `/bin/sh`, where
`env.sh`'s conda hook fails silently: `env.sh:4-6`). Ojasva copies them to `$L/code/pipeline/court/` with his usual
rsync from a checkout of `court-side`. Run ids: `court-main`, `court-def`, `court-x1`..; Turbo checks
`court-turbo-main-s2`, `-s1` (and `-def-` the same); the release variant `court-rel-*`.

**Ojasva's session submits whatever command appears in the status file.** So a command is posted there only with
every number filled in (never a placeholder), and it is one call to `court-submit.sh`, which checks everything first
and submits nothing if any check fails.

**Run folder** (Vishal's Mac rsyncs it; everything stays under `$L/runs/court-*`):
```
$L/runs/court-<id>/
  input.mp4        121 frames, 1216x2160 (the native-4K 9:16 crop, never rescaled), 25 fps container (-r 25)
  job.json         {"id":"court-main","name":"Court Side","kind":"replay","turbo":false,"viewsPerLayer":16,
                    "layerPitches":[-10,15,35],"fps":25,"frames":121,"startS":0,"intent":"",
                    "sourceMasks":"masks","sourceIgnore":"ignore","sourceFocal":<FOCAL>}
  source-4k.mkv    FFV1 (lossless), K+1 frames: frame K = F's crop (the same window, F's own pixels); 0..K-1 black
  masks/000118.png   the player (white); ignore/000118.png: whoever is in front of them (white); K = 118 at stride 2,
                   so 000117.png at stride 1 and 000120.png for the K = 120 alternative
  real/B592/       ask 10(c): B's frame crop at F, its mask and ignore (stream A), focal.txt (calib-real), for Ojasva to wire
  court-run.json   K, FOCAL, stride, window, the source frame of each of the 121 (for our records)
```
- **Source flags are passed by our own scripts.** job.json's `source*` keys are read only by `stage-recon.sbatch`
  (`:26-34`), which chunks all 121 frames and can't do frame K alone; they're in job.json as the run's record and for
  any later `stage-recon` use. `load_masks` needs `{i:06d}.png` for every frame it trains (`source_view.py:291-305`):
  freeze and metrics both train frame K only, so the one mask pair at K is enough.
- **The focal (settled):** FOCAL = the still camera's focal (`still_camera` K in the calibration, not a frame's own
  zoom) x the `--source-video` file's height / the crop's height in the stabilised canvas; the masks go through the
  same stabilise and crop. The file's pixels are what count (`source_view.py:65-66` takes H and W from its decoded
  frames; `:107,141` scale the focal by them). Our still camera is camera F (`--ref-frame 1244`) and our crops are never
  rescaled, so FOCAL = f at F in 4K pixels (from calib-real's final solve) for both `prepped.mp4` and `source-4k.mkv`. A wrong focal
  isn't caught by the solver (1.6x off still scores IoU 0.90, above `min_iou` 0.8: `source_view.py:190`), so P42 reads
  `focal`, `focalHeld` and `iou` from `recon-*/recon-*.json` after every freeze run.
- **Ignore cuts both ways.** Luka's run: ignore only where Gobert passes in front of him (at F, Gobert's fingers are
  behind Luka's head, so the ignore image is empty). Gobert's run: ignore = Luka's mask where he covers Gobert (at F,
  over Gobert's fingers). The input clips fill the same holes neutrally (2).
- `recon` reads only frame K of `--source-video` (`--start K --end K+1`), so the lossless native crop gives a sharper
  real view than `prepped.mp4` (CRF 14, 4:2:0). Masks are resized to the frame if needed (`source_view.py:302-303`).
- `"name": "Court Side"` and an empty intent: export's `SHOT` pattern (`export.py:61`, applied to intent + name at
  `:401-403`) would add a hoop and ball physics for "shot" or "three". Export needs `--id` and `--name`
  (`export.py:37-38`).
- `"turbo": false` gives 4DAnyone's BASE24 schedule (`stage-views.sbatch:29`, `--enable_turbo=False`): 24 steps, not
  50; there is no steps flag. Recon's flags are `recon.py:32-63`.

`pipeline/court/court-submit.sh` (preflight, then one player's whole chain):
```bash
#!/bin/bash
# Court Side: preflight, then one player's chain. Usage: court-submit.sh <id> <K> <FOCAL>, or VIEWS_ONLY=1 court-submit.sh <id>
# Nothing is submitted if a file is missing, K or FOCAL is wrong, or the group quota is short. Env: CAPS, MIN_GB, ITERS, FACE.
set -euo pipefail
ID=$1; L=/blue/iruchkin/vishalnaveen/lucid; H=$L/code/pipeline/hpg; C=$L/code/pipeline/court; RUN=$L/runs/$ID
fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }
[[ $ID == court-* ]] || fail "id $ID"
for f in input.mp4 job.json; do test -s "$RUN/$f" || fail "missing $RUN/$f"; done
if [ "${VIEWS_ONLY:-0}" != 1 ]; then
  K=${2:-}; FOCAL=${3:-}
  [[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) || fail "K=$K"
  [[ $FOCAL =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "FOCAL=$FOCAL"
  P=$(printf '%06d' "$K")
  for f in source-4k.mkv "masks/$P.png" "ignore/$P.png"; do test -s "$RUN/$f" || fail "missing $RUN/$f"; done
fi
FREE=$(blue_quota | awk 'function b(s, u) { u = tolower(substr(s, length(s)))
    return (s + 0) * (u == "k" ? 2^10 : u == "m" ? 2^20 : u == "g" ? 2^30 : u == "t" ? 2^40 : 1) }
  /^Storage quotas for group/ { g = 1; next } /^Storage quotas for user/ { g = 0 }
  g && $1 ~ /^blue/ { printf "%d", (b($4) - b($2)) / 2^30; exit }')
(( ${FREE:-0} >= ${MIN_GB:-20} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-20}"
mkdir -p "$RUN/logs" && cd "$RUN/logs"
V=$(sbatch --parsable --export=ALL,RUN=$RUN "$H/stage-views.sbatch")
if [ "${VIEWS_ONLY:-0}" = 1 ]; then echo "SUBMITTED $ID views=$V"; exit 0; fi
CAPS=${CAPS:-"300000 250000 200000"}; R=""; E=""
for CAP in $CAPS; do
  T=$((CAP / 1000))k
  r=$(sbatch --parsable --dependency=afterok:$V --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=recon-$T "$C/court-freeze.sbatch")
  E="$E:$(sbatch --parsable --dependency=afterok:$r --export=ALL,RUN=$RUN,RECON=recon-$T,OUT=bundle-$T "$C/court-export.sbatch")"
  R="$R:$r"
done
M=$(sbatch --parsable --dependency=afterok:$V --job-name=court-metrics \
  --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=${CAPS%% *},OUT=recon-metrics,HOLDOUT=8 "$C/court-freeze.sbatch")
sbatch --parsable --dependency=afterok$R:$M --export=ALL,RUN=$RUN,WHAT=views "$C/court-clean.sbatch"
sbatch --parsable --dependency=afterok$E:$M --export=ALL,RUN=$RUN,WHAT=frames "$C/court-clean.sbatch"
echo "SUBMITTED $ID views=$V recons=$R metrics=$M exports=$E"
```
`pipeline/court/court-freeze.sbatch` (the freeze, and the metrics run with the exact same flags):
```bash
#!/bin/bash
#SBATCH --job-name=court-freeze
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=20G
#SBATCH --time=01:30:00
#SBATCH --output=%x-%j.log
# Court Side: the freeze frame K only, trained cold at CAP, with the real native-4K frame as a solved view (our mask,
# whoever is in front ignored, the calibrated focal held). Needs RUN, K, FOCAL; optional CAP, OUT, ITERS, FACE, HOLDOUT.
# The metrics run is this script with OUT=recon-metrics HOLDOUT=8.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.recon --result views --start "$K" --end "$((K + 1))" --out "${OUT:-recon}" \
  --cap "${CAP:-300000}" --iters-first "${ITERS:-15000}" --sh-degree 1 --aniso 0.05 --peek 0,4,8,12,20 \
  --source-video source-4k.mkv --source-masks masks --source-ignore ignore --source-focal "$FOCAL" \
  --source-weight 3.0 --source-every 1 --source-iters 4000 --face-weight "${FACE:-2.0}" \
  ${HOLDOUT:+--holdout-every "$HOLDOUT"}
```
`pipeline/court/court-export.sbatch` (the full PLY kept: `stage-export.sbatch:23,27` passes `--no-ply` and deletes
`recon/frames`):
```bash
#!/bin/bash
#SBATCH --job-name=court-export
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --output=%x-%j.log
# Court Side: export the freeze frame with its full PLY. Needs RUN; optional RECON (recon), OUT (bundle).
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.export --recon "${RECON:-recon}" --out "${OUT:-bundle}" --id "$(basename "$RUN")" --name "Court Side" \
  --result views --clip prepped.mp4 --fps 25
```
`pipeline/court/court-clean.sbatch` (views go once every recon is done; export still reads `views/cameras.json`:
`export.py:141,156`):
```bash
#!/bin/bash
#SBATCH --job-name=court-clean
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=1
#SBATCH --mem=1G
#SBATCH --time=00:10:00
#SBATCH --output=%x-%j.log
# Court Side: WHAT=views after every recon (keeps cameras.json, metadata.json, gvhmr/); WHAT=frames after every export.
set -euo pipefail
cd "$RUN"
case "${WHAT:?views or frames}" in
  views) rm -rf views/videos views/skeletons views/.inference source-4k.mkv ;;
  frames) rm -rf recon*/frames ;;
esac
du -sh "$RUN"
```
**The command posted to the status file** (per main player; stream A replaces `<FOCAL>` with the number from
`court-run.json` before posting; posted as written, the preflight rejects it):
```bash
bash /blue/iruchkin/vishalnaveen/lucid/code/pipeline/court/court-submit.sh court-main 118 <FOCAL>
```
- **Three caps, trained now** (300k, 250k, 200k), so the headset's cut ladder never waits on a re-train; Q0 picks which
  one ships.
- **Turbo gate 2** (`court-turbo-main-s2`, `-s1`, and Gobert's): `"turbo": true`, then
  `VIEWS_ONLY=1 bash .../court-submit.sh court-turbo-main-s2`. Fetch `views/videos/{00,04,08,12}.mp4`, `views/gvhmr/`,
  `prepped.mp4`, `prep.json`; once Vishal has looked, `rm -rf $RUN`.
- **Extras in A at F** (Reid, the baseline ref): `"turbo": true` in job.json, then
  `CAPS=60000 ITERS=7000 FACE=0 bash .../court-submit.sh court-x1 118 <FOCAL>` (117 if its clip is stride 1); one
  at a time while the quota allows.
- **Release variant** (`court-rel-*`, stream A2): Turbo only, its own run folders and numbers, posted the same way.
- **After each run:** P42 on `recon-*/recon-*.json` and `peek-source-*.jpg`. Then fetch to the Mac: `bundle-*/`,
  `views/cameras.json`, `views/gvhmr/`, `recon-*/source-camera-*.json`, `recon-*/peek-*.jpg`, `recon-*/recon-*.json`,
  `prepped.mp4`, `prep.json`. The real view's `sourcePsnr` counts only non-ignored pixels.
- `--spz-sh` is gone: export writes SPZ at SH 0 whatever recon keeps (`export.py:301,305`); `reality.ply` is made by
  `assemble.py` from `000000.reality.spz` (same Gaussian order).

**Messages** (ready to paste):
- **Ojasva:** "Court Side GPU jobs are ready for when the clips land: four new files in `pipeline/court/` on branch
  `court-side` (code only; please copy them to `$L/code/pipeline/court/`). Each run is one line in the status file,
  `court-submit.sh <id> <K> <FOCAL>`, posted only with real numbers; it checks the files and `blue_quota` first and
  submits nothing if anything is off. Per main player: `stage-views` (full quality), three freeze recons (300k, 250k,
  200k, so the headset's cut ladder needs no re-train), one metrics recon with the same flags and every 8th view held
  out, three exports, and two cleanup jobs (views after the recons, frames after the exports). That's 4 B200 recons
  of ~30-45 min per player plus views and exports: OK? The Turbo checks are deleted after Vishal's look. For 10(c):
  B592 is a second real view of F (same side as A, ~10 deg off, fixed, 60p); each run folder has `real/B592/` with the
  frame crop, mask, ignore and focal for you to wire. And may the court tests live in `apps/webxr/test/court/`
  (outside `src/`, so `npm run build` stays green)?"
- **Ian:** "Court Side is WebXR-only (`?mode=court`, an AR session drawn opaque, so it looks like VR). Nothing needed in
  the Quest app. Could you run the S6 v2 test page (ask 7, `HOW-TO.md` on branch `court-side-q0`) on your 3S, and at
  Q1/Q2 wear the court mode for 10 minutes: walk toward a wall first, then tell us about comfort, the palm menu with
  hands only, See my room, and frame drops?"

## 8. Headset frame-time budget (Quest 3S at 72 Hz = 13.9 ms)

Measured so far, all on desktop; **every Quest number is "measure" (Q0, then Q1-Q3)**:

| Source | What | Number |
| --- | --- | --- |
| S4 (2D page, M3 Pro laptop) | 2 x 150k x 60 frames + 2 x 225k freeze + court + backdrop + 3 cut-outs | p50 10.1 ms; 590 MB resident, 91 MB textures |
| S5 in IWER | 17-pose walk round the ring | 0 mm drift (emulator only: IWER always grants anchors and shows no boundary); whole body in view fails at 4 of 17 poses |
| S6 in IWER (1.0x; it ran on the host's 120 Hz rAF, not 72) | video 720p60 / freeze 2 x 250k / 2 x 400k / walk / hand-off | p50 8.3 / 8.3 / 10.4 / 8.2 / 8.3 ms; p99 16.2 / 16.0 / 31.2 / 13.3 / 12.8 ms; drops 0.8 / 0.9 / 3.4 / 0.4 / 0% |
| Smooth spike | WebCodecs decode (960x720 Baseline, batch); upload + draw | 0.95 ms; 1.4 ms per frame |
| Ground spike | mirrored-proxy reflections; baked layered map | +0.1-0.4 ms (+3.4% splats); 0.15-0.33 ms |

The M3 Pro draws ~1/4.7 of the Quest's pixels and still dropped 3.4% at 2 x 400k, so the plan is **<= 500k visible**
(Spark's Quest LoD default: `spark.module.js:12652`) until Q0 says more.

| Item (Quest GPU unless noted) | Budget | Notes |
| --- | --- | --- |
| Splats, worst pose (lean-in) | <= 8.0 ms | <= 500k visible: pair 2 x 200k + extras <= 100k by default; the 250k/300k pair only with a Q0 number and `lod: true` (SplatMesh option); sort on a worker (a one-frame lag is fine, the scene is frozen); `maxPixelRadius` ~96 px |
| Show video | <= 1.5 ms GPU; decode <= 3 ms CPU off the render path | one `VideoFrameTexture` upload per display frame + the projection onto the court plane, stands proxy and one card per player |
| Ease and hand-off (video + splats under it) | <= 9.5 ms | splats are drawn from the ease start (~2.2 s with the fade) so the first sort is done before the fade |
| Arena: floor plate + the rendered rulebook court outside the frustum, lines, pools, glows, stands, shadows, reflections | <= 1.5 ms | a handful of draws, no shadow maps, no post; the rendered court is drawn in the watch too (dim) |
| Dome + passthrough under it | measure | `immersive-ar` composites passthrough under our opaque frame, and the dome is one full-screen fill per eye; AR vs VR measured at Q0 (Hz and foveation may differ in AR) |
| Hands, menu, captions | <= 0.5 ms | |
| Margin | >= 2.4 ms (17%) | |

- **Eye buffer:** `XR_QUALITY.res`, 1.0 by default (`src/xr/quality.ts:12`, passed at `src/viewer.ts:666`; Spark's own
  default is 0.5). Measure 1.0 / 0.85 / 0.7 at Q0. It is set at session start, so it is the last rung of every phase.
- **Foveation:** `XR_QUALITY.fov`, 0 by default; 0.3 if GPU-bound (the edges hold the dark arena, which hides it).
- **Refresh:** 72 Hz (the show is baked at 72 Hz); a 90 Hz bake is pre-built for a refused lock (needs GPU p95 under
  ~9.4 ms at 90 Hz).
- **Memory:** one freeze set (~500k splats) + the show stream (~40-80 MB at 2560x1440) + textures, well under S4's
  590 MB; the tab ceiling is measured at Q0. The Service Worker cache holds the fallbacks too.

**Cut ladder, split by phase** (each rung a pre-built URL flag, checked on the headset before the next; every rung
must still look great):
- **Freeze and walk (splats):**
  1. Extras: caps 60k -> 30k (pre-trained), or a far extra from Body or Relief to Leave out.
  2. `lod: true` on the extras; `maxPixelRadius` 96 -> 64 px.
  3. `maxStdDev` sqrt(8) -> sqrt(6) (Spark's default is sqrt(8)).
  4. Reflections off.
  5. Fixed foveation 0.3.
  6. Main pair 300k -> 250k -> 200k (`?cap=`; pre-trained, never pruned).
  7. The pair alone: the extras sink into the dark (Leave out).
- **Watch and ease (video):**
  1. Fixed foveation 0.3.
  2. Show stream 2560x1440 -> 1920x1080 (`?show=1080`, pre-baked).
  3. Pass 1 on `<video>` + `requestVideoFrameCallback` (`?video=element`), only if WebCodecs fails on the headset.
- **Both, last:** eye buffer 1.0 -> 0.9 -> 0.8 (`?res=`).

## 9. Risks and tested fallbacks (each fallback a URL flag, recorded at Q2 against its P-rows: P41)

| Risk | Fallback (tested on the headset once) |
| --- | --- |
| A's camera isn't fixed, or calibration misses P2 | the next clip in the top 3 (Curry's record three, then Lillard over George) |
| **Luka's build is the risky one** (A and B both film his back: his front is invented) | B592 as a second real view sharpens what was seen; his front stays off the shot list and the viewing spots face Gobert's side; worst case one player alone (Ojasva's noon rule: the one that passes) |
| Gobert's input has holes where Luka covers him (~A1020-1120) | his own window picked to cover the fewest (likely stride 1), holes filled neutrally and Reality-marked; else LHM++ body posed to his freeze pose (`?def=body`), signed off by eye against P11 |
| The tilt blur in the frames after F (A1245-1249; K = 118 or 117) hurts the views at F | the window ending at F (K = 120), chosen at gate 2 |
| F isn't the moment Vishal wants | the release variant (A2, freeze at B620), tested at Turbo in parallel; Vishal picks by eye |
| Extras look cheap | per player: Build -> Body -> Relief (< 15 deg only) -> Leave out (3.4b) |
| Hand-off not pixel-exact | the splat-depth proxy at F; P8 at the dolly seat; D' tuned in the headset (`?seat=` 4-7 m) |
| The watch reads as cardboard from the dolly seat | D' toward 7 m (less parallax per body depth); limbs' ~0.6 deg card error checked by eye in motion at Q2 |
| The real view trains with a wrong focal | P42 after every freeze run; re-run with the corrected FOCAL |
| Slow-down steps or ghosts | real frames carry it to 0.6x; RIFE below (labelled); a ghosted in-between is fixed by hand (masked RIFE on the hands and ball, or painted) |
| WebCodecs or `VideoFrameTexture` fails on the Quest (`isConfigSupported` false, decode stalls) | `?video=element` for pass 1 and `?show=1080`; Q0 decides before the bake is final |
| 72 Hz lock refused | `?hz=90` plays the pre-built 90 Hz bake |
| Hand tracking flaky (menu won't open or press) | presenter override keys (3.6; verify at Q1); else the presenter coaches palm-up |
| Quest frame drops at the lean-in | the phase-split cut ladder (section 8), every rung pre-built |
| A small room | already the default: 3.5 x 3.5 m with three viewing spots; the ring only when the bounds allow |
| A wall in the way | our edge fade, always on (room from 0.6 m, fully open at 0.3 m), plus the Quest boundary; the presenter's wall-walk before each session |
| The Quest boundary is hidden in the opaque AR session (Q0) | our edge fade already covers it; tell Ojasva the Q0 result |
| Anchors fail in the session | `local-floor` alone; Seat here again after a recenter; old persistent handles deleted (8 per site) |
| The session ends on headset off | the presenter re-enters and holds Seat here before handing over (Q1 checks P38) |
| The judge sits down blind | Back to my seat always goes through the room with the drawn chair over the real one; the presenter spots the sit |
| Session exits (system palm pinch) | Enter again restores the phase, the anchor and the seat |
| Network on stage | everything from 127.0.0.1 over `adb reverse`, precached by the Service Worker, preloaded in memory; cable off |
| A pop at the hand-off (Spark's first sort) | splats drawn under the opaque video from the ease start |
| Photosensitivity (A's arena strobes) | the three strobe frames replaced in the bake (P39) |
| Court data leaks through the tunnel | the bundle lives outside `dreams/`, served only on 127.0.0.1 (P36) |
| A HiPerGator command goes out half-filled | posted only with real numbers; `court-submit.sh`'s preflight submits nothing on any miss |
| Tab memory | measured at Q0; one freeze set is ~500k splats |
| Audio | B's no-vocals stem is already clean (VAD + Whisper + a listen); C is never used; CC0 sounds only if Vishal approves |

## 10. Demo shot list and failure drill (any hand-off direction)

**Before each judge (presenter, ~1 min):**
1. Quest charged; boundary set to the floor (3.5 x 3.5 m, or more for the ring); a normal chair centred on one side,
   0.6 m from the edge; page and bundle precached (the bookmarked link carries the `?seat=` D' tuned at Q2), one warm
   run done, cable off.
2. In the chair, Enter, hold Seat here 2 s (anchor saved, play area set). At the start of each session, the
   wall-walk: walk toward a wall and see the room open at 0.6 m. Headset off: the session stays live. Hand it over.

**The judge (about 2 minutes):**

| t | Beat | The judge | Presenter (short) |
| --- | --- | --- | --- |
| 0:00 | Arrival: black, room tone, the lights come up, the crowd swells; you're ~5 m from the play, on the camera's line | sits, puts the headset on | "You're courtside: Game 2 of the 2024 West finals. Turn your left palm up." |
| 0:03 | Pass 1: Luka dribbles, steps back, Gobert closes out (real speed) | watches | (silent) |
| 0:10 | Pass 2: the replay in real slow motion | left palm up | "Press Step into the court." |
| 0:13 | Ease to the freeze, the hand-off, the world opens | watches | "That's the real frame: Gobert closes out as Luka gathers. Now it's 3D." |
| 0:18 | Walk closer (one fade) | presses | "Press Walk closer, then stand up." |
| 0:22 | The front spot: Gobert's face and his arm over Luka's head; lean in to the ball at Luka's hip and the hands | stands, leans | "Look at his hand over Luka's head. Lean in to the ball." |
| 0:50 | Next view, twice (60 deg each side; the ring instead if the room allows) | presses, steps | "Press Next view." |
| 1:15 | Reality check on, then off | presses | "Blue is what the camera never saw." |
| 1:25 | See my room | presses | "Press See my room: they're standing in this room." |
| 1:35 | Back to my seat: through the room to the chair, sit, the arena returns | walks, sits, presses | "Walk to your chair and sit. Press Back to my seat." |
| 1:45 | The release in slow motion, the tilt to the rim, the ball through the net, the crowd erupts, darkness | watches | (silent) |
| 1:55 | Replay or hand back | | |

**Failure drill** (in the order you'd try things):

| What goes wrong | You see | Presenter does |
| --- | --- | --- |
| Judge uneasy, or close to a wall | | See my room first |
| Near the edge | the room opens at the edge | judge steps back toward the middle; if it keeps opening, redraw the boundary before the next judge |
| Frame drops | judder | reload the next pre-built rung for that phase (section 8: walking -> the freeze ladder, watching -> the video ladder) |
| Menu won't open | palm up, nothing | palm toward the face, controllers down; then the presenter keys |
| Drift (court off the real floor) | feet sink or float, spots misplaced | Back to my seat, then the setup page, Seat here; if it persists, exit and re-enter |
| Tracking lost | the world swims; "tracking lost" | judge stands still and looks at the floor; the anchor re-pins the court; if it's off, Seat here again (10 s) |
| Tab reloads or freezes | black or a stuck frame | headset off the judge; reload from the Service Worker cache, Enter, Seat here (<= 45 s, P37) |
| Judge exits with the system pinch | the home menu | Enter again: same phase, same anchor |
| No sound | silence | Quest volume, tab not muted; it still works silent: carry on |
| Nothing works | | the recorded Q3 run on the laptop |

## 11. Measurements for the slide

- Calibration reprojection error (median / p95, in degrees and source px) and floor error (cm).
- Seat-view match (P8): at the dolly seat, video layer vs 3D; and the 3D at camera F vs the real frame (players, and
  the whole frame).
- Held-out PSNR per main player **vs generated views** (`recon-metrics`: the exact freeze flags with every 8th
  generated view held out); the real view's IoU and `sourcePsnr` (P42).
- Quest 3S frame time (p50 / p95 / dropped frames) per phase, from `stats.ts` on the headset (S6's
  `court-spikes/s6-quest/spike6/stats.ts`, wired into `court.ts`), GPU % from OVR Metrics Tool, eye buffer, Hz.
- Seen fraction per player (how much the cameras really saw); interpolated share of the show.

## 12. Break-it findings

Verdicts are the main session's (`~/.handoffs/lucid_dreams/court-spikes/review/findings.md`); each was checked at its
source before folding in.

### break-experience (Opus, 8:08 AM)
- exp 1 (judge can't hit the ease): 2, 3.2, 3.3 (pass 2 at 0.6x with Step in live, ease ladder, cutoff), P6, 10.
  Changed from the verdict: pass 2 runs at 0.6x, not A's own 0.375x (~17 s), so every display frame is real.
- exp 2 (dolly seat breaks same pixels): 3.1, 3.3 (splat-depth proxy at F), 3.4 (Walk closer), 4.2, 4.3
  `proxies.ts`, P1, P8; the seat itself is now Decision W (below).
- exp 3 (F isn't the release): 2 (now superseded by freeze-pick: F = A1244, said plainly in the caption).
- exp 4 (blind sit after Walk closer): 3.1, 3.5 (drawn chair, re-seat, always through the room), 9, 10.
- exp 5 (proximity fade on the lean-in): 3.4, P17 (capsules at 0.2 m; ball at 0.3 m doesn't fade).
- exp 6 (shot list shows Luka's invented face): 3.4, 9 (risk row inverted), 10, P11 (pass bar).
- exp 7 (most extras aren't in A at F): 3.4b (with freeze-pick's facts below).
- exp 8 (extras contradictions): 3.3 step 3, 3.4b (card fades over drawn 3D, shadows and reflections, `freeze.ts`,
  batch by quota), 7.
- exp 9 (relief passes rubber sheets): 3.4b, P16 (< 15 deg ray angle).
- exp 10 (courtside plate reads as a poster): 3.3, 3.4, 4.3 `world.ts`/`proxies.ts`, P30.
- exp 11 (arrival has no trigger): 3.1, 3.2, P27.
- exp 12 (cache reload can't work cable-off): 3.1, 10, P37 (Service Worker).
- exp 13 (fallbacks untested, some not great): 9 (URL flags, P41); "nearest real frame" and the longer dissolve
  dropped.
- exp 14 (risks with no fallback): 8, 9 (`?video=element`, 90 Hz bake, presenter keys, 500k with pre-built rungs).
- exp 15 (public figures, tunnel): 2 (watermark inpainted, no UI branding), 4.2, P36, P40.
- exp 16 (requirements with no check): P11 (faces, hands), P22 (caption), P23 (inpainted plate), P27-P29, P31, P32.
- exp 17 (standing mid-fade): 3.3, P10.
- exp 18 (the make is never shown): reversed by pl 4: the make plays in A on resume (2, 3.5, P18).
- exp 19 (Whisper invents words): P19 (VAD + a listen).

### New requirement (Ojasva, 8:10 AM) and the See my room design (break-experience, 8:12 AM)
- See my room in an opaque `immersive-ar` session: 1, 3.6 (menu, feel, per-phase rules), 4.3, 8, 9, 10, P33-P35.
- Boundary layout (the pair 2.5 m from the chair after Walk closer): 3.4; the room sizes are now Ojasva's binding
  answer (below).

### break-runtime (Opus, 8:10 AM)
- rt 1 (800k contradicts S6): 8 (<= 500k, Q0 go/no-go).
- rt 2 (no test matches the video path; level 5.1): 3.3, 4.2, 4.3 `video.ts`, 5 (Q0), P5.
- rt 3 (press forces a decoder reset; P6 vs 3.3): 3.3 (second primed decoder, ladder, cutoff), 4.3, P6.
- rt 4 (IWER timing): 0 (stepped capture, separate timing pass), 6, 8.
- rt 5 (IWER eyes vs freeze.png; SSIM bars): P8 (mono render + per-eye check), P9 (0.95), 6.
- rt 6 (`node --test` can't import): 4.3 (`--experimental-transform-types`, type-only sibling imports; folder per
  agy 4), 6.
- rt 7 (`video.ts` and `world.ts` both claim the proxies): 4.3 (`proxies.ts`, D), 5 (stubs).
- rt 8 (worktrees lack node_modules and dreams/): 5 (start steps; integrator runs timing alone).
- rt 9 (vite serves dreams/; tunnel): 4.2 (bundle outside the repo), P36.
- rt 10 (vite dev on stage): 3.1 (`vite build` + `serve.mjs`, preload, Service Worker).
- rt 11 (hand-over gesture, headset off): 3.1, P38.
- rt 12 (anchors in the session, 8 handles): 3.1, 4.3 `seat.ts`, 9.
- rt 13 (first sort pop): 3.3, 8, P10.
- rt 14 (cut ladder): 7 (three caps pre-trained), 8 (phase split, `lod: true`, `maxStdDev`, reflections off), 10.
- rt 15 (Walk closer needed; no `bounded-floor` in IWER): 3.4, 6.
- rt 16 (`handOccluder` in VR): superseded by addendum D (3.6).
- rt 17 (clock rounding; P6 C1/C2, P17 0.3/0.45): 4.3 `clock.ts`, 6 (C2 throughout), P17 (0.2 m capsules).
- rt 18 (tools that don't exist): 5 (tool table, owners, `pipeline/court/`), 6.

### break-runtime addendum (8:20 AM)
- A (AR, not VR): 4.3.
- B (boundary may hide; app guard): 3.6, 9, P35 (now always on, per Ojasva).
- C (clear alpha no lever; black dome): 4.3.
- D (hands): 3.6 (drawn hands in the arena, occluders only in the room).
- E (passthrough and dome cost): 8.
- F ("S5-validated" overstated): 8, P14.
- G (See my room look): 3.6.
- H (session flags; alpha read-back): 4.3, P33, P34.
- I (freeze commands lack source flags; focal unit): 7 (settled with re-check 3).

### break-pipeline (8:22 AM)
- pl 1 (export needs `--id`/`--name`; no "shot"/"three"): 7.
- pl 2 (source masks, ignore, focal not passed): 7 (run folder and `court-freeze.sbatch`).
- pl 3 (2.67x from a ~120 fps capture): 1, 2, 3.3, 4.2 (`captureFps` 120), 9.
- pl 4 (no cut at 22.12 s; strobes): 2, 3.3, 3.5, P18, P39.
- pl 5 (F = 1240; window <= 1252; K <= 119): superseded by freeze-pick (F = A1244; K = 118 at stride 2, 117 at
  stride 1, windows ending <= A1249; K = 120 as the gate-2 alternative); the K <= 119 limit no longer binds because metrics trains frame K only (2, 7).
- pl 6 (gate-1 frames; crops hold other people): 2, 4.1 (composite, union box, stride 1 if it doesn't fit).
- pl 7 (disk): 7 (cleanup jobs, Turbo runs deleted, extras by quota; `blue_quota` per re-check 6).
- pl 8 (held-out PSNR from a different model): 7 (metrics = freeze flags + holdout), 11 ("vs generated views",
  `stats.ts`).
- pl 9 (`--wrap` under /bin/sh): 7 (bash files).
- pl 10 ("50-step" is BASE24, 24 steps): 4.1, 7.
- pl 11 (`setpts` alone keeps 59.94): 2, 7. Partly changed: `framemd5` checks our `input.mp4`; prep's CRF 14
  re-encode can't match a hash, so `check_prepped.py` matches frames by PSNR.
- pl 12 (`--spz-sh` no effect; native 4K as frame K): 4.1, 7.

### break-pipeline re-check of section 7 vs acb2863 (8:13 AM)
- rc 1 (export `--id`/`--name`): DUP of pl 1; in 7.
- rc 2 (job.json source keys only reach `stage-recon`): 7 (our scripts pass the flags; keys kept in job.json as the
  record; masks for frame K, since metrics trains frame K only, not K-1..K+1).
- rc 3 (focal and masks must describe the exact `--source-video`): 4.1, 5 (`stabilize.py --ref-frame`), 7 (FOCAL
  formula), P42. Changed: with camera F as the still camera and unscaled crops, the formula's factor is 1, so FOCAL
  is F's own focal for both files.
- rc 4 (ignore cuts both ways; Gobert's holes): 2 (Gobert's own window, neutral fill), 7, 9, P23.
- rc 5 (Ojasva's session auto-submits; placeholders break bash): 7 (`court-submit.sh` preflight, numbers only), 9.
- rc 6 (`df` shows all of /blue; cleanup list): 7 (`blue_quota` group line, the exact rm lists in two jobs).
- rc 7 (stale line 460; flags span recon.py:32-63): 7.
- rc 8 (no slot for ask 10c): 7 (`real/B592/`), with freeze-pick's B592.

### Antigravity (crew, 8:08 AM; verified by verify-agy): 13 DUP, 5 NEW-REAL, 0 rejected
- agy 1 (window past the shin cut): DUP of pl 5.
- agy 2 (nothing caches the page or bundle): DUP of exp 12 + rt 10.
- agy 3 (dolly seat, flat cards): DUP of exp 2.
- agy 4 (tests under `src/` break `npm run build`): NEW; 4.3, 5, 6 (`apps/webxr/test/court/`).
- agy 5 (export `--id`/`--name`): DUP of pl 1.
- agy 6 (pixel thresholds mix source and display px): NEW; 0 (header, P2, P8), 3.3, 6, 11 (degrees).
- agy 7 (projecting with a smoothed path): NEW; 3.2, 4.2, 4.3 (each frame's own solved pose).
- agy 8 (1.2 s ease from 1x breaks 0.02 per frame): NEW; 3.3, P6, 6 (eases start at 0.6x; resume lengthened to
  0.8 s, which at 0.7 s would peak at 0.022).
- agy 9 (Back to my seat gates only horizontal distance): DUP of the See my room beats + exp 4.
- agy 10 (tunnelled vite serves the bundle): DUP of rt 9 + exp 15.
- agy 11 (800k in 8 ms): DUP of rt 1.
- agy 12 (3.5 x 3.5 m can't hold the walk): DUP of rt 15 + the boundary layout; now Ojasva's binding answer.
- agy 13 (shot list sends the judge to Luka's face): DUP of exp 6.
- agy 14 (fixed ramp start, late press reruns the play): DUP of exp 1 + rt 3.
- agy 15 (per-frame k1 vs one fixed k1): NEW; 3.3, 4.2 (the bake undistorts with each frame's k1; the bundle ships
  k1 = 0).
- agy 16 (avc1.640033 is level 5.1): DUP of rt 2.
- agy 17 (unbounded decode-ahead): DUP of rt 2.
- agy 18 (metrics past frame 121): DUP of pl 5.

### freeze-pick (8:25 AM) and the main session's decision
- F = A1244 (Gobert's closeout): 1, 2, 3.3, 3.4, 4.2 (`freezeSource`, caption), 9, 10, P22.
- Windows (main session, 8:54 AM, even grid): default A929-1249 (stride 2, K = 118) or A1088-1248 (stride 1,
  K = 117); the decision's
  A921/A1083-1244 (K = 120, exact starts A924/A1084) kept as the gate-2 alternative: 2, 4.1, 7, 9.
- B592 as a second real view (ask 10c); B is not Luka's front: 1, 2, 7, 9, P11.
- Release variant (stream A2): 2, 4.1, 5, 7, 9.
- Extras (only Reid and the baseline ref in A at F; C's table): 3.3, 3.4b.
- Branding (watermark in A, B, C; Sprite LED and TISSOT ignore boxes; C never shown): 2, 5, P40.

### DECISION W, watch geometry (main session, 8:50 AM)
- Seat on camera F's optical ray at D' ~5 m (4-7 m by eye), eye at the judge's seated height, per-frame projection
  onto court plane + stands proxy + per-player cards, splat-depth meshes at F, the rendered court outside the frustum
  fading to dark and Reality-marked, the lit region following the pan, P8 at the dolly seat; v9 numbers provisional:
  0 (header, P1-P3, P8, P23), 1, 2, 3.1-3.5, 4.2 (`seat`, `court.hardwood`), 4.3, 6, 8, 9, 10, 11.

### Ojasva's answers to asks 12-13 (binding)
- 3.5 x 3.5 m default with three viewing spots; the ring automatic from the bounds, never a setting: 3.1, 3.4, 4.2
  (`spots`, `ringArea`), 4.3 `seat.ts`, 6, 9, 10, P16, P29.
- The room fade near the edge always on (from 0.6 m, fully open at 0.3 m; `bounded-floor`, else the play area set at
  Seat here) and a wall-walk before anyone else wears it: 3.1, 3.6, 4.3 `world.ts`/`court.ts`, 5 (Q1-Q4), 9, 10, P33,
  P35.

### Main-session reversals
- exp 18 reversed by pl 4 (the make in A on resume): applied.
- exp 1 watch length recomputed from the 120 fps capture: 2, 3.2.
- Masks on the Mac (PC unreachable): 4.1.

### Grok (pending)
- The first run timed out; re-run on this revision.
