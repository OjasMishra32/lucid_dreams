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
