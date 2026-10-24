# Ian: the Quest app

You own what people actually see: photoreal people standing on the real floor in Meta Quest 3S passthrough,
moving smoothly at full frame rate. Read `AGENTS.md` first.

## TOP PRIORITY (Sat 1 AM): make them read as real people in the headset

Ojasva's verdict: the people look "creepy, uncanny". Vishal is fixing faces and idle motion at the source; most of
the rest happens at render time, and that's yours. You have Ojasva's OK to edit `apps/webxr` for these as well as
the Unity app. Every item gets a before/after passthrough capture.

1. **Match the room's light.** A person brighter or bluer than your room reads as a sticker.
   - Use Meta's Passthrough Camera API (Quest 3 / 3S, Horizon OS v74+) in Unity: once a second, sample the room's
     average brightness and white point near the person, and apply a gentle gain and white balance in the splat
     shader (clamped to ±30%, eased over 1 s).
   - If the permission flow is too heavy for the demo, ship a "Light" button on the hands bar with three presets
     (warm room, daylight, dim) instead.
2. **Resolution where it counts.** Eye-buffer scale 1.3-1.5x (WebXR: `framebufferScaleFactor`), low fixed
   foveation, splats sorted every frame. Report the highest scale that holds 72 fps with `jump-shot` (121 frames)
   on the 3S.
3. **Feet that belong to the floor.** A contact shadow plus a faint ambient-occlusion ring. Then measure foot height
   across every frame of each replay and report the worst one: a floating or sliding foot is the fastest way to
   look fake.
