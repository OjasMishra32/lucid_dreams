# avatars

Vishal's area: photoreal, rigged people that can do any move. A photo or clip goes through DiGS-Avatar,
gets fine-tuned on 4DAnyone's generated views, and is exported as `avatar/avatar.ply` + `avatar/motion.json`
in a dream bundle (see `AGENTS.md`, Contracts).

## Results

The research claim ("Fine-tune on 4DAnyone's views" below), measured on held-out views.
`uv run python -m lucid_avatars results <run>-tuned.work` rewrites this section from a finished fine-tune.

<!-- results:start (written by `python -m lucid_avatars results`) -->
Being measured: the one-photo avatar vs the same avatar fine-tuned on 4DAnyone's views, PSNR / SSIM / LPIPS on held-out views, with before/after renders. The table lands here when verified.
<!-- results:end -->

## What's here

`lucid_avatars/` is plain numpy, so it runs anywhere, including the GPU environment:


| Module | Does |
| --- | --- |
| `motion.py` | `motion.json` read/write/validate; DiGS-Avatar packed SMPL-X <-> motion; turning a motion to face the viewer on the floor |
| `idle.py` | Seamless idle loops so a person never freezes: standing (breathing, weight shift, head sway) and seated at the chess board (forearms on the table, looking at the board) |
| `ik.py` | Closed-form two-bone arm IK (elbow can rest on a table) and head aim on the SMPL-X skeleton |
| `ball.py` | The basketball's 3D path: pixel box of a 24 cm ball -> GVHMR camera -> GVHMR world (incam + global fits) -> any 4x4 |
| `ball_props.py` | props.json's basketball for an export: YOLO ball boxes in `views/source.mkv` + GVHMR's MotionResult -> bundle coordinates (4DAnyone env) |
| `gaussian_ply.py` | Standard 3DGS binary PLY read/write |
| `bundle.py` | Writes an avatar bundle; validates any bundle against the contract |
| `digs_io.py` | Photo/NLF/DiGS glue: crop and intrinsics, DiGS reference JSON, rasterizer Gaussians to PLY, sanity checks |
| `skinning.py` | `skin.bin` / `skeleton.json` read, write, check; reference linear-blend skinning |
| `retarget.py` | Someone else's motion on an avatar: leg-length scaling, facing the viewer, soles on the floor |
| `gvhmr.py` | GVHMR's SMPL-X motion (4DAnyone's) as a Motion, moved into 4DAnyone's world |
| `detail.py` | Hands and face pass: face and hand regions from posed joints, 2x close-up cameras, the view resampled into them |
| `finetune_io.py` | Fine-tune helpers: DiGS cameras from 4DAnyone's rig, held-out views, results table |
| `results_page.py` | `python -m lucid_avatars results <work dir>`: a fine-tune's table and renders into this README's Results section |
| `bake.py` | Avatar bundle -> replay bundle (posed per frame, `.ply` + `.spz`) for players that can't skin yet |

GPU side (DiGS-Avatar env unless noted): `digs_avatar.py` one photo -> bundle; `digs_finetune.py` fine-tune on
4DAnyone views; `digs_perform.py` an avatar doing someone else's move; `gvhmr_motion.py` and `prep_views.py`
(4DAnyone env) feed them.

## One photo -> avatar on HiPerGator (Ojasva submits)

Order: `pipeline/hpg/setup-digs.sbatch` (once), then `hpg/digs-assets.sbatch` (once, CPU), then
`hpg/digs-sample.sbatch` per photo (RTX PRO 6000, 1 h limit; not L4, the CUDA extensions are built for sm_100/sm_120).

1. SMPL-X: `SMPLX_NEUTRAL.pkl` or `.npz` in `$L/models/smplx` (`pipeline/hpg/install-smplx-when-ready.sh` puts the `.npz`
   there; pass `SMPLX_DIR=...` for elsewhere). DiGS wants the `.pkl`; the assets job converts the `.npz` if that's all there is.
2. `sbatch avatars/hpg/digs-assets.sbatch`: clones this repo to `$L/repos/lucid_dreams`, links SMPL-X, unpacks the
   IDOL cache, fetches the diffusers AutoencoderDC, the DINOv3 code, NLF and the rembg person matte (about 1.5 GB),
   and fails if `student.ckpt` lacks DINOv3 weights while the gated `pretrained/dinov3_vitb16.pth` is absent. Ends `ASSETS_OK`.
3. Put a consented, head-to-toe photo at `$L/data/avatars/inputs/sample.jpg`, or pass your own:
   `sbatch --export=ALL,IMAGE=/path/photo.jpg,ID=grandma-01,NAME="Grandma" avatars/hpg/digs-sample.sbatch`.
   Ends `BUNDLE_OK <dir>` and `SAMPLE_OK`; the bundle is `$L/data/avatars/dreams/<id>/`.
