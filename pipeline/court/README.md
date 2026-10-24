# Court Side clip tools

Code only. The footage, its calibration, masks, clips and run folders live outside the repo, and every number about
the footage (the freeze frame, the windows, the paths) comes from a private config passed with `--config`.
The `.gitignore` admits only `*.py`, `*.sbatch`, `*.sh` and `*.md`. Run Python with `python3 -I`.

| File | What it does |
| --- | --- |
| `stabilize.py` | The still camera. With `--ref-frame N` it is frame N's own camera (its R and f, no lens distortion), so frame N lands on the canvas as its own pixels. Also library helpers: `ref_still_camera`, `crop_maps`, `canvas_points` |
| `camgeom.py` | Camera maths shared with the calibration (one centre, per-frame R, f, k1) |
| `player_clip.py` | Builds one player's clip set: the window on the replay's grid of unique frames, the union of the player's mask boxes on the still camera, a fixed 9:16 clip window composited onto a plain background (the people in front of them are cut out and never fill the hole), `input.mp4` at 25 fps, `source-4k.mkv` (frame k = the reference frame's native pixels around the player), `masks/` and `ignore/` at k, `court-run.json`, `job.json`, and contact sheets to check by eye |
| `check_prepped.py` | After a run's views: are `prepped.mp4`'s 121 frames ours, in order, at 40 dB or better? |
| `court-submit.sh` | On HiPerGator: preflight, then one run's chain (views, three freeze caps + a metrics recon, exports, cleanups). K and FOCAL come from the run's `court-run.json` |
| `court-freeze.sbatch`, `court-export.sbatch`, `court-clean.sbatch` | The jobs it chains |
| `court-dryrun.sh` | Runs `court-submit.sh` here against a fake `$L` with `sbatch` and `blue_quota` stubbed, and prints the chain |

## Make the clips (Mac)

```bash
python3 -I pipeline/court/player_clip.py --config <private config> --measure-only   # union boxes, windows, fill
python3 -I pipeline/court/player_clip.py --config <private config>                  # all clip sets
```
Each run id in the config gets `<out>/runs/<id>/`: exactly the folder that goes to HiPerGator.
Look at `<out>/<set>/sheet.jpg`, `edge-<k>.png` and `k-vs-ref.png` before uploading.

## Upload and submit

```bash
# Mac, once per run id
pipeline/court/court-dryrun.sh <out>/runs/<id>                     # the exact chain, nothing submitted
rsync -a <out>/runs/<id>/ <hpg>:<L>/data/court/<id>/
# HiPerGator (the code synced to <L>/code/pipeline/court/ from a checkout of court-side)
bash <L>/code/pipeline/court/court-submit.sh <id>                   # full quality
VIEWS_ONLY=1 bash <L>/code/pipeline/court/court-submit.sh <id>      # the Turbo checks (job.json "turbo": true)
```
`court-submit.sh` submits nothing if a file is missing, the ids or the focal disagree, the run was submitted before,
or the group quota has less than `MIN_GB` (20) free.

## Tests

```bash
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v   # numpy, scipy, opencv, PyAV, ffmpeg
```
