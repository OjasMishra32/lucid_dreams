"""realism.py: the face box, crops, Laplacian sharpness, the identity helpers and the metrics assembly."""

import math
import sys
import types

import numpy as np
import pytest
from smplx_rest import smplx_like_rest

from lucid_avatars import realism as R
from lucid_avatars.smplx_layout import J

K = np.array([[1000.0, 0, 320], [0, 1000.0, 448], [0, 0, 1]])
UPRIGHT = np.zeros(165)
UPRIGHT[0:3] = [math.pi, 0, 0]  # SMPL-X turned half a turn about x: upright in a y-down camera, as NLF reports it


# ---------------------------------------------------------------- face box

def test_project_is_a_pinhole():
    assert R.project(K, np.array([0.0, 0.0, 2.0])) == pytest.approx((320, 448))
    assert R.project(K, np.array([0.2, -0.1, 2.0])) == pytest.approx((420, 398))
    assert R.project(K, np.array([0.0, 0.0, 0.0])) is None  # on the camera plane: no image point


def test_face_box_is_a_square_of_the_face_height_around_the_centre():
    x0, y0, x1, y1 = R.face_box(np.array([0.1, -0.2, 2.0]), K, half_m=0.17)
    assert (x1 - x0) == pytest.approx(170) and (y1 - y0) == pytest.approx(170)  # 2 * 0.17 m * 1000 px / 2 m
    assert ((x0 + x1) / 2, (y0 + y1) / 2) == pytest.approx((370, 348))
    assert R.face_box(np.array([0, 0, -1.0]), K) is None  # behind the camera


def test_face_centre_sits_above_the_head_joint_along_the_posed_head():
    rest = smplx_like_rest()
    pelvis, head = rest[J["pelvis"]], rest[J["head"]]
    trans = np.array([0.0, 0.0, 3.0])
    centre, up = R.posed_face_centre(rest, UPRIGHT, trans)
    assert up == pytest.approx([0, -1, 0], abs=1e-9)  # the head's up is image-up (negative y)
    # the half turn about x (y and z flip) swings the body about the pelvis, as SMPL-X poses it
    expected = pelvis + (head - pelvis) * [1, -1, -1] + trans + R.FACE_ABOVE_HEAD_JOINT_M * up
    assert centre == pytest.approx(expected, abs=1e-9)


def test_face_box_from_fit_lands_above_the_middle_for_a_standing_person():
    rest = smplx_like_rest()
    trans = np.array([0.0, 0.2, 3.0])
    box = R.face_box_from_fit(rest, UPRIGHT, trans, K)
    centre, _ = R.posed_face_centre(rest, UPRIGHT, trans)
    assert box == R.face_box(centre, K)
    assert (box[2] - box[0]) == pytest.approx(2 * R.FACE_HALF_M * 1000 / centre[2])
    assert box[3] < 448  # the head is in the top half of the frame


def test_face_box_from_fit_follows_a_tilted_head():
    rest = smplx_like_rest()
    tilted = UPRIGHT.copy()
    tilted[3 * J["head"]: 3 * J["head"] + 3] = [0, 0, math.pi / 2]  # head bowed sideways a quarter turn about its z
    upright_c, _ = R.posed_face_centre(rest, UPRIGHT, np.array([0.0, 0, 3.0]))
    tilt_c, up = R.posed_face_centre(rest, tilted, np.array([0.0, 0, 3.0]))
    assert abs(up[0]) == pytest.approx(1.0, abs=1e-9)  # the head's up now points sideways in the image
    assert np.linalg.norm(tilt_c - upright_c) == pytest.approx(R.FACE_ABOVE_HEAD_JOINT_M * math.sqrt(2), abs=1e-9)


# ---------------------------------------------------------------- boxes and crops

def test_clip_box_rounds_clamps_and_refuses_faces_outside_or_tiny():
    assert R.clip_box((10.4, 20.6, 110.2, 120.9), 640, 896) == (10, 21, 110, 121)
    assert R.clip_box((-20, 20, 80, 120), 640, 896) == (0, 20, 80, 120)  # a fifth outside is still a face
    assert R.clip_box((-90, 20, 10, 120), 640, 896) is None  # mostly outside the image
    assert R.clip_box((100, 100, 108, 108), 640, 896) is None  # 8 px: nothing to measure
    assert R.clip_box(None, 640, 896) is None


def test_crop_takes_the_box_pixels():
    img = np.arange(5 * 6 * 3, dtype=np.uint8).reshape(5, 6, 3)
    assert np.array_equal(R.crop(img, (1, 2, 4, 4)), img[2:4, 1:4])


def test_map_box_moves_a_crop_box_into_the_photo():
    # the crop is the photo's x 100..740, y 50..946 shown at 640x896 (same scale): offsets only
    assert R.map_box((10, 20, 110, 120), (100, 50, 740, 946), 640, 896) == pytest.approx((110, 70, 210, 170))
    # the crop is a 1280x1792 region shown at 640x896: the box doubles
    assert R.map_box((10, 20, 110, 120), (0, 0, 1280, 1792), 640, 896) == pytest.approx((20, 40, 220, 240))
    assert R.map_box(None, (0, 0, 1280, 1792), 640, 896) is None


# ---------------------------------------------------------------- sharpness

def test_laplacian_variance_is_zero_for_flat_and_grows_with_detail():
    flat = np.full((32, 32, 3), 128, dtype=np.uint8)
    noisy = np.random.default_rng(0).integers(0, 255, (32, 32, 3)).astype(np.uint8)
    assert R.laplacian_variance(flat) == 0
    assert R.laplacian_variance(noisy) > 100


