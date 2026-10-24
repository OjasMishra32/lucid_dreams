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
| `idle.py` | Seamless idle loops so a person never freezes: standing (20 s: breathing, weight shift, head sway, eye saccades, blinks) and seated at the chess board (forearms on the table, looking at the board) |
| `face_expr.py` | Life in a head-swapped face: `avatar/expr.bin` (FLAME's expressions per LAM Gaussian) and a blink fitted to the person's own eyelids |
| `arkit.py` | ARKit's 52 blendshapes: LAM_Audio2Expression's JSON (validated names, fps, frame times) and ARKit's shapes on FLAME (FBX-to-FLAME vertex correspondence by index or nearest neighbour, refused when the RMS is off) |
| `lips.py` | A consenting person's own voice moves their lips: ARKit's shapes on the head Gaussians, the utterance's 9 principal components as `mouth0`..`mouth8` in a new `expr.bin`, `motion.json` as long as the clip, `voice.m4a` |
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
| `head_swap.py` | LAM's one-photo head on a consenting person's own avatar: consent gate, FLAME-to-SMPL-X fit, jaw-line seam, skinning, skin tone, the `<id>-head` bundle |

GPU side (DiGS-Avatar env unless noted): `digs_avatar.py` one photo -> bundle; `digs_finetune.py` fine-tune on
4DAnyone views; `digs_perform.py` an avatar doing someone else's move; `gvhmr_motion.py` and `prep_views.py`
(4DAnyone env) feed them; `head_swap_render.py` (4DAnyone env) renders a head swap's turntable and side-by-side.

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
SMPL-X zero pose become `avatar/avatar.ply` -> a 20 s idle loop standing on the floor becomes `avatar/motion.json`.
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
uv run python -m lucid_avatars idle motion.json                   # write a 20 s idle motion
```

**Realism numbers** (`dream.json` `metrics`, for the web app's Realism panel; `lucid_avatars/realism.py` is the plain
part, `digs_avatar.py measure_realism` the GPU glue). All rounded to 4 places; any that can't be computed is `null`,
logged as `[realism] <key> skipped: ...` and never stops the bundle. Nothing leaves the cluster.

| key | what | read it as |
| --- | --- | --- |
| `identity` | InsightFace buffalo_l ArcFace cosine between the avatar's front face render and the photo's face (the original photo's pixels) | 1 = same face, 0 = unrelated |
| `lpipsFace` | LPIPS (VGG, as in `digs_finetune.py`) on the face crop: DiGS's re-render from the photo's own fitted camera vs the crop it was fitted to, both resized to 128 px | lower is better; 0 = identical |
| `sharpness` | variance of the Laplacian on that render's face crop / the photo's (same crop, native pixels) | 1.0 = as sharp as the photo; under 1 = blurrier |

The face crop is the fitted SMPL-X's head joint (NLF's pose and `trans`, run through our FK) plus 7 cm along the posed
head's up, projected through the photo's camera as a square 34 cm tall (`head_swap_render.py`'s `FACE_HALF_M`). In a
head-to-toe photo that is ~60-80 px, so `lpipsFace` and `sharpness` are rough there; a face under 16 px or mostly out of
frame gives null. `identity` needs InsightFace in the DiGS env (`pip install insightface onnxruntime-gpu`; models in
`--insightface-root`, default `~/.insightface`, which can't download on a compute node, so put `buffalo_l` there first);
without it, `identity` is null. Fine-tunes and performances have no single source photo, so all three are null there
(a head-swapped bundle's `identity` is `head_swap_render.py`'s, against LAM's close-up, and its `lpipsFace` and
`sharpness` are reset to null: they described the face the swap replaced).

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

**Hands and face pass** (on by default, `DETAIL_STEPS=300`; `DETAIL_STEPS=0` skips it): after the fine-tune, a short extra
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

## A real face: LAM head swap (consenting people only)

DiGS guesses the face from a full-body photo, so it rarely reads as the person. LAM (aigc3d, SIGGRAPH 2025) builds an
animatable FLAME Gaussian head from one close-up; the head swap puts it on the person's own avatar. Only people in
`CONSENTED` (`lucid_avatars/head_swap.py`; add a name only on that person's word), only on their own avatar (bundle id
`<person>` or `<person>-...`), and never anyone in `dreams/.held`; otherwise it stops before writing anything. Never a
public figure (AGENTS.md rule 5).

1. One or two frontal close-ups of the person in `$L/data/avatars/faces/<person>/` (a full-body photo gives a blotchy
   head), then `sbatch --export=ALL,NAME=<person> avatars/hpg/lam-head.sbatch` (L4).
2. `SMPL-X__FLAME_vertex_ids.npy` (SMPL-X site, model-transfer download) anywhere under `$L/models/smplx/`.
3. `sbatch --export=ALL,NAME=<person> avatars/hpg/head-swap.sbatch` (minutes). `AVATAR=<id>` for another of their
   avatars (e.g. `vishal-tuned`), `PHOTO=<stem>` for another LAM head, `SEAM_OFFSET=0.01` to raise the jaw-line seam 1 cm.

It writes `dreams/<avatar>-head`: the bundle with a new preview.mp4 and thumb.jpg, `head_swap.json` (FLAME fit scale
and RMS, seam height, Gaussians kept and dropped, identity) and `compare.png` (the photo | the old face | the new face,
front and 3/4). Identity is the ArcFace cosine (InsightFace buffalo_l) of each face's front render to the photo, also
in `metrics.identity`; it's skipped (null) if InsightFace isn't installed in the 4DAnyone env. Check in the log: the
fit RMS (it refuses over 3 cm), `BUNDLE_OK`, `HEAD_SWAP_OK`; then look at compare.png before the bundle goes in the
library. LAM's head saw one frontal photo, so its back is marked imagined in reality.ply. Each head Gaussian takes the
skinning weights of its own FLAME vertex's SMPL-X twin (through the vertex ids; an edge midpoint the mean of its two
ends), so an upper-lip Gaussian never takes the jaw's weights from a lower lip it touches. The neck ring is shifted in
Lab to the body's skin and the shift fades out over 3 cm above the seam (under the jaw), so the face keeps LAM's
colours from the close-up (`toneShiftLab` in head_swap.json; scaling the colour spread as well once turned brown eyes blue).
`bodyVisibleAboveSeam` counts, by joint, what of the old body still shows above the seam: a big number there is
leftover DiGS hair or face doubling the head.

**Life in the face** (`face_expr.py`, when FLAME is there: the job fetches FLAME 2023's two files once
from LAM's public assets into `$L/models/flame/` and extracts `flame2023_expr.npz` with `flame_expr_npz.py`, in any env:
no chumpy needed; FLAME never leaves HiPerGator). The bundle
gets `avatar/expr.bin` (format below) with ten channels per head Gaussian: FLAME's expressions 0-8 (LAM animates its
heads with FLAME's first ten) and a blink. The blink is fitted to this person's eyelids: FLAME's expressions give the
natural motion around the eye (capped at 0.3 mm outside the eye region), the eyelid margins meet exactly (the upper
lid travels 80%, sliding over the eyeball, which never moves). FLAME's eye sockets are closed (its head's only boundary
is the neck), so the lids are LAM's eyelid lists plus the skin hugging each eyeball's front, and each margin is the
envelope of its lid: extra rows of lid skin follow it instead of folding over, and the eye corners stay put. The
extract fits the blink on FLAME's own template first and stops if it doesn't shut (`[expr]` lines in the log: lid
counts per eye, then `openFraction`). If a head's eyes can't be shut, the swap goes on without expr.bin, says why in
`expr.skipped`, and still gets the 20 s living idle (breathing and glances, no blinks). `head_swap.json` `expr.blink` says how well:
`openFraction` (0 = shut), `pcaShare` (how much FLAME's own expressions explain), `leakMm`. An idle source motion is
replaced by the 20 s living idle that blinks through it (`motion: "living idle"`; a bundle whose source names a
motion, `digs-perform`'s move or `digs-finetune`'s own clip, or `KEEP_MOTION=1` keeps it), and `blink.png` shows the face open | shut with the eyes zoomed: look at it before
anyone sees the bundle.

Locally, without a GPU: `uv run python -m lucid_avatars head-swap dreams/<person> <heads dir> --person <person>
--smplx SMPLX_NEUTRAL.npz --flame-ids SMPL-X__FLAME_vertex_ids.npy [--flame-expr flame2023_expr.npz]` does the swap
alone.

## Blinks and the living idle for any SMPL-X avatar (no head swap needed)

`head_swap` writes `avatar/expr.bin` only for LAM's heads. SMPL-X's own head has FLAME's topology (SMPL-X vertex
`ids[j]` is FLAME vertex j), so any SMPL-X bundle (a DiGS photo avatar, an LHM++ one) can blink too, in place:

```
sbatch --export=ALL,BUNDLE=<id> avatars/hpg/blink.sbatch          # CPU; KEEP_MOTION=1 keeps the motion
python -m lucid_avatars blink dreams/<id> --smplx SMPLX_NEUTRAL.npz --flame-ids SMPL-X__FLAME_vertex_ids.npy \
  --flame-expr flame2023_expr.npz [--keep-motion]                  # locally, same thing
```

`any_face.py`: the avatar's rest SMPL-X vertices (the bundle's betas, checked against skeleton.json to 2 mm) are fitted
to FLAME's template (Umeyama); the blink is fitted to those eyelids in FLAME's frame and, with FLAME expressions 0-8,
carried into the avatar's frame by the fit's scale and rotation. Head Gaussians (dominant skin joint head, jaw or an
eye) each blend their 3 nearest FLAME vertices' offsets (eyeball vertices excluded); one within 1.05 eyeball radii of an
eye centre is the eye itself: zero offsets, it turns with the eye joint. `expr.bin` needs the head as one range at the
end, so the Gaussians are reordered (body first, then head, each in original order) and the same permutation goes to
`skin.bin` and `reality.ply`; `dream.json` gets `expr`/`exprChannels` and, unless `--keep-motion` or the motion is a
performance or a fine-tune's clip, the 20 s living idle with blinks. `face.json` next to `dream.json` has the numbers:
`expr.blink.openFraction` (0 = shut; look for near 0), FLAME fit RMS, Gaussians per part. Running it twice changes
nothing. It refuses (writing nothing) an id in `dreams/.held`, a bundle without skinning, a skeleton that isn't this
SMPL-X, a FLAME that doesn't fit the head (over 3 cm RMS: wrong ids), and a head swap's own LAM-fitted `expr.bin`. Eyes
FLAME can't shut skip `expr.bin` and the reorder (reason in `face.json` `expr.skipped`) but still get the idle. It adds
no likeness, so there is no consent gate. Not yet run on a real DiGS or LHM++ bundle.

## Their own voice moves their lips (voice-consenting people only)

Only people in `VOICE_CONSENTED` (`lucid_avatars/head_swap.py`; today only `vishal`: his own voice, his own say-so; a
separate yes from the face's `CONSENTED`), on their own head swap (`<person>-head`), nobody in `dreams/.held`. Ian's
grandma's voice is the family's call through Ian, not ours; never a public figure's, whatever recordings exist
(AGENTS.md rule 5). `python -m lucid_avatars lips ... --check` and `hpg/lips.sbatch` run the gate before any
environment, download or audio is touched, and `lips_bundle` runs it again. The audio must be the person's own recording
of their own voice: the gate can't hear whose it is.

How it works (`arkit.py`, `lips.py`, plain numpy and tested; the cluster parts are `arkit_on_flame_npz.py` and the sbatch):

1. **Audio -> ARKit.** LAM_Audio2Expression (aigc3d, Apache-2.0; `inference.py` with `lam_audio2exp_config_streaming.py`,
   the one config whose weights are released) writes per frame the weights of ARKit's 52 blendshapes at 30 fps (JSON
   via `save_json_path`; `arkit.read_a2e_json` checks the names, the fps, the frame times and every weight). The job
   turns its spleeter vocal extraction off (`ex_vol=False`): the recording is the voice alone.
2. **ARKit on FLAME.** LAM's team fitted the 52 shapes to FLAME's topology; they are the morph targets of
   `assets/sample_oac/template_file.fbx` (`sample_oac.tar`). `arkit_on_flame_npz.py` (the python 3.10 `envs/a2e`, LAM's FBX SDK wheel,
   once) writes `$L/models/flame/arkit_on_flame.npz` (names, `(52, 5023, 3)` deltas in FLAME's frame and metres; it
   never leaves HiPerGator: licences). The template's mesh may be in other axes and units, subdivided once (20018
   vertices: FLAME's 5023 first, as LAM orders its Gaussians) or reordered, so it finds which FBX vertex is which FLAME
   vertex (by index when the first vertices fit FLAME's template, else by nearest neighbour from 24 axis turns) and
   **refuses** over 4% of the head's extent in RMS, or if the nearest match isn't one-to-one, or if `jawOpen` doesn't move
   the chin down by centimetres. `--list` prints what the FBX holds when a name or mesh isn't what it expects.
3. **Into the bundle.** The speech shapes (jaw, mouth, cheeks, nose: 32 of the 52; not brows or eyes) go onto LAM's head
   Gaussians exactly as FLAME's expressions do (`face_expr.lam_fit` + `carry_fields`: vertex pairs of the subdivided
   mesh, `k R0` into LAM's frame, then `s R` into the avatar's). The head is recomputed from the same LAM head and SMPL-X
   files as the swap, and the job refuses unless its recomputed FLAME channels equal the bundle's own `expr.bin`
   (`flameChannelCheckMm` in lips.json): the same Gaussians, frames and pairs. For the utterance, every frame's
   displacement of every head Gaussian is weights x shapes; its 9 principal components (SVD over frames about the
   neutral face; never builds the frames x Gaussians matrix) are channels `mouth0`..`mouth8` of a new `expr.bin`;
   channel 9 is the head swap's own `blink`, untouched. Coefficients are unit-variance, the channels carry the metres.
4. **motion.json** is the living idle (breathing, sway, saccades, blink every 3-5 s) as long as the clip, `expr` per frame
   = the 9 coefficients (interpolated to the motion's fps) + the idle's own blink curve. A performance's motion is never
   replaced (it refuses). **voice.m4a** is the audio itself, for players to play in sync; captions are another pipeline's job.

Run (Ojasva submits; needs the head swap with FLAME, `sbatch --export=ALL,NAME=vishal avatars/hpg/head-swap.sbatch` first):

```
sbatch --export=ALL,NAME=vishal,AUDIO=/blue/iruchkin/vishalnaveen/lucid/data/avatars/voice/vishal.m4a avatars/hpg/lips.sbatch
```

First run builds `envs/a2e` (Python 3.10, torch 2.1.2 cu121, so L4s), fetches A2E and its weights
(`huggingface-cli download 3DAIGC/LAM_audio2exp`), and extracts ARKit-on-FLAME once. Out: `dreams/<bundle>-voice` with
`lips.json`. `MAX_S=120` caps the audio's length; `BUNDLE=`, `PHOTO=`, `ID=` as in head-swap.

What to check before anyone sees it: in the log, `FBX SDK OK`, the `[arkit]` line (`route`, `rmsOverExtent` well under
0.04, `jawOpenMaxMm` a few centimetres at most), `LIPS_OK`. In `lips.json`: `varianceKept` > 0.95 (the share of the mouth's
motion, against its own mean, that the 9 channels keep: the stricter measure; `energyKept` is against neutral; a
busy mouth under it prints a WARNING), `clipS` equal to the recording's length, `flameChannelCheckMm` ~0, `peakMm` a
few centimetres. Then **look at a render with the mouth open and shut**: nothing here renders the speaking face yet.

Not measured yet: SyncNet confidence on a front render, before (idle) and after (voice-driven), is the number for the
slide: render the bundle front-on to a video with `voice.m4a` muxed in, run SyncNet on both, and report the two
confidences. Untested on the cluster: the whole job (A2E env, weights layout, its CLI), and above all the FBX route:
the SDK calls, the channel names, whether shapes come out as absolute positions, and the template's vertex order.

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

Optional `expr` (10 floats, in every frame or none) carries the face: blinks, and later speech. Its meaning is the
bundle's. With `avatar/expr.bin` (head-swapped avatars; `dream.json` names it as `"avatar": {..., "expr":
"avatar/expr.bin", "exprChannels": [10 names]}`) it weights expr.bin's channels; without, it is SMPL-X's expression
for DiGS renders, and a skinning-only player ignores it.

`avatar/expr.bin`, little-endian: `uint32 first, uint32 count`, then `count x 10 x 3` float16. For Gaussian `first + i`
of avatar.ply and channel k, `d[i][k]` is an xyz offset in metres in the rest pose. The head is one contiguous range
ending at the last Gaussian. Before skinning, for each motion frame:

```
x_rest' = x_rest + sum_k expr[k] * d[i][k]        (lucid_avatars.face_expr.apply_expr)
```

then skin `x_rest'` as above. Channels (`exprChannels`): `flame0`..`flame8`, then `blink` (index 9, 1 = shut). A player
that only wants blinks needs channel 9 alone: `x_rest + expr[9] * d[i][9]`. The 20 s idle's blinks are 150 ms (50 ms
shut, 100 ms open, one frame fully shut), so interpolate `expr` between frames like the pose. The eye saccades are
plain joint rotations (`left_eye`, `right_eye`): any skinning player already shows them.

A bundle whose lips follow a voice (`lips.json` next to `head_swap.json`) names its channels `mouth0`..`mouth8`, `blink`
(`exprChannels`; the blink is still index 9) and has `voice.m4a`; the motion is as long as the clip. Same formula, no
player change: play `voice.m4a` from `t = 0` with the motion, and interpolate `expr` between frames.
