# Shared environment for every Lucid Dreams job on HiPerGator. Source it; don't run it.
export L=/blue/iruchkin/vishalnaveen/lucid
export HF_HOME=$L/cache/hf PIP_CACHE_DIR=$L/cache/pip
module load conda/26.7 cuda/12.8.1 >/dev/null 2>&1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
export PYTHONPATH=$L/code/pipeline:$L/repos/4DAnyone:${PYTHONPATH:-}
