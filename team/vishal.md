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

