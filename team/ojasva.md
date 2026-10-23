# Ojasva: pipeline lead and HiPerGator operator

You (with Claude Code) own everything that runs on HiPerGator and the hand-off to the apps. You are the only person
who submits GPU jobs. Read `AGENTS.md` first.

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