4. Honesty: `metrics.seenFraction` in `dream.json` is the share of Gaussians the photo really saw (a depth test
   against DiGS's visibility pass from the photo's camera); `<id>.work/reality.ply` tints the imagined rest blue.
5. Check `<id>.work/ref_check.png` (the photo crop beside DiGS's re-render from the photo's camera: should overlap)
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

## Fine-tune on 4DAnyone's views (the research claim)

`hpg/digs-finetune.sbatch` with `RUN_ID=<a finished replay run>` (RTX PRO 6000, 2 h limit, after `digs-assets`):

1. `gvhmr_motion.py` (4DAnyone env): the clip's GVHMR SMPL-X motion, moved into the world 4DAnyone's `cameras.json`
   uses. 4DAnyone computes that transform but doesn't save it, so this calls 4DAnyone's own `_body_geometry` again.
2. `prep_views.py` (4DAnyone env): 8 frames spread over the clip, every view, the person cut out with BiRefNet.
3. `digs_avatar.py`: the one-photo avatar from the clip's first frame (the "before").
4. `digs_finetune.py`: optimizes DiGS's decoder code, the UV feature map every Gaussian is decoded from, against the
   training views; the decoder, the body model and the motion stay fixed. 4 views spread round the ring are held out.

Design: tune the code, not the Gaussians, so the result stays a DiGS avatar (rigged, re-posable, same skinning) and
the prior keeps unseen regions sane; tune in pre-tanh space; Adam, lr 0.02 with cosine decay, 800 steps, 4 random
training views of a random frame per step; loss L1 + 0.2 (1 - SSIM) on views composited on white, as DiGS renders;
the clip's own betas and motion (GVHMR), hands in the hand mean as GVHMR's SMPL-X shows them. `--tune-decoder` also
trains the decoder at lr / 1000, a second ablation row if there's time.

Output, in `$L/data/avatars/finetune/<run>/dreams/<run>-tuned.work/`: `results.md` (the table for the slides),
`results.json`, `compare.png` (held-out views of the first frame: 4DAnyone view / one photo / fine-tuned) and a
bundle `<run>-tuned` that plays the clip's motion. Metrics are over every prepared frame x held-out view, on full
frames composited on white (so absolute PSNR runs high; the before/after change is the claim). Once fetched,
`uv run python -m lucid_avatars results <run>-tuned.work` puts the table and renders (shrunk to 1600 px, in
`avatars/results/`) into the Results section at the top of this file.

**Hands and face pass** (`DETAIL_STEPS=300`, off until it has run once): after the fine-tune, a short extra
optimisation on 2x close-ups of the face and both hands, so close-ups hold up (`lucid_avatars/detail.py`). DiGS needs a
centred principal point, so each close-up is a camera at the view's own centre turned onto the face or hand (from the
clip's posed SMPL-X joints) at twice the focal length; the view maps onto it exactly by a homography and is resampled
into it. Loss L1 + 0.2 (1 - SSIM) on those crops only, decoder code only. `results.md` then has three columns (one
photo / + fine-tune / + hands and face pass) and face and hand crop rows on the held-out views, plus
`compare_detail.png` (held-out face crops). The crops resample the view, so they reweight the face and hands, not add
pixels the view doesn't have. If the pass fails, the job keeps the fine-tune's code and numbers.

## "You, perfected"

`hpg/digs-perform.sbatch` with `AVATAR=<some avatar's code.pt>`, `RUN_ID=<the run with the move>`, `ID`, `NAME`:
the move's joint rotations play on the avatar unchanged, the root path scaled by leg length, turned to face the
viewer, and dropped so the avatar's lowest Gaussian over the clip touches the floor (crouches and jumps stay).

## Seated at the chess board

`seated_idle(rest, betas)` (`idle.py`) is the opponent's idle: hips on a 0.45 m seat, feet on the floor, forearms on a
0.75 m table, hands short of the board, looking at its centre, breathing and blinking. Same person frame as every
bundle (hips over x = z = 0, facing -Z); the board centre is `BOARD_Z` = 0.72 m in front of the hips, so a player puts
this origin 0.72 m behind the board centre on the opponent's side (the chess game's standing opponent uses 0.58 m,
which is too close: the forearms would have to lie on the board). `rest` is the avatar's `skeleton.json` rest.

On the approximate SMPL-X proportions in `tests/smplx_rest.py` (not yet checked on a real avatar's skeleton.json): the
shoulder joint is about 0.64 m above the seat and the upper arm only about 0.26 m,
so from a 0.45 m seat the elbows can't come down onto a 0.75 m table without folding the arms. `seated_rest_pose`
therefore leans in (pelvis and spine, at most 0.5 rad) and, only if that isn't enough, lowers the seat (to 0.36 m at
most; the chair is never drawn). Elbows and wrists then sit exactly on the table and stay put while the chest breathes.

