"""fit_hands.py around a stand-in for WiLoR-mini's pipeline (the model itself needs a GPU and its weights)."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fit_hands as F  # noqa: E402

from lucid_avatars.bundle import validate_bundle, write_avatar_bundle  # noqa: E402
from lucid_avatars.hand_fk import mirror_hand  # noqa: E402
from lucid_avatars.hand_poses import pose as named_pose  # noqa: E402
from lucid_avatars.idle import idle_loop  # noqa: E402
from lucid_avatars.motion import Motion  # noqa: E402
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix  # noqa: E402
from lucid_avatars.smplx_layout import LEFT_HAND, RIGHT_HAND  # noqa: E402
from test_bundle import random_gaussians  # noqa: E402


class Arr:
    def __init__(self, a):
        self.a = np.asarray(a)

    def cpu(self):
        return self

    def numpy(self):
        return self.a


class FakePipe:
    """Detects what it is told; 'regresses' a fixed right-hand-frame pose, as rotation matrices like WiLoR."""

    def __init__(self, dets, right_frame_pose):
        self.dets, self.pose, self.calls = dets, right_frame_pose, []

    def hand_detector(self, rgb, conf, verbose):
        xyxy = [d["box"] for d in self.dets]
        res = type("R", (), {})()
        res.boxes = type("B", (), {"xyxy": Arr(xyxy), "cls": Arr([float(d["is_right"]) for d in self.dets]),
                                   "conf": Arr([d["conf"] for d in self.dets])})()
        return [res]

    def predict_with_bboxes(self, image, bboxes, is_rights):
        self.calls.append((image, np.asarray(bboxes), list(is_rights)))
        R = quat_to_matrix(aa_to_quat(self.pose))[None]  # (1, 15, 3, 3)
        return [{"hand_bbox": list(bboxes[0]), "is_right": 1.0, "wilor_preds": {"hand_pose": R}}]


def photo(w=200, h=120):
    return np.random.default_rng(0).integers(0, 255, size=(h, w, 3), dtype=np.uint8)


def test_detect_reads_boxes_classes_and_confidences():
    pipe = FakePipe([{"box": [10, 20, 90, 100], "is_right": True, "conf": 0.9},
                     {"box": [110, 20, 190, 100], "is_right": False, "conf": 0.6}], named_pose("pinch"))
    got = F.detect(pipe, photo())
    assert [d["is_right"] for d in got] == [True, False]
    assert got[0]["box"] == [10.0, 20.0, 90.0, 100.0] and got[1]["conf"] == pytest.approx(0.6)


def test_a_right_hand_is_regressed_on_the_image_as_it_is():
    pose = named_pose("pinch")
    pipe = FakePipe([{"box": [10, 20, 90, 100], "is_right": True, "conf": 0.9}], pose)
    rgb = photo()
    got = F.fit_image(pipe, rgb)
    image, box, is_rights = pipe.calls[0]
    np.testing.assert_array_equal(image, rgb)
    np.testing.assert_allclose(box, [[10, 20, 90, 100]])
    assert is_rights == [True]
    np.testing.assert_allclose(got["right"]["pose"], pose, atol=1e-9)
    assert got["left"] is None and got["right"]["conf"] == pytest.approx(0.9)


def test_a_left_hand_goes_through_as_a_mirrored_right_hand_and_comes_back_mirrored():
    pose = named_pose("fist")  # what the regressor says about the mirrored hand, in a right hand's frame
    pipe = FakePipe([{"box": [10, 20, 90, 100], "is_right": False, "conf": 0.9}], pose)
    rgb = photo(200, 120)
    got = F.fit_image(pipe, rgb)
    image, box, is_rights = pipe.calls[0]
    np.testing.assert_array_equal(image, rgb[:, ::-1])  # the library is told it is a right hand: no flip of its own
    np.testing.assert_allclose(box, [[200 - 90, 20, 200 - 10, 100]])
    assert is_rights == [True]
    np.testing.assert_allclose(got["left"]["pose"], mirror_hand(pose), atol=1e-9)
    assert got["right"] is None


def test_small_hands_and_wild_poses_lower_the_confidence():
    wild = named_pose("relaxed").copy()
    wild[1] = [0.0, 1.4, 3.0]
    small = F.fit_image(FakePipe([{"box": [0, 0, 24, 60], "is_right": True, "conf": 0.9}], named_pose("relaxed")),
                        photo())["right"]
    assert small["conf"] == pytest.approx(0.9 * 0.5)
    got = F.fit_image(FakePipe([{"box": [0, 0, 80, 80], "is_right": True, "conf": 0.9}], wild), photo())["right"]
    assert got["clamped"] == pytest.approx(1 / 15) and got["conf"] == pytest.approx(0.9 * (1 - 1 / 15))
    assert not (got["pose"][1] == wild[1]).all()


def test_side_fit_gives_missing_frames_zero_confidence():
    r = {"left": None, "right": {"pose": named_pose("pinch"), "conf": 0.9}}
    fit = F.side_fit([r, {"left": None, "right": None}, r], [0.0, 0.1, 0.2], "right")
    np.testing.assert_allclose(fit.conf, [0.9, 0.0, 0.9])
    assert fit.poses.shape == (3, 15, 3) and not fit.poses[1].any()
    assert F.side_fit([r, r], [0.0, 0.1], "left") is None


def make_bundle(tmp_path, seconds=1.0):
    motion = idle_loop(betas=np.zeros(10), seconds=seconds, fps=30)
    root = write_avatar_bundle(tmp_path / "dreams", "hand-test", "Hand test", random_gaussians(200), motion,
                               source={"clip": "p.jpg", "width": 100, "height": 100})
    return root, motion


def run(monkeypatch, root, pipe, *extra):
    monkeypatch.setattr(F, "load_pipeline", lambda weights, device: pipe)
    monkeypatch.setattr(F, "read_rgb", lambda path: photo())
    return F.main([str(root), "--device", "cpu", *extra])


def test_photo_replaces_both_hands_keeps_the_original_and_reruns_to_the_same_result(tmp_path, monkeypatch, capsys):
    root, motion = make_bundle(tmp_path)
    pipe = FakePipe([{"box": [10, 20, 90, 100], "is_right": True, "conf": 0.95},
                     {"box": [110, 20, 190, 100], "is_right": False, "conf": 0.95}], named_pose("pinch"))
    assert run(monkeypatch, root, pipe, "--photo", "p.jpg") == 0
    assert "HANDS_OK" in capsys.readouterr().out
    out = Motion.load(root / "avatar" / "motion.json")
    n = out.num_frames
    np.testing.assert_allclose(out.pose[:, RIGHT_HAND], np.broadcast_to(named_pose("pinch", "right"), (n, 15, 3)),
                               atol=1e-5)
    np.testing.assert_allclose(out.pose[:, LEFT_HAND], np.broadcast_to(named_pose("pinch", "left"), (n, 15, 3)),
                               atol=1e-5)
    np.testing.assert_allclose(out.pose[:, :25], motion.pose[:, :25], atol=1e-5)
    original = Motion.load(root / "avatar" / F.ORIGINAL)
    np.testing.assert_allclose(original.pose, motion.pose, atol=1e-5)
    report = json.loads((root / F.REPORT).read_text())
    assert report["mode"] == "photo" and report["used"]["left"]["meanWeight"] == 1.0
    assert validate_bundle(root) == []
    # again: starts from the original, not from its own output
    assert run(monkeypatch, root, pipe, "--photo", "p.jpg") == 0
    np.testing.assert_allclose(Motion.load(root / "avatar" / "motion.json").pose, out.pose, atol=1e-9)
    np.testing.assert_allclose(Motion.load(root / "avatar" / F.ORIGINAL).pose, motion.pose, atol=1e-5)


def test_an_unsure_detection_leaves_the_original_hands(tmp_path, monkeypatch):
    root, motion = make_bundle(tmp_path)
    pipe = FakePipe([{"box": [10, 20, 90, 100], "is_right": True, "conf": 0.35}], named_pose("pinch"))
    assert run(monkeypatch, root, pipe, "--photo", "p.jpg") == 0
    out = Motion.load(root / "avatar" / "motion.json")
    np.testing.assert_allclose(out.pose, motion.pose, atol=1e-5)
    assert json.loads((root / F.REPORT).read_text())["used"]["right"]["framesFitted"] == 0


def test_no_hands_found_changes_nothing(tmp_path, monkeypatch):
    root, motion = make_bundle(tmp_path)
    assert run(monkeypatch, root, FakePipe([], named_pose("pinch")), "--photo", "p.jpg") == 0
    np.testing.assert_allclose(Motion.load(root / "avatar" / "motion.json").pose, motion.pose, atol=1e-5)


def test_clip_is_a_time_series_on_the_motions_own_clock(tmp_path, monkeypatch):
    root, motion = make_bundle(tmp_path, seconds=1.6)
    poses = [named_pose("relaxed"), named_pose("pinch")]
    frames = [(0.0, photo()), (0.5, photo()), (1.0, photo()), (1.5, photo())]
    seq = iter([poses[0], poses[0], poses[1], poses[1]])

    class SeqPipe(FakePipe):
        def predict_with_bboxes(self, image, bboxes, is_rights):
            self.pose = next(seq)
            return super().predict_with_bboxes(image, bboxes, is_rights)

    pipe = SeqPipe([{"box": [10, 20, 90, 100], "is_right": True, "conf": 0.95}], poses[0])
    monkeypatch.setattr(F, "video_frames", lambda *a, **k: iter(frames))
    assert run(monkeypatch, root, pipe, "--video", "clip.mp4", "--clip-start", "0") == 0
    out = Motion.load(root / "avatar" / "motion.json")
    right = out.pose[:, RIGHT_HAND]
    np.testing.assert_allclose(right[0], named_pose("relaxed"), atol=1e-4)  # t = 0 s
    np.testing.assert_allclose(right[-1], named_pose("pinch"), atol=1e-4)   # the end of the clip: the pinch
    assert not np.allclose(right[0], right[-1])
    assert json.loads((root / F.REPORT).read_text())["mode"] == "clip"
    np.testing.assert_allclose(out.pose[:, LEFT_HAND], motion.pose[:, LEFT_HAND], atol=1e-5)  # no left hand seen


def test_refuses_a_bundle_that_is_not_an_avatar(tmp_path, monkeypatch):
    (tmp_path / "dream.json").write_text(json.dumps({"kind": "replay", "avatar": None}))
    with pytest.raises(SystemExit):
        run(monkeypatch, tmp_path, FakePipe([], named_pose("pinch")), "--photo", "p.jpg")
