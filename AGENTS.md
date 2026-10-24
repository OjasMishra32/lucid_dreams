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

**The main goal, in one line: any photo or video in, plus one sentence of what you want to do with that person, and
they're in your room doing it with you.** A guitar teacher's clip + "teach me this strum" becomes a lesson (each step
slowed down, then your turn). A grandparent's photo + "I just want to sit with her" becomes a quiet companion. A
player's photo + "play chess with me" sits them across a board. The sentence is the `intent`; Gemini turns intent +
clip into `experience.json` (Contracts, "Experience"); every player runs it. Everything else serves this.

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
   Public figures appear for the demo only, from their real footage or a freely licensed photo (credited): never
   clone their voice, never have AI speak as them, and always label them (e.g. the chess legends are "Stockfish at
   X's peak rating. Not affiliated."). Never use a public figure's likeness to suggest they endorse us.
6. **Honesty:** generated content (the sides and back a camera never saw) can be revealed with a "seen vs imagined"
   toggle. We never present generated detail as real.
7. Stay in your lane: each area below has one owner. Change a contract (bundle format, API) only after telling everyone.

## Work without waiting (everyone)

- **Decide inside your own area. Don't wait for anyone, Ojasva included.** Write the decision in your brief and move on.
  Only changes to a shared contract (bundle format, job API, coordinates) need a one-line heads-up in the Status log first.
- **Never block on real data.** `samples/synthetic-test/` is a real dream bundle in the repo (4 frames, SPZ + one PLY,
  preview, thumb). Copy it to `dreams/synthetic-test/` and build against it. `python -m lucid.synthetic` (in `pipeline/`)
  makes a multi-view moving person with cameras, for anyone who needs views + cameras.
- **Getting clips into the pipeline:** AirDrop or copy them to Ojasva's Mac into `~/Downloads/lucid-clips/`. An
  autopilot there submits them, and finished dreams appear in `dreams/` and in both web apps. Nobody has to be awake.
- **When you finish something:** push, add one line to the Status log, then take the next item in your brief's backlog.
  Backlogs are ordered: top item first.

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
  voice.m4a              optional, the speaking voice alone (separated from music and noise); players prefer it
  frames/000000.ply ...  replay: one Gaussian file per frame (3DGS PLY; may switch to compressed later)
  avatar/avatar.ply      avatar: Gaussians in the rig's rest pose
  avatar/motion.json     avatar: the motion to play
  avatar/skin.bin        avatar: per-Gaussian skinning, 4 joints x uint8 index + uint8 weight (sum 255)
  avatar/skeleton.json   avatar: SMPL-X rest joints + parents (see avatars/README.md for how to pose)
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
`"avatar": { "file": "avatar/avatar.ply", "rig": "smplx", "motion": "avatar/motion.json", "skin": "avatar/skin.bin",
"skeleton": "avatar/skeleton.json" }`, plus optional `"reality": "avatar/reality.ply"` (the same Gaussians, what the photo
didn't see tinted blue; players skin it identically for the "seen vs imagined" toggle).

Optional in any bundle: `"captions": "captions.vtt"` (WebVTT of what the person says, times in the clip's own time; Atina's
`pipeline/lucid/captions.py` writes it, players show it beside the person).

`motion.json`: `{ "fps": 30, "betas": [10 floats], "frames": [ { "root_t": [x,y,z], "root_q": [x,y,z,w],
"pose": [55 x 3 axis-angle, SMPL-X joint order] } ] }`

### Experience (what you do with the person: `experience.json`, optional in any bundle)

`dream.json` carries `"intent"` (the user's sentence, or null) and `"experience": "experience.json"` once the plan
exists. Gemini writes the plan on the bridge (Raami) from the intent and the clip; players run it (WebXR: Ojasva,
Quest: Ian). Unknown fields are ignored, so it can grow.

```json
{
  "intent": "teach me this strum",
  "mode": "teach",
  "title": "Down, down-up: a first strum",
  "summary": "One sentence on what they're doing.",
  "place": "ahead",
  "steps": [
    { "start": 0.0, "end": 1.6, "title": "Rest the wrist", "tip": "Let it hang loose over the sound hole.", "speed": 0.5, "repeat": 2 }
  ],
  "play": { "game": "chess", "strength": "carlsen" }
}
```

- `mode`: `teach` (steps: each plays at `speed`, `repeat` times, then the person freezes for your turn, then the next
  step), `companion` (they're simply with you: idle, voice, captions), `watch` (plain playback), `play` (`play.game`:
  `chess`, `strength` one of club, expert, master, gm, fischer, carlsen, max).
- `place`: `facing` (1.8 m in front, facing you; default), `beside` (at your side, facing your way: copy them),
  `ahead` (1.5 m ahead, facing away: follow them like a teacher at the front of a class).
- `steps[].start/end`: seconds in the bundle's own clip time (0 = the bundle's first frame, after `startS`).
- Tips are read in the device's voice, never the person's.

The drop folder takes an intent too: a `.txt` with the same name next to the clip or photo
(`guitar-teacher.mp4` + `guitar-teacher.txt`).

### Job API (the bridge on Ojasva's Mac; Raami builds it, Ojasva wires it to HiPerGator)

| Call | Body / reply |
| --- | --- |
| `POST /api/jobs` | multipart: `file` (clip or photo), `name`, `kind` = `replay` or `avatar`, optional `startS` (seconds: where the 5-second window starts in a long clip), optional `intent` (what to do with them; pass to the runner as `--intent`) -> `{ "id" }` |
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
- Fri 10:15 PM, Ojasva: avatar environment (DiGS-Avatar) built on HiPerGator with public weights; gsplat runs on L4s too (about 290 more GPUs for reconstruction). Seen-vs-imagined frames + seenFraction in every replay. Still blocked: SMPL-X download (stalled in Safari), DINOv3 access.
- Fri 11:00 PM, Ojasva: runner submits avatars too (`--kind avatar`, photo -> Vishal's DiGS job). `startS` approved in the job API. Sample bundle committed at samples/synthetic-test. Every brief now has a long self-serve backlog.
- Fri 8:30 PM, Vishal: avatar bundles now carry `avatar/skin.bin` + `avatar/skeleton.json` (format and posing maths in avatars/README.md; reference LBS in `lucid_avatars/skinning.py`). Ian: that's everything your player needs to pose `avatar.ply` with `motion.json`.
- Fri 8:45 PM, Ojasva: SMPL-X downloaded; installing as soon as Vishal re-logs in (the Mac lost Wi-Fi and the HiPerGator connection dropped). First real runs queued: a free-licensed 4K jump-shot clip (Pexels) x2. Vishal's fine-tune, skinning and blinking are in.
- Fri Oct 23, 8:24 PM ET, Atina: first-milestone capture and handoff kit completed in demo/ (three shot plans, source-quality checklist, clip register, family consent request and private-evidence tracking); actual clips, transfer, family selection and sent consent request remain unconfirmed.
- Fri 8:49 PM, Vishal: avatar jobs ready for Ojasva (avatars/README.md): `digs-finetune.sbatch RUN_ID=<replay run>` is the research table (one photo vs fine-tuned on 4DAnyone views, held-out PSNR/SSIM/LPIPS); `digs-perform.sbatch` is "you, perfected" (any avatar plays a run's GVHMR move). Note: 4DAnyone's gvhmr/ motion is in GVHMR's own frame, not cameras.json's world; `avatars/gvhmr_motion.py` converts it with 4DAnyone's own transform.
- Fri 8:53 PM, Vishal: avatar bundles now report `metrics.seenFraction` too (share of the avatar the photo really saw; the rest is DiGS's imagination), so the web app's seen % works for avatars. `python -m lucid_avatars bake dreams/<id>` turns an avatar into a replay bundle (.ply + .spz frames) for players that can't skin yet.
- Fri 9:00 PM, Ojasva: chess side mode pushed (`?mode=chess` in apps/webxr: hands only, fingertip buttons, real hands occlude pieces, Stockfish 19 from Club 1400 to full strength incl. Fischer/Carlsen peak ratings, labelled not affiliated). Autopilot now chains Vishal's `digs-finetune` onto each jump-shot run (queue `then` jobs). HiPerGator still waiting on Vishal's login after his exam.
- Fri 9:05 PM, Ian: Quest replay sequence player in apps/quest: loads every PLY frame at runtime (device storage, StreamingAssets or the bridge), all frames resident on the GPU in float precision, frame swaps with no uploads; play/pause, 0.25/0.5/1x, scrub. Verified in a headless playback check (30 frames at 25 fps, correct facing and handedness) and an APK build; not yet run on the Quest. GPU cost is 72 B per Gaussian per frame, so 121 x 300k is about 2.5 GB. Next: runtime SPZ loading.
- Fri 9:05 PM, Ojasva: WebXR viewer skins avatar bundles live (Spark dual-quaternion splat skinning; matches skinning.py to 1e-6). New optional bundle field `captions` (WebVTT). Atina now owns captions (whisper.cpp) and old-footage restoration (Real-ESRGAN, no face models). Chess opponents are consenting teammates' avatars only; legends stay engine ratings.
- Fri 9:04 PM, Vishal: HiPerGator login is back. Avatar jobs, in order: (1) clone this repo to `$L/repos/lucid_dreams` if it isn't there, then `sbatch avatars/hpg/digs-assets.sbatch` from it (CPU; its `ASSETS_OK` unblocks autopilot's jump-shot fine-tunes); (2) `digs-sample.sbatch` with Vishal's head-to-toe photo, `ID=vishal` (the chess opponent and "you, perfected" subject; checks the whole DiGS path); (3) `digs-finetune` runs itself via autopilot; (4) `digs-perform.sbatch AVATAR=$L/data/avatars/dreams/vishal.work/code.pt RUN_ID=jump-shot ID=vishal-jumper`. Exact commands and what to check: avatars/README.md.
- Fri 9:06 PM, Ian: Quest runtime SPZ loading: the sequence player now plays SPZ bundles (what the bridge serves) as well as PLY, auto-picking PLY when every frame is there. samples/synthetic-test plays (4 SPZ frames); decode matches the PLY up to SPZ quantization. Ojasva: SPZ is written at SH 0 (Quest loses view-dependent colour; sh_degree=1 costs 9 B/Gaussian and is already supported), and gaussiansPerFrame is frame 0, not the max (13,527 vs 16,768). Notes in team/ian.md. Not yet run on the Quest.
- Fri 9:30 PM, Ojasva: hands-only WebXR viewer (fingertip bar: pause, speed, reality check, bring here; quick pinch = pause, held pinch = bring them in front of you; real hands occlude the person). Captions show beside the person (and as subtitles on a laptop) when a bundle has `captions`. New drop folder: a consenting person's photo in `~/Downloads/lucid-photos/` on Ojasva's Mac becomes an avatar automatically. Chess linked from the library.
- Fri 9:40 PM, Ojasva: fixed: fetching an avatar left out its `avatar.ply` (the fetch skipped every PLY; now only replay frames). Avatar bundles now carry Vishal's `reality.ply` as `avatar.reality`, and the viewer's Reality check works on avatars (skinned identically, with the seen %). Vishal: nothing to change on your side.
- Fri 9:22 PM, Ian: Quest hands-only controls in apps/quest: quick pinch play/pause, pinch-drag the person along the floor, two hands turn, long pinch re-places where you point, a control bar in reach with fingertip buttons (once per push) and a pinch-drag timeline, real hands occlude the person, soft contact shadow under the feet. HandsCheck (simulated hands, real scene) passes every gesture; APK builds; not yet tried with real hands on the Quest.
- Fri 9:45 PM, Raami: **heads-up for Ojasva, blocks exports.** pipeline/hpg/stage-export.sbatch: `read -r ID NAME FPS` splits on spaces, so any dream name with a space ("Jump shot", and most names from the web app) gives NAME=`"Jump` and FPS=`shot" 25`; export's `--fps` then fails after the GPU work. Reproduced in bash. One-line fix: put FPS before the name, `read -r ID FPS NAME` with `print(j["id"], j.get("fps", 25), json.dumps(...))` (read gives the rest of the line to the last variable).
- Fri 9:50 PM, Raami: heads-up, additive bundle change: the bridge writes `guide.json` (+ spoken `guide.m4a`) into each replay bundle and adds `"guide": "guide.json"` to its dream.json. guide.json = `{ move, category, summary, steps: [{ t, title, cue }], tips, narration, audio: "guide.m4a" | null, durationS, source, model, createdAt }`; step `t` is seconds into the motion (the frames' and preview.mp4's clock). Gemini watches the source clip (trimmed on the Mac to the rebuilt window) plus preview.mp4 and times steps on the preview; uploads are deleted from Gemini after. Ian: guide.m4a is AAC, play it in the headset. Needs `GEMINI_API_KEY` in apps/web/.env.local.
- Fri 9:50 PM, Raami: web app round two: the Gemini guide on dream pages (steps follow the preview, tap to jump, Listen), 1x/0.5x/0.25x, captions under the preview when a bundle has `captions`, Share with the Mac's LAN address; Make a dream picks the 5 seconds on a filmstrip (`startS`), checks "one person, head to toe" in the browser (MediaPipe pose), photos need a consent tick, HEIC is converted to JPEG, videos can't be sent as avatars; `kind` and `startS` reach the runner; Chess in the nav and "Play chess with them" on avatars; `npm run demo`; Lighthouse 98-100 on every page. Hardening from an adversarial review: run ids validated before the runner (shell injection over SSH), avatars fetched with their .ply, the library and /api/dreams only list complete bundles, guides never start on half-fetched bundles.
- Fri 9:50 PM, Raami: for Ojasva: (1) autopilot.py fetches every run without .ply, so avatars land without avatar/avatar.ply; the bridge repairs these when /api/dreams is listed in runner mode, but `with_ply=True` for avatars in autopilot would fix it at the source. (2) The root .gitignore's `dreams/` matches any folder named dreams (it hid two web routes); `/dreams/` anchors it. For Atina: the `--faint` token is now #7a7a7f (#6e6e73 failed 4.5:1 contrast on black).
- Fri 10:05 PM, Ojasva: **the main goal is now explicit** (top of this file): photo/video + one sentence of intent -> an experience. `intent` flows from the job API / runner `--intent` / drop-folder `.txt` into dream.json; `experience.json` contract added (teach / companion / watch / play; place facing / beside / ahead). The WebXR viewer runs teach mode (steps slowed and repeated, your turn, step card, Back / Again / Next) and play mode. Raami: Gemini writes experience.json (your top item now). Chess legends: Fischer's and Carlsen's avatars from freely licensed photos are queued.
- Fri 9:49 PM, Ian: Quest reality check: a Reality check button (fingertip) loads frames.reality on first push and swaps it in at the same moment; the bar reads "N% seen by the camera · blue was imagined" from metrics.seenFraction. HandsCheck passes (incl. load, same-frame swap, seen %, toggle back); APK builds; not yet run on the Quest.
- Fri 10:20 PM, Ojasva: **HiPerGator is back and the night is queued as one Slurm chain** (it no longer needs the Mac connected): SMPL-X installed; voice isolation installed (Demucs, torch 2.8 cu128 untouched); `digs-assets` queued; both jump-shot replays (views -> reconstruct -> export); Vishal's `digs-finetune` behind each export and the assets; Bobby Fischer and Magnus Carlsen avatars behind the assets.
- Fri 10:24 PM, Ian: Quest teach mode: runs experience.json (or the intent fallback) like the WebXR Lesson: steps at speed x repeat, your turn frozen in the last pose (move length + 1.5 s, blue bar), next step, wrap; step card at eye level right of the person; steps spoken by Android TTS; Back / Again / Next on the bar. Placement by place: facing 1.8 m, beside, ahead. HandsCheck passes (timing exact: turn at 1.60 s, next step at 3.50 s); APK builds; TTS not yet heard on a real Quest.
- Fri 10:45 PM, Ojasva: queue now runs 12 GPUs per replay (all 24 of the group's GPUs fit after right-sizing jobs). Processing: jump-shot, jump-shot-2, lebron-jumper (intent: teach me this jump shot); Buster Keaton 1920 and Josephine Baker 1928 (public domain) via `lucid.find_windows`. Fixed: 60 fps clips gave 2 s of motion and 30 fps clips played slow (clip prep resamples to 25 fps now); failed runs that get resubmitted now come home. Avatars wait on Meta's DINOv3 weights (watcher re-queues them).
