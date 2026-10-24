"""Look at an avatar bundle from every side before anyone else does: renders and numbers that find its hiccups.

    python avatar_audit.py <bundle> [<bundle> ...] --out <folder> [--label a,b]

For each bundle, posed by its own skin.bin (gsplat, the way the players pose it):
  standing  the idle's first frame, from 0, 45, ..., 315 degrees round the person (0 = in front)
  seated    the chess opponent's seated pose (lucid_avatars.idle.seated_idle), the same eight angles
  close-ups hands (seated, from across the table), collar and neck seam (front, side, back), jacket hem and hips
            (front, back), knees and crotch (seated front, standing front), shoes and ankles (front, side), back of
            the head (135, 180), under the arms (seated, both sides)
Each view is drawn twice: colour on grey, and its alpha with every half-transparent pixel inside the person painted
magenta (see-through patches, holes; a soft one-pixel outline is normal). With two or more bundles the sheets put
them side by side, view for view (before | after).

Numbers (audit.json, and the console): Gaussians that float (far from their 8 nearest neighbours), oversized ones,
needles (long and thin), large faint ones (the stuff of smoke and see-through patches), and in the seated pose the
ones the linear-blend skinning squashes or stretches (the blended joint transform far from a rotation), each by body
part. Run with the avatars env that has gsplat (UIKA's or LHM++'s), from anywhere.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lucid_avatars import skinning as S  # noqa: E402
from lucid_avatars.gaussian_ply import SH_C0, read_ply  # noqa: E402
from lucid_avatars.idle import seated_idle  # noqa: E402
from lucid_avatars.motion import Motion  # noqa: E402
from lucid_avatars.smplx_layout import J  # noqa: E402

ANGLES = tuple(range(0, 360, 45))
GREY = 0.55
PARTS = {
    "head": ("head", "jaw", "left_eye", "right_eye", "neck"),
    "torso": ("pelvis", "spine1", "spine2", "spine3", "left_collar", "right_collar"),
    "arms": ("left_shoulder", "right_shoulder", "left_elbow", "right_elbow"),
    "hands": ("left_wrist", "right_wrist"),
    "legs": ("left_hip", "right_hip", "left_knee", "right_knee"),
    "feet": ("left_ankle", "right_ankle", "left_foot", "right_foot"),
}


def part_of(dom: np.ndarray) -> np.ndarray:
    names = np.full(len(dom), "hands", dtype=object)  # finger joints (25..54) are hands
    for part, joints in PARTS.items():
        names[np.isin(dom, [J[j] for j in joints])] = part
    return names


class Bundle:
    def __init__(self, root: Path):
        self.root = root
        self.dream = json.loads((root / "dream.json").read_text())
        av = self.dream["avatar"]
        self.g = read_ply(root / av["file"])
        self.idx, self.q = S.read_skin_bin(root / av["skin"])
        self.rest = np.asarray(json.loads((root / av["skeleton"]).read_text())["rest"], dtype=np.float64)
        self.motion = Motion.load(root / av["motion"])
        self.dom = self.idx[np.arange(len(self.idx)), np.argmax(self.q, 1)].astype(int)
        self.part = part_of(self.dom)

    def matrices(self, seated: bool) -> np.ndarray:
        if seated:
            m = seated_idle(self.rest, self.motion.betas, seconds=1.0)
            return S.skin_matrices(self.rest, m.root_q[0], m.root_t[0], m.pose[0])
        m = self.motion
        return S.skin_matrices(self.rest, m.root_q[0], m.root_t[0], m.pose[0])

    def posed(self, M: np.ndarray) -> dict:
        """gsplat inputs for the bundle posed by skin matrices M, plus the blended 3x3 per Gaussian."""
        import torch
        from pytorch3d.transforms import matrix_to_quaternion, quaternion_multiply

        dev = "cuda"
        w = torch.as_tensor(self.q, dtype=torch.float32, device=dev) / 255
        Mt = torch.as_tensor(M, dtype=torch.float32, device=dev)[torch.as_tensor(self.idx.astype(np.int64), device=dev)]
        B = torch.einsum("nk,nkab->nab", w, Mt)
        xyz = torch.as_tensor(self.g.xyz, dtype=torch.float32, device=dev)
        means = torch.einsum("nab,nb->na", B[:, :3, :3], xyz) + B[:, :3, 3]
        U, sv, Vh = torch.linalg.svd(B[:, :3, :3])
        quats = quaternion_multiply(matrix_to_quaternion(U @ Vh), torch.nn.functional.normalize(
            torch.as_tensor(self.g.rotation, dtype=torch.float32, device=dev), dim=-1))
        g = self.g
        if g.sh_degree == 0:
            colors, deg = (0.5 + SH_C0 * torch.as_tensor(g.f_dc, dtype=torch.float32, device=dev)).clamp_min(0), None
        else:
            rest_c = torch.as_tensor(g.f_rest, dtype=torch.float32, device=dev).reshape(len(g), 3, -1).transpose(1, 2)
            colors = torch.cat([torch.as_tensor(g.f_dc, dtype=torch.float32, device=dev)[:, None], rest_c], 1)
            deg = g.sh_degree
        return dict(means=means, quats=quats, scales=torch.exp(torch.as_tensor(g.scale, dtype=torch.float32, device=dev)),
                    opacities=torch.sigmoid(torch.as_tensor(g.opacity, dtype=torch.float32, device=dev)),
                    colors=colors, sh_degree=deg, sv=sv.cpu().numpy(), means_np=means.cpu().numpy())


def look_at(eye, target) -> np.ndarray:
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    z = target - eye
    z /= np.linalg.norm(z)
    up = np.array([0.0, 1.0, 0.0]) if abs(z[1]) < 0.95 else np.array([0.0, 0.0, -1.0])
    x = np.cross(z, up)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    V = np.eye(4)
    V[:3, :3] = np.stack([x, y, z])
    V[:3, 3] = -V[:3, :3] @ eye
    return V


def eye_at(target, distance: float, angle_deg: float, elev_deg: float = 0.0) -> np.ndarray:
    """A camera `angle_deg` round +Y from straight in front of a person who faces -Z, `elev_deg` up."""
    a, e = math.radians(angle_deg), math.radians(elev_deg)
    return np.asarray(target, float) + distance * np.array([-math.sin(a) * math.cos(e), math.sin(e),
                                                            -math.cos(a) * math.cos(e)])


def render(gs: dict, eye, target, size, fov_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """(colour on grey uint8 (H, W, 3), alpha view uint8: grey person, magenta where 5-85% transparent)."""
    import torch
    from gsplat import rasterization

    W, H = size
    f = (H / 2) / math.tan(math.radians(fov_deg) / 2)
    K = torch.tensor([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], dtype=torch.float32, device="cuda")
    V = torch.as_tensor(look_at(eye, target), dtype=torch.float32, device="cuda")
    with torch.no_grad():
        img, alpha, _ = rasterization(gs["means"], gs["quats"], gs["scales"], gs["opacities"], gs["colors"], V[None],
                                      K[None], W, H, near_plane=0.02, sh_degree=gs["sh_degree"],
                                      backgrounds=torch.full((1, 3), GREY, device="cuda"))
    rgb = (img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    a = alpha[0, ..., 0].cpu().numpy()
    av = np.full((H, W, 3), 255, np.uint8)
    av[a > 0.05] = (np.clip(1 - a[a > 0.05, None], 0, 1) * 255).astype(np.uint8).repeat(3, -1)
    av[(a > 0.05) & (a < 0.85)] = (230, 0, 200)
    return rgb, av


def views(b: Bundle) -> tuple[dict, dict]:
    out, numbers = {}, {}
    for seated in (False, True):
        M = b.matrices(seated)
        gs = b.posed(M)
        P = gs["means_np"]
        Mj = lambda j: (M[J[j]] @ np.r_[b.rest[J[j]], 1.0])[:3]  # noqa: E731  posed joint
        solid = P[(gs["opacities"] > 0.5).cpu().numpy()]
        mid = np.array([np.median(solid[:, 0]), (solid[:, 1].max() + solid[:, 1].min()) / 2, np.median(solid[:, 2])])
        height = float(np.ptp(solid[:, 1]))
        key = "seat" if seated else "stand"
        for a in ANGLES:
            out[f"{key}_{a:03d}"] = render(gs, eye_at(mid, 1.25 * height / 2 / math.tan(math.radians(14)) + 0.3, a, 8),
                                           mid, (480, 720), 28.0)
        neck, pelvis = Mj("neck"), Mj("pelvis")
        head = Mj("head") + np.array([0, 0.06, 0])
        if seated:
            hands = (Mj("left_wrist") + Mj("right_wrist")) / 2
            out["seat_hands"] = render(gs, eye_at(hands, 0.75, 0, 35), hands, (512, 512), 40.0)
            knees = (Mj("left_knee") + Mj("right_knee")) / 2
            out["seat_knees"] = render(gs, eye_at(knees, 1.0, 0, 10), knees, (512, 512), 40.0)
            for side, a in (("left", 270), ("right", 90)):
                pit = Mj(f"{side}_shoulder") + np.array([0, -0.08, 0])
                out[f"seat_underarm_{side}"] = render(gs, eye_at(pit, 0.8, a, -10), pit, (512, 512), 40.0)
            out["seat_hips_back"] = render(gs, eye_at(pelvis, 1.0, 180, 15), pelvis, (512, 512), 40.0)
        else:
            for a in (0, 90, 180):
                out[f"neck_{a:03d}"] = render(gs, eye_at(neck, 0.55, a, 5), neck, (512, 512), 40.0)
            for a in (0, 180):
                out[f"hips_{a:03d}"] = render(gs, eye_at(pelvis, 0.9, a, 0), pelvis, (512, 512), 40.0)
            crotch = pelvis + np.array([0, -0.12, 0])
            out["crotch_000"] = render(gs, eye_at(crotch, 0.8, 0, 0), crotch, (512, 512), 40.0)
            ankles = (Mj("left_ankle") + Mj("right_ankle")) / 2
            for a in (0, 90):
                out[f"feet_{a:03d}"] = render(gs, eye_at(ankles, 0.7, a, 15), ankles, (512, 512), 40.0)
            for a in (135, 180):
                out[f"headback_{a:03d}"] = render(gs, eye_at(head, 0.6, a, 10), head, (512, 512), 40.0)
        # the skinning: how far each Gaussian's blended transform is from a rotation (volume squashed or stretched)
        sv = gs["sv"]
        bad = ((sv.min(1) < 0.85) | (sv.max(1) > 1.15)) & (b.g.opacity > -2)
        numbers[f"{key}SkinSquashed"] = by_part(b, bad)
    return out, numbers


def by_part(b: Bundle, mask: np.ndarray) -> dict:
    names, counts = np.unique(b.part[mask], return_counts=True)
    return {"total": int(mask.sum()), **{str(n): int(c) for n, c in zip(names, counts)}}


def rest_numbers(b: Bundle) -> dict:
    from scipy.spatial import cKDTree

    g = b.g
    op = 1 / (1 + np.exp(-g.opacity))
    seen = op > 0.1
    smax, smin = np.exp(g.scale.max(1)), np.exp(g.scale.min(1))
    d, _ = cKDTree(g.xyz).query(g.xyz, k=9)
    lonely = d[:, 1:].mean(1)
    return {"gaussians": int(len(g)),
            "floaters": by_part(b, seen & (lonely > 0.025)),
            "oversized": by_part(b, seen & (smax > 0.025)),
            "needles": by_part(b, seen & (smax / np.maximum(smin, 1e-6) > 8) & (smax > 0.004)),
            "faintLarge": by_part(b, (op < 0.3) & (op > 0.02) & (smax > 0.008)),
            "faint": by_part(b, (op < 0.5) & (op > 0.02))}


def sheet(rows: list[tuple[str, dict]], keys: list[str], dest: Path, which: int, h: int = 360) -> None:
    from PIL import Image, ImageDraw

    tiles = []
    for label, v in rows:
        row = []
        for k in keys:
            im = Image.fromarray(v[k][which])
            row.append(im.resize((round(im.width * h / im.height), h), Image.LANCZOS))
        tiles.append((label, row))
    W = sum(t.width for t in tiles[0][1])
    out = Image.new("RGB", (W, len(tiles) * (h + 22)), "white")
    d = ImageDraw.Draw(out)
    for r, (label, row) in enumerate(tiles):
        y = r * (h + 22)
        d.text((6, y + 4), label, fill=(0, 0, 0))
        x = 0
        for k, t in zip(keys, row):
            out.paste(t, (x, y + 22))
            d.text((x + 4, y + 26), k, fill=(255, 255, 0))
            x += t.width
    out.save(dest, quality=88)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("bundles", type=Path, nargs="+")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--label", help="labels, one per bundle, comma- or colon-separated (default: folder names)")
    a = p.parse_args()
    labels = a.label.replace(":", ",").split(",") if a.label else [b.name for b in a.bundles]
    a.out.mkdir(parents=True, exist_ok=True)
    rows, report = [], {}
    for label, root in zip(labels, a.bundles):
        b = Bundle(root)
        v, numbers = views(b)
        report[label] = {"bundle": str(root), **rest_numbers(b), **numbers}
        rows.append((label, v))
        print(label, json.dumps(report[label]), flush=True)
    keys = list(rows[0][1])
    groups = {"stand": [k for k in keys if k.startswith("stand_")], "seat": [k for k in keys if k.startswith("seat_")
                                                                           and k[5:].isdigit()],
              "close": [k for k in keys if not k[-3:].isdigit() or not k.startswith(("stand_", "seat_"))]}
    for name, ks in groups.items():
        for which, kind in ((0, "colour"), (1, "alpha")):
            sheet(rows, ks, a.out / f"{name}-{kind}.jpg", which)
    (a.out / "audit.json").write_text(json.dumps(report, indent=1) + "\n")
    print("AUDIT_OK", a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
