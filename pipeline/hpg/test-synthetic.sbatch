#!/bin/bash
#SBATCH --job-name=lucid-test-synth
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=00:45:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# End-to-end check without 4DAnyone: synthetic person -> per-frame reconstruction -> dream bundle.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
T=$L/data/out/synthetic
rm -rf $T && mkdir -p $T
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python -m lucid.synthetic --out $T/prepared --frames 4 --views 24
python -m lucid.recon --prepared $T/prepared --out $T/recon --iters-first 3000 --iters-warm 800 --cap 120000 --holdout-every 6
python -m lucid.export --recon $T/recon --out $T/bundle --id synthetic-test --name "Synthetic test" --fps 25
ls -la $T/bundle $T/bundle/frames | head -20
cat $T/bundle/dream.json
echo TEST_OK
