#!/bin/bash
#SBATCH --job-name=lucid-avatar
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=01:00:00
#SBATCH --output=%x-%j.log
# Avatar runs: one photo -> an avatar dream bundle, through Vishal's avatars/hpg/digs-sample.sbatch. Needs RUN.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
cd "$RUN"
export PYTHONPATH=$L/code/pipeline:${PYTHONPATH:-}
python3 -m lucid.status mark "$RUN" reconstruct running
read -r ID NAME < <(python3 - <<'PY'
import json; j = json.load(open("job.json")); print(j["id"], json.dumps(j.get("name", j["id"])))
PY
)
PHOTO=$(ls input.* | head -1)
IMAGE="$RUN/$PHOTO" ID="$ID" NAME="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]))" "$NAME")" OUT="$RUN/out" \
  bash $L/repos/lucid_dreams/avatars/hpg/digs-sample.sbatch || { python3 -m lucid.status mark "$RUN" reconstruct failed; exit 1; }
rm -rf bundle && mv "out/$ID" bundle
if [ -f "out/$ID.work/reality.ply" ]; then  # seen vs imagined: what the photo didn't see, tinted blue
  cp "out/$ID.work/reality.ply" bundle/avatar/reality.ply
  python3 - <<'PY'
import json
d = json.load(open("bundle/dream.json"))
d["avatar"]["reality"] = "avatar/reality.ply"
json.dump(d, open("bundle/dream.json", "w"), indent=2)
PY
fi
python3 -m lucid.status mark "$RUN" reconstruct done
python3 -m lucid.status mark "$RUN" export done
