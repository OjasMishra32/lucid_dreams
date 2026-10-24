# Vishal: avatars (photoreal people that can do any move)

You own the **Avatar** kind of person: a rigged, photoreal Gaussian human built from one photo or one clip, that
can perform any motion. It powers "you, perfected", teach mode, and the family-photo moment. Read `AGENTS.md` first.

HiPerGator is your account, but Ojasva runs the batch GPU jobs. For development you can open an interactive GPU
session on your own login (one GPU, `--account=iruchkin --qos=iruchkin`), and hand finished scripts to Ojasva.


## HEADS-UP (Sat 5:10 AM): hands are locked in the headset

Ojasva tried everything on the Quest with hands only: gestures fired by accident ("a person will do a lot with
their hands so we need it to be locked"). In WebXR now: **no pinch or gesture changes anything by itself**; every
control sits on a palm-up menu on the left hand, pressed by the right index fingertip (`apps/webxr/src/xr/menu.ts`,
`HandMenu`), and placed things are pinned to the room with a WebXR anchor (`xr/anchor.ts`, `WorldLock`). Ghost
Coach's in-headset controls (start a try, replay the overlay) go on that menu too, never on a gesture or a button
floating where your arms move while you copy the move.

## TOP PRIORITY NOW (Sat 4:20 AM): Ghost Coach, approved

Your plan (`docs/plans/vishal-feature.md`) is approved as your main feature: film your try, and your own body doing
exactly what you did stands inside the teacher's replay; the joints where you differ glow; Gemini names the two
biggest fixes; "Show me right" plays your body doing it correctly. Build on what already works: Raami's Gemini Live
coach (the "Ask" button, `apps/webxr/src/coach.ts`, `/api/live/token`), your Watch me try and `/live`. Ship the
Remix fallback first, as you planned.

**Your two questions, answered:**
1. **No `vishal` avatar exists yet.** Build your learner body with LHM++: put 8-16 photos of yourself from one
   session (front, 3/4, side, one head-to-toe) in `$L/data/avatars/photos/vishal/`, then run
   `sbatch --export=ALL,NAME=vishal,TITLE="Vishal" avatars/hpg/lhmpp-avatar.sbatch` (L4, about 4 min; Magnus's
   took 9 s of inference) and `avatars/lhmpp_cleanup.py <bundle> --smplx $L/models/smplx/SMPLX_NEUTRAL.npz`. The
   cleanup caps hand Gaussians, re-skins the fingers and clears clothing specks.
2. **GVHMR can run on its own.** 4DAnyone bundles GVHMR, HMR2, ViTPose and YOLO weights
   (`$L/repos/4DAnyone/models/gvhmr/`). Its pose-conditioning step took ~80 s per clip on a B200 in our runs, and
   the entry point is `fdanyone/skeleton/pipeline.py`. A `pipeline/hpg/stage-gvhmr.sbatch` that writes only the
   motion (B200, 3 CPUs, 16G) is yours to add.

**Facts you'll hit:**
- **GPUs:** all 24 are busy with replays until about 5 AM. Ask for 3 CPUs and 16-20G (real use is ~5G).
- **Disk:** the lab has ~20 GB free; delete intermediates.
- **Hands** are the weakest part of every photo-built avatar. Keep them low and still in demos; the chess
  opponent no longer raises them.
- `GEMINI_API_KEY` is still missing from `apps/web/.env.local` on the bridge Mac, so ask Ojasva for it before
  testing the coach end to end.
- Ian's `ian-grandma-avatar` and `ian-grandma-avatar-head` exist on HiPerGator (held). Check them with Ian.

## DECIDED (Sat 3:30 AM): passthrough only; the web app drops Places

Ojasva: "the backgrounds are cooked; we only keep the passthrough." In the web app, remove the Places row from dream
pages and `?place=` from every link; the viewer ignores places now (`PLACES = false`).

## RESEARCH (Sat 2:50 AM): the models to use, checked against their repos and weights

- **Bodies: LHM++** (aigc3d/LHM-plusplus, 700M weights; code Apache-2.0, weights CC BY-NC 4.0). Takes 1-16
  pose-free photos or video frames and outputs ~160K Gaussians on SMPL-X, at 27.8 dB vs ExAvatar's 26.6 dB from 2
  views. Judge only its plain Gaussian render, never its neural refiner (the Quest gets Gaussians). Skin weights
  come from the nearest SMPL-X vertex. Being tested on Magnus now.
- **Heads: UIKA** (ant-research/UIKA, CVPR 2026 Highlight, MIT). A folder of photos becomes ~130K Gaussians on
  FLAME: 21.7 dB / identity 0.738 vs LAM's 18.3 / 0.602. FlexAvatar (TUM, CVPR 2026) is the backup with the best
  identity scores, but it's slower and needs Pixel3DMM tracking. LAM is retired (its repo is deleted to free disk;
  the heads it already made stay in `data/avatars/heads/`).
