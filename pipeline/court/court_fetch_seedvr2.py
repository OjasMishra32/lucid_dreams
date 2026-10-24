"""SeedVR2's 3B fp16 DiT and VAE into a folder (node-local scratch in court-job.sbatch), checked by SHA-256.

    python court_fetch_seedvr2.py <dir>        (in the seedvr2 venv; HF_HOME should point into scratch too)

The same two files and hashes as pipeline/hpg/setup-seedvr2.sbatch.
"""

import hashlib
import os
import sys

WANT = {"seedvr2_ema_3b_fp16.safetensors": "2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304",
        "ema_vae_fp16.safetensors": "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"}


def main(argv=None):
    from huggingface_hub import hf_hub_download

    d = (argv or sys.argv[1:])[0]
    os.makedirs(d, exist_ok=True)
    for name, sha in WANT.items():
        p = os.path.join(d, name)
        if not os.path.exists(p):
            hf_hub_download("numz/SeedVR2_comfyUI", name, local_dir=d)
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for b in iter(lambda: f.read(1 << 24), b""):
                h.update(b)
        if h.hexdigest() != sha:
            sys.exit(f"{name}: sha256 {h.hexdigest()} != {sha}")
        print(f"[seedvr2] {name} ok")


if __name__ == "__main__":
    main()