4. **Eye contact.** For avatars in `companion` and `play` modes, the head (joint 15, with the neck, 12, taking 30%)
   turns toward the viewer's head: ±35° yaw, ±20° pitch, eased over 300 ms. In WebXR, `SkinnedAvatar.pose(t,
   edit)` in `apps/webxr/src/avatar.ts` lets you change a joint's local rotation before skinning. Chess opponents
   look up at you after their move, then back down at the board.
5. **Blinks and breathing** once Vishal ships `expr` / `expr.bin`: apply the 10 expression offsets per head
   Gaussian on the GPU (one extra buffer, read in the splat vertex stage).

## MORE (Sat 1:20 AM): a lot more, in order, after the top items

1. **Real furniture hides them.** Use the Quest Depth API (environment depth, Quest 3 / 3S): someone walking
   behind your real couch or table is cut off by it, per pixel, with a soft edge. After the light match, this is
   the biggest single "they're really here" effect. Ship it in the Unity app; in WebXR use the `depth-sensing`
   feature if the Quest browser exposes it, else skip.
2. **72 fps with a full replay.** 121 frames x about 285k Gaussians. Do these, measuring after each:
   - distance-based LOD: past 3 m, draw a 50% subset chosen by opacity x size, precomputed per frame;
   - sort every other frame when nothing moved much;
   - SH 0 beyond 2 m;
   - a frame budget readout on the debug bar.

   Report fps and GPU ms in the Status log.
3. **They belong in the Place.** When a Place is up, tint the person by the panorama's ambient light (its first SH
   band, precomputed per Place) and cast their contact shadow on the Place's floor. No one should look pasted onto
   the court.
4. **Spatial audio that sounds like the room:** voice from the mouth with distance falloff and a short early
   reflection, plus a little reverb inside Places (more in the concert hall).
5. **The 3-minute demo, rehearsed hands-only.** Script the order (piano lesson, then a basketball lesson, chess,
   then the family moment), with no controller, no menus typed and no reload. Time it twice and write the run sheet
   in `demo/run-sheet.md`.

## TAKEN OVER FROM ATINA (Sat 12:35 AM): the submission is yours too

Atina's remaining work moves to you (she built the capture kit, captions, restoration and drafts; you already
built her headset UI). Her drafts are in `demo/`: start from them, don't redo them. Deadlines are hard: Devpost
**submitted by Sun 3 PM** (late entries aren't accepted). Do these between the Quest items below, in this order:

1. **Credits, complete** (`demo/credits.md`, then the README): every source with link and license. Jason Han's
   piano videos (Wikimedia Commons, CC BY-SA 4.0, "JMC, Han (Jason)"); Bobby Fischer (W. Punt / Anefo, Nationaal
   Archief, CC0); Magnus Carlsen (Wikimedia user Autopilot, CC BY-SA 3.0); Juice WRLD (Lexiou WesCudi, CC BY-SA 2.0);
   the Pexels jump-shot clips (Pexels license); LeBron's clip (supplied for a non-commercial demo, not
   redistributed); Poly Haven places (CC0, `apps/webxr/public/places/CREDITS.md`) and chess set (CC0); every model
   and library (4DAnyone, DiGS-Avatar, gsplat, Spark, three.js, Unity Gaussian Splatting, NLF, rembg, GVHMR,
   BiRefNet, SMPL-X, DINOv3, Stockfish (GPL-3.0, separate file), Gemini, whisper.cpp, Real-ESRGAN, Demucs).
2. **Root `README.md`** (Sat 8 PM): turn `demo/README-draft.md` into the public README: one line of what it is, a
   GIF or still of a real person in a room, how it works (the five steps), the five showcase moments
   (`demo/showcase.md`), how to run each app, real numbers, credits, MIT license. MLH Open Source prize reads this.
3. **Devpost** (`demo/devpost.md`; draft by Sat noon, final Sun 1 PM): fill every blank with measured numbers from
   the Status log: held-out PSNR 26-28 dB and SSIM 0.96-0.97 on real clips, ~285k Gaussians per frame, 48 views
   per clip, 12 GPUs per person, minutes per dream, and Vishal's fine-tune table once it lands. Tracks: overall,
   Best AI Hack, Best Design, Best Social Impact, MLH Gemini, MLH Open Source (not Twinly). Say why the tech is
   recent (4DAnyone Aug 2026, DiGS-Avatar Jun 2026).
4. **The video** (3 min max, edited by Sun 1 PM): `demo/video.md` is the script. You're already capturing the
   passthrough clips (item 6 below), so you edit: the five moments ~30 s each, then how it works with the real
   numbers, then the team. Screen-record the WebXR viewer on a laptop for anything the headset can't capture.
5. **Slides** (Sat 8 PM, 6-8 slides): problem, the one sentence, the five moments, how it works, numbers, honesty
   (seen vs imagined, consent, public figures labelled), team.
6. **Judge Q&A** (`demo/judges.md`): add "Why are there public figures?" (demo only, from real footage or freely
   licensed photos, never their voice, always labelled, no endorsement implied), "What's real vs imagined?"
   (Reality check, % seen), "What runs where?" (HiPerGator for reconstruction, Mac bridge, Quest/WebXR to view).
7. **Family moment** (if a teammate's family agrees in writing): a photo or video in `~/Downloads/lucid-photos/`
   or `lucid-clips/` on Ojasva's Mac with a `.txt` "I just want to sit with her". Consent record in
   `demo/consent.md`. Skip it if there's no written yes; the demo works without it.

## BIG CHUNK (Sat 12:20 AM): real people land tonight; make the Quest app demo-ready

Avatar player, library, voice and captions, props: outstanding pace. Real bundles land in `dreams/` within the
hour: `jump-shot`, `jump-shot-2`, `lebron-jumper` (ball + hoop props), `piano-han` (seated, beside you), and
avatars `bobby-fischer`, `magnus-carlsen`, `juice-wrld`. In order:

1. **Real-bundle pass:** load each one as it lands and fix whatever breaks: scale (life size, never scaled), feet
   on the floor, facing, the hoop where `props.json` says, the seated tutor not floating. Log what you fixed.
2. **Frame rate on the Quest 3S with LeBron's real replay** (121 frames x ~285k Gaussians): report fps. If it's
   under 72, find the Gaussian count that holds 72 and tell Ojasva (he re-exports at that cap); try fixed foveation
   and a lower sort rate first.
3. **Places:** the six environments in `apps/webxr/public/places/` (CC0 equirects; ids and per-place rotation in
   `apps/webxr/src/places.ts`). Skybox swap with passthrough off, a floor at y = 0 for the contact shadow, and a
   fingertip button that cycles Your room -> places -> back. `experience.json`'s `environment` picks the start.
4. **Two people at once:** load a second dream next to the first (LeBron, and your own avatar doing his shot
   1.5 m to his left). The library gets a "Bring in another" action.
5. **Seated people:** `place: "beside"` with someone seated (piano) should put their hips at bench height, not
   their feet at the floor; read the bundle's lowest point per frame, and add a simple bench under them if the
   reconstruction has none.
6. **Demo capture:** record each showcase moment in passthrough (`demo/showcase.md`) as clean 30 s clips for
   Atina's video: the piano lesson, LeBron's lesson with the hoop, a legend at chess (WebXR, recorded on the Quest),
   Juice WRLD standing with you.
7. **Install story:** a signed APK, a one-command install (`adb install -r`), and a short "run it on the Quest"
   section in `apps/quest/README.md`.

## ADDED (Fri 11:40 PM): Places and the piano tutor

- **Places:** the WebXR viewer is getting a "Place" button that swaps your room for a 360-degree environment around
  the person (Poly Haven CC0 HDRIs in `apps/webxr/public/places/`, ids in AGENTS.md under Experience once pushed).
  In Unity it's a skybox swap with passthrough off; worth an hour after the avatar player.
- **Seated people:** the piano tutor sits at an upright. `place: "beside"` puts them 0.8 m to your right facing your
  way, so you sit next to them. Make sure your placement handles a seated person (feet on the floor, not the hips).

## ADDED (Fri 11 PM): props and seated opponents

- **Props (new contract, `props.json`, in AGENTS.md shortly):** the important objects around the person. For
  basketball: the real ball's path per frame (`kind: basketball`, radius 0.12, `track` of [x,y,z] or null per
  frame in bundle coordinates) and a regulation hoop (`kind: hoop`, rim at 3.05 m, `facing` toward the shooter).
  The WebXR viewer renders both procedurally. Do the same in Unity after the avatar player: ball sphere on the
  track (interpolate between frames), hoop at real size, both children of the person's root, so placement moves them.
- The chess legends will sit and move their own pieces in WebXR (procedural seated pose + arm IK), so chess stays
  WebXR-only; nothing for you there.

## NEXT (Fri 10:45 PM): you're ahead, here's the next big chunk

Teach mode, reality check, SPZ and hands in one evening: excellent. Real bundles start landing in `dreams/` tonight:
two Pexels jump shots and **LeBron's jump shot** (intent "teach me this jump shot"), then Buster Keaton (1920,
public domain). In order:

1. **Avatar player (GPU skinning).** Bobby Fischer, Magnus Carlsen and Vishal's avatars are queued (they start once
   Meta's DINOv3 weights arrive). Pose `avatar/avatar.ply` from `skin.bin` + `skeleton.json` + `motion.json` exactly as
   `apps/webxr/src/avatar.ts` does (identity rest per bone, the full skinning transform per bone per frame,
   dual-quaternion blend, slerp between motion frames). Test data now: `dreams/test-avatar/` on Ojasva's Mac (a waving
   SMPL-X body; derived from the licensed SMPL-X model, so AirDrop it, never commit it).
2. **Their voice and words:** `voice.m4a` (fall back to `audio.m4a`) as a spatial source at mouth height
   (`bounds.max.y - 0.13`, 8 cm in front of the face); `captions.vtt` as a quiet caption in front of them at chest height.
3. **Library in the headset:** `GET /api/dreams` from the bridge, a grid of thumbs you poke to open, newest first.
4. **Numbers:** fps on the Quest 3S with LeBron's real replay loaded (121 frames). If it's under 72, tell Ojasva the
   Gaussian count that holds 72 and he'll re-export at that cap.
5. **Capture:** once LeBron lands, record a clean passthrough clip of the lesson in a real room for Atina's video.

## NOW (Fri 10:10 PM): run experience.json, the main goal

Hands-only controls with a passing HandsCheck: excellent. The product is now one line (AGENTS.md, top): photo or
video + one sentence of intent -> the person in your room doing it with you, driven by `experience.json` (AGENTS.md,
Contracts, "Experience"). Your next item, before anything else in the backlog:

1. **Teach mode in the Quest app:** steps from `experience.json`. Each step plays at its `speed`, `repeat` times, then
   the person freezes in the step's last pose for your turn (the move's length at 1x + 1.5 s, with a thin progress
   bar), then the next step, wrapping after the last. A step panel at eye level, off to the right of the person
   (step n of N or "Your turn", title, tip), and Back / Again / Next added to your fingertip bar. Read tips aloud with
   Android TTS (never the person's voice). Reference behaviour: `apps/webxr/src/experience.ts` (`Lesson`).
2. **Placement by `place`:** `facing` (1.8 m in front, facing you), `beside` (0.8 m to your right, 0.5 m ahead,
   facing your way), `ahead` (1.5 m ahead, facing away).
3. Then the SPZ/avatar items as before.

## Your big chunk

| Piece | Done means |
| --- | --- |
| Unity project in `apps/quest/` | Builds to the Quest 3S in passthrough (OpenXR + Meta XR SDK), Unity 2022.3 LTS |
| Gaussian rendering | Start from MIT `ninjamode/Unity-VR-Gaussian-Splatting` (Aras Pranckevicius's renderer, VR fork). Reference `VU-RASL/GaussianAvatarRender` for depth-correct passthrough avatars (learn from it; it has no license yet, so don't copy its code) |
| Replay playback | Loads a dream bundle (`frames/%06d.ply`) and plays it at the clip's fps, looping; preloads ahead so it never stutters |
| Avatar playback | Loads `avatar/avatar.ply` + `avatar/motion.json` (SMPL-X) and animates it (coordinate with Vishal) |
| Placement | Person appears life size on the real floor (Scene API / floor plane), facing you; grab to move or rotate |
| Controls | Play/pause, freeze, 0.25x / 0.5x / 1x, scrub with a pinch-drag, "seen vs imagined" toggle, next person |
| Library | Pulls the dream list from the bridge (`GET /api/dreams`) and downloads bundles over Wi-Fi |
| Performance | Holds 72 fps; find the real Gaussian budget per frame on Quest 3S (expect around 300-400k) and report it to Ojasva |
| Max-fidelity mode | PC-streamed (Quest Link / Air Link with passthrough) from a Windows laptop with an RTX GPU, for the hero demo. Find out who on the team has one |

## Milestones

| When | Done |
| --- | --- |
| Fri 11 PM | A static Gaussian person (the sample bundle's first frame) standing in passthrough on the Quest |
| Sat 10 AM | Full replay playing from a real bundle, at frame rate |
| Sat 8 PM | Controls, library from the bridge, avatar playback, polished in-headset UI (Atina designs it, you build it) |
| Sun 10 AM | Frozen, demo-proof, works offline from cached bundles |

## Talk to

- Ojasva: bundle format, Gaussian counts, compression if files are too big.
- Vishal: avatar rig and motion format.
- Atina: in-headset UI design (she matches Raami's web app look).

## Next chunk (added after your first push: nice work on the project setup and the first-frame importer)

1. **Sequence playback.** Real bundles have about 121 frames (`frames/%06d.ply`, 25 fps). Extend `DreamBundleImport`
   to batch-import every frame into Gaussian assets, then a `DreamSequencePlayer` that swaps the active asset at the
   bundle's `fps` (loop, play/pause, 0.25x / 0.5x / 1x, scrub). Preload everything before play so it never stutters.
2. **Budget.** Frames are capped at 300k Gaussians. Measure fps on the Quest 3S with a full sequence loaded; if it
   drops under 72, tell Ojasva the number that holds 72 and he'll re-export at that cap.
3. **Sample bundles.** A synthetic test bundle is on HiPerGator now; real people (4DAnyone's sample clips) follow as
   soon as SMPL-X finishes downloading. Ojasva fetches them into `dreams/<id>/` on his Mac (`.ply` with `--with-ply`).
4. **Grounding.** Add a soft contact shadow under the feet (a blurred dark disc on the floor plane). It's the single
   biggest thing that makes a person read as standing on the floor rather than floating.
5. The WebXR viewer in `apps/webxr` already does placement 1.8 m in front, facing you, on `local-floor`: use it as the
   reference for how placement should feel.

## Heads-up from Vishal's side (avatars)

Avatar bundles (`kind: "avatar"`) will carry `avatar/avatar.ply` (SMPL-X rest pose), `avatar/motion.json`,
`avatar/skin.bin` (per Gaussian: 4 joint indices + 4 weights as uint8) and `avatar/skeleton.json` (rest joints +
parents). Plan an avatar player that skins Gaussians on the GPU (linear blend skinning of positions and rotations).

## Your backlog (ordered; decide everything inside apps/quest yourself)

Test data now: `samples/synthetic-test/` in the repo (frame 0 as PLY, frames 0-3 as SPZ). Real bundles land in
`dreams/` on Ojasva's Mac as they finish; ask anyone at the table to copy one to you.

1. **Sequence player:** import all frames, swap at `fps`, preload, loop; play/pause, 0.25/0.5/1x, scrub.
2. **Runtime loading (big win):** a C# SPZ reader so bundles load at runtime from the bridge, with no editor import.
   The format is tiny: gzip of a header + packed arrays; `pipeline/lucid/gaussians.py` `write_spz` is the exact
   spec we write (positions 24-bit fixed point, alpha u8, colour u8, log-scale u8, rotation xyz u8). Build Aras's
   `GaussianSplatAsset` data from it at runtime.
3. **Library from the bridge:** `GET http://<mac>:5170/api/dreams`, download with progress, cache to disk for offline.
4. **Placement and hands:** pinch to pause, grab to move or rotate, soft contact shadow, the person life size on the
   real floor (never scaled).
