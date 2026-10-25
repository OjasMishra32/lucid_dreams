"""court_matte.py (the band rule and the Mac-side pack/unpack; BiRefNet itself is stubbed). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import json
import os
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import court_matte as matte  # noqa: E402


def disc(h, w, cy, cx, r):
    yy, xx = np.mgrid[:h, :w]
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r


class Band(unittest.TestCase):
    def test_alpha_only_moves_inside_the_band(self):
        own = disc(200, 200, 100, 100, 50)
        net = np.full((200, 200), 0.5, np.float32)  # the net is unsure everywhere
        a, ok = matte.band_alpha(own, np.zeros_like(own), net, band=12)
        self.assertTrue(ok)
        dist_in = cv2.distanceTransform(own.astype(np.uint8), cv2.DIST_L2, 5)
        dist_out = cv2.distanceTransform((~own).astype(np.uint8), cv2.DIST_L2, 5)
        self.assertTrue(np.all(a[dist_in > 13] == 255))   # deep inside: SAM says them
        self.assertTrue(np.all(a[dist_out > 13] == 0))    # far outside: SAM says not them
        self.assertTrue(np.all(a[(dist_in > 0) & (dist_in < 10)] == 128))  # the band: the net's alpha

    def test_another_person_never_leaks_in(self):
        own = disc(200, 200, 100, 80, 50)
        other = disc(200, 200, 100, 140, 30) & ~own
        net = np.ones((200, 200), np.float32)  # the net calls both people foreground
        a, ok = matte.band_alpha(own, other, net, band=12)
        self.assertTrue(ok)
        self.assertTrue(np.all(a[other] == 0))
        near = cv2.dilate(own.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        self.assertEqual(int(a[~own & ~other & near].min()), 255)  # the band outside them: the net's 1.0

    def test_a_net_that_disagrees_falls_back_to_sam(self):
        own = disc(200, 200, 100, 100, 50)
        net = np.zeros((200, 200), np.float32)  # the net missed the player entirely
        a, ok = matte.band_alpha(own, np.zeros_like(own), net, band=12)
        self.assertFalse(ok)
        self.assertTrue(np.array_equal(a, own.astype(np.uint8) * 255))


class PackUnpack(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.masks = self.root / "masks"
        H, W = 120, 160
        self.frame = np.random.default_rng(0).integers(0, 255, (H, W, 3), np.uint8)
        for name, (cy, cx, r) in {"front": (60, 50, 20), "back": (60, 100, 25)}.items():
            (self.masks / name).mkdir(parents=True)
            for n in (100, 101):
                cv2.imwrite(str(self.masks / name / f"{n:06d}.png"), disc(H, W, cy, cx, r).astype(np.uint8) * 255)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pack_then_unpack(self):
        frames = {100: self.frame, 101: self.frame}
        up = matte.pack(self.masks, ["front", "back"], frames, self.root / "up", band=4, pad=6)
        with zipfile.ZipFile(up / "crops.zip") as z:
            names = set(z.namelist())
            idx = json.loads(z.read("index.json"))
        self.assertIn("crops/front/000100.jpg", names)
        self.assertIn("own/back/000101.png", names)
        self.assertIn("others/front/000100.png", names)
        self.assertEqual(len(idx["items"]), 4)
        box = next(i["box"] for i in idx["items"] if i["name"] == "front" and i["frame"] == 100)
        self.assertEqual(box, [24, 34, 77, 87])  # the disc's box (30..70, 40..80 in x, y) + pad 6, clipped
        # the HPG side's output: alpha crops in a tar (here: the own masks, so unpack must give back the binaries)
        res = self.root / "res"
        for it in idx["items"]:
            p = res / "alpha" / it["name"] / f"{it['frame']:06d}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(up / "crops.zip") as z:
                p.write_bytes(z.read(f"own/{it['name']}/{it['frame']:06d}.png"))
        (res / "index.json").write_text(json.dumps(idx))
        tar = self.root / "masks-matte.tar"
        with tarfile.open(tar, "w") as t:
            t.add(res, arcname=".")
        n = matte.unpack(tar, self.masks)
        self.assertEqual(n, 4)
        got = cv2.imread(str(self.masks / "front-alpha" / "000100.png"), cv2.IMREAD_UNCHANGED)
        want = cv2.imread(str(self.masks / "front" / "000100.png"), cv2.IMREAD_UNCHANGED)
        self.assertEqual(got.shape, want.shape)
        self.assertTrue(np.array_equal(got, want))


if __name__ == "__main__":
    unittest.main()
