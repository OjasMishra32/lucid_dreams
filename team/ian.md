# Ian: the Quest app

You own what people actually see: photoreal people standing on the real floor in Meta Quest 3S passthrough,
moving smoothly at full frame rate. Read `AGENTS.md` first.

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
  The same loader takes SPZ next (backlog item 2).
- **GPU budget:** 121 frames x 300k Gaussians is about 2.5 GB. The player refuses anything over its budget (3 GB for
  now) and logs the per-frame cap that fits; the real Quest 3S number comes from item 8.
- **Delivery size:** a 121-frame PLY replay at 300k is about 9 GB, too big for Wi-Fi to the headset. Real bundles
  reach the Quest as SPZ once the runtime SPZ reader lands; PLY stays for development and editor checks.

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
