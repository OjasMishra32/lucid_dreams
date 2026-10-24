# Vishal: avatars (photoreal people that can do any move)

You own the **Avatar** kind of person: a rigged, photoreal Gaussian human built from one photo or one clip, that
can perform any motion. It powers "you, perfected", teach mode, and the family-photo moment. Read `AGENTS.md` first.

HiPerGator is your account, but Ojasva runs the batch GPU jobs. For development you can open an interactive GPU
session on your own login (one GPU, `--account=iruchkin --qos=iruchkin`), and hand finished scripts to Ojasva.

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
