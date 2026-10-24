# Ian: the Quest app

You own what people actually see: photoreal people standing on the real floor in Meta Quest 3S passthrough,
moving smoothly at full frame rate. Read `AGENTS.md` first.

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

