# Lucid Dreams: full context for every teammate and every coding agent

Read this whole file before doing anything. Then read your own brief in `team/<name>.md`.
If you are an AI agent (Codex, Claude, Cursor): this file is your ground truth. Follow the rules below exactly,
stay inside your owner's area, and never change another area's contract without telling its owner.

## What we are building

**Lucid Dreams turns any video or photo into photoreal, life-size 3D people standing in your room.**
Drop in a Steph Curry workout clip, an old family photo or your own phone video. A minute or two later they
stand in your Meta Quest 3S passthrough, moving exactly like the footage. Walk around them, freeze them, slow
them down, and learn the move from them.

Tagline: *Anyone from any video, standing in your room.*

The name comes from lucid dreams: people who feel real enough to be in the room with you, and you're in control.

## The bar: extreme fidelity

The whole project lives or dies on how real the people look. **No blur, no floaters, no mushy faces or hands.**
Target: indistinguishable from the footage at 1.5 m in the headset. We spend compute on quality, not savings.
Measured, not claimed: PSNR, SSIM and LPIPS against real held-out frames, plus render sharpness (variance of the
Laplacian) against the source video.

## The event

- **Gator Hack V** (UF AI Days 2026), Newell Hall, University of Florida. Devpost: https://gatorhack2026.devpost.com/
- Hacking: **Fri Oct 23, 5 PM to Sun Oct 25, 5 PM ET**. Late submissions are not accepted. We submit by **Sun 3 PM**.
- Finals: top 10 teams demo live **Mon Oct 26, 10:15 AM**, Reitz Union. Winners at 12:15 PM.
- Judges: UF graduate students and faculty. Criteria: **Impact, Technical Execution, Design & Usability,
  Presentation & Demo.**
- **Theme, "Fresh off the frontier":** the central technology must have been made public within the last
  12 months. We must show what it does, the difficulties we hit, and why it is recent.
- Submission: title, description, **public repo**, demo video (3 min max), full roster, tracks chosen.

### Prizes we go for (one project can win several)

| Prize | How we qualify |
| --- | --- |
| 1st / 2nd / 3rd overall ($2k / $1k / $500) | Theme fit, fidelity, polish, live demo |
| Best AI Hack | The whole pipeline |
| Best Design | Apple-quality web app and in-headset UI |
| Best Social Impact | Family members brought back into the room; learning movement at home |
| MLH Best Use of Gemini | Gemini as the guide: names the move, splits it into steps, talks you through it |
| MLH Best Open Source | Public GitHub repo, MIT license, a real README |

We do **not** enter the Twinly API prize (conflict of interest: it's Ojasva's company).

## Rules (non-negotiable)

1. All project code is written during the hacking period. Open-source models and libraries are fine; credit them in the README.
2. Repo is public, MIT licensed.
3. **Commits:** plain messages about Lucid Dreams only. **No AI co-author trailers** (no "Co-Authored-By: Claude",
   no "Generated with"). **Never mention any previous hackathon project** anywhere in the repo or commits.
4. Never commit secrets (Hugging Face tokens, API keys) or big binaries (model weights, raw videos, Gaussian files).
   Use `.gitignore`; large assets live on HiPerGator or in a shared drive.
5. **Consent:** photoreal likeness and any voice only for people who agreed (team, family who said yes).
   Public figures (e.g. Steph Curry clips) appear for the demo only: never clone their voice or have AI speak as them.
6. **Honesty:** generated content (the sides and back a camera never saw) can be revealed with a "seen vs imagined"
   toggle. We never present generated detail as real.
7. Stay in your lane: each area below has one owner. Change a contract (bundle format, API) only after telling everyone.

## Team

| Person | Owns | Brief |
| --- | --- | --- |
| **Ojasva** | Pipeline lead and the only HiPerGator operator (runs every GPU job, with Claude Code) | `team/ojasva.md` |
| **Vishal** | Avatars: animatable photoreal people, motion retargeting, family-photo people | `team/vishal.md` |
| **Ian** | Quest app (Unity): photoreal people in passthrough, playback, interaction, frame rate | `team/ian.md` |
| **Raami** | Product app: Apple-style web app, the job API bridge, Gemini guide | `team/raami.md` |
| **Atina** | Story, data and demo: clips, consent, in-headset UI design, Devpost, video, slides, README (light compute) | `team/atina.md` |

Owners are a proposal; swap if skills fit better, but keep one owner per area.

## How it works

