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
| `extra_view.py` | Another calibrated camera's frame of the freeze, cropped natively around one player, with mask, ignore, focal and camera |
| `court-job.sbatch` | One run's whole freeze grid on one GPU node, in node-local scratch: views, SeedVR2 2x, per variant (`raw`/`up` x `default`/`agree`) a freeze per cap, a held-out metrics recon and an export; only results come back to `$L/runs/<id>/`. K and FOCAL are read from the uploaded `court-run.json` when each recon starts |
| `court-job-submit.sh` | Login node (bash and awk only): checks every run, then one `sbatch` per run |
| `court-grid.sh` | From the Mac: uploads the scripts and the run folders, then runs `court-job-submit.sh` there |
| `court_grid_report.py` | The numbers side by side (held-out PSNR/SSIM, real-frame PSNR, face, IoU, focal) |
| `court_fetch_seedvr2.py` | SeedVR2's weights into scratch, hash-checked |
| `court-dryrun.sh` | Runs a login-node script here against a fake `$L` with `sbatch` and `blue_quota` stubbed |

## Make the clips (Mac)

```bash
python3 -I pipeline/court/player_clip.py --config <private config> --measure-only   # union boxes, windows, fill
python3 -I pipeline/court/player_clip.py --config <private config>                  # all clip sets
```
Each run id in the config gets `<out>/runs/<id>/`: exactly the folder that goes to HiPerGator.
Look at `<out>/<set>/sheet.jpg`, `edge-<k>.png` and `k-vs-ref.png` before uploading.

## Upload and submit

With the HiPerGator session open (`ssh hpg true`):
```bash
PLAN=1 pipeline/court/court-grid.sh <out>/runs [id...]    # uploads, runs the checks, submits nothing
NGPU=4 pipeline/court/court-grid.sh <out>/runs [id...]    # one court-job per run; job ids printed
python3 <L>/code/pipeline/court/court_grid_report.py <L>/runs/court-*   # on a compute node or the Mac, once fetched
```
The winner's other caps: a new run id for the same set, with `VARIANTS=<views:mode> CAPS="250000 200000" METRICS=0`.

## Tests

```bash
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v   # numpy, scipy, opencv, PyAV, ffmpeg
```
