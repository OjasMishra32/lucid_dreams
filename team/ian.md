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
| Sat 8 PM | Controls, library from the bridge, avatar playback, polished in-headset UI (Raami designs it, you build it) |
| Sun 10 AM | Frozen, demo-proof, works offline from cached bundles |

## Talk to

- Ojasva: bundle format, Gaussian counts, compression if files are too big.
- Vishal: avatar rig and motion format.
- Raami: in-headset UI design, matching the web app's look.