```
 any clip / photo
      |
      v
 Web app (Raami) --upload--> Bridge API on Ojasva's Mac --rsync + sbatch--> HiPerGator (Ojasva)
                                                                            1. check clip
                                                                            2. 4DAnyone: one video -> 24-48 synced views + cameras
                                                                            3. upscale views (if it helps sharpness)
                                                                            4. 4D Gaussian reconstruction, frame by frame
                                                                            5. export a "dream bundle"
      +------------------------- dream bundle over HTTP <-------------------+
      v
 Quest app (Ian): the person on your real floor, life size, in passthrough

 Avatars (Vishal): photo or clip -> DiGS-Avatar -> fine-tuned on 4DAnyone's views -> rigged (SMPL-X) photoreal
 person that can do ANY motion (teach mode, "you, perfected", grandpa doing a new dance)
```

### Two kinds of people

| Kind | What it is | Strength | Owner |
| --- | --- | --- | --- |
| **Replay** | 4D Gaussian reconstruction of the clip itself | Exactly like the footage from every angle; plays that clip's motion | Ojasva |
| **Avatar** | Rigged photoreal Gaussian person | Can do any move; works from one photo | Vishal |

## Contracts (build against these so everything fits)

### Coordinates
Meters. +Y up. The person stands on the floor at y = 0, centred at x = z = 0. Their front faces -Z: a viewer standing
at (0, 1.6, -2) looking toward +Z sees their face. Never scale a person: the bundle is real size.
The Quest app and the WebXR viewer place that origin on the user's real floor.

### Dream bundle (HiPerGator output -> Quest app and web app input)

```
dreams/<id>/
  dream.json
  preview.mp4            orbit render for the web app card
  thumb.jpg
  audio.m4a              optional, the clip's sound
  frames/000000.ply ...  replay: one Gaussian file per frame (3DGS PLY; may switch to compressed later)
  avatar/avatar.ply      avatar: Gaussians in the rig's rest pose
  avatar/motion.json     avatar: the motion to play
```

`dream.json`:

```json
{
  "id": "curry-jumper-01",
  "name": "Steph's jumper",
  "kind": "replay",
  "fps": 25,
  "frameCount": 121,
  "durationS": 4.84,
  "units": "meters",
  "upAxis": "+Y",
  "bounds": { "min": [-0.6, 0.0, -0.5], "max": [0.6, 1.95, 0.5] },
  "frames": { "dir": "frames", "pattern": "%06d.ply", "spz": "%06d.spz", "gaussiansPerFrame": 300000, "spzBytesTotal": 520000000 },
  "avatar": null,
  "audio": "audio.m4a",
  "preview": "preview.mp4",
  "thumb": "thumb.jpg",
  "source": { "clip": "curry-jumper-01.mp4", "width": 2160, "height": 3840 },
  "metrics": { "psnr": null, "ssim": null, "lpips": null, "views": 48 },
  "createdAt": "2026-10-24T03:00:00Z"
}
```

Every frame ships twice: `.ply` (full quality, standard 3DGS layout, SH degree 1, for Unity import) and `.spz`
(about 10x smaller, colour only, for the web and streaming). The fetch step leaves out `.ply` unless asked.
Replays also ship `frames.reality` (`%06d.reality.spz`): the same frame with every Gaussian the source camera could
not have seen tinted blue, for the "seen vs imagined" toggle, and `metrics.seenFraction` (0-1, how much was really seen).

For an avatar, `kind` is `"avatar"`, `frames` is null and
`"avatar": { "file": "avatar/avatar.ply", "rig": "smplx", "motion": "avatar/motion.json" }`.

`motion.json`: `{ "fps": 30, "betas": [10 floats], "frames": [ { "root_t": [x,y,z], "root_q": [x,y,z,w],
"pose": [55 x 3 axis-angle, SMPL-X joint order] } ] }`

### Job API (the bridge on Ojasva's Mac; Raami builds it, Ojasva wires it to HiPerGator)

| Call | Body / reply |
| --- | --- |
| `POST /api/jobs` | multipart: `file` (clip or photo), `name`, `kind` = `replay` or `avatar` -> `{ "id" }` |
| `GET /api/jobs/:id` | `{ id, status: queued/running/done/failed, stage, progress 0-1, etaS, message }` |
| `GET /api/dreams` | list of `dream.json` objects |
| `GET /dreams/<id>/...` | the bundle's files, static |

Stages, in order: `upload`, `check`, `views`, `upscale`, `reconstruct`, `export`.
Until the real pipeline is wired, the bridge serves a sample bundle so the web and Quest apps never wait.

### Clips that work (4DAnyone's input rules plus our fidelity rules)

- One person, full body in frame, camera still (tripod), no big camera moves.
- **4K if possible**, at least 1080p, **portrait 9:16**, at least 121 frames (about 5 s at 25 fps), 60 fps preferred.
- Bright, even light; fast shutter (no motion blur); plain background; person fills most of the frame.

## Compute: HiPerGator

- Account belongs to Vishal (`vishalnaveen`), lab group `iruchkin`. Up to 24 GPUs (B200 ~180 GB,
  RTX PRO 6000 96 GB, L4 24 GB), 96 CPU cores, 750 GB RAM; burst queue 864 CPU cores (no GPUs).
