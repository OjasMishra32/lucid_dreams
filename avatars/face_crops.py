#!/usr/bin/env python3
"""A consenting person's photos -> face close-ups, the folder UIKA reads (avatars/hpg/uika-head.sbatch).

    python face_crops.py --name vishal --photos data/avatars/photos/vishal --out data/avatars/faces/vishal \
        --insightface-root models/insightface

Each photo's face is found by InsightFace (buffalo_l, on the CPU; found on a 1600 px copy, cut from the full-resolution
photo) and cut square round the head, with room for the hair and the chin, at most 1024 px. A photo with no face (a
back view) is left out. Writes <photo>.jpg and faces.json (the box and detector score of each, and what was skipped).
Consenting people only (AGENTS.md rule 5): the name must be in lucid_avatars.head_swap.CONSENTED; never a public figure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True, help="the consenting person (head_swap.CONSENTED)")
    p.add_argument("--photos", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--insightface-root", type=Path, default=Path.home() / ".insightface")
    p.add_argument("--margin", type=float, default=2.3, help="crop side / the face box's longer side")
    p.add_argument("--max-side", type=int, default=1024)
    a = p.parse_args()

    from lucid_avatars.head_swap import CONSENTED

    if a.name not in CONSENTED:
        sys.exit(f"REFUSED: {a.name} is not in head_swap.CONSENTED (consenting people only)")

    import cv2
    import numpy as np
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name="buffalo_l", root=str(a.insightface_root), providers=["CPUExecutionProvider"], allowed_modules=["detection"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    a.out.mkdir(parents=True, exist_ok=True)
    report: dict = {"name": a.name, "faces": {}, "skipped": []}
    for f in sorted(x for x in a.photos.iterdir() if x.suffix.lower() in {".jpg", ".jpeg", ".png"}):
        img = cv2.imread(str(f))
        if img is None:
            report["skipped"].append({"photo": f.name, "why": "unreadable"})
            continue
        h, w = img.shape[:2]
        s = min(1.0, 1600 / max(h, w))
        small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img
        faces = app.get(small)
        if not faces:
            report["skipped"].append({"photo": f.name, "why": "no face (a back view)"})
            continue
        face = max(faces, key=lambda d: (d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]))
        x0, y0, x1, y1 = (np.asarray(face.bbox) / s).tolist()
        side = a.margin * max(x1 - x0, y1 - y0)
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2 - 0.1 * (y1 - y0)  # a little up: the hair matters more than the neck
        l, t = int(round(cx - side / 2)), int(round(cy - side / 2))
        r, b = int(round(cx + side / 2)), int(round(cy + side / 2))
        pad = [max(0, -t), max(0, b - h), max(0, -l), max(0, r - w)]
        crop = cv2.copyMakeBorder(img, *pad, cv2.BORDER_REPLICATE)[t + pad[0] : b + pad[0], l + pad[2] : r + pad[2]]
        if crop.shape[0] > a.max_side:
            crop = cv2.resize(crop, (a.max_side, a.max_side), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(a.out / f"{f.stem}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 95])
        report["faces"][f.name] = {"box": [round(v, 1) for v in (x0, y0, x1, y1)], "score": round(float(face.det_score), 3), "side": int(side)}
        print(f"[faces] {f.name}: face {int(x1 - x0)} x {int(y1 - y0)} px, crop {int(side)} px, score {face.det_score:.2f}")
    (a.out / "faces.json").write_text(json.dumps(report, indent=1))
    print(f"FACES_OK {len(report['faces'])} faces, {len(report['skipped'])} skipped")


if __name__ == "__main__":
    main()