- **How to combine them (what went wrong with LAM):** never paste a head model's Gaussians onto a body; LAM's are
  a 25%-opacity shell that falls apart outside its own renderer. Use the head model as a teacher instead:
  1. Render its neutral head from 60-100 views in its own renderer.
  2. Delete the body's Gaussians above the neck seam.
  3. Start new Gaussians on the SMPL-X head vertices and fit them to those renders with gsplat for a few thousand
     steps, with a minimum opacity.
  4. Skin them from the nearest SMPL-X vertex.

  That gives a solid head. Your `head_swap.py` alignment (FLAME to SMPL-X) is exactly the first step of this; it's
  the obvious next version of your head swap, for Ian's grandma.
- **Avoid:** Pippo (no weights), Avat3r and HumanRAM (no code), and the single-photo full-body models (IDOL,
  AniGS, PSHuman: same class as DiGS).

## NEW (Sat 2:35 AM): LHM++ may replace the two-model chain; your bridge is up

1. **LHM++ is under test** (aigc3d/LHM-plusplus, March 2026, from LAM's lab). It builds one animatable full-body
   Gaussian person from many photos with no pose information; our problem so far is that DiGS (body) and LAM (face)
   each see one photo and get glued together. Ojasva's agent is testing it on Magnus with 6-10 photos from one
   2015 session; if it wins, it'll leave `avatars/hpg/lhmpp-avatar.sbatch` (photos folder in, our avatar bundle
   out). **If it wins, use it for Ian's grandma and your own avatar too**: same bundle format, several photos per
   person. Your head swap stays the fallback, and your idle loop and `expr.bin` work on any SMPL-X bundle.
2. **Your bridge and site are running** on Ojasva's Mac: :5170 (runner mode, `LUCID_DREAMS_DIR` set) and :5190.
   Fixed on the way: Next 16 wrote `apps/web/AGENTS.md`, which made the bridge look for dreams in `apps/web`
   (`agentRules: false` in next.config now). Still missing: `GEMINI_API_KEY` in `apps/web/.env.local`.

## TAKEN OVER FROM RAAMI (Sat 2:25 AM): the web app, the bridge, the Gemini guide and the site are yours too

Ojasva moved Raami's area to you: `apps/web` (product app + the job API bridge on Ojasva's Mac), the Gemini
steps, and `apps/site`. Read `team/raami.md` for the design bar (Apple-level, calm, one accent colour) and how
it's built; his status-log lines (Sat 2:55-4:05 AM) list what's done. **Done by Raami:** Gemini experience
plans, the realism check with candidate heads ranked by likeness, the legends back on `/showcase` with their
label on every surface, private family dreams (`"private": true`, `ian-grandma*` private by id), the site's real
jump-shot hero and reel of real dreams, Lighthouse 100 on mobile. **Open, in order** (Gemini prize work first):

1. **Gemini key on the bridge.** `apps/web/.env.local` doesn't exist on Ojasva's Mac, so no Gemini step runs:
   put `GEMINI_API_KEY=...` there (ask Ojasva for the key; never commit it). The bridge runs on :5170 in runner
   mode (`BRIDGE_MODE=runner`), the site on :5190.
2. **Gemini Live coach in the lesson:** an "Ask" fingertip button in the WebXR viewer opens a Gemini Live audio
   session about the step on screen; the device's voice, never the person's; a token endpoint in `apps/web` mints
   short-lived credentials (raami.md, MORE 1).
3. **"Watch me try":** record an attempt in the browser, Gemini compares it with the teacher's clip and returns
   timestamped notes, shown side by side and added to the experience as a `feedback` step (raami.md, MORE 2).
4. **Several photos of one person** in "From a photo" (body + face tags; repeated `file` fields, first = body),
   which feeds your head swap directly (raami.md, TOP 1).
5. **`/live`** for the judges: a running job's stages, timings, GPUs and its latest truth-vs-render strip
   (`runs/<id>/recon/peek-*.jpg`), and the **40-sentence intent test** (raami.md, MORE 3 and 4).

## CHANGED AGAIN (Sat 2:45 AM): Ojasva's call, Bobby and Magnus are back; you don't have to touch them

