"""Darken a crown the camera only saw lit from above (or never saw): pull the head's low-saturation hair Gaussians above
the eyes toward the darkness of the person's own hair at the temples, so a seated viewer looking down (chess) sees
hair, not a gray cap. Faces, skin and the hairline below `--from` are untouched; the change fades in over `--ramp` metres
so there is no seam. The same scaling goes into reality.ply wherever that Gaussian isn't tinted as imagined.

  avatars/.venv/bin/python avatars/hair_tone.py dreams/vishal [--from 0.03 --ramp 0.04 --keep 0.35 --all-above 0.09 --dry]

Prints the hair's luminance by height before and after.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lucid_avatars.skinning import read_skin_bin  # noqa: E402

C0 = 0.28209479
HEAD_JOINTS = [15, 22, 23, 24]  # head, jaw, eyes (SMPL-X)


def load(path: Path):
    raw = path.read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    names = [l.split()[-1].decode() for l in raw[:end].split(b"\n") if l.startswith(b"property")]
    data = np.frombuffer(raw[end:], dtype=np.float32).reshape(-1, len(names)).copy()
    return raw[:end], names, data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", type=Path)
    ap.add_argument("--from", dest="start", type=float, default=0.03, help="metres above the eyes where it starts")
    ap.add_argument("--ramp", type=float, default=0.04, help="metres over which it fades in")
    ap.add_argument("--keep", type=float, default=0.35, help="share of the brightness above the reference kept")
    ap.add_argument("--sat", type=float, default=0.07, help="only Gaussians this grey (max-min of RGB) or greyer")
    ap.add_argument("--all-above", type=float, default=0.09, help="metres above the eyes where any colour is hair (no skin)")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    av = a.bundle / "avatar"
    header, names, d = load(av / "avatar.ply")
    col = {n: i for i, n in enumerate(names)}
    dc = [col["f_dc_0"], col["f_dc_1"], col["f_dc_2"]]
    rgb = np.clip(0.5 + C0 * d[:, dc], 0, 1)
    alpha = 1 / (1 + np.exp(-d[:, col["opacity"]]))
    idx, w = read_skin_bin(av / "skin.bin")
    dom = idx[np.arange(len(idx)), np.argmax(w, 1)]
    rest = np.array(json.loads((av / "skeleton.json").read_text())["rest"])
    eye_y = (rest[23][1] + rest[24][1]) / 2
    y = d[:, col["y"]]
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    sat = rgb.max(1) - rgb.min(1)
    head = np.isin(dom, HEAD_JOINTS)

    temples = head & (y > eye_y + 0.01) & (y < eye_y + 0.05) & (sat < a.sat) & (alpha > 0.3)
    ref = float(np.median(lum[temples]))
    hair = head & (y > eye_y + a.start) & ((sat < a.sat) | (y > eye_y + a.all_above))
    t = np.clip((y - eye_y - a.start) / a.ramp, 0, 1)
    target = np.where(lum > ref, ref + (lum - ref) * a.keep, lum)
    new_lum = lum + (target - lum) * t
    scale = np.where(hair & (lum > 1e-4), new_lum / np.maximum(lum, 1e-4), 1.0)
    new_rgb = np.clip(rgb * scale[:, None], 0, 1)

    def table(L, label):
        print(label)
        for lo in np.arange(0.0, 0.14, 0.02):
            m = head & (y >= eye_y + lo) & (y < eye_y + lo + 0.02) & (alpha > 0.3)
            if m.sum() >= 20:
                print(f"  eyes {lo:+.2f} m  n {m.sum():5d}  lum {L[m].mean():.3f}  lighter than 0.30: {np.mean(L[m] > 0.30):.2f}")

    print(f"reference (temples) luminance {ref:.3f}, hair Gaussians changed {int((hair & (scale < 0.999)).sum())}")
    table(lum, "before")
    table(new_rgb @ np.array([0.299, 0.587, 0.114]), "after")
    if a.dry:
        return
    changed = hair & (scale < 0.999)
    d[np.ix_(changed, dc)] = (new_rgb[changed] - 0.5) / C0
    (av / "avatar.ply").write_bytes(header + d.astype(np.float32).tobytes())
    rh, _, rd = load(av / "reality.ply")
    r_rgb = np.clip(0.5 + C0 * rd[:, dc], 0, 1)
    untinted = np.abs(r_rgb - rgb).sum(1) < 0.02
    m = changed & untinted
    rd[np.ix_(m, dc)] = (new_rgb[m] - 0.5) / C0
    (av / "reality.ply").write_bytes(rh + rd.astype(np.float32).tobytes())
    note = {"hairTone": {"reference": round(ref, 4), "changed": int(changed.sum()), "realityChanged": int(m.sum()),
                         "from": a.start, "ramp": a.ramp, "keep": a.keep, "sat": a.sat, "allAbove": a.all_above}}
    (a.bundle / "hair_tone.json").write_text(json.dumps(note, indent=2) + "\n")
    print("written", note)


if __name__ == "__main__":
    main()
