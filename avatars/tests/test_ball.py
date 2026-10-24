import numpy as np
import pytest

from lucid_avatars.ball import BALL_DIAMETER, ball_in_camera, ball_world, camera_to_global
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix

W, H = 704, 1280  # 4DAnyone's input video
K = np.array([[1230.0, 0, W / 2], [0, 1230.0, H / 2], [0, 0, 1]])  # about 55 degrees across the long side


def sphere_box(K, centre, radius):
    """The pixel box a sphere really covers: project its whole surface (silhouette included)."""
    rng = np.random.default_rng(0)
    d = rng.normal(size=(20000, 3))
    pts = centre + radius * d / np.linalg.norm(d, axis=1, keepdims=True)
    uv = (pts / pts[:, 2:]) @ K.T
    return [uv[:, 0].min(), uv[:, 1].min(), uv[:, 0].max(), uv[:, 1].max()]


@pytest.mark.parametrize("centre", [[0, 0, 3.0], [0.9, -1.4, 3.5], [-1.2, 2.0, 5.0], [0.3, 0.2, 8.0]])
def test_ball_in_camera_from_its_box(centre):
    got = ball_in_camera(K, np.array([sphere_box(K, np.array(centre), BALL_DIAMETER / 2)]))[0]
    assert np.linalg.norm(got - centre) < 0.02 * np.linalg.norm(centre)  # 2% of the range, corners included


def test_missing_and_cut_off_boxes_give_nan():
    boxes = np.array([[np.nan] * 4, [0.0, 600, 30, 640], [300, 600, 340, 640]])
    got = ball_in_camera(K, boxes, width=W, height=H)
    assert np.isnan(got[:2]).all() and np.isfinite(got[2]).all()  # a box on the image edge is a partial ball


def _gvhmr_pair(n, J0, rng):
    """incam and global params of one body, and the per-frame camera -> global transform that relates them."""
    go_c = rng.normal(scale=0.8, size=(n, 3))
    t_c = rng.normal(size=(n, 3)) + [0, 0, 4]
    T = np.tile(np.eye(4), (n, 1, 1))
    T[:, :3, :3] = quat_to_matrix(aa_to_quat(rng.normal(scale=1.0, size=(n, 3))))
    T[:, :3, 3] = rng.normal(size=(n, 3))
    R_c = quat_to_matrix(aa_to_quat(go_c))
    R_g = T[:, :3, :3] @ R_c
    t_g = np.einsum("nab,nb->na", T[:, :3, :3], J0 + t_c) + T[:, :3, 3] - J0
    from lucid_avatars.ik import to_aa

    go_g = np.stack([to_aa(r) for r in R_g])
    return {"global_orient": go_c, "transl": t_c}, {"global_orient": go_g, "transl": t_g}, T


def test_camera_to_global_from_the_two_fits():
    rng = np.random.default_rng(1)
    J0 = np.array([0.003, -0.35, 0.012])
    incam, glob, T = _gvhmr_pair(5, J0, rng)
    np.testing.assert_allclose(camera_to_global(incam, glob, J0), T, atol=1e-9)


def test_ball_world_end_to_end():
    rng = np.random.default_rng(2)
    J0 = np.array([0.003, -0.35, 0.012])
    incam, glob, T = _gvhmr_pair(3, J0, rng)
    world = np.eye(4)
    world[:3, :3] = quat_to_matrix(aa_to_quat([0, 0.7, 0]))
    world[:3, 3] = [0.5, 0.1, -2]
    cam_pts = np.array([[0.4, -0.5, 3.0], [0.1, 0.3, 4.0], [-0.6, 0.0, 6.0]])
    boxes = np.array([sphere_box(K, p, BALL_DIAMETER / 2) for p in cam_pts])
    got = ball_world(K, boxes, incam, glob, J0, world=world)
    want = np.einsum("ab,nb->na", world[:3, :3], np.einsum("nab,nb->na", T[:, :3, :3], cam_pts) + T[:, :3, 3])
    want += world[:3, 3]
    assert (np.linalg.norm(got - want, axis=1) < 0.02 * np.linalg.norm(cam_pts, axis=1)).all()
    # one K per frame works the same
    np.testing.assert_allclose(ball_world(np.tile(K, (3, 1, 1)), boxes, incam, glob, J0, world=world), got)


def test_pelvis_from_model_is_the_regressed_root_of_the_shaped_body():
    from lucid_avatars.ball import pelvis_from_model

    rng = np.random.default_rng(3)
    v_template = rng.normal(size=(6, 3))
    shapedirs = rng.normal(scale=0.01, size=(6, 3, 300))  # SMPL-X ships more shape components than GVHMR's 10
    J_regressor = np.zeros((4, 6))
    J_regressor[0, [1, 4]] = 0.5
    betas = rng.normal(size=10)
    shaped = v_template + shapedirs[:, :, :10] @ betas
    np.testing.assert_allclose(pelvis_from_model(v_template, shapedirs, J_regressor, betas), (shaped[1] + shaped[4]) / 2)


def test_smooth_distance_fixes_a_bad_box_and_keeps_directions():
    from lucid_avatars.ball import smooth_distance

    t = np.linspace(0, 1, 9)
    pts = np.stack([0.5 * t, -0.2 + t, 3.0 + t], axis=1)
    noisy = pts.copy()
    noisy[4] *= 1.3  # a hand over the ball: box too small, so the distance comes out too far
    noisy[6] = np.nan
    got = smooth_distance(noisy, window=5)
    assert np.isnan(got[6]).all()
    np.testing.assert_allclose(got[4] / np.linalg.norm(got[4]), pts[4] / np.linalg.norm(pts[4]))  # same ray
    assert abs(np.linalg.norm(got[4]) - np.linalg.norm(pts[4])) < 0.1
    assert np.linalg.norm(got[[0, 1, 2, 7, 8]] - pts[[0, 1, 2, 7, 8]], axis=1).max() < 0.1


def test_track_for_frames_one_entry_per_bundle_frame():
    from lucid_avatars.ball import track_for_frames

    pts = np.array([[0.12345, 1.0, -0.5], [np.nan] * 3, [1.0, 2.0, 3.0]])
    assert track_for_frames(pts, 3) == [[0.123, 1.0, -0.5], None, [1.0, 2.0, 3.0]]
    assert track_for_frames(pts, 5) == [[0.123, 1.0, -0.5], [0.123, 1.0, -0.5], None, [1.0, 2.0, 3.0], [1.0, 2.0, 3.0]]


def test_ball_world_smooths_distance_when_asked():
    rng = np.random.default_rng(4)
    J0 = np.array([0.003, -0.35, 0.012])
    incam, glob, T = _gvhmr_pair(5, J0, rng)
    cam_pts = np.array([[0.2, 0.0, 4.0]] * 5)
    boxes = np.array([sphere_box(K, p, BALL_DIAMETER / 2) for p in cam_pts])
    boxes[2] = [boxes[2][0] + 3, boxes[2][1] + 3, boxes[2][2] - 3, boxes[2][3] - 3]  # cut by a hand: looks farther
    want = np.einsum("nab,nb->na", T[:, :3, :3], cam_pts) + T[:, :3, 3]
    raw = ball_world(K, boxes, incam, glob, J0)
    smooth = ball_world(K, boxes, incam, glob, J0, smooth=5)
    assert np.linalg.norm(raw[2] - want[2]) > 0.3
    assert np.linalg.norm(smooth[2] - want[2]) < 0.05