5. **Reality check:** a toggle that swaps to `frames.reality` (the blue imagined parts), with the seen % shown.
6. **In-headset UI:** build Atina's mockups (she's designing to match Raami's web app). Start with placeholders now.
7. **Avatar player:** GPU skinning from `avatar/skin.bin` + `skeleton.json` + `motion.json` (Vishal's format above).
8. **Performance report:** fps vs Gaussians on Quest 3S, so Ojasva sets the export cap; LOD if needed.
9. **Max-fidelity mode:** PC streaming over Quest Link if anyone has a Windows laptop with an RTX GPU.
10. **Capture:** record a clean passthrough video of a person in the room for Atina's demo video.

## Update (Fri ~9 PM): after your OpenXR + hand-tracking push

Nice: Android OpenXR settings, Meta hand tracking and the batch APK build are in. Still the order:
1. **Sequence player** (all frames, swap at `fps`, preload, loop) and 2. **runtime SPZ loading**: these are what
   the demo needs first. Real bundles start landing in `dreams/` on Ojasva's Mac tonight once HiPerGator is back.
3. **Hands-only, no controllers** (the WebXR app now works this way; copy the feel): pinch to grab, release to
   drop; buttons pressed by pushing an index fingertip through them, firing once per push (not repeatedly while the
   finger rests there); a long pinch (~0.9 s) on empty space re-places things. Reference: `apps/webxr/src/chess/game.ts`
   (`XrButton`, `handOccluder`).
4. **Real hands in front of virtual things:** in passthrough, render the tracked hand mesh depth-only (a material
   with colour writes off, drawn first) so your real fingers stay visible in front of a person or object you reach
   past. Meta's hand mesh + a `ColorMask 0` shader does it in Unity.

## Decisions (Ian, apps/quest)

- **Unity 6000.6.0f1**, not 2022.3: the VR Gaussian renderer needs Unity 6000.3 or later.
- **Replays load at runtime, not through editor import.** `DreamSequencePlayer` reads `frames/*.ply` from the
  headset's storage, StreamingAssets or the bridge, keeps every frame on the GPU in full float precision (72 B per
  Gaussian per frame at SH degree 1) and swaps frames through the renderer's deformation hook: no uploads while playing.
  SPZ (`SpzFrameReader`, the exact inverse of `write_spz`) uses the same path; `Auto` picks PLY when every frame is
  there, else SPZ. Verified against the sample's frame 0: identical up to SPZ quantization.
