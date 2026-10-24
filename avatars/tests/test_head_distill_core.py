import json
import math

import numpy as np
import pytest

from test_head_swap import _gaussians, _rot, _synthetic_body

from lucid_avatars import head_distill_core as D
from lucid_avatars import head_swap as H
from lucid_avatars.bundle import validate_bundle
from lucid_avatars.gaussian_ply import SH_C0, Gaussians, read_ply
from lucid_avatars.skinning import quantize_top4, read_skin_bin
from lucid_avatars.smplx_layout import NUM_JOINTS, J


# ---------------------------------------------------------------- consent

def _faces_dir(tmp_path, person="vishal", files=("a.jpg", "b.JPEG", "c.png", "notes.txt", ".hidden.jpg")):
    d = tmp_path / "data" / "avatars" / "faces" / person
    d.mkdir(parents=True)
    for f in files:
        (d / f).write_bytes(b"x")
    return d


def _teacher_dir(tmp_path, person="vishal"):
    d = tmp_path / "data" / "avatars" / "heads" / person / "uika"
    d.mkdir(parents=True)
    return d


def test_teacher_gate_allows_a_consenting_person_on_their_own_photos(tmp_path):
    photos, out = _faces_dir(tmp_path), _teacher_dir(tmp_path)
    held = tmp_path / ".held"
    assert D.teacher_consent_errors("vishal", photos, out, held) == []


def test_teacher_gate_refuses_anyone_not_consented_and_someone_elses_folders(tmp_path):
    photos, out = _faces_dir(tmp_path), _teacher_dir(tmp_path)
    held = tmp_path / ".held"
    assert any("consent" in e for e in D.teacher_consent_errors("magnus-carlsen", photos, out, held))
    ians = _faces_dir(tmp_path, "ian-grandma")
    assert any("photos" in e for e in D.teacher_consent_errors("vishal", ians, out, held))
    assert any("teacher" in e for e in D.teacher_consent_errors("vishal", photos, _teacher_dir(tmp_path, "ian-grandma"),
                                                                 held))
    loose = tmp_path / "vishal"
    loose.mkdir()
    assert any("photos" in e for e in D.teacher_consent_errors("vishal", loose, out, held))  # not under faces/
    for bad in ("../vishal", "Vishal", "vishal/x", ""):
        assert D.teacher_consent_errors(bad, photos, out, held), bad


def test_teacher_gate_honours_dreams_held(tmp_path):
    photos, out = _faces_dir(tmp_path), _teacher_dir(tmp_path)
    held = tmp_path / ".held"
    held.write_text("bobby-fischer\nvishal\n")
    assert any(".held" in e for e in D.teacher_consent_errors("vishal", photos, out, held))


def test_photo_paths_are_the_jpg_jpeg_png_files_in_name_order(tmp_path):
    photos = _faces_dir(tmp_path)
    assert [p.name for p in D.photo_paths(photos)] == ["a.jpg", "b.JPEG", "c.png"]