Ojasva (project lead) overruled the 2:20 AM line: **Bobby Fischer and Magnus Carlsen sit across the chess board**,
silent, labelled "Stockfish at <legend>'s peak rating. Not affiliated.", from freely licensed photos. Your
objection is on record, and **you don't have to build or run anything for them.** Ojasva's Claude runs the legends
himself: LAM heads (Fischer: the 1966 portrait; Carlsen: Ralf Roletschek's 2015 close-up, CC BY-SA 3.0), Fischer's
body rebuilt from his DDColor-colourised photo, then your `swap_bundle` called directly from a one-off job outside
the repo. Your CLI, `CONSENTED` and `head-swap.sbatch` stay exactly as you wrote them.

Your work, in order:
1. **Ian's grandma.** Her family's written consent is confirmed; `ian-grandma` is in `CONSENTED` (one line, tests
   pass) and her three ids are in `dreams/.held` on Ojasva's Mac. Her face and her idle life matter more than
   anything else we build.
2. **Your own avatar** (`vishal-head`) for the other chess strengths and "you, perfected".
3. Then MORE below: voice-driven lips (consenting people only), hands, video-to-avatar, realism metrics.
4. `SMPL-X__FLAME_vertex_ids.npy` and `MANO_SMPLX_vertex_ids.pkl` are installed in `$L/models/smplx/`.

## TOP PRIORITY (Sat 1 AM): make them look like actual humans, not mannequins

Ojasva's verdict on the legends: "creepy, uncanny, I want it to look like an actual human". Three causes: the face
is guessed from about 60 px; the black-and-white recolour flattened all shading (that's going: B&W photos are now
colourised on the photo, with DDColor, before any model sees them); and nothing moves when they're idle (dead eyes).
This is the hardest and most important avatar work left. In order:

1. **A real face: LAM's head on your body** (`avatars/head_swap.py` + `hpg/head-swap.sbatch`). LAM (SIGGRAPH 2025,
   Apache-2.0) builds an animatable FLAME Gaussian head from one photo and was trained on real talking-head video.
   Ojasva's `avatars/hpg/lam-head.sbatch` is running on an L4 now. For every photo in `data/avatars/faces/<name>/`
   it writes `data/avatars/heads/<name>/heads/<name>-<photo>_gs_offset.ply` (canonical head Gaussians, FLAME space),
   `..._shaped_mesh.obj` (the FLAME mesh they sit on, 5023 vertices) and a talking render in `videos/`. Your part:
   - **Align.** SMPL-X's head is FLAME topology. Pair LAM's 5023 vertices with the avatar's rest-pose SMPL-X head
     through the official `SMPL-X__FLAME_vertex_ids.npy` (SMPL-X site, same login), solve a similarity transform
     (Umeyama, with scale) and apply it to the head Gaussians (means, rotations, scales).
   - **Replace.** Drop body Gaussians whose dominant joint is head, jaw or eyes above the jaw line. Fade the
     opacity of the ones left over a 3 cm band at the seam, so there's no collar.
   - **Skin.** Each head Gaussian takes the LBS weights of its nearest SMPL-X vertex, written into `skin.bin`
     (same format).
   - **Tone.** Match the head's skin to the body's on the neck ring (mean and std in Lab), so face and hands agree.
   - **Output** a bundle `<id>-head` and a `compare.png`: source photo, old face and new face, front and 3/4. Run
     it on `bobby-fischer` and `magnus-carlsen`. Ojasva swaps the chess legends to it if it wins.
   - **The number for the slide:** identity cosine (InsightFace `buffalo_l`) between a front render and the source
     photo, before and after.
   - **What LAM taught us (Sat 1:25 AM):**
     - A frontal close-up portrait gives a head that reads as a real person. Full-body photos, where the face is
       small, give blotchy heads, so ask people for a close-up.
     - Your format notes are right: the `.ply` holds offsets, `f_dc` is RGB, and positions are in
       `_textured_mesh.obj`, which the job now copies.
     - The job deletes LAM's `_audio.mp4` renders, which carry its sample voice.
     - The chess legends' face jobs are on hold while Ojasva and you settle your 1:35 AM call.
2. **Life when idle** (this kills most of the uncanny):
   - `motion.json` gets an optional `expr` per frame (FLAME's first 10 expression coefficients).
   - The bundle gets an optional `avatar/expr.bin`: per head Gaussian, 10 x xyz offsets from FLAME's expression
     basis, float16.
   - Write a 20 s idle loop: breathing (chest and shoulders 2-3 mm at 0.25 Hz), a blink every 3-5 s (150 ms),
     small eye saccades, slight head sway.
   - This changes the contract: post one line in the Status log first. Ojasva wires the WebXR side.
3. **Colour photos into DiGS too.** LAM's job leaves DDColor-colourised copies in `heads/<name>/colour/`. Rebuild
   `bobby-fischer`'s body from the colourised full photo so body and head agree (`lucid.monochrome` only touches
   greyscale photos, so it then leaves it alone).

**Your fine-tune landed (Sat 1:45 AM), and the claim holds.** On jump-shot's held-out views, fine-tuning on
4DAnyone's views beats one photo by +3.09 dB PSNR (17.12 -> 20.22) and +0.028 SSIM (person crop: +3.09 dB, +0.076
SSIM). LPIPS didn't move (0.104 -> 0.105), so it's more right, not yet sharper: your hands and face pass is the
next lever. **One bug before it ships:** the job log says `height 4.52 m, stand_y 1.608` for `jump-shot-tuned`.
A person is about 1.8 m, so either floaters stretch the bounds or the scale is off. Check the bounds on the
opacity > 0.5 Gaussians, and look at the bundle in the viewer, before Ojasva fetches it. Table:
`$L/data/avatars/finetune/jump-shot/dreams/jump-shot-tuned.work/results.md`.

