#!/bin/bash
# One-time: Practical-RIFE code (hzwer, MIT) + the v4.26 model into $L/models/rife/Practical-RIFE (about 30 MB).
# Login node is fine (two small downloads, no compute). Idempotent: does nothing if the model is already there.
# Sources: https://github.com/hzwer/Practical-RIFE (code: model/warplayer.py, model/loss.py) and the author's own
# Hugging Face upload https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip (22,869,906 bytes,
# sha256 1fa9b9cda3d9b8c3e301359e2595960902f97bf926c08598b0e9957a3f3f760e = its LFS oid), unpacked into train_log/.
# Prints any flownet.pkl already under $L/models or /data/ai/models first, so nothing is fetched twice.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}
D=$L/models/rife
R=$D/Practical-RIFE
SHA=1fa9b9cda3d9b8c3e301359e2595960902f97bf926c08598b0e9957a3f3f760e
if [[ -s $R/train_log/flownet.pkl && -s $R/model/warplayer.py ]]; then
  echo "RIFE_READY $R"; exit 0
fi
echo "existing RIFE models (any):"
find "$L/models" /data/ai/models -maxdepth 6 -iname 'flownet*.pkl' 2>/dev/null | sed 's/^/  /' || true
mkdir -p "$D"
T=$(mktemp -d "${TMPDIR:-/tmp}/rife-fetch.XXXXXX")  # local temp, never on /blue
trap 'rm -rf "$T"' EXIT
git clone --depth 1 https://github.com/hzwer/Practical-RIFE.git "$T/Practical-RIFE"
curl -fL --retry 3 -o "$T/RIFEv4.26_0921.zip" https://huggingface.co/hzwer/RIFE/resolve/main/RIFEv4.26_0921.zip
echo "$SHA  $T/RIFEv4.26_0921.zip" | sha256sum -c -
mkdir -p "$T/unz" && unzip -q "$T/RIFEv4.26_0921.zip" -d "$T/unz" -x '__MACOSX/*' '*.pyc' '*.DS_Store'
mkdir -p "$T/Practical-RIFE/train_log"
cp "$T/unz/RIFEv4.26_0921/"{flownet.pkl,IFNet_HDv3.py,RIFE_HDv3.py,refine.py} "$T/Practical-RIFE/train_log/"
[[ -e $R ]] && { echo "rife_setup: $R exists but is incomplete; move it aside by hand (nothing is deleted)"; exit 1; }
cp -r "$T/Practical-RIFE" "$R"
du -sh "$R"
echo "RIFE_READY $R (v4.26, git $(git -C "$R" rev-parse --short HEAD))"
