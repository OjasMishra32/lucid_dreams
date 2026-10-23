#!/bin/bash
#SBATCH --job-name=lucid-test-export
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --time=00:20:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Re-runs only the export step on the synthetic test's reconstruction.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
T=$L/data/out/synthetic
rm -rf $T/bundle
python -m lucid.export --recon $T/recon --out $T/bundle --id synthetic-test --name "Synthetic test" --fps 25
ls -la $T/bundle $T/bundle/frames | head -20
cat $T/bundle/dream.json
echo TEST_OK
