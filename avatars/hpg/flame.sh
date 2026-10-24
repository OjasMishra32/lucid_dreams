# Sourced by head-swap.sbatch and blink.sbatch, after their env (python with numpy, hf or huggingface-cli): FLAME for
# blinks, once. Needs L and AV; sets FLAME_NPZ and says NO BLINKS loudly when FLAME can't be had.
# LAM is retired and its repo deleted, so FLAME's two files come on their own from LAM's
#    public assets (3DAIGC/LAM-assets, LAM_human_model.tar) through node-local space into models/flame; this env reads
#    FLAME's chumpy pickle without chumpy. Nothing of FLAME's leaves HiPerGator (its licence).
FL=$L/models/flame
FLAME_NPZ=$FL/flame2023_expr.npz
if [ ! -f "$FLAME_NPZ" ]; then
  mkdir -p "$FL"
  if [ ! -f "$FL/flame2023.pkl" ] || [ ! -f "$FL/FLAME_masks.pkl" ]; then
    X=${TMPDIR:-/tmp}/lam-human-$$
    mkdir -p "$X"
    echo "[expr] fetching FLAME 2023 from 3DAIGC/LAM-assets (LAM_human_model.tar, node-local, deleted after)"
    # `hf` replaced `huggingface-cli` (which no longer runs on HiPerGator); the same download works with either
    HFCLI=$(command -v hf || command -v huggingface-cli)
    if HF_HOME=$X/hf "$HFCLI" download 3DAIGC/LAM-assets LAM_human_model.tar --local-dir "$X" >/dev/null; then
      WANT=$(tar -tf "$X/LAM_human_model.tar" | grep -E 'flame_assets/flame/(flame2023|FLAME_masks)\.pkl$' || true)
      # shellcheck disable=SC2086  # two plain member paths
      [ -n "$WANT" ] && tar -xf "$X/LAM_human_model.tar" -C "$X" $WANT \
        && find "$X" \( -name flame2023.pkl -o -name FLAME_masks.pkl \) -exec cp {} "$FL/" \;
    fi
    rm -rf "$X"
  fi
  if [ -f "$FL/flame2023.pkl" ] && [ -f "$FL/FLAME_masks.pkl" ]; then
    TMP_NPZ=$FLAME_NPZ.tmp.$$.npz  # written whole, then moved: a killed or concurrent job never leaves half a file
    if python $AV/flame_expr_npz.py "$FL/flame2023.pkl" "$FL/FLAME_masks.pkl" "$TMP_NPZ"
    then mv -f "$TMP_NPZ" "$FLAME_NPZ"
    else rm -f "$TMP_NPZ"; echo "[expr] FLAME extract FAILED (see above): NO BLINKS for this head"
    fi
  else
    echo "[expr] NO FLAME: $FL/flame2023.pkl or FLAME_masks.pkl missing and the download failed: NO BLINKS"
  fi
fi
