"""The GPU half of the head swap: the new bundle's turntable (preview.mp4, thumb.jpg), the side-by-side that says
whether the face reads as the person (compare.png: photo | old face | new face, front and 3/4), how much each
face looks like the photo (InsightFace ArcFace cosine, when InsightFace is installed) in head_swap.json and
dream.json metrics.identity, and, when the bundle has avatar/expr.bin, blink.png (the face open and shut through
expr.bin's blink channel, with the eyes zoomed) so a person checks the blink before anyone sees it.

4DAnyone env (gsplat and lucid.export's renderer), with this folder on PYTHONPATH for lucid_avatars:
  python head_swap_render.py --old dreams/vishal --new dreams/vishal-head --photos heads/vishal/colour --person vishal
hpg/head-swap.sbatch runs it after `python -m lucid_avatars head-swap`. Both bundles are drawn in their rest pose,
which faces +Z (SMPL-X's), so the faces line up view for view.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

from lucid_avatars.bundle import validate_bundle
from lucid_avatars.face_expr import BLINK, N_CHANNELS, apply_expr, read_expr_bin
from lucid_avatars.head_swap import consent_errors, dream_id_of
from lucid_avatars.skinning import SKELETON_FILE
from lucid_avatars.smplx_layout import J

FRONT = math.pi  # lucid.export.orbit_camera's angle 0 sits on -Z, behind a body facing +Z
THREE_QUARTER = FRONT - math.pi / 4
TAN_HALF_FOV = math.tan(math.radians(40.0) / 2)  # lucid.export.render's vertical field of view
FACE_PX = 512
FACE_HALF_M = 0.17  # half the height a face view shows: chin to crown with a little neck and hair
FACE_ABOVE_HEAD_JOINT_M = 0.07  # SMPL-X's head joint is at the top of the neck; the face's middle is above it
TURNTABLE_FILL = 1.2  # the body's height times this fills the frame's height
LABEL_PX = 28
EYES_BOX = (0.25, 0.35, 0.30)  # top, left, side of the eyes in a face view, as shares of its size


def framing(xyz: np.ndarray, opacity_logit: np.ndarray) -> tuple[float, float, tuple[float, float]]:
    """(visible height, middle y, (x, z) centre) of the Gaussians with alpha >= 0.5 (all of them if under 100)."""
    solid = xyz[opacity_logit >= 0] if (opacity_logit >= 0).sum() >= 100 else xyz
    y = solid[:, 1]
    centre = np.median(solid[:, [0, 2]], axis=0)
    return float(np.ptp(y)), float((y.min() + y.max()) / 2), (float(centre[0]), float(centre[1]))


def face_target(head_joint: np.ndarray) -> tuple[float, tuple[float, float], float]:
    """(target y, (x, z) centre, radius) for a level close-up of the face."""
    return float(head_joint[1] + FACE_ABOVE_HEAD_JOINT_M), (float(head_joint[0]), float(head_joint[2])), \
        FACE_HALF_M / TAN_HALF_FOV


def square(img, px: int) -> np.ndarray:
    """The photo's centre square at px x px, RGB uint8 (LAM's photos are close-ups, so the face is in the middle)."""
    from PIL import Image

    img = img.convert("RGB")
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    return np.asarray(img.crop((left, top, left + side, top + side)).resize((px, px), Image.LANCZOS))


def grid(rows: list[list[np.ndarray]], labels: list[str]):
    """Equal-size RGB tiles in rows, a label strip over each column (a PIL image)."""
    from PIL import Image, ImageDraw

    h, w = rows[0][0].shape[:2]
    out = Image.new("RGB", (w * len(labels), LABEL_PX + h * len(rows)), (0, 0, 0))
    draw = ImageDraw.Draw(out)
    for c, text in enumerate(labels):
        draw.text((c * w + 8, 6), text, fill=(235, 235, 235))
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            out.paste(Image.fromarray(tile), (c * w, LABEL_PX + r * h))
    return out


def with_expr(g, bundle: Path, dream: dict, expr: np.ndarray):
    """The rest-pose Gaussians (lucid.gaussians) with one motion frame's expression added from the bundle's expr.bin,
    exactly as a player adds it (face_expr.apply_expr)."""
    from dataclasses import replace

    first, d = read_expr_bin(bundle / dream["avatar"]["expr"])
    return replace(g, means=apply_expr(g.means, first, d, expr).astype(np.float32))


def eyes(face: np.ndarray) -> np.ndarray:
    """The eyes of a face view (face_target's framing), zoomed back to the view's size by repeating pixels: an
    inspection image, so no smoothing hides what the Gaussians did."""
    h, w = face.shape[:2]
    top, left, side = (int(round(f * h)) for f in EYES_BOX)
    rows = top + np.arange(h) * side // h
    cols = left + np.arange(w) * side // w
    return face[rows[:, None], cols[None, :]]


def identity_report(embeddings: dict[str, np.ndarray]) -> dict | None:
    """Cosine of the old and new faces' ArcFace embeddings to the photo's (None without a face in the photo)."""
    if "photo" not in embeddings:
        return None
    p = embeddings["photo"] / np.linalg.norm(embeddings["photo"])
    cos = {k: round(float(p @ (v / np.linalg.norm(v))), 4) for k, v in embeddings.items() if k != "photo"}
    return {"model": "InsightFace buffalo_l (ArcFace), cosine to the photo, front view", "old": cos.get("old"),
            "new": cos.get("new")}


def embed_faces(images: dict[str, np.ndarray], root: Path) -> dict[str, np.ndarray] | None:
    """ArcFace embedding of the biggest face in each image, or None if InsightFace isn't installed."""
    try:
        from insightface.app import FaceAnalysis
    except ImportError:
        return None
    app = FaceAnalysis(name="buffalo_l", root=str(root), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
    out = {}
    for key, rgb in images.items():
        faces = app.get(np.ascontiguousarray(rgb[..., ::-1]))  # InsightFace wants BGR
        if faces:
            out[key] = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])).normed_embedding
        else:
            print(f"[identity] no face found in the {key} image")
    return out