- **GPU budget:** 121 frames x 300k Gaussians is about 2.5 GB. The player refuses anything over its budget (3 GB for
  now) and logs the per-frame cap that fits; the real Quest 3S number comes from item 8.
- **Delivery size:** a 121-frame PLY replay at 300k is about 9 GB, too big for Wi-Fi to the headset, so real
  bundles reach the Quest as SPZ; PLY stays for development and editor checks.
- **For Ojasva (SPZ fidelity):** the export writes SPZ at SH degree 0, so the Quest loses view-dependent colour that
  the PLY has; `write_spz(..., sh_degree=1)` adds 9 bytes per Gaussian and the reader already handles it. On the
  sample, 0.3% of colour values sit outside SPZ's range and get clamped (very bright or saturated spots).
  Also, `gaussiansPerFrame` is the first frame's count, not the largest (sample: 13,527 vs 16,768); the player
  copes by reloading, but the true max saves a reload.

## Update (Fri 9:10 PM): sequence player in, next is SPZ

The sequence player is exactly right (runtime loading, everything resident, no uploads while playing). Your own
numbers make the next step obvious: **the runtime SPZ reader is now item 1.** A 121-frame PLY replay is about 9 GB;
the same replay as SPZ is about 2-3% of that and decodes into the same GPU buffers. Format: `write_spz` in
`pipeline/lucid/gaussians.py` (gzip, header, then positions as 24-bit fixed point, alpha u8, colour u8, log-scale u8,
rotation xyz u8). `samples/synthetic-test/frames/*.spz` is test data. After that: hands (pinch to pause, grab to
move) and the avatar player below.