def test_laplacian_variance_of_a_known_edge():
    img = np.zeros((6, 6))
    img[:, 3:] = 10.0  # a vertical step: the Laplacian is -10 at column 2, +10 at column 3, 0 elsewhere
    # interior columns 1..4 hold 0, -10, 10, 0 in every interior row: mean 0, variance 50
    assert R.laplacian_variance(img) == pytest.approx(50.0)


def test_sharpness_is_the_render_over_the_photo():
    photo = np.random.default_rng(1).integers(0, 255, (40, 40, 3)).astype(np.uint8)
    p = photo.astype(float)
    blur = (p + np.roll(p, 1, 0) + np.roll(p, 1, 1) + np.roll(p, (1, 1), (0, 1))) / 4
    assert R.sharpness_ratio(photo, photo) == pytest.approx(1.0)
    assert 0 < R.sharpness_ratio(blur, photo) < 0.5  # blurrier than the photo
    assert R.sharpness_ratio(photo, np.full((40, 40, 3), 9, dtype=np.uint8)) is None  # a flat photo has no sharpness
    assert R.sharpness_ratio(np.zeros((2, 2, 3)), photo) is None  # too small for a Laplacian


# ---------------------------------------------------------------- identity helpers

def test_identity_report_is_the_cosine_to_the_photo():
    photo = np.array([1.0, 0, 0])
    out = R.identity_report({"photo": 2 * photo, "old": np.array([0.0, 1, 0]), "new": np.array([1.0, 1, 0])})
    assert out["old"] == 0 and out["new"] == pytest.approx(math.sqrt(0.5), abs=1e-4)
    assert R.identity_report({"old": photo}) is None


def test_identity_of_needs_both_faces():
    photo = np.array([1.0, 0, 0])
    assert R.identity_of({"photo": photo, "avatar": np.array([1.0, 1, 0])}) == pytest.approx(math.sqrt(0.5), abs=1e-4)
    assert R.identity_of({"photo": photo}) is None
    assert R.identity_of({"avatar": photo}) is None
    assert R.identity_of(None) is None  # InsightFace isn't installed


def test_embed_faces_is_none_without_insightface(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "insightface", None)  # importing it raises ImportError
    assert R.embed_faces({"photo": np.zeros((8, 8, 3), dtype=np.uint8)}, tmp_path) is None


def test_embed_faces_takes_the_biggest_face_and_skips_images_without_one(monkeypatch, tmp_path):
    def face(w, vec):
        return types.SimpleNamespace(bbox=np.array([0, 0, w, w]), normed_embedding=np.array(vec, dtype=float))

    class App:
        def __init__(self, **kw):
            pass

        def prepare(self, **kw):
            pass

        def get(self, bgr):
            return [face(10, [1, 0]), face(50, [0, 1])] if bgr[0, 0, 2] == 200 else []  # BGR's last channel is red

    pkg, app = types.ModuleType("insightface"), types.ModuleType("insightface.app")
    app.FaceAnalysis = App
    monkeypatch.setitem(sys.modules, "insightface", pkg)
    monkeypatch.setitem(sys.modules, "insightface.app", app)
    with_face = np.zeros((4, 4, 3), dtype=np.uint8)
    with_face[..., 0] = 200
    out = R.embed_faces({"a": with_face, "b": np.zeros((4, 4, 3), dtype=np.uint8)}, tmp_path)
    assert list(out) == ["a"] and out["a"].tolist() == [0, 1]


# ---------------------------------------------------------------- metrics assembly and guards

def test_metrics_round_to_four_places_and_keep_all_three_keys():
    out = R.realism_metrics(identity=0.123456, lpips_face=0.98765432, sharpness=0.5)
    assert out == {"identity": 0.1235, "lpipsFace": 0.9877, "sharpness": 0.5}


def test_metrics_are_null_when_missing_or_not_finite():
    assert R.realism_metrics(None, None, None) == {"identity": None, "lpipsFace": None, "sharpness": None}
    assert R.realism_metrics(float("nan"), float("inf"), 1.0) == {"identity": None, "lpipsFace": None,
                                                                  "sharpness": 1.0}


def test_guarded_turns_any_failure_into_none_and_logs_it(capsys):
    assert R.guarded("identity", lambda: 0.5) == 0.5

    def boom():
        raise RuntimeError("no GPU")

    assert R.guarded("lpipsFace", boom) is None
    assert "[realism] lpipsFace skipped: RuntimeError: no GPU" in capsys.readouterr().out


def test_realism_metrics_ride_in_a_valid_bundle_beside_the_other_metrics(tmp_path):
    import json

    from test_bundle import random_gaussians

    from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
    from lucid_avatars.idle import idle_loop

    metrics = {"psnr": None, "ssim": None, "lpips": None, "views": None, "seenFraction": 0.38,
               **R.realism_metrics(0.61234, None, 0.4)}
    root = write_avatar_bundle(tmp_path / "dreams", "grandpa-01", "Grandpa", random_gaussians(),
                               idle_loop(betas=np.zeros(10), seconds=2.0, fps=30),
                               source={"clip": "g.jpg", "width": 1200, "height": 1600}, metrics=metrics)
    assert validate_bundle(root) == []
    got = json.loads((root / "dream.json").read_text())["metrics"]
    assert (got["identity"], got["lpipsFace"], got["sharpness"], got["seenFraction"]) == (0.6123, None, 0.4, 0.38)