## MORE (Sat 1:20 AM): a lot more, in order, after the top items

1. **Their own voice moves their lips** (the family moment; consenting people only, never a public figure).
   - LAM_Audio2Expression (aigc3d, Apache-2.0, 2025) turns speech into FLAME expressions. Run it on a bundle's
     `voice.m4a` and write `expr` per frame into `motion.json`.
   - Grandma's own words from the home video then move her own mouth, with captions beside her.
   - Measure lip sync with SyncNet confidence on a front render, before and after.
2. **Hands that hold up at 1.5 m.** Hands are the second thing people notice after faces.
   - Fit finger poses from the photo or clip with WiLoR (2025) or HaMeR, so the fingers aren't the SMPL-X mean.
   - Run your 2x hands-and-face crop pass by default on every fine-tune, not opt-in.
   - Give the chess builder a "pinch grasp" hand pose (thumb on index, three fingers curled) for lifting pieces.
3. **Avatar from a phone video, not only a photo.** A family clip has many frames of the face: pick the sharpest
   8-12 (variance of the Laplacian on the face crop), fit DiGS on all of them (multi-view loss across frames, one
   identity code), and report identity cosine against one photo. This is the honest version of "someone you've lost".
4. **Realism numbers in every avatar bundle:** `metrics.identity` (InsightFace cosine to the source),
   `metrics.lpipsFace` (face crop) and `metrics.sharpness` (face Laplacian variance vs the source photo). The web
   app's Realism panel reads them.
5. **"You, perfected" end to end, filmed:** Ojasva's or your photo plus `lebron-jumper`'s motion through
   `digs-perform`, with a 10 s side-by-side render (their clip | you doing it) for the video. If the feet slide,
   fix the foot contact (pin the stance foot while GVHMR says it's planted).

## SECOND (was top): the face pass, so the legends look like themselves

The avatars run now (six fixes, all pushed: env packages, assets on GPU, repo lock, SMPL-X UV mesh, rembg on CPU,
the weights check counting DINOv3's own file, the rasterizer's four outputs; please review those edits in
`avatars/`). But Ojasva's verdict on Bobby Fischer: "this looks nothing like Fischer". In a full-body photo the face
is ~60 px, so DiGS invents most of it. Black-and-white sources are now made black-and-white automatically
(`pipeline/lucid/monochrome.py`), and a second Fischer is building from the iconic 1966 AP portrait (frontal,
sharp, public domain: `runs/bobby-fischer-1966`). That helps; the real fix is yours:

1. **`avatars/digs_face.py` + `hpg/digs-face.sbatch`:** refine an avatar's head against a close-up portrait. Fit
   NLF SMPL-X + camera on the portrait (as `digs_avatar.py` does for the body photo), render the avatar from that
   camera at 2x resolution, and optimise the DiGS code (the UV feature map, as in `digs_finetune.py`) with a loss
   only inside the face/hair region (the face mask from `face_mask_thu_newNeutral.npy`, or a landmark crop): L1 +
   0.2 (1 - SSIM) + LPIPS, 300-500 steps, everything else frozen so the body stays as it is. Write a new bundle
   `<id>-face` and a before/after `compare.png` of the face.
2. Run it on Fischer (portrait: the 1966 one, or `Bobby Fischer 1972.jpg`, CC0, Bert Verhoeff) and Carlsen
   (`Magnus Carlsen (2012).jpg` face crop). Ojasva will swap the chess legends to the `-face` bundles if they win.
3. If identity still drifts, try a second portrait from another angle in the same loss (two views beat one).

## BIG CHUNK (Sat 12:20 AM): everything avatars, now that they run

`ball.py`, the seated idle and the IK fixes: great, thank you. The avatar chain is finally unblocked: DINOv3 is in,
the env has mmengine / mmcv-lite / pytz / ipdb, the assets job runs on a GPU node (its NLF load needs CUDA), the
repo pull holds a lock, and the IDOL cache was missing SMPL-X's `smplx_uv.obj` (installed from the official SMPL-X
UV download). Building now: `bobby-fischer`, `magnus-carlsen`, `juice-wrld` (CC-licensed photos; Juice WRLD's is
waist-up, so his legs are imagined). In order:

1. **Watch the three avatar jobs** (`runs/<id>/logs/lucid-avatar-*.log`): if one fails, fix it in your code and tell
   Ojasva which job to resubmit. When they pass, check each `ref_check.png` (photo vs re-render overlap) and
   `thumb.jpg` (must show the front), and `seenFraction` (Juice WRLD's should be low: say so in the Status log).
2. **The fine-tune table:** `digs-finetune` is queued behind both jump-shot exports (~30 min). When `results.md`
   lands, check the fine-tuned avatar beats the one-photo one on held-out views; if not, tune it and resubmit.
   Put the table and `compare.png` in `avatars/README.md`.
3. **Wire `ball.py` into the export (you have Ojasva's OK to edit `pipeline/lucid/export.py`'s props section):**
   when the run's GVHMR camera exists, add `{"kind": "basketball", "radius": 0.12, "track": [...]}` to
   `props.json` in bundle coordinates, null where the ball isn't seen. The viewer and Ian's app already draw it.
   Test on `runs/lebron-jumper` (its views and GVHMR are done).
4. **You, perfected, for real:** take your head-to-toe photo now (`~/Downloads/lucid-photos/vishal.jpg` on Ojasva's
   Mac, or `$L/data/avatars/inputs/vishal.jpg`), then `digs-perform.sbatch` with `RUN_ID=lebron-jumper` once your
   avatar exists: your body doing LeBron's shot. This is a showcase moment.
5. **Chess legends seated, on their real bodies:** the WebXR chess poses any SMPL-X avatar procedurally
   (`apps/webxr/src/chess/seated.ts`), so Bobby and Magnus sit and reach as soon as their bundles land. Check their
   proportions look right seated (shoulder width vs the board), and send Ojasva any fix.
6. Hands/face pass and the results page, as before.

## ADDED (Fri 11 PM): one piece only you can do well

- **The ball's 3D path (props).** Ojasva is detecting the basketball in the source clip and lifting it to 3D with
  its known size (24 cm). The precise version needs GVHMR's camera: the incam SMPL-X (`smpl_params_incam`) and
  `K_fullimg` in `runs/<id>/views/gvhmr/`, to put the ball in the same frame as the person's pelvis, then into
  bundle space with the same transform you use in `gvhmr_motion.py`. If you have 30 minutes after the exam, write
  `lucid_avatars/ball.py: ball_world(K, incam, world, boxes) -> [N,3]` with a test; Ojasva will call it from the
  export. Until then his estimate uses the person's height in pixels for scale.
- Chess: a background builder is doing the seated pose + reach procedurally in the WebXR app, so your seated idle
  and reach-and-place are no longer blocking. Do them only if you have time after the fine-tune table.

## NEXT (Fri 10:45 PM): once you're back

- HiPerGator is connected and running (your login, thanks). Your `digs-assets` failed: `student.ckpt` has no DINOv3
  weights and `pretrained/dinov3_vitb16.pth` was missing. Ojasva requested Meta's DINOv3 download. A watcher on his
  Mac (`pipeline/runner/after_dinov3.py`) installs the `.pth` the moment it arrives, then re-queues digs-assets,
  Bobby, Magnus and both jump-shot fine-tunes as one Slurm chain. Check that `ASSETS_OK` appears, and that the
  Meta-format file loads the way your check expects.
- **LeBron's jump shot** is processing as a replay (`runs/lebron-jumper`). Once its views exist, its GVHMR motion is
  the best "you, perfected" demo: `digs-perform.sbatch AVATAR=$L/runs/vishal/out/vishal.work/code.pt
  RUN_ID=lebron-jumper ID=vishal-lebron NAME="Vishal, LeBron's jumper"`. That needs your photo (in
  `~/Downloads/lucid-photos/vishal.jpg`) and the assets.
- Seated idle + reach-and-place for the chess legends, then hands/face pass: unchanged.

## NOW (Fri 10:10 PM): what changed while you were in the exam

- The product is one line (AGENTS.md, top): photo/video + one sentence of intent -> an experience
  (`experience.json`: teach / companion / watch / play). Avatars run the same plans: a teach step's times are
  `motion.json` time. A photo-only person with an idle loop is a `companion`.
- Chess legends are queued as avatars from freely licensed photos: `bobby-fischer.jpg` and `magnus-carlsen.jpg` in
  `~/Downloads/lucid-photos/`, submitted automatically once `ASSETS_OK`. Check their `ref_check.png` and `thumb.jpg`
  like any other avatar. Fischer's photo is black and white and Carlsen's stops at the thighs: if DiGS struggles with
  either, say so in the Status log.
- Your seated idle and reach-and-place are now what makes them sit across the board and move the pieces.
- Your list below is unchanged otherwise. Step 1 is still connecting Ojasva's Mac to HiPerGator.

## DO THIS NOW (Fri 9:15 PM): your list, in order

This is your current list. Everything further down is earlier context.

**1. Connect Ojasva's Mac to HiPerGator (blocks everything; about 2 minutes).**
Your login on your own laptop doesn't run anything: every job, sync and fetch goes through the shared connection on
Ojasva's Mac, and it's still down. From anywhere:
- Put an SSH key on GitHub: `ssh-keygen -t ed25519` (if you have none), then paste `~/.ssh/id_ed25519.pub` at
  github.com/settings/keys. A watcher on Ojasva's Mac notices it within 30 seconds and opens a login-only session.
- Ojasva texts you one line, `ssh <session>@uptermd.upterm.dev`. Run it in your terminal, type your HiPerGator
  password and approve Duo. It closes by itself. Only your GitHub key can join, and you get nothing but that login.
- If you're at the table instead, just type your password into the login waiting in his Terminal.

**2. Then it runs by itself (nothing to do, just know the order):**
`after-reconnect.sh` installs SMPL-X and submits `digs-assets` -> the autopilot submits both jump-shot replays ->
when a replay finishes and `ASSETS_OK` is in `$L/jobs/lucid-digs-assets-*.log`, it submits `digs-finetune` for it.

**3. Your head-to-toe photo, tonight.** It becomes the `vishal` avatar: the chess opponent, the "you, perfected"
subject and the first avatar in the demo. Full body with feet in frame, arms slightly away from the body, plain
background, even light, phone at chest height about 3 m away. AirDrop it to Ojasva's Mac into
`~/Downloads/lucid-photos/` named `vishal.jpg` (HEIC is fine): the autopilot submits it as avatar `vishal` once
`ASSETS_OK` exists, and fetches the bundle into `dreams/vishal/` when it's done. Its work dir is
`$L/runs/vishal/out/vishal.work/`. Check `ref_check.png` there (photo vs re-render should overlap) and
`thumb.jpg` (must show your front; if it shows your back, apply the 180-degree turn in `avatar.ply`).

**4. When the fine-tune table lands** (`$L/data/avatars/finetune/jump-shot/dreams/jump-shot-tuned.work/results.md`):
if fine-tuned doesn't beat one-photo on the held-out views, fix it before anything else (steps, lr, which views).
Then copy the numbers and `compare.png` into a Results section in `avatars/README.md`. This is our research claim.

**5. "You, perfected":** after 3 and the first replay, Ojasva runs
`digs-perform.sbatch AVATAR=$L/runs/vishal/out/vishal.work/code.pt RUN_ID=jump-shot ID=vishal-jumper`.
Check that the feet stay on the floor through the jump.

**6. Code while the GPUs work (no HiPerGator needed):**
- a. **Seated idle** in `lucid_avatars/idle.py`: the breathing and blinking loop, but sitting (hips on a 0.45 m chair,
  forearms on a 0.75 m table, looking down at a board in front). The chess opponent sits in it.
- b. **Reach-and-place** in `lucid_avatars/reach.py`, with a test: the right hand reaches a board square (5 cm
  squares, board centre at the origin, your side at -Z), "picks", carries to another square, places, and returns
  to the seated idle in about 1.2 s. Numpy IK on the arm chain is fine. The chess mode plays it whenever the
  engine moves.
- c. **Hands and face pass:** a short extra optimisation on 2x face and hand crops, so close-ups hold up.
- d. **Family-photo person:** one old photo -> avatar + blinking idle, with the honest seen % (you already ship
  `seenFraction`).

What you don't need to do: bake for the WebXR viewer (it skins your bundles live now, matching `skinning.py` to
1e-6), or any public-figure avatars. Chess legends stay engine ratings, and opponents are consenting teammates only.