### Avatars skin live in WebXR now: copy the maths

`apps/webxr/src/avatar.ts` plays avatar bundles with GPU skinning and matches Vishal's Python reference to 1e-6.
What makes it simple, and what to do the same way in Unity:
- Rest = identity for every bone. Each frame, hand each bone the whole skinning transform
  `M_j = G_j [I | -rest_j] + root_t` (`skinTransforms()`), so the shader is just "blend 4 bone transforms per Gaussian".
- Dual-quaternion blend (no candy-wrapper wrists); rotate each Gaussian's own rotation by the blended rotation.
- Blend between motion frames (slerp per joint) so 30 fps motion is smooth at 72-90 Hz.
- Until your skinning works, Vishal's `python -m lucid_avatars bake dreams/<id>` turns an avatar into a normal frame
  sequence your sequence player already plays.

## Decisions: hands (Ian, Fri night)

- Same feel as the WebXR app: pinch 1.8 cm on / 3 cm off; quick pinch = play/pause; long pinch (0.9 s) re-places,
  pointing along your eye ray to the floor (a person can't land at arm's length); fingertip buttons fire once per push.
- Grab = pinch on the person (within 45 cm of their axis): drag moves along the floor, two hands turn. A grab counts
  from where the pinch began, so nothing is lost while it decides between tap and drag.