## The ball's 3D path (props)

`ball_world(K, boxes, incam, global_, J0, world)` (`ball.py`): per frame, the ball's pixel box in the video GVHMR ran on
(4DAnyone's input) -> distance from its angular size (24 cm ball) -> GVHMR's camera (`K_fullimg`) -> GVHMR's world, using
the camera pose implied by GVHMR's two fits of the same body (`smpl_params_incam` and `smpl_params_global`; `J0` is
`gvhmr_motion.rest_pelvis`) -> `world`: pass `[rot | t] @ motion_world_to_canonical_world` for bundle space (the
export's `placement`). No box, or a box touching the image edge (with `width`/`height`), gives NaN. A hand over the ball
or motion blur changes its size and so its distance: smooth the distance over time before trusting single frames.
`smooth=5` does that: each distance becomes a robust line (Theil-Sen) through the seen frames around it, so one cut box is
ignored and a ball flying away isn't pulled back at the clip's ends.

**In the export:** for a shooting clip, `pipeline/lucid/export.py` calls `ball_props.basketball_object(views, [rot | t], n)`
and puts `{"kind": "basketball", "radius": 0.12, "track": [...]}` before the hoop in `props.json`. It reads, all from the
run's `views/`: `source.mkv` (4DAnyone's canonical clip, RGB-identical to GVHMR's input), `gvhmr/` (MotionResult:
`smpl_params_incam`, `smpl_params_global`, `K_fullimg`, image size; names checked against 4DAnyone's source) and
`cameras.json` (`motion_world_to_canonical_world`). Boxes: YOLOv8x's COCO "sports ball", most confident per frame.
J0 comes from GVHMR's own `SMPLX_NEUTRAL.npz` (`pelvis_from_model`, numpy). No GVHMR camera, fewer than 3 seen frames,
or any error: no ball (logged as `[export] ball skipped`), the export goes on.

## Showing an avatar in a player that can't skin yet

The WebXR viewer and the Quest app play replays; until they read `skin.bin`, bake the avatar into one (numpy only,
runs on the Mac after fetching; about 20 MB of `.ply` + 2 MB of `.spz` per frame, so not on HiPerGator's Blue):

```bash
cd avatars && uv run python -m lucid_avatars bake ../dreams/<id> --fps 15   # writes ../dreams/<id>-baked
```

## motion.json and skinning (for Ian's player and the WebXR viewer)

Conventions (agreed with Ojasva, Fri night):

- `root_t`, `root_q` are SMPL-X `transl` and `global_orient`, applied exactly the way SMPL-X applies them.
- `pose[0]` (pelvis) is always zero; the root rotation lives only in `root_q`, so it is never applied twice.
- `pose` holds absolute joint rotations, hands included (no hand-mean offset, no PCA).
- `avatar.ply` is in SMPL-X rest space (zero rotations, flat hands, faces +Z); the 180-degree turn to face -Z is in `root_q`.

Skinning files (named in `dream.json` as `avatar.skin` and `avatar.skeleton`; the validator checks both):

- `avatar/skin.bin`: per Gaussian, in `avatar.ply`'s order, 8 bytes: 4 x uint8 joint index, then 4 x uint8 weight
  summing to 255. Unused slots are index 0 with weight 0.
- `avatar/skeleton.json`: `{"joints": [55 SMPL-X names], "parents": [55, -1 for the pelvis], "rest": [55 x [x,y,z]]}`,
  the rest-pose joint positions in metres for this avatar's body shape.

Posing one frame (the reference is `lucid_avatars/skinning.py`, `skin_matrices` + `pose_points`):

```
G_0 = [R(root_q) R(pose[0]) | rest_0]          G_j = G_parent(j) [R(pose[j]) | rest_j - rest_parent(j)]
M_j = G_j [I | -rest_j] + [0 | root_t]         x = sum_k (w_k / 255) M_{i_k} x_rest
```

Rotate each Gaussian's own rotation by the blended M's 3x3 as well; scales stay. Weights come from the SMPL-X
template: each Gaussian blends its 4 nearest rest vertices' weights by inverse distance, top 4 joints kept.

Optional `expr` (10 SMPL-X expression floats, in every frame or none) carries blinks: `idle_loop(..., blink_expr=v)`
blinks every few seconds along `v`, the expression that closes this avatar's eyes. DiGS renders it; a skinning-only
player needs per-Gaussian expression blendshapes to show it, which `skin.bin` doesn't carry, so it can ignore `expr`.