def load(bundle: Path):
    """(dream.json, the rest-pose Gaussians for lucid.export.render, the head joint)."""
    from lucid.gaussians import read_ply

    dream = json.loads((bundle / "dream.json").read_text())
    av = dream["avatar"]
    rest = np.asarray(json.loads((bundle / av.get("skeleton", SKELETON_FILE)).read_text())["rest"], dtype=np.float64)
    return dream, read_ply(bundle / av["file"]), rest[J["head"]]


def photo_for(report: dict, photos: Path, person: str) -> Path:
    """The colour photo LAM saw for this head (lam-head.sbatch names LAM's inputs <person>-<photo>), and no other:
    the identity score is against it."""
    stem = report.get("headPhoto", "")
    named = photos / f"{stem.removeprefix(f'{person}-')}.jpg"
    if not stem.startswith(f"{person}-") or not named.is_file():
        raise SystemExit(f"the photo behind LAM head {stem!r} isn't {photos}/<photo>.jpg (or isn't {person}'s)")
    return named


def gate(person: str, old: Path, new: Path) -> list[str]:
    """The swap's consent checks again, on both bundles, plus: new is a head swap made from old."""
    errors = consent_errors(person, old) + consent_errors(person, new)
    report = new / "head_swap.json"
    if not report.is_file():
        return errors + [f"{new} has no head_swap.json: not a head swap"]
    if json.loads(report.read_text()).get("from") != dream_id_of(old):
        errors.append(f"{new.name} wasn't made from {old.name}")
    return errors


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--old", type=Path, required=True, help="the source avatar bundle (the guessed face)")
    p.add_argument("--new", type=Path, required=True, help="the head-swapped bundle from `lucid_avatars head-swap`")
    p.add_argument("--photos", type=Path, required=True, help="the colour photos LAM saw (heads/<person>/colour)")
    p.add_argument("--person", required=True)
    p.add_argument("--insightface-root", type=Path, default=Path.home() / ".insightface")
    p.add_argument("--preview-size", default="1080x1920")
    p.add_argument("--seconds", type=float, default=4.0)
    p.add_argument("--device", default="cuda")
    a = p.parse_args()

    refused = gate(a.person, a.old, a.new)
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2
    report = json.loads((a.new / "head_swap.json").read_text())
    photo_path = photo_for(report, a.photos, a.person)

    from lucid.export import orbit_camera, render
    from PIL import Image

    bg = np.zeros(3)
    _, old, _ = load(a.old)
    dream, new, head = load(a.new)

    # turntable of the new avatar, front first (the thumbnail)
    w, h = (int(v) for v in a.preview_size.split("x"))
    height, middle_y, centre = framing(new.means, new.opacities)
    radius = TURNTABLE_FILL * height / 2 / TAN_HALF_FOV
    part = a.new / "preview.part.mp4"  # renamed once whole, so a failed run never leaves a broken preview
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", "30", "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", str(part)],
        stdin=subprocess.PIPE,
    )
    try:
        n = int(a.seconds * 30)
        for k in range(n):
            frame = render(new, orbit_camera(FRONT + 2 * math.pi * k / n, radius, middle_y, middle_y, centre), w, h,
                           bg, a.device)
            if k == 0:
                Image.fromarray(frame).save(a.new / "thumb.jpg", quality=92)
            ff.stdin.write(frame.tobytes())
        ff.stdin.close()
    except BrokenPipeError:
        pass  # ffmpeg died; its exit code below says so
    except BaseException:
        ff.kill()
        part.unlink(missing_ok=True)
        raise
    if ff.wait() != 0:
        part.unlink(missing_ok=True)
        raise SystemExit("ffmpeg failed writing preview.mp4")
    part.replace(a.new / "preview.mp4")

    # the side-by-side: photo | old face | new face, front and 3/4
    target_y, face_centre, face_r = face_target(head)
    photo = square(Image.open(photo_path), FACE_PX)
    views = {}
    for view, angle in (("front", FRONT), ("3/4", THREE_QUARTER)):
        vm = orbit_camera(angle, face_r, target_y, target_y, face_centre)
        views[view] = [render(g, vm, FACE_PX, FACE_PX, bg, a.device) for g in (old, new)]
    grid([[photo, *views["front"]], [photo, *views["3/4"]]],
         ["photo", f"old face ({report['from']})", "new face (LAM head)"]).save(a.new / "compare.png")

    if dream["avatar"].get("expr"):
        front = orbit_camera(FRONT, face_r, target_y, target_y, face_centre)
        shut = render(with_expr(new, a.new, dream, np.eye(N_CHANNELS)[BLINK]), front, FACE_PX, FACE_PX, bg, a.device)
        is_open = views["front"][1]
        grid([[is_open, shut], [eyes(is_open), eyes(shut)]], ["eyes open", "blink = 1 (expr.bin)"]).save(
            a.new / "blink.png")
        print(f"[expr] blink.png written; fit: {report.get('expr', {}).get('blink')}")

    embeddings = embed_faces({"photo": photo, "old": views["front"][0], "new": views["front"][1]}, a.insightface_root)
    identity = identity_report(embeddings) if embeddings is not None else None
    if embeddings is None:
        print("[identity] skipped: InsightFace isn't installed in this env (pip install insightface onnxruntime-gpu)")
    elif identity is None:
        print("[identity] skipped: no face found in the photo")
    else:
        print(f"[identity] ArcFace cosine to the photo: old face {identity['old']}, new face {identity['new']}")

    report["identity"] = identity
    (a.new / "head_swap.json").write_text(json.dumps(report, indent=2) + "\n")
    dream.update(preview="preview.mp4", thumb="thumb.jpg")
    dream["metrics"] = {**dream.get("metrics", {}), "identity": identity["new"] if identity else None}
    (a.new / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")

    problems = validate_bundle(a.new)
    for problem in problems:
        print(f"[bundle] {problem}")
    print(f"{'BUNDLE_FAIL' if problems else 'BUNDLE_OK'} {a.new}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
