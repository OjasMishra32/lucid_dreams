import numpy as np
import pytest

from lucid_avatars.detail import crop_camera, crop_homography, detail_regions, sample_grid
from lucid_avatars.smplx_layout import J, NUM_JOINTS

W, H = 704, 1280
K = np.array([[1100.0, 0, W / 2], [0, 1100.0, H / 2], [0, 0, 1]])


def ring_camera(yaw_deg=30.0, dist=3.2, height=1.1):
    """A 4DAnyone-style ring camera (OpenCV: +X right, +Y down, +Z forward) looking at the body's middle."""
    a = np.radians(yaw_deg)
    C = np.array([dist * np.sin(a), height, dist * np.cos(a)])
    z = np.array([0, 0.95, 0]) - C
    z /= np.linalg.norm(z)
    x = np.cross([0, -1.0, 0], z)  # world +Y is up, the image's +Y is down
    x /= np.linalg.norm(x)
    c2w = np.eye(4)
    c2w[:3, :3] = np.stack([x, np.cross(z, x), z], axis=1)
    c2w[:3, 3] = C
    return c2w


def project(K, c2w, X):
    Xc = (np.asarray(X) - c2w[:3, 3]) @ c2w[:3, :3]
    uv = Xc @ K.T
    return uv[..., :2] / uv[..., 2:]


def test_crop_camera_centres_the_region_at_twice_the_focal():
    c2w = ring_camera()
    centre = np.array([0.1, 1.62, 0.05])  # a face
    Kv, c2w_v, size = crop_camera(K, c2w, centre, 0.16, W, H)
    np.testing.assert_allclose(c2w_v[:3, 3], c2w[:3, 3])  # same camera centre: only a turn and a zoom
    np.testing.assert_allclose(Kv[:2, 2], [size / 2, size / 2])  # DiGS needs the principal point centred
    np.testing.assert_allclose(project(Kv, c2w_v, centre), [size / 2, size / 2], atol=1e-6)
    np.testing.assert_allclose(Kv[0, 0], 2 * K[0, 0])
    assert size % 16 == 0
    rng = np.random.default_rng(0)
    d = rng.normal(size=(500, 3))
    rim = centre + 0.16 * d / np.linalg.norm(d, axis=1, keepdims=True)
    uv = project(Kv, c2w_v, rim)
    assert (uv > 0).all() and (uv < size).all()  # the whole region is in the crop


def test_crop_camera_keeps_the_image_upright():
    c2w = ring_camera()
    Kv, c2w_v, size = crop_camera(K, c2w, np.array([0.1, 1.62, 0.05]), 0.16, W, H)
    assert c2w_v[:3, 1] @ c2w[:3, 1] > 0.95  # image down stays down


def test_big_regions_are_capped_by_zooming_out():
    Kv, _, size = crop_camera(K, ring_camera(dist=1.0), np.array([0.0, 1.0, 0.0]), 0.3, W, H, max_px=256)
    assert size == 256 and Kv[0, 0] < 2 * K[0, 0]


def test_no_crop_behind_or_outside_the_view():
    c2w = ring_camera()
    behind = c2w[:3, 3] - 2 * c2w[:3, 2]
    assert crop_camera(K, c2w, behind, 0.1, W, H) is None
    far_left = c2w[:3, 3] + 3 * c2w[:3, 2] - 5 * c2w[:3, 0]
    assert crop_camera(K, c2w, far_left, 0.1, W, H) is None


def test_homography_maps_crop_pixels_to_source_pixels():
    c2w = ring_camera(yaw_deg=-50)
    centre = np.array([-0.35, 0.9, 0.1])  # a hand
    Kv, c2w_v, size = crop_camera(K, c2w, centre, 0.12, W, H)
    Hm = crop_homography(K, c2w, Kv, c2w_v)
    rng = np.random.default_rng(1)
    X = centre + rng.uniform(-0.1, 0.1, size=(50, 3))
    uv_v, uv_s = project(Kv, c2w_v, X), project(K, c2w, X)
    got = np.c_[uv_v, np.ones(len(X))] @ Hm.T
    np.testing.assert_allclose(got[:, :2] / got[:, 2:], uv_s, atol=1e-6)


def test_sample_grid_is_grid_sample_coordinates():
    Hm = np.diag([2.0, 2.0, 1.0])  # crop pixel (u, v) -> source pixel (2u, 2v)
    g = sample_grid(Hm, 4, W, H)
    assert g.shape == (4, 4, 2)
    # align_corners=False: source pixel x (OpenCV, centres on integers) sits at (2x + 1) / W - 1
    np.testing.assert_allclose(g[1, 3], [(2 * 6 + 1) / W - 1, (2 * 2 + 1) / H - 1])


def test_detail_regions_from_posed_joints():
    joints = np.zeros((NUM_JOINTS, 3))
    joints[J["head"]] = [0, 1.60, 0]
    joints[J["left_eye"]], joints[J["right_eye"]] = [0.03, 1.66, 0.08], [-0.03, 1.66, 0.08]
    joints[J["jaw"]] = [0, 1.58, 0.03]
    for side, x in (("left", 0.5), ("right", -0.5)):
        joints[J[f"{side}_wrist"]] = [x, 1.0, 0]
        joints[J[f"{side}_middle1"]] = [x * 1.2, 1.0, 0]
        joints[J[f"{side}_middle3"]] = [x * 1.25, 1.0, 0]
    r = detail_regions(joints)
    assert set(r) == {"face", "left_hand", "right_hand"}
    face, face_r = r["face"]
    assert 1.6 < face[1] < 1.68 and face[2] > 0.0 and 0.12 < face_r < 0.25  # in front of the skull, hair included
    hand, hand_r = r["left_hand"]
    assert 0.5 < hand[0] < 0.65 and 0.08 < hand_r < 0.2


@pytest.mark.parametrize("radius", [0.05, 0.4])
def test_crop_size_bounds(radius):
    Kv, _, size = crop_camera(K, ring_camera(), np.array([0.0, 1.2, 0.0]), radius, W, H)
    assert 64 <= size <= 512


def test_no_crop_when_the_region_runs_past_the_view_edge():
    c2w = ring_camera()
    # a hand whose centre is in the image but 20 px from its left edge
    local_dir = np.linalg.inv(K) @ [20.0, H / 2, 1.0]
    centre = c2w[:3, 3] + c2w[:3, :3] @ (3.0 * local_dir / local_dir[2])
    assert crop_camera(K, c2w, centre, 0.12, W, H) is None
