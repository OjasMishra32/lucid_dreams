# avatars

Vishal's area: photoreal, rigged people that can do any move. A photo or clip goes through DiGS-Avatar,
gets fine-tuned on 4DAnyone's generated views, and is exported as `avatar/avatar.ply` + `avatar/motion.json`
in a dream bundle (see `AGENTS.md`, Contracts).

## What's here

`lucid_avatars/` is plain numpy, so it runs anywhere, including the GPU environment:


| Module | Does |
| --- | --- |
| `motion.py` | `motion.json` read/write/validate; DiGS-Avatar packed SMPL-X <-> motion; turning a motion to face the viewer on the floor |
| `idle.py` | Seamless idle loop (breathing, weight shift, head sway) so a family-photo person never freezes |
| `gaussian_ply.py` | Standard 3DGS binary PLY read/write |
| `bundle.py` | Writes an avatar bundle; validates any bundle against the contract |
| `digs_io.py` | Photo/NLF/DiGS glue: crop and intrinsics, DiGS reference JSON, rasterizer Gaussians to PLY, sanity checks |

`digs_avatar.py` is the GPU side (needs the DiGS-Avatar env): one photo becomes a dream bundle.

## One photo -> avatar on HiPerGator (Ojasva submits)

Order: `pipeline/hpg/setup-digs.sbatch` (once), then `hpg/digs-assets.sbatch` (once, CPU), then
`hpg/digs-sample.sbatch` per photo (RTX PRO 6000, 1 h limit; not L4, the CUDA extensions are built for sm_100/sm_120).

1. Unzip `models_smplx_v1_1.zip` into `$L/models/smplx` (or pass `SMPLX_DIR=...`): it needs `SMPLX_NEUTRAL.pkl`.
2. `sbatch avatars/hpg/digs-assets.sbatch`: clones this repo to `$L/repos/lucid_dreams`, links SMPL-X, unpacks the
   IDOL cache, fetches the diffusers AutoencoderDC, the DINOv3 code, NLF and the rembg person matte (about 1.5 GB),
   and fails if `student.ckpt` lacks DINOv3 weights while the gated `pretrained/dinov3_vitb16.pth` is absent. Ends `ASSETS_OK`.
3. Put a consented, head-to-toe photo at `$L/data/avatars/inputs/sample.jpg`, or pass your own:
   `sbatch --export=ALL,IMAGE=/path/photo.jpg,ID=grandma-01,NAME="Grandma" avatars/hpg/digs-sample.sbatch`.
   Ends `BUNDLE_OK <dir>` and `SAMPLE_OK`; the bundle is `$L/data/avatars/dreams/<id>/`.
4. Check `<id>.work/ref_check.png` (the photo crop beside DiGS's re-render from the photo's camera: should overlap)
   and `preview.mp4` (turntable). Debug files: `matte.png`, `crop.png`, `ref_smplx.json`.

What it does: rembg matte -> 640x896 crop around the person -> NLF SMPL-X fit on the crop (55-degree FOV assumed, principal point centred as DiGS requires) -> DiGS
reference JSON -> DiGS sampling -> turntable `preview.mp4` + `thumb.jpg` -> the Gaussians DiGS rasterizes for the
SMPL-X zero pose become `avatar/avatar.ply` -> an 8 s idle loop standing on the floor becomes `avatar/motion.json`.
`avatar.ply` is the SMPL-X zero pose with flat hands; `motion.json` holds the hands in DiGS's relaxed hand mean. It fails loudly (no bundle) if weights didn't load or the
captured body isn't 0.8-2.4 m tall.

Still unverified (needs the first GPU run): NLF's output keys and units (the script converts mm if it sees them), and
whether DiGS's rest pose faces +Z like SMPL-X. The turntable camera sits on +Z, so `thumb.jpg` should be the front;
if it shows the back, the rest pose faces -Z and `avatar.ply` needs a 180-degree turn before Ian's player uses it.

Credits: [DiGS-Avatar](https://github.com/KLMAV-CUC/DiGS-Avatar) (MIT), [NLF](https://github.com/isarandi/nlf)
(code MIT, models non-commercial research), [rembg](https://github.com/danielgatis/rembg) (MIT), IDOL assets, SMPL-X (licensed).

```bash
cd avatars
uv run --group dev pytest -q                                      # tests
uv run python -m lucid_avatars validate ../samples/<id>           # check a bundle
uv run python -m lucid_avatars idle motion.json --seconds 8       # write an idle motion
```

## motion.json conventions (proposed, to confirm with Ian)

- `root_t`, `root_q` are SMPL-X `transl` and `global_orient`, applied exactly the way SMPL-X applies them.
- `pose[0]` (pelvis) is always zero; the root rotation lives only in `root_q`, so it is never applied twice.
- `pose` holds absolute joint rotations, hands included (no hand-mean offset, no PCA).
- `avatar.ply` is in SMPL-X rest space (faces +Z); the 180-degree turn to face -Z is in `root_q`.

Open questions for the Quest side: how per-Gaussian skinning weights travel (extra PLY properties or a
side file), and whether `motion.json` gets an optional `expr` field so avatars can blink.