- The control bar floats low in front of you (fingertip reach) rather than beside the person 1.5 m away; it follows
  lazily. Placeholder glass styling (`GlassUI`) until Atina's mockups.
- Hand occlusion: depth-only spheres and capsules on the tracked joints, drawn before the splats (which depth-test).
- `HandsCheck` (simulated hands, real scene) passes all gestures; not yet tried with real hands on the Quest.

## Decisions: reality check (Ian, Fri night)

- Loads `frames.reality` on the first push only (playback carries on meanwhile), into a second GPU sequence at the
  same Gaussian count; the player is the renderer's frame source, so on/off is instant and keeps the moment.
- Bar title while on: "N% seen by the camera · blue was imagined" from `metrics.seenFraction` (falls back to
  "Blue was imagined" when the bundle doesn't say). The button only appears for bundles that ship reality frames.
- Avatar bundles' `avatar.reality` is parsed; it gets used with the avatar player.

## Decisions: teach mode (Ian, Fri night)

- `Lesson` is a straight port of the WebXR one (same phases, turn = move length at 1x + 1.5 s, wraps after the last
  step) and owns the player's clock while it runs; steps outside the clip are trimmed.
- No `experience.json` yet: the plan is guessed from `intent` with the WebXR rules, so "teach me ..." still teaches.
- Step card at eye level, 0.95 m ahead and 0.42 m to your right, turned to your eyes; it moves when the person is
  placed in front of you. Back / Again / Next replace the speed button in a lesson; the bar sizes itself to its buttons.
- Tips are read by Android TextToSpeech (device voice; Again says the step again). Not yet heard on a real Quest.
- `place` sets placement once the plan loads; `facing` is now 1.8 m (the contract), was 1.5 m.
- Companion / watch / play modes: plain playback for now; chess stays in the WebXR app.

## Decisions: library (Ian, Fri night)

- Bridge address: `bridge.txt` in the app's storage (one adb line, see apps/quest/README.md) or the scene field.
  Ojasva / Raami: if the Mac's address changes, that file is the only thing to update.
- Downloads take SPZ + reality frames, plan, thumb, guide and audio (not PLY), into `<id>.part`, renamed when
  complete; `dream.json` is written last. Cached dreams play offline; launch replays the last one played.
- Checked against a static stand-in for the bridge (same paths as apps/web); not yet against the real bridge.

## Decisions: avatar player (Ian, Fri night)

- GPU skinning in a compute shader that writes straight into the renderer's float frame (one dispatch per display
  frame, no CPU readback); bone maths on the CPU in the bundle's right-handed space, exactly `skin_matrices`.
