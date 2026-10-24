"""court_stance.py on a synthetic freeze: put back into court space through its solved camera, the soles found, and
the stance split along / across the source camera's line of sight."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

sys.path.insert(0, str(Path(__file__).resolve().parent))
import court_stance as cs  # noqa: E402

F, CX, CY = 2000.0, 300.0, 500.0


def look_at(C, target):
    """camera-from-world R for an OpenCV camera at C looking at target, y up in the world."""
    z = np.asarray(target, float) - C
    z /= np.linalg.norm(z)
    x = np.cross(z, [0, 1.0, 0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.stack([x, y, z])


def body(feet):
    """Points of a standing person: two soles on the floor at `feet` (x, z), and a column up to 2 m between them."""
    rng = np.random.default_rng(1)
    pts = []
    for fx, fz in feet:
        n = 400
        pts.append(np.c_[fx + rng.uniform(-0.06, 0.06, n), rng.uniform(0, 0.02, n), fz + rng.uniform(-0.12, 0.12, n)])
    mx, mz = np.mean(feet, 0)
    n = 4000
    pts.append(np.c_[mx + rng.uniform(-0.2, 0.2, n), rng.uniform(0.3, 2.0, n), mz + rng.uniform(-0.15, 0.15, n)])
    return np.concatenate(pts)


class Stance(unittest.TestCase):
    def setUp(self):
        self.C = np.array([-10.0, 1.5, -2.0])
        self.feet = [(2.0, -1.0), (2.6, -0.8)]
        self.R = look_at(self.C, [2.3, 1.0, -0.9])
        self.still = {"R": self.R.tolist(), "C": self.C.tolist(), "K": [[F, 0, CX], [0, F, CY], [0, 0, 1]]}

    def test_stance_in_court_space(self):
        s = cs.stance_of(body(self.feet), np.ones(len(body(self.feet))), self.C)
        self.assertAlmostEqual(s["stance"], np.hypot(0.6, 0.2), delta=0.02)
        view = np.array([2.3, -0.9]) - self.C[[0, 2]]
        view /= np.linalg.norm(view)
        self.assertAlmostEqual(abs(s["along"]), abs(np.array([0.6, 0.2]) @ view), delta=0.02)

    def test_a_recon_in_its_own_world_comes_back_to_court_space(self):
        P = body(self.feet)
        # the recon's world: court space turned, moved and shrunk; its solved camera is the still camera moved along,
        # with its principal point elsewhere (as the solver leaves it)
        Q = Rotation.from_euler("y", 40, degrees=True).as_matrix()
        s, t = 0.7, np.array([0.3, -1.2, 2.0])
        to_recon = lambda X: s * (X @ Q.T) + t  # noqa: E731
        c2w = np.eye(4)
        c2w[:3, :3] = Q @ self.R.T
        c2w[:3, 3] = to_recon(self.C[None])[0]
        dx, dy = 40.0, -25.0  # the solved camera's principal point is off the still one's
        R_rec = c2w[:3, :3].T
        pc = (to_recon(P) - c2w[:3, 3]) @ R_rec.T
        u, v = F * pc[:, 0] / pc[:, 2] + CX, F * pc[:, 1] / pc[:, 2] + CY
        pc2 = np.c_[(u - (CX + dx)) / F * pc[:, 2], (v - (CY + dy)) / F * pc[:, 2], pc[:, 2]]  # same pixels, other K
        P_rec = pc2 @ R_rec + c2w[:3, 3]
        cam = {"camera_to_world": c2w.tolist(), "K": [[F, 0, CX + dx], [0, F, CY + dy], [0, 0, 1]]}
        back = cs.to_court(P_rec, cam, self.still)
        st = cs.stance_of(back, np.ones(len(back)), self.C)
        self.assertAlmostEqual(st["stance"], np.hypot(0.6, 0.2), delta=0.03)

    def test_main_writes_stance_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run, clips = root / "runs" / "court-a" / "seed1", root / "clips" / "court-a"
            rec = run / "recon-raw-default-r2-300k"
            (rec / "frames").mkdir(parents=True)
            clips.mkdir(parents=True)
            P = body(self.feet)
            cs.write_ply_xyz(rec / "frames" / "000060.ply", P, np.full(len(P), 5.0))
            c2w = np.eye(4)
            c2w[:3, :3], c2w[:3, 3] = self.R.T, self.C
            (rec / "source-camera-000060.json").write_text(json.dumps(
                {"camera_to_world": c2w.tolist(), "K": [[F, 0, CX], [0, F, CY], [0, 0, 1]]}))
            (clips / "court-run.json").write_text(json.dumps({"K": 60, "still": self.still}))
            cs.main([str(run), "--clips", str(root / "clips"), "--ref", "0.63,0.6,0.2"])
            out = json.loads((rec / "stance.json").read_text())
            self.assertAlmostEqual(out["stance"], np.hypot(0.6, 0.2), delta=0.03)
            self.assertEqual(out["ref"], {"stance": 0.63, "along": 0.6, "across": 0.2})


if __name__ == "__main__":
    unittest.main()