## Your big chunk

| Piece | Done means |
| --- | --- |
| DiGS-Avatar running | Repo `KLMAV-CUC/DiGS-Avatar` (already cloned at `/blue/iruchkin/vishalnaveen/lucid/repos/DiGS-Avatar`) turns one image into an animatable SMPL-X Gaussian person |
| Fine-tune on 4DAnyone views | Starting from the DiGS avatar, optimize against 4DAnyone's 24-48 generated views (and the real frames) so the back, face and hands match the person. **This is our research contribution.** Report PSNR / LPIPS before and after |
| Motion | Take the per-frame SMPL-X motion 4DAnyone computes (it runs GVHMR internally) and play it on any avatar; retarget between body sizes |
| "You, perfected" | Teammate's own avatar performs a pro's move cleanly |
| Family photo -> person | One old photo becomes a person in the room, with an idle loop (breathing, blinking, weight shift) so they never freeze |
| Export | `avatar/avatar.ply` + `avatar/motion.json` exactly as `AGENTS.md` specifies |

## Assets DiGS-Avatar needs (start downloads early)

- SMPL-X model files: same zip Ojasva is getting; we share one copy on HiPerGator.
- DINOv3 ViT-B/16 (`facebook/dinov3-vitb16-pretrain-lvd1689m`): gated, Ojasva is requesting access.
- SANA Sprint 1.6B 1024px and its VAE: public on Hugging Face (`Efficient-Large-Model/Sana_Sprint_1.6B_1024px`).
- IDOL cache: public (`yiyuzhuang/IDOL`).
- Student checkpoint: Google Drive link in the DiGS-Avatar README.
- Watch out: `pytorch3d` and `simple-knn` compile with CUDA; on B200 / RTX PRO 6000 you need a CUDA 12.8 PyTorch build.

