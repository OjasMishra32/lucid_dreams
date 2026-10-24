"""court_sam.py with a stand-in for SAM's video predictor (the real one runs on HiPerGator). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import json
import subprocess
import sys
import types
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import court_sam  # noqa: E402

H, W = 40, 60


class FakePredictor:
    """Each object's logits are +5 inside its last prompted box and -5 elsewhere, on every frame it is asked for;
    records the calls so the propagation order can be checked."""

    def __init__(self):
        self.calls, self.boxes = [], {}

    def init_state(self, video_path, offload_video_to_cpu=False):
        self.n = len(list(Path(video_path).glob("*.jpg")))
        return {"n": self.n}

    def add_new_points_or_box(self, st, frame_idx, obj_id, box=None, points=None, labels=None):
        self.calls.append(("prompt", frame_idx, obj_id, None if box is None else box.tolist(),
                           None if points is None else points.tolist()))
        if box is not None:
            self.boxes[obj_id] = box

    def propagate_in_video(self, st, start_frame_idx=None, reverse=False):
        self.calls.append(("propagate", start_frame_idx, reverse))
        idxs = range(start_frame_idx, -1, -1) if reverse else range(start_frame_idx, self.n)
        ids = sorted(self.boxes)
        for i in idxs:
            lg = np.full((len(ids), 1, H, W), -5.0, np.float32)
            for k, o in enumerate(ids):
                x0, y0, x1, y1 = self.boxes[o].astype(int)
                lg[k, 0, y0:y1, x0:x1] = 5.0
            yield i, ids, lg

    def reset_state(self, st):
        self.calls.append(("reset",))


def make_set(d: Path, stems, prompts) -> Path:
    d.mkdir(parents=True)
    with zipfile.ZipFile(d / "frames.zip", "w") as z:
        for s in stems:
            ok, jpg = cv2.imencode(".jpg", np.zeros((H, W, 3), np.uint8))
            z.writestr(f"{s}.jpg", jpg.tobytes())
    (d / "prompts.json").write_text(json.dumps(prompts))
    return d


class Segment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_both_ways_from_ref_every_frame_once(self):
        stems = [f"{n:06d}" for n in range(100, 110)]
        prompts = {"ref": 106, "objects": {"front": {"000106": [5, 5, 20, 30], "000100": [4, 4, 19, 29]},
                                           "ball": {"000106": {"box": [30, 10, 36, 16], "points": [[33, 13]],
                                                               "labels": [1]}}}}
        d = make_set(self.root / "pair", stems, prompts)
        pred = FakePredictor()
        rep = court_sam.run_set(pred, d, self.root / "out", self.root / "work")
        self.assertEqual(rep["written"], 10)
        props = [c for c in pred.calls if c[0] == "propagate"]
        self.assertEqual(props, [("propagate", 6, False), ("propagate", 6, True)])
        self.assertIn(("prompt", 6, 2, [30.0, 10.0, 36.0, 16.0], [[33.0, 13.0]]), pred.calls)
        for name in ("front", "ball"):
            self.assertEqual(sorted(p.stem for p in (self.root / "out/masks" / name).glob("*.png")), stems)
        m = cv2.imread(str(self.root / "out/masks/ball/000102.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(int(m[13, 33]), 255)
        self.assertEqual(int(m[0, 0]), 0)
        p = cv2.imread(str(self.root / "out/prob/ball/000102.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(int(p[13, 33]), 253)  # round(sigmoid(5) * 255)
        self.assertEqual(rep["empty"], {"front": [], "ball": []})

    def test_a_prompt_off_the_clip_is_an_error(self):
        d = make_set(self.root / "x", ["000000", "000001"], {"objects": {"a": {"000007": [1, 1, 5, 5]}}})
        with self.assertRaises(KeyError):
            court_sam.run_set(FakePredictor(), d, self.root / "out", self.root / "work")

    def test_sets_in_an_upload(self):
        up = self.root / "up"
        make_set(up / "p1", ["000000"], {"objects": {"t": {"000000": [1, 1, 5, 5]}}})
        make_set(up / "p2", ["000000"], {"objects": {"t": {"000000": [1, 1, 5, 5]}}})
        (up / "notes").mkdir()
        self.assertEqual([p.name for p in court_sam.sets_in(up)], ["p1", "p2"])
        self.assertEqual(court_sam.sets_in(up / "p2"), [up / "p2"])


class FromVideo(unittest.TestCase):
    """A set that carries the clip: frames decoded on the node, then the banded matte on the same frames."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.set = self.root / "court-sam-pair"
        self.set.mkdir()
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={W}x{H}:rate=25", "-frames:v", "10",
                        "-pix_fmt", "yuv420p", str(self.set / "clip.mp4")], check=True)

    def tearDown(self):
        self.tmp.cleanup()
        for m in ("fdanyone", "fdanyone.assets", "fdanyone.download", "fdanyone.foreground"):
            sys.modules.pop(m, None)

    def test_decodes_the_range_and_names_frames_by_number(self):
        frames = list(court_sam.decode_video(self.set / "clip.mp4", 2, 5))
        self.assertEqual([n for n, _ in frames], [2, 3, 4, 5])
        self.assertEqual(frames[0][1].shape, (H, W, 3))
        with self.assertRaises(ValueError):
            list(court_sam.decode_video(self.set / "clip.mp4", 8, 12))  # past the end

    def test_sam_then_matte_on_the_same_node(self):
        # a stand-in for 4DAnyone's BiRefNet: it calls everything foreground
        fd = types.ModuleType("fdanyone")
        fd.__file__ = str(self.root / "fdanyone" / "__init__.py")
        mods = {"fdanyone": fd}
        for sub, attrs in {"assets": {"resolve_foreground_model": lambda d: "model"},
                           "download": {"ensure_foreground_model": lambda d: None},
                           "foreground": {"predict_foreground_masks":
                                          lambda imgs, model, dev: np.full((len(imgs),) + imgs[0].shape[:2], 255,
                                                                           np.uint8)}}.items():
            m = types.ModuleType(f"fdanyone.{sub}")
            for k, v in attrs.items():
                setattr(m, k, v)
            mods[f"fdanyone.{sub}"] = m
        sys.modules.update(mods)
        prompts = {"video": "clip.mp4", "range": [2, 5], "ref": 3, "matte": True,
                   "objects": {"a": {"3": [5, 5, 25, 30]}, "b": {"3": [30, 5, 55, 30]}}}
        (self.set / "prompts.json").write_text(json.dumps(prompts))
        rep = court_sam.run_set(FakePredictor(), self.set, self.root / "out", self.root / "work")
        self.assertEqual(rep["written"], 4)
        self.assertEqual(sorted(p.stem for p in (self.root / "out/masks/a").glob("*.png")),
                         ["000002", "000003", "000004", "000005"])
        self.assertEqual(rep["matte"]["crops"], 8)
        a = cv2.imread(str(self.root / "out/alpha/a/000004.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(a.shape, (H, W))
        self.assertEqual(int(a[15, 15]), 255)  # inside a
        self.assertEqual(int(a[15, 40]), 0)    # b's pixels, though the net called them foreground
        self.assertEqual(int(a[2, 15]), 255)   # in the band above a: the net's alpha
        self.assertEqual(int(a[38, 50]), 0)    # beyond the band (26 px from a, outside b)
        n = court_sam.unpack(self._tar(), self.root / "masks")
        self.assertEqual(n, 8)
        self.assertTrue((self.root / "masks/a-alpha/000004.png").exists())
        self.assertTrue((self.root / "masks/b-prob/000002.png").exists())

    def _tar(self) -> Path:
        tar = self.root / "masks-sam.tar"
        with tarfile.open(tar, "w") as t:
            t.add(self.root / "out", arcname=".")
        return tar


class PackUnpack(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_crop_moves_prompts_and_unpack_pastes_back(self):
        frames = {n: np.full((H, W, 3), n % 255, np.uint8) for n in (10, 11)}
        prompts = {"ref": 10, "objects": {"a": {"10": [20, 10, 30, 25]}, "b": {"11": {"points": [[40, 20]]}}}}
        d = court_sam.pack(frames, prompts, self.root / "pair", crop=[15, 5, 55, 35])
        with zipfile.ZipFile(d / "frames.zip") as z:
            self.assertEqual(sorted(z.namelist()), ["000010.jpg", "000011.jpg"])
            img = cv2.imdecode(np.frombuffer(z.read("000010.jpg"), np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (30, 40))
        p = json.loads((d / "prompts.json").read_text())
        self.assertEqual(p["crop"], [15, 5, 55, 35])
        self.assertEqual(p["objects"]["a"]["10"]["box"], [5, 5, 15, 20])
        self.assertEqual(p["objects"]["b"]["11"]["points"], [[25, 15]])
        # what the HPG side returns for this set: crop-sized masks, then unpack into full frames
        res = self.root / "res"
        m = np.zeros((30, 40), np.uint8)
        m[5:20, 5:15] = 255
        for kind in ("masks", "prob"):
            (res / kind / "a").mkdir(parents=True)
            cv2.imwrite(str(res / kind / "a" / "000010.png"), m)
        (res / "prompts.json").write_text(json.dumps(p))
        tar = self.root / "masks-sam.tar"
        with tarfile.open(tar, "w") as t:
            t.add(res, arcname=".")
        with self.assertRaises(ValueError):
            court_sam.unpack(tar, self.root / "masks")  # cropped: the full size is required
        self.assertEqual(court_sam.unpack(tar, self.root / "masks", size=(W, H)), 1)
        full = cv2.imread(str(self.root / "masks/a/000010.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(full.shape, (H, W))
        self.assertEqual(int(full[10, 20]), 255)   # the box's corner in full-frame pixels
        self.assertEqual(int(full[9, 20]), 0)
        self.assertTrue((self.root / "masks/a-prob/000010.png").exists())

    def test_unpack_one_set_of_many(self):
        res = self.root / "res"
        for who in ("p1", "p2"):
            (res / who / "masks" / "target").mkdir(parents=True)
            cv2.imwrite(str(res / who / "masks/target/000007.png"), np.full((H, W), 255, np.uint8))
            (res / who / "prompts.json").write_text(json.dumps({"objects": {"target": {}}}))
        tar = self.root / "masks-sam.tar"
        with tarfile.open(tar, "w") as t:
            t.add(res, arcname=".")
        self.assertEqual(court_sam.unpack(tar, self.root / "p2", "p2"), 1)
        self.assertTrue((self.root / "p2/target/000007.png").exists())
        self.assertEqual(court_sam.unpack(tar, self.root / "all"), 2)
        self.assertTrue((self.root / "all/p1/target/000007.png").exists())
        self.assertTrue((self.root / "all/p2/target/000007.png").exists())


if __name__ == "__main__":
    unittest.main()
