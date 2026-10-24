# Vishal: avatars (photoreal people that can do any move)

You own the **Avatar** kind of person: a rigged, photoreal Gaussian human built from one photo or one clip, that
can perform any motion. It powers "you, perfected", teach mode, and the family-photo moment. Read `AGENTS.md` first.

HiPerGator is your account, but Ojasva runs the batch GPU jobs. For development you can open an interactive GPU
session on your own login (one GPU, `--account=iruchkin --qos=iruchkin`), and hand finished scripts to Ojasva.

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