## Milestones

| When | Done |
| --- | --- |
| Fri midnight | DiGS-Avatar environment builds; one sample image becomes an avatar |
| Sat noon | Avatar of a teammate from a photo, animated with motion from a test clip |
| Sat 8 PM | Fine-tuning on 4DAnyone views works, with before/after numbers; family photo person with idle loop |
| Sun 10 AM | Frozen; exports load in Ian's Quest app |

## Talk to

- Ojasva for GPU jobs and 4DAnyone outputs (views, cameras, SMPL-X motion).
- Ian for how avatars render on Quest (Gaussian count budget, rig format).

## Status from Ojasva (Fri night)

- **Your environment is built**: `/blue/iruchkin/vishalnaveen/lucid/envs/digs` (PyTorch 2.8 + CUDA 12.8; pytorch3d,
  simple-knn and diff-gaussian-rasterization compiled for B200 and RTX PRO 6000; DiGS-Avatar installed editable).
- **Downloaded**: SANA Sprint 1.6B + its VAE + IDOL (in `/blue/iruchkin/vishalnaveen/lucid/cache/hf`), and the student
  checkpoint at `repos/DiGS-Avatar/checkpoints/student.ckpt`.
- **Still missing**: DINOv3 ViT-B/16 (Meta approval pending on Hugging Face) and SMPL-X (download in progress).
  SMPL-X will land at `/blue/iruchkin/vishalnaveen/lucid/models/smplx/SMPLX_NEUTRAL.npz`.
- To start: `source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh` then
  `conda activate /blue/iruchkin/vishalnaveen/lucid/envs/digs`, in an interactive GPU session on hpg-rtx6000 or hpg-b200.
- 4DAnyone's per-frame SMPL-X motion for every real run will be in `runs/<id>/views/gvhmr/` (motion.json + motion.safetensors).

## Next chunk (added after your avatar pushes: the one-photo pipeline, idle loop and validator are great)

**Ojasva runs your jobs the moment SMPL-X lands:** `digs-assets.sbatch` once, then `digs-sample.sbatch` per photo.
Put a consented, head-to-toe photo of a teammate at `$L/data/avatars/inputs/sample.jpg` (your login works for that).

1. **The research piece: fine-tune on 4DAnyone's views.** Every real replay run leaves, in `runs/<id>/views/`:
   `cameras.json` (24-48 OpenCV cameras in 4DAnyone's world: metric, +Y up, subject faces +Z), `videos/NN.mp4`
   (704x1280, 121 frames), and `gvhmr/motion.json` + `motion.safetensors` (per-frame SMPL-X, `smpl_params_global`).
   Start from the one-photo DiGS avatar, pose it with the GVHMR SMPL-X for frame t, render into those cameras, and
   optimize the Gaussians (colours, offsets, scales) against the generated views, with the person cut out by alpha.
   Hold out 4 views. **Report PSNR / SSIM / LPIPS on held-out views before vs after.** That table is our research claim.
2. **"You, perfected":** play the GVHMR motion from any replay run (e.g. a Steph clip) on a teammate's avatar.
   Export it as `avatar/motion.json` in a new bundle (`kind: "avatar"`).
3. **Your open questions, answered:**
   - Motion conventions: accepted as you proposed (root only in `root_q`/`root_t`, pelvis zero, absolute joint rotations).
   - Skinning: ship `avatar/skin.bin` (per Gaussian, same order as `avatar.ply`: 4 x uint8 joint index + 4 x uint8
     weight summing to 255) and `avatar/skeleton.json` (rest joint positions + parents, SMPL-X order). The WebXR
     viewer can drive this with Spark 2.4's `SplatSkinning`; Ian reads the same files in Unity. Add both to
     `dream.json` under `avatar` and tell Ian.
   - Blinking: yes, add an optional `expr` (10 floats per frame) to `motion.json`; players that don't know it ignore it.
4. **Front check:** your note says `thumb.jpg` should show the front. After the first sample run, if it shows the
   back, apply the 180-degree turn in `avatar.ply` so every player gets the front facing the viewer (contract: front
   faces -Z).

## Work without waiting (while SMPL-X and the first real runs land)

- Develop the fine-tune loop now on synthetic data: `cd pipeline && python -m lucid.synthetic --out /tmp/synth
  --frames 4 --views 24` (in the 4DAnyone env on a GPU node) writes `cameras.json` + RGBA views of a moving person,
  the same camera format 4DAnyone produces. Swap in real 4DAnyone runs when they exist.
- Unit-test everything that doesn't need the GPU (you already do: keep it up).
- Decide the fine-tune design yourself (which parameters, losses, schedule); write it in this file.

## Your backlog (ordered)

1. Fine-tune on 4DAnyone views, with the before/after table (the research claim).
2. "You, perfected": GVHMR motion from a replay run driving a teammate's avatar.
3. `skin.bin` + `skeleton.json` export, validated by your bundle checker.
4. Family-photo person: one old photo -> avatar + idle loop, with an honest "imagined" share.
5. Blink: optional `expr` in `motion.json`.
6. A short results page in `avatars/README.md`: images and numbers Atina can drop into the slides.

## Update (Fri ~8:40 PM): done and next

Done, nice: fine-tune on 4DAnyone views (`digs_finetune.py`, `prep_views.py`), skinning + skeleton in bundles,
blinking idle, floor-aware retargeting.

Next, in order:
1. **First real numbers.** As soon as the jump-shot replay finishes on HiPerGator (`runs/jump-shot/views/` will hold
   cameras, 48 views and GVHMR motion), Ojasva runs your fine-tune on it. Write the exact sbatch for that
   (`avatars/hpg/digs-finetune.sbatch`: inputs = a photo or a frame of that clip + the run dir) so it's one command.
2. **"You, perfected" job:** `avatars/hpg/perfected.sbatch`: avatar bundle A + replay run B -> a new avatar bundle
   wearing B's motion (retargeted to A's height). This is the demo's jaw-drop: make it one command.
