import numpy as np
import pytest

from lucid_avatars import digs_io as D
from lucid_avatars.gaussian_ply import SH_C0


def test_intrinsics_from_fov_uses_the_long_side():
    K = D.intrinsics_from_fov(1080, 1920, 55.0)
    f = 1920 / 2 / np.tan(np.radians(55.0) / 2)
    np.testing.assert_allclose(K, [[f, 0, 540], [0, f, 960], [0, 0, 1]])


def test_aspect_crop_box_keeps_aspect_and_margin():
    box = D.aspect_crop_box((400, 300, 600, 1500), aspect_wh=640 / 896, margin=0.1)
    x0, y0, x1, y1 = box
    assert np.isclose((x1 - x0) / (y1 - y0), 640 / 896)
    assert (y1 - y0) == pytest.approx(1200 * 1.2)
    assert np.isclose((x0 + x1) / 2, 500) and np.isclose((y0 + y1) / 2, 900)


def test_crop_intrinsics_maps_points_consistently():
    K = D.intrinsics_from_fov(1080, 1920, 55.0)
    box = (100.0, 200.0, 740.0, 1096.0)  # 640 x 896, so scale 0.5 into 320 x 448
    Kc = D.crop_intrinsics(K, box, out_w=320, out_h=448)
    p = np.array([0.1, -0.3, 2.5])  # camera-space point
    uv = (K @ p)[:2] / p[2]
    uv_crop = (Kc @ p)[:2] / p[2]
    np.testing.assert_allclose(uv_crop, (uv - [100, 200]) * 0.5)


def test_digs_fit_json_layout():
    rng = np.random.default_rng(0)
    pose = rng.normal(size=165)
    betas = rng.normal(size=16)
    trans = np.array([0.1, 0.2, 3.0])
    hand_mean = rng.normal(size=90)
    K = D.intrinsics_from_fov(640, 896, 55.0)
    d = D.digs_fit_json(pose, betas, trans, K, hand_mean)
    np.testing.assert_allclose(d["root_pose"][0], pose[:3])
    np.testing.assert_allclose(d["body_pose"][0], pose[3:66])
    np.testing.assert_allclose(d["jaw_pose"][0], pose[66:69])
    # NLF hands are absolute; DiGS (flat_hand_mean=False) wants them relative to the mean.
    np.testing.assert_allclose(d["lhand_pose"][0], pose[75:120] - hand_mean[:45])
    np.testing.assert_allclose(d["rhand_pose"][0], pose[120:165] - hand_mean[45:])
    np.testing.assert_allclose(d["betas_save"][0], betas[:10])
    np.testing.assert_allclose(d["trans"][0], trans)
    cam = d["camera"]
    assert cam["R"] == [[1, 0, 0], [0, 1, 0], [0, 0, 1]] and cam["t"] == [0, 0, 0]
    np.testing.assert_allclose(cam["focal"], [K[0, 0], K[1, 1]])
    np.testing.assert_allclose(cam["princpt"], [K[0, 2], K[1, 2]])
    assert len(d["expr"][0]) == 10 and d["scale"] == [1.0]


def test_rendered_to_gaussians_inverts_activations():
    rng = np.random.default_rng(1)
    n = 50
    rgb = rng.uniform(0, 1, size=(n, 3))
    opacity = rng.uniform(0.1, 1.0, size=n)
    scale = rng.uniform(0.002, 0.05, size=(n, 3))
    rot = rng.normal(size=(n, 4))
    g = D.rendered_to_gaussians(rng.normal(size=(n, 3)), rgb, opacity, scale, rot)
    np.testing.assert_allclose(g.f_dc * SH_C0 + 0.5, rgb, atol=1e-9)
    np.testing.assert_allclose(1 / (1 + np.exp(-g.opacity)), np.clip(opacity, 1e-6, 1 - 1e-6), atol=1e-9)
    np.testing.assert_allclose(np.exp(g.scale), scale)
    np.testing.assert_allclose(np.linalg.norm(g.rotation, axis=1), 1.0)
    assert g.sh_degree == 0


def test_stand_y_puts_soles_on_floor_ignoring_faint_floaters():
    xyz = np.array([[0, -1.2, 0], [0, 0.5, 0], [0, -1.5, 0]], dtype=float)
    opacity_logit = np.array([3.0, 3.0, -4.0])  # the lowest point is nearly transparent
    assert D.stand_y(xyz, opacity_logit) == pytest.approx(1.2)


def test_alpha_bbox_is_the_visible_extent():
    alpha = np.zeros((50, 40), dtype=np.uint8)
    alpha[10:31, 5:16] = 255
    alpha[0, 0] = 3  # matte noise below the threshold
    assert D.alpha_bbox(alpha) == (5, 10, 16, 31)


def test_alpha_bbox_rejects_an_empty_matte():
    with pytest.raises(ValueError, match="no person"):
        D.alpha_bbox(np.zeros((8, 8), dtype=np.uint8))


def test_largest_person_picks_the_biggest_box():
    boxes = np.array([[0, 0, 10, 10, 0.99], [5, 5, 40, 80, 0.7], [0, 0, 20, 20, 0.9]])
    assert D.largest_person(boxes) == 1
    assert D.largest_person(None) == 0