- **Only Ojasva submits GPU jobs** (with Claude Code). Nobody else needs HiPerGator access.
- Workspace: `/blue/iruchkin/vishalnaveen/lucid/{repos,envs,models,cache,jobs,data}`.
- The lab's storage is nearly full (about 190 GB free): keep our footprint under 100 GB and delete intermediates.
- It's a research lab's allocation: run real work, never park idle GPUs, release them when done.

## The new tech, and why it counts as recent (say this to judges)

| Tech | Public since | What it does for us |
| --- | --- | --- |
| **4DAnyone** (Ant Research, SIGGRAPH Asia 2026), Apache-2.0 | Aug 2026 | The core: turns one casual video into consistent 360-degree multi-view video, so a single clip becomes a full 3D person |
| **DiGS-Avatar** (ECCV 2026), MIT | Jun 2026 | Photoreal, animatable Gaussian person from one image in under a second |
| **SAM 3D Body** (Meta), optional | Nov 2025 | Full-body, hands and feet 3D pose if we need better motion |
| **Gemini** (Google) | n/a | The guide (MLH prize) |
| GVHMR (bundled inside 4DAnyone) | 2024 | Supporting motion estimate |
| Unity Gaussian Splatting (Aras Pranckevicius; VR fork by ninjamode), MIT | 2023-24 | Rendering on Quest |

The research contribution we claim: **fine-tuning a one-photo avatar on 4DAnyone's generated views**, which turns a
single video into a photoreal person that can perform any motion. We report fidelity before and after.

## Timeline (ET)

| When | Done means |
| --- | --- |
| **Fri 11 PM** | 4DAnyone views for a test clip; one frame reconstructed; a static person visible in Quest passthrough; web app skeleton; bridge serving the sample bundle |
| **Sat 10 AM** | One full replay playing in the Quest; upload -> job -> bundle works end to end through the bridge |
| **Sat 2 PM** | Our own 4K portrait clips processed at hero settings |
| **Sat 8 PM** | Avatars animatable; family photo -> person; UI polished; Gemini guide talking |
| **Sun 10 AM** | Feature freeze. Film the demo video. Metrics slide done |
| **Sun 3 PM** | Devpost submitted (2-hour buffer before the 5 PM deadline) |
| **Mon 10:15 AM** | Finals demo if we're top 10 |

## Repo layout

```
AGENTS.md          this file (CLAUDE.md points here)
team/              one brief per person
pipeline/hpg/      Ojasva: sbatch scripts and stage runners for HiPerGator
pipeline/lucid/    Ojasva: reconstruction (per-frame, warm-started Gaussians), export, status (Python, runs on HiPerGator)
pipeline/runner/   Ojasva: lucid_runner.py, the Mac side (submit / status / fetch); the bridge calls it
avatars/           Vishal: avatar fitting, fine-tuning, motion retargeting
apps/quest/        Ian: Unity project
apps/web/          Raami: web app and the bridge API
apps/webxr/        Ojasva: WebXR viewer (Quest browser passthrough + desktop), Spark renderer
demo/              Atina: clip list, consent notes, Devpost text, video script, slides
samples/           a small sample dream bundle for development (kept tiny, or linked)
```

## Status log (append newest at the bottom: time, who, what)

- Fri 7:00 PM, Ojasva: HiPerGator workspace created; 4DAnyone installed (PyTorch 2.8, CUDA 12.8, for B200 / RTX PRO 6000); first GPU test run queued.
- Fri 8:30 PM, Ojasva: reconstruction trainer works (synthetic test on a B200: 32.5 dB PSNR on held-out views, SSIM 0.98; warm-started frames 27 s vs 105 s cold). Job chain views -> reconstruct (array, one GPU per chunk) -> export written. 4DAnyone blocked only on the SMPL-X download (in progress).
- Fri 8:45 PM, Ojasva: WebXR viewer in apps/webxr (Spark 2.4): library + viewer, life-size passthrough on the real floor via local-floor. Run: npm --prefix apps/webxr run dev, open https://<mac-ip>:5180 on the Quest.
- Fri 9:35 PM, Ojasva: export verified (synthetic person 1.73 m tall, feet on y = 0) and SPZ frames load in the WebXR viewer. Landscape clips now get a fixed 9:16 crop around the person automatically. Autopilot runs on Ojasva's Mac: drop clips in ~/Downloads/lucid-clips/ and they come back as dreams.
- Fri 8:00 PM, Raami: web app + bridge in apps/web on :5170 (landing, Make a dream with in-browser clip checks, live progress, library, dream pages with seen % and fidelity). Job API done; mock mode by default, BRIDGE_MODE=runner calls lucid_runner.py. Ian: GET http://<mac>:5170/api/dreams. Run: npm --prefix apps/web install && npm --prefix apps/web run dev.