- Dual-quaternion blend like the WebXR viewer. Checked against a synthetic SMPL-X-layout avatar written with
  `lucid_avatars` itself: one-bone Gaussians match `skinning.py` to 0.001 mm; blended ones match a dual-quaternion
  blend of `skin_matrices` to 0.001 mm (linear blend differs by up to 3.5 cm at a bent elbow, by design).
- Avatars without skin.bin/skeleton.json show as "Soon" in the library (bake them into a replay meanwhile).
- Not yet run with a real DiGS avatar (dreams/test-avatar is on Ojasva's Mac) or on the Quest.

## Decisions: voice and captions (Ian, Fri night)

- Voice: Unity AudioSource (3D, log rolloff from 1.2 m) at mouth height, 8 cm in front of the face; resynced past
  0.12 s; quiet when paused, in your turn and below 1x. AAC decoded by Android MediaCodec (JNI) on the Quest:
  compiles and builds, but not yet heard on a real headset. No HRTF until Meta's XR Audio SDK is added.
- Captions: WebVTT parsed like captions.ts (tags stripped, HTML entities decoded, which the WebXR canvas doesn't
  do: Atina's captions.py escapes `&`), quiet pill at 60% height, 0.42 m toward you.

## Decisions: props (Ian, Fri night)

- Ball maths ported line for line from props.ts (sample, bounce rule, fade, jump fade, backspin, shadow). Opaque when
  whole, a transparent copy only while fading, so it sorts right against the person.
- Built under the person's transform, so props share its handedness mirror and every placement. Checked on a test
  track: exact on frames, on the curve between, fades across nulls, never under the floor, rim at 3.05 m.

## Decisions: Atina's in-headset UI (Ian, Sat early)

- Built to demo/quest-ui/README.md's tokens, sizes and copy. Left out: the optional search and the category chips
  from the concept board (no categories in the data yet). No hand haptics exist, so seeks confirm with an audio tick.
- Previous / Next step through a lesson, otherwise move to the previous / next person on the headset (the brief's
  "next person"). Again stays in lessons. All eight controls fit one 0.82 m row; it wraps only if they don't.
- Checked headless (every HandsCheck run passes with the new controls); not yet seen at headset distance on a Quest.

## Decisions: Places (Ian, Sat early)

- Same places, ids, order and "column straight ahead" as places.ts; the panoramas stay once in apps/webxr and are
  converted to textures by Set Up Project (Unity can't import WebP), so nothing is duplicated in git.
- Grounded sphere built like three.js's GroundedSkybox (30 m, floor flattened at 1.6 m below the panorama's camera).
- Passthrough (ARCameraManager) is off while a place is fully in, saving the camera feed's cost; the hand stand-ins are
  off too (with passthrough off they would cut holes showing the panorama instead of your hand).


## Decisions: seated people (Ian, Sat)

- Read from the Gaussians, not from a new contract field: each frame's lowest point, top, torso axis and seat (where
  the torso column ends going down) are measured on the decode thread, and the median over frames is used. A
  per-frame lift would make them bob whenever a foot moved.
- Seated only when the plan or sentence asks for it (`experience.objects` bench / chair / piano..., or sit / piano /
  cello / drums in the intent) and the shape agrees (under 1.45 m tall from the lowest point). A standing person
  asked to sit stays standing.
- No legs below the hips: hips go to 0.48 m (a piano bench). Legs there: the bundle's floor stays on yours and the
  bench goes at their own seat height. Bench only if the reconstruction has almost nothing under the seat.
- Not applied to avatars (their rest pose stands). A `bench` kind in props.json, if the pipeline adds one, would
  draw a second bench; we'd drop ours then.
- Checked headless on two synthetic pianists (legs, no legs) and every earlier check; not yet on a real seated
  reconstruction (piano-han) or on a Quest.