def test_rest_pose_errors_flags_wrong_scale_and_empty_output():
    rng = np.random.default_rng(1)
    person = rng.uniform([-0.9, -0.9, -0.2], [0.9, 0.85, 0.2], size=(500, 3))
    logit = np.full(500, 2.0)
    assert D.rest_pose_errors(person, logit) == []
    assert D.rest_pose_errors(person * 10, logit)  # ten times too big
    assert D.rest_pose_errors(person, np.full(500, -9.0))  # nothing visible


def test_with_hand_mean_sets_both_hands_and_leaves_the_rest():
    from lucid_avatars.idle import idle_loop
    from lucid_avatars.smplx_layout import LEFT_HAND, RIGHT_HAND

    mean = np.arange(90, dtype=np.float64) / 100
    m = D.with_hand_mean(idle_loop(np.zeros(10), seconds=1.0, fps=10), mean)
    np.testing.assert_allclose(m.pose[0, LEFT_HAND].reshape(-1), mean[:45])
    np.testing.assert_allclose(m.pose[-1, RIGHT_HAND].reshape(-1), mean[45:])
    assert m.pose[:, 16:22].any()  # arms still posed


def test_centred_crop_intrinsics_keeps_the_focal_scale_and_centres_the_principal_point():
    K = D.intrinsics_from_fov(1000, 2000, 55.0)
    box = (100, 300, 740, 1196)  # 640 x 896, off-centre
    Kc = D.centred_crop_intrinsics(K, box, 640, 896)
    np.testing.assert_allclose(Kc[0, 0], K[0, 0])  # crop is already 640 wide: no scaling
    np.testing.assert_allclose(Kc[:2, 2], [320, 448])  # DiGS's mesh renderer assumes the centre
    np.testing.assert_allclose(D.centred_crop_intrinsics(K, (0, 0, 320, 448), 640, 896)[1, 1], 2 * K[1, 1])


def test_seen_from_camera_depth_tests_against_the_rendered_positions():
    K = np.array([[100.0, 0, 50], [0, 100.0, 50], [0, 0, 1]])
    ys, xs = np.mgrid[0:100, 0:100]
    # the rendered front surface: a plane at z = 2 (OpenCV camera, identity extrinsics)
    pos = np.stack([(xs - 50) / 100 * 2, (ys - 50) / 100 * 2, np.full(xs.shape, 2.0)], axis=-1)
    front = np.array([[0.0, 0.0, 2.0], [0.3, -0.2, 2.0]])
    behind = np.array([[0.0, 0.0, 2.5]])  # hidden by the plane
    outside = np.array([[5.0, 0.0, 2.0]])  # projects off the image
    seen = D.seen_from_camera(np.concatenate([front, behind, outside]), K, pos)
    assert seen.tolist() == [True, True, False, False]


def test_seen_from_camera_accepts_channel_first_renders():
    K = np.array([[10.0, 0, 5], [0, 10.0, 5], [0, 0, 1]])
    pos = np.zeros((3, 10, 10))
    pos[2] = 1.0
    assert D.seen_from_camera(np.array([[0.0, 0.0, 1.0]]), K, pos).tolist() == [True]


def test_drop_floaters_keeps_the_body_and_fixes_height_and_floor():
    # a fine-tuned cloud: a 1.7 m body, transparent Gaussians drifted metres away, and a visible one under the feet
    rng = np.random.default_rng(2)
    body = rng.uniform([-0.3, -1.3, -0.15], [0.3, 0.4, 0.15], size=(400, 3))
    body[0, 1], body[1, 1] = -1.3, 0.4  # soles and crown
    far = np.array([[0, 3.2, 0], [0, -1.6, 0.0], [2.0, 0, 0]])
    xyz = np.concatenate([body, far])
    logit = np.concatenate([np.full(400, 2.0), [-5.0, 3.0, -5.0]])
    gap = np.concatenate([np.full(400, 0.02), [2.8, 0.3, 1.7]])  # distance to the nearest SMPL-X rest vertex
    g = D.rendered_to_gaussians(xyz, np.full((403, 3), 0.5), 1 / (1 + np.exp(-logit)), np.full((403, 3), 0.01),
                                np.tile([1.0, 0, 0, 0], (403, 1)))
    kept, keep = D.drop_floaters(g, gap)
    assert keep.sum() == 400 and not keep[400:].any()
    for field in ("xyz", "f_dc", "f_rest", "opacity", "scale", "rotation"):
        assert len(getattr(kept, field)) == 400
    np.testing.assert_array_equal(kept.xyz, body)
    assert D.stand_y(kept.xyz, kept.opacity) == pytest.approx(-body[:, 1].min())
    assert "visible height 1.70 m" in D.cloud_summary(kept.xyz, kept.opacity)
    assert "4.80 m" in D.cloud_summary(g.xyz, g.opacity)  # all Gaussians: the misleading number


def test_drop_floaters_keeps_everything_on_a_clean_avatar():
    g = D.rendered_to_gaussians(np.zeros((5, 3)), np.full((5, 3), 0.5), np.full(5, 0.9), np.full((5, 3), 0.01),
                                np.tile([1.0, 0, 0, 0], (5, 1)))
    kept, keep = D.drop_floaters(g, np.full(5, 0.24))
    assert keep.all() and len(kept) == 5
