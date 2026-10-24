"""court_foot_ref.py on made-up geometry: a person's silhouette drawn into a low camera and a steep one; the feet come
back where they are, triangulated when the low camera sees them apart, from the steep camera alone when it doesn't."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import camgeom as cg  # noqa: E402
import court_foot_ref as fr  # noqa: E402


def look_at(C, target):
    """camera-from-world R for an OpenCV camera at C looking at target, y up in the world."""
    z = np.asarray(target, float) - C
    z /= np.linalg.norm(z)
    x = np.cross(z, [0, 1.0, 0])
    x /= np.linalg.norm(x)
    return np.stack([x, np.cross(z, x), z])


def cam(C, target, f, w, h):
    C = np.asarray(C, float)
    return {"R": look_at(C, target), "C": C, "f": f, "k1": 0.0, "cx": (w - 1) / 2, "cy": (h - 1) / 2, "size": (w, h)}


LOW = cam([-10.0, 0.8, -1.0], [2.3, 0.6, -0.9], 6000.0, 2000, 1400)  # grazing, looking along +x
STEEP = cam([2.5, 6.0, 12.0], [2.3, 0.5, -0.9], 3000.0, 1200, 1600)  # ~23 degrees down, looking along -z


def person(feet, n=60000, seed=0):
    """Points of a person standing on two shoes centred at feet [(x, z)]: shoes, shins, a torso, a head."""
    rng = np.random.default_rng(seed)
    parts = []
    for x, z in feet:
        parts.append(np.c_[x + rng.uniform(-0.14, 0.14, n // 6), rng.uniform(0, 0.1, n // 6),
                           z + rng.uniform(-0.05, 0.05, n // 6)])
        t, r = rng.uniform(0, 2 * np.pi, n // 6), 0.06 * np.sqrt(rng.uniform(0, 1, n // 6))
        parts.append(np.c_[x + r * np.cos(t), rng.uniform(0.1, 0.9, n // 6), z + r * np.sin(t)])
    cx, cz = np.mean(feet, 0)
    t, r = rng.uniform(0, 2 * np.pi, n // 3), 0.18 * np.sqrt(rng.uniform(0, 1, n // 3))
    parts.append(np.c_[cx + r * np.cos(t), rng.uniform(0.9, 1.9, n // 3), cz + r * np.sin(t)])
    return np.concatenate(parts)


def draw(c, P):
    w, h = c["size"]
    u, v, z = cg.project(P, c["R"], c["C"], c["f"], c["k1"], c["cx"], c["cy"])
    ok = (z > 0) & (u >= 0) & (u < w) & (v >= 0) & (v < h)
    m = np.zeros((h, w), np.uint8)
    m[v[ok].astype(int), u[ok].astype(int)] = 1
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))


class Feet(unittest.TestCase):
    def solve(self, feet):
        P = person(feet)
        y = float(np.mean(P[P[:, 1] < 0.25, 1]))  # about where the band's centroid sits
        return fr.solve_feet(LOW, draw(LOW, P), STEEP, draw(STEEP, P), band_y=y)

    def test_apart_in_both_cameras_they_are_triangulated(self):
        feet = [(2.0, -1.0), (2.6, -0.75)]
        out = self.solve(feet)
        self.assertEqual([f["method"] for f in out], ["A+C", "A+C"])
        for f, (x, z) in zip(out, feet):
            self.assertLess(abs(f["x"] - x), 0.03, out)
            self.assertLess(abs(f["z"] - z), 0.03, out)
            self.assertLess(f["gap"], 0.08)  # the two bands' centroids differ mostly in height
            self.assertLess(max(f["sigma"]), 0.06)
        self.assertLess(abs(out[0]["px"]["shiftA"]), 20)  # the two cameras agree: no offset between them

    def test_one_blob_in_the_low_camera_leaves_the_steep_one_alone(self):
        feet = [(2.0, -1.0), (2.6, -0.97)]  # one behind the other along the low camera's rays
        out = self.solve(feet)
        self.assertEqual([f["method"] for f in out], ["C", "C"])
        for f, (x, z) in zip(out, feet):
            self.assertLess(abs(f["x"] - x), 0.05, out)
            self.assertLess(abs(f["z"] - z), 0.10, out)
            self.assertGreater(f["sigma"][1], f["sigma"][0])  # the steep camera's own ray runs along z here
            self.assertIsNone(f["gap"])

    def test_cli_writes_foot_ref_per_player(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            P = person([(2.0, -1.0), (2.6, -0.75)])
            spec = {}
            for name, c in (("A", LOW), ("C", STEEP)):
                cv2.imwrite(str(t / f"{name}.png"), draw(c, P) * 255)
                w, h = c["size"]
                (t / f"{name}.json").write_text(json.dumps({"image_size": [w, h], "frames": [
                    {"source_frame": 7, "R": c["R"].tolist(), "C": c["C"].tolist(), "f": c["f"], "k1": 0.0}]}))
                spec[name] = {"calib": str(t / f"{name}.json"), "frame": 7, "mask": str(t / f"{name}.png")}
            (t / "cfg.json").write_text(json.dumps({"players": {"p1": spec}, "bandY": 0.1}))
            fr.main(["--config", str(t / "cfg.json"), "--out", str(t / "out.json")])
            out = json.loads((t / "out.json").read_text())
            self.assertEqual(len(out["players"]["p1"]["footRef"]), 2)
            self.assertEqual(out["players"]["p1"]["feet"][0]["method"], "A+C")


if __name__ == "__main__":
    unittest.main()