3. **Hands and face pass:** a short extra optimisation on face and hand crops at 2x resolution, so close-ups hold up.
4. **Results page** in `avatars/README.md`: before/after renders and the PSNR / SSIM / LPIPS table (Atina's slides
   pull from it).
5. **Family-photo person:** one old photo -> avatar + blinking idle, with the honest imagined share.


## Update (Fri ~9 PM): your jobs are wired in

`digs-finetune.sbatch` and `digs-perform.sbatch` are great. The autopilot on Ojasva's Mac now submits
`digs-finetune.sbatch RUN_ID=jump-shot` (and `jump-shot-2`) by itself the moment each replay finishes and
`digs-assets` has printed `ASSETS_OK` (queue items carry `"then"` jobs: `pipeline/runner/queue.json`). So the
research table should exist tonight without anyone pressing anything. HiPerGator is back once you log in after the
exam: Ojasva's Mac is sitting at the password prompt for your account.

Next, in order:
1. **Check the first table** in `$L/data/avatars/finetune/jump-shot/dreams/jump-shot-tuned.work/results.md` when it
   lands; if the fine-tune doesn't beat the one-photo avatar on held-out views, tune it (steps, lr, which views)
   before anything else. Copy `results.md` + `compare.png` numbers into `avatars/README.md` (Results section).
2. **A seated idle** in `lucid_avatars/idle.py`: the same breathing / blinking / weight-shift loop, but sitting (hips
   on a chair 0.45 m high, forearms resting on a table at 0.75 m, looking down at a board in front). The chess mode
   will sit an avatar opponent across the board. Same `motion.json` format.
3. **A reach-and-place motion**: given a board-local start and end square (5 cm squares, board centre at the origin,
   your side at -Z), the right hand reaches, "picks", carries and places, about 1.2 s, returning to the seated idle.
   Pure numpy IK on the arm chain is fine; write it as `lucid_avatars/reach.py` with a test. The WebXR chess plays it
   whenever the engine moves.
4. Hands and face pass, then the family-photo person (unchanged from before).

## Update (Fri 9:05 PM): bake + seen % in; the viewer skins your avatars live

The WebXR viewer now plays avatar bundles with live GPU skinning from your `skin.bin` / `skeleton.json` / `motion.json`.
It matches `skinning.py` to 1e-6, so bake is only needed for the Quest app until Ian's skinning lands.

Chess opponent: `?mode=chess&opponent=<avatar id>` stands an avatar across the table. It should be a **consenting
teammate**, never a public figure's face (the legends stay engine ratings only; AGENTS.md, Consent). So:
1. **Your own avatar first** (after the fine-tune table): a head-to-toe photo of you -> `digs-sample` -> bundle `vishal`.
   That one avatar is the chess opponent, the "you, perfected" subject and the first avatar in the demo.
2. Then the seated idle and reach-and-place motions (above), so the opponent sits and moves its own pieces.

## Log in to HiPerGator from anywhere (2 minutes, once)

You don't need to be at Ojasva's Mac. Do this once:
1. Put an SSH key on your GitHub: `ssh-keygen -t ed25519` (if you have none), then paste `~/.ssh/id_ed25519.pub`
   at github.com/settings/keys. Tell Ojasva when it's there.
2. Ojasva runs `zsh pipeline/hpg/share-login.sh` and texts you the `ssh ...@uptermd.upterm.dev` line it prints.
3. Run that line in your own terminal: type your HiPerGator password, approve Duo. It closes by itself.

Only your GitHub keys can join, you get nothing but that login (no shell or files on his Mac), and your password
goes straight from your keyboard to HiPerGator. Each of us getting our own HiPerGator account under the group is the
proper fix after the weekend.
