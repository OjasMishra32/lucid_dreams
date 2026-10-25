# Ojasva: pipeline lead and HiPerGator operator

You (with Claude Code) own everything that runs on HiPerGator and the hand-off to the apps. You are the only person
who submits GPU jobs. Read `AGENTS.md` first.

## FIRST, Sun Oct 25 (Vishal): put Court Side on the website

**Done Sun 6:25 AM:** live at https://getluciddreams.vercel.app/xr/?mode=court, with a Court Side card on the site (Status log).

Vishal wants Court Side (his feature, `?mode=court`) live on **https://getluciddreams.vercel.app/xr/?mode=court**.
The site and `/xr/` run on your Mac and your Vercel, so only you (or your Claude) can do this. He has approved it
going public. Today it runs on Vishal's Mac behind a quick tunnel; that link only works while his Mac is up.

1. **Stopgap (2 min, do it now):** a "Court Side" link or button on the site that opens Vishal's live link. Ask
   Vishal for the link (it carries an access token, so it's not written here).
2. **The real thing:**
   - **The code:** branch `court-on-site` = `main` + `court-side`, with Court Side working under the `/xr/` base. It
     defaults to the Screen view and seats the judge by itself.
     - `git fetch origin court-on-site`. Vishal's loop session is preparing it; if it isn't on origin yet, wait for
       it or merge `origin/court-side` (7ba5060) into `main` yourself.
     - Check chess, tennis and the replays still load, then merge into `main` (your call: you own `main`).
   - **The bundle (290 MB, not in git):** one tar served through Vishal's tunnel at `<his link host>/bundle/court-side.tar`.
     It needs his token, so first visit `https://<host>/?k=<token>` to set the cookie, then:
     ```bash
     J=$(mktemp); curl -s -o /dev/null -c "$J" "https://<host>/?k=<token>"
     mkdir -p apps/webxr/public/court && curl -sS -b "$J" "https://<host>/bundle/court-side.tar" | tar -x -C apps/webxr/public/court
     ```
     Keep `apps/webxr/public/court/` git-ignored (the branch adds it to .gitignore; check before any commit). Or
     AirDrop it from Vishal: `~/court-side-data/luka/bundle/headset-test/court-side/`.
   - **Build and check:**
     - Run `~/LucidDreams-held/rebuild-stable.sh`. The court then serves at `/xr/court/`, which is Court Side's
       default bundle path under that base.
     - Open https://getluciddreams.vercel.app/xr/?mode=court: the loading bar, then Enter, then the video on the big
       screen, then it steps into 3D by itself. On a laptop add `&emulate` (dev build only); in the Quest use the link
       as is.
   - **Tell Vishal** when it's live.

## Unblock right now (only a human can do these)

1. **SMPL-X** (needed by 4DAnyone and by Vishal's avatars): make a free account at https://smpl-x.is.tue.mpg.de/,
   accept the license, download `models_smplx_v1_1.zip`, and drop it in `~/Downloads`. Claude copies it to
   HiPerGator and installs it.
2. **Hugging Face:** request access to `facebook/sam3` and `facebook/dinov3-vitb16-pretrain-lvd1689m` (Meta approves by
   hand; it can take hours). Then make a read token and log in on HiPerGator yourself when Claude opens the prompt.
3. **Test clips:** get Atina's first 3 clips (4K or 1080p, portrait, 5+ s, one person, tripod) into `~/Downloads/lucid-clips/`.
4. **GitHub:** create the public repo `lucid-dreams` (MIT) or tell Claude to; no AI co-author on any commit.
5. Keep the Mac **plugged in, awake and online** while we submit jobs and move files. Jobs already running on
   HiPerGator don't need the Mac.

## Photoreal everywhere (Sat 1:40 AM): the bar for every person we show

Ojasva's bar: every person, in every scene, should look like a real person standing there, as real as he looks
in person. Nothing creepy reaches the library: `dreams/.held` keeps a dream out (the autopilot skips it) until its
truth-vs-render strip and a front and side check pass. Where each run loses realism, and the fix:

| Where | What was wrong | Fix | State |
| --- | --- | --- | --- |
| Views (4DAnyone) | Every run so far was 4-step Turbo: the flag we passed (`--turbo`) doesn't exist, it's `--enable_turbo` | Base model, 50 steps | Fixed; all four clips re-running as `<id>-hq` |
| Views resolution | 704x1280 views from a 4K clip; the face is ~70 px tall | SeedVR2 video upscaling, 2x (`stage-upscale.sbatch`, ready) | Views 6-9x sharper and steady in time, but fine texture is invented differently per view; not adopted until the 3D A/B on held-out views says sharper and clean |
| Real frame | The sharpest data we have (4K) isn't used in training | Solve the source camera (silhouette + colour over all 48 ring cameras), train on a crop of the real frame | Done: 38-42 dB against the real 4K frame; on by default (`sourceView`); seen-vs-imagined now uses the real camera |
| Reconstruction | Needle-shaped Gaussians: right from trained views, streaks from the sides | Stretch penalty (`--aniso`), A/B on held-out views | A/B running; HQ runs use 0.05 until it reports |
| Every run | Only PSNR, no look | `peek-*.jpg`: truth beside render, front, sides and back, for every chunk | Done |
| Previews | Orbit aimed at frame 0's spot, so a moving person drifts out; 720p | Orbit follows the person; 1080x1920 | Done |
| Photo people | Face guessed from ~60 px; B&W recolour painted skin flat; dead eyes | LAM head (one photo -> real 3D head), DDColor on the photo, idle life (blink, breathing, gaze) | LAM building; head swap and idle life with Vishal |
| In the headset | Brighter or bluer than the room; low resolution; floating feet | Room-matched light, 1.3-1.5x eye buffer, contact shadow, eye contact | Ian |

## What you own

| Piece | Done means |
| --- | --- |
| 4DAnyone stage | Any good clip becomes 24-48 consistent views plus cameras on a B200 or RTX PRO 6000 |
| Reconstruction stage | Views become per-frame Gaussian people (replay), sharp faces and hands, no floaters |
| Export stage | A dream bundle exactly as `AGENTS.md` specifies, plus `preview.mp4` and `thumb.jpg` |
| Job runner | Bridge on the Mac rsyncs a clip in, submits the chain, reports stage and progress, rsyncs the bundle out |
| Fidelity metrics | PSNR, SSIM, LPIPS on held-out real frames, sharpness vs source; numbers in `dream.json` |
| GPU plan | 4-8 GPUs working at once over the weekend, nothing idle, lab storage under 100 GB |

## Fidelity plan (the reason we win)

1. Input quality first: 4K portrait, fast shutter, tripod, bright light (Atina's capture guide).
2. 4DAnyone-**Base** (50 steps) for hero clips; Turbo only for quick previews.
3. 48 views over 3 pitch rings (`--views_per_layer 16 --layer_pitches '[-10,15,35]'`).
4. Keep the **real camera frames** as an extra, highest-weight view in reconstruction: they're the sharpest data we have.
5. Upscale the generated views if they come out softer than the source (test before adopting).
6. Reconstruct frame by frame, each frame **warm-started from the previous one**: faster, and it stops flicker.
7. A dedicated face and hands refinement pass at higher resolution.
8. Every change gets a number: keep a table of settings vs PSNR, LPIPS and sharpness.

## GPU plan (adjust to what's free)

| GPU | Job |
| --- | --- |
| 1-2 | 4DAnyone generation queue (hero clips at Base settings) |
| 3-6 | Reconstruction: frames split across GPUs, embarrassingly parallel |
| 7 | Vishal's avatar fine-tuning runs |
| 8 | Live demo queue during judging |

## Status (Claude keeps this current)

- Workspace `/blue/iruchkin/vishalnaveen/lucid` ready. 4DAnyone env built (PyTorch 2.8 cu128) and its weights downloaded.
- First GPU test reached the model and stopped only because SMPL-X isn't installed (see step 1 above).