def test_distill_gate_is_the_head_swap_gate_plus_their_own_teacher(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    teacher = _teacher_dir(tmp_path)
    assert D.distill_consent_errors("vishal", root, teacher, new_id="vishal-head") == []
    assert any("consent" in e for e in D.distill_consent_errors("bobby-fischer", root, teacher, new_id="bobby-fischer-head"))
    assert any("teacher" in e for e in D.distill_consent_errors("vishal", root, _teacher_dir(tmp_path, "ian-grandma"),
                                                                new_id="vishal-head"))
    (teacher / D.VIEWS_DIR).mkdir()
    (teacher / D.VIEWS_DIR / D.CAMERAS_FILE).write_text(json.dumps({"person": "ian-grandma"}))
    assert any("ian-grandma" in e for e in D.distill_consent_errors("vishal", root, teacher, new_id="vishal-head"))
    (tmp_path / "dreams" / ".held").write_text("vishal\n")
    assert any(".held" in e for e in D.distill_consent_errors("vishal", root, teacher, new_id="vishal-head"))


def test_distill_never_replaces_another_bundle_a_head_swap_included(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    teacher = _teacher_dir(tmp_path)
    swap = tmp_path / "dreams" / "vishal-head"
    swap.mkdir()
    (swap / "head_swap.json").write_text("{}")  # LAM's head swap lives here: the distill never overwrites it
    assert any("never replaced" in e for e in D.distill_consent_errors("vishal", root, teacher, new_id="vishal-head"))
    again = tmp_path / "dreams" / "vishal-head-2"
    again.mkdir()
    (again / D.DISTILL_FILE).write_text("{}")  # its own earlier run may be redone
    assert D.distill_consent_errors("vishal", root, teacher, new_id="vishal-head-2") == []
    assert H.consent_errors("vishal", root, new_id="vishal-head") == []  # the head swap's own gate is unchanged


# ---------------------------------------------------------------- cameras

def test_look_at_puts_the_target_on_the_optical_axis_with_y_down():
    eye, target = np.array([0.3, 0.2, 0.7]), np.array([0.0, 0.05, 0.0])
    w2c = D.look_at_w2c(eye, target)
    R = w2c[:3, :3]
    np.testing.assert_allclose(R @ R.T, np.eye(3), atol=1e-12)
    assert np.linalg.det(R) == pytest.approx(1)
    cam = w2c[:3, :3] @ target + w2c[:3, 3]
    np.testing.assert_allclose(cam[:2], 0, atol=1e-12)
    assert cam[2] == pytest.approx(np.linalg.norm(eye - target))
    above = w2c[:3, :3] @ (target + [0, 0.1, 0]) + w2c[:3, 3]
    assert above[1] < 0  # OpenCV: up in the world is up in the image (smaller v)
    np.testing.assert_allclose(-R.T @ w2c[:3, 3], eye, atol=1e-12)


def test_view_sphere_covers_the_face_densely_and_the_whole_head():
    angles = D.view_angles()
    assert 60 <= len(angles) <= 100
    yaw = np.array([a[0] for a in angles])
    elev = np.array([a[1] for a in angles])
    front = (np.abs(yaw) <= 90) & (np.abs(elev) <= 45)
    assert front.sum() >= 0.6 * len(angles)  # most views on the face
    level = yaw[np.abs(elev) < 1]
    assert np.diff(np.sort(level[np.abs(level) <= 90])).max() <= 10  # yaw -90..90 dense at eye level
    assert (elev >= 60).any() and (elev <= -30).any()  # top and below
    assert (np.abs(yaw) >= 120).sum() >= 4  # the back of the head
    assert len(set(angles)) == len(angles)


def test_view_cameras_are_at_one_distance_and_one_focal_looking_at_the_target():
    target = np.array([0.01, -0.02, 0.03])
    views = D.view_cameras(target, distance=0.8, size=512, half_extent=0.24)
    assert len(views) == len(D.view_angles())
    f = D.focal_for(512, 0.8, 0.24)
    for v in views:
        K, w2c = np.asarray(v["K"]), np.asarray(v["w2c"])
        assert K[0, 0] == K[1, 1] == pytest.approx(f) and K[0, 2] == K[1, 2] == 256
        eye = -w2c[:3, :3].T @ w2c[:3, 3]
        assert np.linalg.norm(eye - target) == pytest.approx(0.8)
        uv, z = D.project(K, w2c, target[None])
        np.testing.assert_allclose(uv[0], [256, 256], atol=1e-9)
    front = next(v for v in views if v["yawDeg"] == 0 and v["elevDeg"] == 0)
    eye = -np.asarray(front["w2c"])[:3, :3].T @ np.asarray(front["w2c"])[:3, 3]
    np.testing.assert_allclose(eye, target + [0, 0, 0.8], atol=1e-12)  # FLAME faces +Z
    # the half extent fills half the frame at the target's distance
    uv, _ = D.project(np.asarray(front["K"]), np.asarray(front["w2c"]), (target + [0, 0.24, 0])[None])
    assert uv[0, 1] == pytest.approx(0, abs=1e-9)


def test_cameras_json_round_trips_and_is_validated(tmp_path):
    views = D.view_cameras(np.zeros(3), size=64)
    for i, v in enumerate(views):
        (tmp_path / v["file"]).write_bytes(b"png")
    D.write_cameras(tmp_path / D.CAMERAS_FILE, views, 64, "vishal", {"uikaCommit": "abc"})
    header, read = D.read_cameras(tmp_path / D.CAMERAS_FILE)
    assert header["person"] == "vishal" and header["width"] == header["height"] == 64 and header["uikaCommit"] == "abc"
    assert len(read) == len(views)
    np.testing.assert_allclose(read[3]["K"], views[3]["K"])
    np.testing.assert_allclose(read[3]["w2c"], views[3]["w2c"])
    assert read[3]["path"] == tmp_path / views[3]["file"]


@pytest.mark.parametrize("breakage", ["missing file", "bad rotation", "bad K", "path", "too few", "bottom row",
                                      "duplicate"])
def test_read_cameras_refuses_broken_views(tmp_path, breakage):
    views = D.view_cameras(np.zeros(3), size=64)
    for v in views:
        (tmp_path / v["file"]).write_bytes(b"png")
    if breakage == "missing file":
        (tmp_path / views[5]["file"]).unlink()
    elif breakage == "bad rotation":
        views[5]["w2c"] = (np.asarray(views[5]["w2c"]) * [[2], [1], [1], [1]]).tolist()
    elif breakage == "bad K":
        views[5]["K"] = [[-1, 0, 32], [0, -1, 32], [0, 0, 1]]
    elif breakage == "path":
        views[5]["file"] = "../evil.png"
    elif breakage == "too few":
        views = views[:D.MIN_VIEWS - 1]
    elif breakage == "bottom row":
        views[5]["w2c"] = (np.asarray(views[5]["w2c"]) + np.array([[0] * 4] * 3 + [[0, 0, 1, 0]])).tolist()
    elif breakage == "duplicate":
        views[6]["file"] = views[5]["file"]
    D.write_cameras(tmp_path / D.CAMERAS_FILE, views, 64, "vishal")
    with pytest.raises(ValueError):
        D.read_cameras(tmp_path / D.CAMERAS_FILE)


def test_cameras_carried_into_the_avatars_frame_see_the_same_pixels():
    rng = np.random.default_rng(0)
    pts = rng.normal(scale=0.1, size=(50, 3))
    R, s, t = _rot([1, 2, 3], 0.4), 1.13, np.array([0.02, 1.5, -0.1])
    moved = s * pts @ R.T + t
    for v in D.view_cameras(np.zeros(3), size=256)[::7]:
        K, w2c = np.asarray(v["K"]), np.asarray(v["w2c"])
        w2c_a = D.camera_to_avatar(w2c, s, R, t)
        uv, z = D.project(K, w2c, pts)
        uv_a, z_a = D.project(K, w2c_a, moved)
        np.testing.assert_allclose(uv_a, uv, atol=1e-9)
        np.testing.assert_allclose(z_a, s * z, atol=1e-9)  # depths in metres of the avatar
        Ra = w2c_a[:3, :3]
        np.testing.assert_allclose(Ra @ Ra.T, np.eye(3), atol=1e-12)


def test_split_views_holds_out_every_eighth_and_never_none():
    train, held = D.split_views(91)
    assert len(held) == len(range(D.HOLDOUT_EVERY // 2, 91, D.HOLDOUT_EVERY))
    assert sorted(np.concatenate([train, held]).tolist()) == list(range(91))
    assert len(D.split_views(5)[1]) == 1


# ---------------------------------------------------------------- the new head's surface

def _tetra_head():
    """Four triangles of a tetrahedron above y = 0.2, skinned to the head; one more triangle below on the neck."""
    v = np.array([[0, 0.3, 0], [0.1, 0.4, 0], [-0.1, 0.4, 0], [0, 0.4, 0.1],  # head
                  [0, 0.1, 0], [0.1, 0.1, 0], [0, 0.1, 0.1]])  # neck
    faces = np.array([[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2], [4, 5, 6]])
    lbs = np.zeros((len(v), NUM_JOINTS))
    lbs[:4, J["head"]] = 0.8
    lbs[:4, J["neck"]] = 0.2
    lbs[1, J["jaw"]], lbs[1, J["head"]] = 0.6, 0.2
    lbs[4:, J["neck"]] = 1
    return v, faces, lbs


def test_head_faces_are_the_ones_whose_vertices_are_all_head_jaw_or_eyes_above_the_seam():
    v, faces, lbs = _tetra_head()
    assert D.head_faces(faces, v, lbs, seam_lo=0.2).tolist() == [0, 1, 2, 3]
    assert D.head_faces(faces, v, lbs, seam_lo=0.45).tolist() == []


def test_sample_surface_is_area_weighted_on_the_faces_with_barycentric_points():
    v, faces, lbs = _tetra_head()
    fid, bary, pts, nrm = D.sample_surface(v, faces, np.array([0, 1, 2, 3]), 4000, seed=1)
    assert len(fid) == 4000 and set(fid.tolist()) <= {0, 1, 2, 3}
    np.testing.assert_allclose(bary.sum(1), 1)
    assert (bary >= 0).all()
    np.testing.assert_allclose(pts, np.einsum("nk,nkx->nx", bary, v[faces[fid]]))
    np.testing.assert_allclose(np.linalg.norm(nrm, axis=1), 1)
    area = 0.5 * np.linalg.norm(np.cross(v[faces[:4, 1]] - v[faces[:4, 0]], v[faces[:4, 2]] - v[faces[:4, 0]]), axis=1)
    share = np.bincount(fid, minlength=4) / 4000
    np.testing.assert_allclose(share, area / area.sum(), atol=0.03)
    again = D.sample_surface(v, faces, np.array([0, 1, 2, 3]), 4000, seed=1)
    np.testing.assert_array_equal(again[0], fid)  # seeded: the same head every run


def test_face_skin_blends_the_face_vertices_weights_by_barycentric_coordinates():
    v, faces, lbs = _tetra_head()
    fid = np.array([0, 0, 1])
    bary = np.array([[1, 0, 0], [0.2, 0.5, 0.3], [0.1, 0.1, 0.8]])
    idx, q = D.face_skin(fid, bary, faces, lbs)
    want = np.einsum("nk,nkj->nj", bary, lbs[faces[fid]])
    w_idx, w_q = quantize_top4(want)
    np.testing.assert_array_equal(idx, w_idx)
    np.testing.assert_array_equal(q, w_q)
    assert (q.astype(int).sum(1) == 255).all()


def test_initial_scale_is_about_the_spacing_of_the_samples():
    v, faces, lbs = _tetra_head()
    area = 0.5 * np.linalg.norm(np.cross(v[faces[:4, 1]] - v[faces[:4, 0]], v[faces[:4, 2]] - v[faces[:4, 0]]),
                                axis=1).sum()
    log_s = D.initial_log_scale(v, faces, np.arange(4), 1000)
    assert 0.3 * math.sqrt(area / 1000) < math.exp(log_s) < math.sqrt(area / 1000)


# ---------------------------------------------------------------- opacity floor, seam

def test_floor_parameterisation_never_goes_under_the_floor_and_inverts():
    raw = np.linspace(-30, 30, 101)
    a = D.floor_alpha(raw)
    assert (a >= D.OPACITY_FLOOR).all() and (a <= 1).all() and np.all(np.diff(a) >= 0)
    for alpha in (0.55, 0.9, 0.99):
        assert D.floor_alpha(D.raw_for_alpha(alpha)) == pytest.approx(alpha)
    with pytest.raises(ValueError):
        D.raw_for_alpha(0.3)


def test_ply_opacity_is_the_floor_alpha_times_the_seam_fade_as_a_logit():
    raw = np.array([-5.0, 0.0, 5.0, 0.0])
    fade = np.array([1.0, 1.0, 1.0, 0.5])
    logit = D.ply_opacity(raw, fade)
    alpha = 1 / (1 + np.exp(-logit))
    np.testing.assert_allclose(alpha, D.floor_alpha(raw) * fade, atol=1e-9)
    assert (alpha[:3] >= D.OPACITY_FLOOR - 1e-9).all()  # every kept Gaussian out of the seam band is at least half opaque


def test_keep_mask_prunes_the_ones_that_want_to_vanish():
    raw = np.array([-6.0, -2.0, 0.0, 3.0])
    keep = D.keep_mask(raw)
    np.testing.assert_array_equal(keep, 1 / (1 + np.exp(-raw)) >= D.PRUNE_BELOW)
    assert keep.tolist() == [False, True, True, True]


def test_opacity_stats_report_the_floor_outside_the_band():
    alpha = np.array([0.5, 0.6, 0.9, 1.0, 0.2])
    band = np.array([False, False, False, False, True])
    s = D.opacity_stats(alpha, band)
    assert s["minOutsideBand"] == pytest.approx(0.5) and s["count"] == 5 and s["inSeamBand"] == 1
    assert s["shareAtLeastHalf"] == pytest.approx(0.8) and s["median"] == pytest.approx(0.6)


def test_seam_fade_matches_the_head_swaps_cross_fade():
    rng = np.random.default_rng(3)
    head = _gaussians(np.column_stack([np.zeros(200), rng.uniform(0.1, 0.4, 200), np.zeros(200)]), alpha=0.8)
    body = _gaussians(np.zeros((0, 3)))
    seam = 0.25
    _, _, h, keep = H.cross_fade(body, np.zeros(0, dtype=int), head, seam)
    fade = D.seam_fade(head.xyz[keep, 1], seam)
    np.testing.assert_allclose(1 / (1 + np.exp(-h.opacity)), np.clip(0.8 * fade, 1e-6, 1 - 1e-6), atol=1e-9)


def test_seam_height_is_the_head_swaps_jaw_line():
    rest = np.zeros((NUM_JOINTS, 3))
    rest[J["jaw"]] = [0, 0.22, 0.04]
    assert D.seam_height(rest) == pytest.approx(0.22 - H.SEAM_BELOW_JAW_M)
    assert D.seam_height(rest, 0.01) == pytest.approx(0.22 - H.SEAM_BELOW_JAW_M + 0.01)


def test_loss_weight_skips_the_teachers_neck_and_the_bodys_shoulders_only():
    seam_lo = 0.2
    # pixels: teacher FLAME above seam over the body's chest | teacher neck | hair (no FLAME) over background |
    #         hair over the body's shoulder | background over nothing
    a_ref = np.array([[1.0, 1.0, 0.0, 0.0, 0.0]])
    y_ref = np.array([[0.3, 0.1, 0.0, 0.0, 0.0]])
    a_body = np.array([[1.0, 1.0, 0.0, 1.0, 0.0]])
    y_body = np.array([[0.1, 0.1, 0.0, 0.1, 0.0]])
    w = D.loss_weight(y_ref, a_ref, y_body, a_body, seam_lo)
    assert w.tolist() == [[1.0, 0.0, 1.0, 0.0, 1.0]]
    assert w.dtype == np.float32
    # seen from below, the body's chest can be nearer than the teacher's chin: those pixels aren't the head's to fit
    d_ref = np.array([[1.0, 1.0, 0.0, 0.0, 0.0]])
    w = D.loss_weight(y_ref, a_ref, y_body, a_body, seam_lo, d_ref=d_ref, d_body=np.array([[0.9, 1.0, 0, 1.0, 0]]))
    assert w.tolist() == [[0.0, 0.0, 1.0, 0.0, 1.0]]
    w = D.loss_weight(y_ref, a_ref, y_body, a_body, seam_lo, d_ref=d_ref, d_body=np.array([[1.2, 1.0, 0, 1.0, 0]]))
    assert w.tolist() == [[1.0, 0.0, 1.0, 0.0, 1.0]]  # the chest behind the chin: the chin counts


def test_body_cut_drops_the_old_head_above_the_seam_and_fades_the_neck(tmp_path):
    root, verts, _ = _synthetic_body(tmp_path)
    body = read_ply(root / "avatar" / "avatar.ply")
    idx, q = read_skin_bin(root / "avatar" / "skin.bin")
    seam = 0.2
    body_k, keep, above = D.cut_body(body, idx, q, seam)
    dominant = idx[np.arange(len(idx)), np.argmax(q, axis=1)]
    assert not (np.isin(dominant[keep], H.HEAD_JOINTS) & (body.xyz[keep, 1] > seam)).any()
    assert (~keep).sum() > 0 and len(body_k) == keep.sum()
    assert not {"head", "jaw", "left_eye", "right_eye", "neck"} & set(above)


# ---------------------------------------------------------------- colour from the teacher, metrics

def test_project_colours_takes_each_points_colour_from_the_views_that_face_it():
    K = np.array([[100.0, 0, 32], [0, 100.0, 32], [0, 0, 1]])
    front = D.look_at_w2c(np.array([0, 0, 1.0]), np.zeros(3))
    back = D.look_at_w2c(np.array([0, 0, -1.0]), np.zeros(3))
    red = np.zeros((64, 64, 4))
    red[..., 0] = red[..., 3] = 1
    blue = np.zeros((64, 64, 4))
    blue[..., 2] = blue[..., 3] = 1
    pts = np.array([[0, 0, 0.05], [0, 0, -0.05], [5.0, 5.0, 0.0]])
    nrm = np.array([[0, 0, 1.0], [0, 0, -1.0], [0, 1.0, 0]])
    rgb, seen = D.project_colours(pts, nrm, [(K, front, red), (K, back, blue)])
    np.testing.assert_allclose(rgb[0], [1, 0, 0])
    np.testing.assert_allclose(rgb[1], [0, 0, 1])
    assert seen.tolist() == [1, 1, 0]
    assert np.all((rgb[2] >= 0) & (rgb[2] <= 1))  # unseen: the median of the seen ones, not black


def test_masked_psnr_and_box():
    gt = np.zeros((20, 30, 3))
    pred = gt.copy()
    pred[5:10, 5:10] = 0.1
    mask = np.zeros((20, 30), dtype=bool)
    mask[4:12, 4:12] = True
    mse = (25 * 3 * 0.01) / (64 * 3)
    assert D.masked_psnr(pred, gt, mask) == pytest.approx(-10 * math.log10(mse))
    assert D.masked_psnr(pred, gt, np.zeros_like(mask)) is None
    assert D.mask_box(mask, pad=2) == (2, 14, 2, 14)
    assert D.mask_box(np.zeros_like(mask)) is None


# ---------------------------------------------------------------- the bundle

def _distilled(tmp_path, new_id="vishal-head"):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    body = read_ply(root / "avatar" / "avatar.ply")
    idx, q = read_skin_bin(root / "avatar" / "skin.bin")
    seam = 0.2
    body_k, keep, above = D.cut_body(body, idx, q, seam)
    rng = np.random.default_rng(5)
    n = 300
    head = _gaussians(np.column_stack([rng.uniform(-0.08, 0.08, n), rng.uniform(0.18, 0.45, n),
                                       rng.uniform(-0.09, 0.11, n)]), rgb=0.3)
    lbs = np.zeros((n, NUM_JOINTS))
    lbs[:, J["head"]] = 1
    h_idx, h_q = quantize_top4(lbs)
    seen = head.xyz[:, 2] > 0
    out = D.write_distilled_bundle(root, tmp_path / "dreams", new_id, body_k, keep, idx, q, head, h_idx, h_q, seen,
                                   {"alignRmsM": 0.004})
    return root, out, body_k, head


def test_distilled_bundle_is_valid_with_the_new_head_last_and_its_numbers(tmp_path):
    root, out, body_k, head = _distilled(tmp_path)
    assert validate_bundle(out) == []
    g = read_ply(out / "avatar" / "avatar.ply")
    idx, q = read_skin_bin(out / "avatar" / "skin.bin")
    assert len(g) == len(idx) == len(body_k) + len(head)
    np.testing.assert_allclose(g.xyz[len(body_k):], head.xyz)  # one contiguous head range at the end
    np.testing.assert_array_equal(idx[len(body_k):, 0], J["head"])
    report = json.loads((out / D.DISTILL_FILE).read_text())
    assert report["alignRmsM"] == 0.004 and report["headGaussians"] == len(head) and report["bodyKept"] == len(body_k)
    dream = json.loads((out / "dream.json").read_text())
    assert dream["id"] == "vishal-head" and dream["preview"] is None and dream["thumb"] is None
    assert dream["source"]["head"]["model"].startswith("UIKA") and dream["source"]["head"]["from"] == "vishal"
    assert "expr" not in dream["avatar"] and 0 < dream["metrics"]["seenFraction"] < 1
    reality = read_ply(out / dream["avatar"]["reality"])
    tinted = ~np.isclose(reality.f_dc, g.f_dc).all(axis=1)
    np.testing.assert_array_equal(tinted[len(body_k):], ~(head.xyz[:, 2] > 0))  # the back of the head is imagined
    assert not (out / "head_swap.json").exists()


def test_distilled_bundle_drops_a_stale_expr_bin_and_redoes_only_its_own(tmp_path):
    root, out, _, _ = _distilled(tmp_path)
    dream = json.loads((root / "dream.json").read_text())
    dream["avatar"].update(expr="avatar/expr.bin", exprChannels=["blink"] * 10)
    (root / "dream.json").write_text(json.dumps(dream))
    (root / "avatar" / "expr.bin").write_bytes(b"\0" * 8)
    (root / "face.json").write_text("{}")
    _, out2, _, _ = _distilled_again(tmp_path, root)
    assert not (out2 / "avatar" / "expr.bin").exists() and not (out2 / "face.json").exists()
    assert validate_bundle(out2) == []
    other = tmp_path / "dreams" / "vishal-other"
    other.mkdir()
    with pytest.raises(ValueError, match="never replaced"):
        _distilled_again(tmp_path, root, "vishal-other")
    with pytest.raises(ValueError, match="new id"):
        _distilled_again(tmp_path, root, "vishal")


def _distilled_again(tmp_path, root, new_id="vishal-head"):
    body = read_ply(root / "avatar" / "avatar.ply")
    idx, q = read_skin_bin(root / "avatar" / "skin.bin")
    body_k, keep, _ = D.cut_body(body, idx, q, 0.2)
    head = _gaussians(np.array([[0, 0.3, 0.05], [0, 0.35, -0.05]]))
    lbs = np.zeros((2, NUM_JOINTS))
    lbs[:, J["head"]] = 1
    h_idx, h_q = quantize_top4(lbs)
    out = D.write_distilled_bundle(root, tmp_path / "dreams", new_id, body_k, keep, idx, q, head, h_idx, h_q,
                                   np.array([True, False]), {})
    return root, out, body_k, head


def test_merge_pads_the_heads_colour_bands_to_the_bodys():
    body = _gaussians(np.zeros((3, 3)))
    body = Gaussians(body.xyz, body.f_dc, np.ones((3, 9)), body.opacity, body.scale, body.rotation)
    head = _gaussians(np.ones((2, 3)))
    m = D.merge_gaussians(body, head)
    assert len(m) == 5 and m.f_rest.shape == (5, 9)
    np.testing.assert_array_equal(m.f_rest[3:], 0)
    np.testing.assert_allclose(m.f_dc[3:], (0.5 - 0.5) / SH_C0)


# ---------------------------------------------------------------- the gates on the command line (both sbatch scripts)

def test_cli_uika_check_passes_their_own_photos_and_refuses_anyone_else(tmp_path, monkeypatch, capsys):
    from lucid_avatars.__main__ import main

    photos, out = _faces_dir(tmp_path), _teacher_dir(tmp_path)
    args = ["lucid_avatars", "uika-check", "--photos", str(photos), "--out", str(out), "--held", str(tmp_path / "x")]
    monkeypatch.setattr("sys.argv", args + ["--person", "vishal"])
    assert main() == 0 and "consent OK" in capsys.readouterr().out
    monkeypatch.setattr("sys.argv", args + ["--person", "bobby-fischer"])
    assert main() == 2 and "REFUSED" in capsys.readouterr().out


def test_cli_distill_check_refuses_replacing_a_head_swap(tmp_path, monkeypatch, capsys):
    from lucid_avatars.__main__ import main

    root, _, _ = _synthetic_body(tmp_path)
    teacher = _teacher_dir(tmp_path)
    args = ["lucid_avatars", "distill-check", str(root), "--person", "vishal", "--teacher", str(teacher)]
    monkeypatch.setattr("sys.argv", args + ["--id", "vishal-head"])
    assert main() == 0
    (tmp_path / "dreams" / "vishal-head").mkdir()
    (tmp_path / "dreams" / "vishal-head" / "head_swap.json").write_text("{}")
    monkeypatch.setattr("sys.argv", args + ["--id", "vishal-head"])
    assert main() == 2 and "never replaced" in capsys.readouterr().out
