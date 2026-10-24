# Court Side show bake: RIFE in-betweens on HiPerGator

The show needs in-between frames wherever a 72 Hz or 90 Hz display time falls between two real captures (pass 1 at
real speed, the eases, the resume ramp, the strobe replacements). `rife_needs.py` lists them from bake-core's
timeline, `rife.sbatch` makes them with Practical-RIFE v4.26 on one GPU, and the bake reads them through
`interp.Inbetweens` (`Source.from_config` with `rife_dir` set). Without the results the bake falls back to DIS flow on
the Mac.

RIFE runs on the **raw** source frames (the decoded 1080p frames, watermark and lens distortion still in). The bake
removes the watermark and undistorts each in-between afterwards, using the in-between's own interpolated focal
(`source.py`), just as it does for real frames. So nothing has to be preprocessed before the upload.

Private inputs and outputs (frame lists, frames, results) stay in the private data folder and under `$L`, never in
git. Below, `P` is the private bake folder's `rife/` and `FRAMES` the decoded 1080p source frames (the main session
has both paths).

## Files
| File | Where it runs | What it does |
| --- | --- | --- |
| `rife_needs.py` | Mac | `needs.json` (each `{a, b, w, out}`, 24 held-out checks `{a, m, c, w}`) and `frames.txt` (the frame files to upload) |
| `rife_setup.sh` | HPG login node, once | Practical-RIFE code (github.com/hzwer/Practical-RIFE, MIT) + v4.26 weights (the author's Hugging Face upload `hzwer/RIFE`, `RIFEv4.26_0921.zip`, 22.9 MB, sha256 checked) into `$L/models/rife/Practical-RIFE` (~30 MB). Prints any `flownet.pkl` already under `$L/models` or `/data/ai/models` first. Idempotent. |
| `rife.sbatch` | GPU node | Stages everything in node-local `$TMPDIR`, runs `rife_run.py`, copies only results to `$L/runs/$ID/out/`. Deletes nothing on /blue. |
| `rife_run.py` | GPU node | Writes every listed in-between (JPEG q93, 4:4:4), scores the held-out checks (`checks.json`: RIFE vs dissolve PSNR against the real middle frame), then writes `done.json`. Resumes if rerun. |

## Exact lines (the main session runs them; Vishal holds the connection)
```bash
WT=<this checkout>; L=/blue/iruchkin/vishalnaveen/lucid; P=<private bake dir>/rife; FRAMES=<decoded 1080p frames>

# 0. Mac: the list (play_start is the private config's; rerun if the timeline changes)
python3 "$WT/pipeline/court/bake/hpg/rife_needs.py" --play-start <play_start> --out $P --frames-dir $FRAMES

# 1. code (3 files)
ssh hpg "mkdir -p $L/code/pipeline/court/bake/hpg $L/data/court/court-rife $L/runs/court-rife"
rsync -av "$WT/pipeline/court/bake/hpg/"{rife_run.py,rife.sbatch,rife_setup.sh} hpg:$L/code/pipeline/court/bake/hpg/

# 2. inputs: the frames stream as one tar (no copy on the Mac's disk), plus the list
tar -cf - -C $FRAMES -T $P/frames.txt | ssh hpg "cat > $L/data/court/court-rife/frames.tar"
rsync -av $P/needs.json hpg:$L/data/court/court-rife/

# 3. model, once (login node: two small downloads, prints RIFE_READY)
ssh hpg "bash $L/code/pipeline/court/bake/hpg/rife_setup.sh"

# 4. submit (log court-rife-<job>.log lands in $L/runs/court-rife/)
ssh hpg "cd $L/runs/court-rife && sbatch --export=ALL,ID=court-rife $L/code/pipeline/court/bake/hpg/rife.sbatch"

# 5. results back to the Mac
rsync -av hpg:$L/runs/court-rife/out/ $P/out/
```
Then set `"rife_dir": "<P>/out"` in the private bake_config.json.

What to check in the log: `torch ... cuda True`, `[rife] Practical-RIFE 4.25 ...`, `held-out checks: PSNR X dB
(dissolve Y dB)` (X should clearly beat Y), and `RIFE_OK`. (`Model.version` in the 4.26 model file says 4.25. That is
the author's own label; the sha256 in `done.json` identifies the file.)

Sizes: upload a few hundred MB of 1080p JPEGs (`rife_needs.py` prints `upload_mb`) + ~30 MB model; results ~0.4 MB
per in-between. Footprint on
/blue is under 1 GB, well inside the ~13 GB quota. Expected runtime: a few minutes on a B200 or RTX PRO 6000 (RIFE at
1080p takes tens of ms per frame; most of the time is conda activation and JPEG I/O). Walltime is set to 45 min.

To rerun with another list, use a new id (`ID=court-rife-2`, with its own `$L/data/court/court-rife-2/`). The job
refuses to overwrite an existing `out/done.json`.
