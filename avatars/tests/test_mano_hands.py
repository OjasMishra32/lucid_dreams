import numpy as np
import pytest
from smplx_rest import smplx_like_rest

from lucid_avatars import mano_hands as M
from lucid_avatars.digs_io import with_hand_mean
from lucid_avatars.hand_fk import HAND_JOINTS, fingertips, mirror_hand, pinch_gap
from lucid_avatars.hand_poses import pose as named_pose
from lucid_avatars.idle import idle_loop
from lucid_avatars.motion import validate_motion_dict
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix
from lucid_avatars.smplx_layout import J, JOINT_NAMES, LEFT_HAND, RIGHT_HAND

REST = smplx_like_rest()
RNG = np.random.default_rng(7)


def rand_hand(scale=0.4, n=None):
    return RNG.normal(size=((n,) if n else ()) + (15, 3)) * scale


def test_mano_joint_order_is_smplxs_so_the_map_is_the_identity():
    assert M.MANO_JOINTS == ["index1", "index2", "index3", "middle1", "middle2", "middle3", "pinky1", "pinky2",
                             "pinky3", "ring1", "ring2", "ring3", "thumb1", "thumb2", "thumb3"]
    assert [JOINT_NAMES[LEFT_HAND][i] for i in range(15)] == [f"left_{n}" for n in M.MANO_JOINTS]
    assert [JOINT_NAMES[RIGHT_HAND][i] for i in range(15)] == [f"right_{n}" for n in M.MANO_JOINTS]
    h = rand_hand()
    np.testing.assert_allclose(M.convert(h), h)  # right hand, absolute: nothing changes but the type


def test_a_named_source_order_is_applied():
    h = rand_hand()
    order = tuple(reversed(range(15)))
    np.testing.assert_allclose(M.convert(h, order=order), h[::-1])


def test_rotation_matrices_become_the_same_axis_angle():
    h = rand_hand()
    R = quat_to_matrix(aa_to_quat(h))
    np.testing.assert_allclose(M.convert(R), h, atol=1e-9)
    batch = rand_hand(n=4)
    np.testing.assert_allclose(M.convert(quat_to_matrix(aa_to_quat(batch))), batch, atol=1e-9)


def test_rotation_matrices_off_orthogonal_by_a_hair_are_snapped():
    h = rand_hand()
    R = quat_to_matrix(aa_to_quat(h)) + RNG.normal(size=(15, 3, 3)) * 1e-4
    np.testing.assert_allclose(M.convert(R), h, atol=2e-3)


def test_flat_45_vector_and_bad_shapes():
    h = rand_hand()
    np.testing.assert_allclose(M.convert(h.reshape(45)), h)
    with pytest.raises(ValueError):
        M.convert(np.zeros((16, 3)))


def test_a_pose_relative_to_the_mean_gets_the_mean_added():
    mean, rel = rand_hand(0.3), rand_hand(0.2)
    np.testing.assert_allclose(M.convert(rel, relative_to_mean=True, mean=mean), rel + mean)
    np.testing.assert_allclose(M.convert(rel + mean), rel + mean)  # absolute: used as is
    with pytest.raises(ValueError):
        M.convert(rel, relative_to_mean=True)
    # the mean is a right-hand-frame vector: for a left hand it is added first, then the pose is mirrored
    np.testing.assert_allclose(M.convert(rel, False, relative_to_mean=True, mean=mean), mirror_hand(rel + mean))


def test_left_hand_is_the_right_hand_frame_pose_mirrored():
    h = rand_hand()
    left = M.convert(h, is_right=False)
    np.testing.assert_allclose(left, mirror_hand(h))
    np.testing.assert_allclose(left[:, 0], h[:, 0])
    np.testing.assert_allclose(left[:, 1:], -h[:, 1:])
    np.testing.assert_allclose(M.convert(h, is_right=False, already_mirrored=True), h)


def test_a_left_hand_seen_as_a_mirrored_right_hand_poses_the_left_fingers_the_same_way():
    """The regressor sees a left pinch as a right pinch in the mirrored image; mirroring its answer back must put
    the thumb on the index of the SMPL-X left hand, with every tip where the mirror image says."""
    right_frame = named_pose("pinch", "right")
    left = M.convert(right_frame, is_right=False)
    assert pinch_gap(REST, "left", left) < 0.01
    tl = fingertips(REST, "left", left)
    tr = fingertips(REST, "right", right_frame)
    for f in tl:
        np.testing.assert_allclose(tl[f] - REST[J["left_wrist"]], (tr[f] - REST[J["right_wrist"]]) * [-1, 1, 1],
                                   atol=1e-12)
    # and NOT mirroring leaves a left hand whose fingers curl the wrong way (flexion sign flipped)
    wrong = fingertips(REST, "left", right_frame)
    flat = fingertips(REST, "left", np.zeros((15, 3)))
    assert wrong["middle"][1] > flat["middle"][1]  # bent backwards, over the back of the hand


def test_confidence_weight():
    np.testing.assert_allclose(M.confidence_weight([0.0, 0.5, 0.65, 0.8, 1.0]), [0, 0, 0.5, 1, 1])


def test_smooth_series_keeps_a_constant_and_calms_jitter():
    base = rand_hand()
    series = np.broadcast_to(base, (12, 15, 3)).copy()
    np.testing.assert_allclose(M.smooth_series(series, np.ones(12)), series, atol=1e-9)
    jitter = series + RNG.normal(size=series.shape) * 0.05
    out = M.smooth_series(jitter, np.ones(12), window=5)
    assert np.abs(np.diff(out, axis=0)).mean() < np.abs(np.diff(jitter, axis=0)).mean()


def test_smooth_series_ignores_untrusted_frames_and_returns_zeros_when_none_are_trusted():
    a, b = named_pose("pinch"), named_pose("fist")
    series = np.stack([a, a, b, a, a])
    w = np.array([1, 1, 0, 1, 1.0])
    np.testing.assert_allclose(M.smooth_series(series, w, window=3)[2], a, atol=1e-9)
    assert not M.smooth_series(series, np.zeros(5), window=3).any()


def test_fuse_uses_the_fit_when_confident_and_the_original_when_not():
    fallback = np.broadcast_to(named_pose("relaxed"), (10, 15, 3)).copy()
    fit = named_pose("pinch")
    hands, w = M.fuse(fallback, fit, 0.95)
    np.testing.assert_allclose(hands, np.broadcast_to(fit, hands.shape), atol=1e-9)
    assert np.all(w == 1.0)
    hands, w = M.fuse(fallback, fit, 0.2)
    np.testing.assert_allclose(hands, fallback, atol=1e-12)
    assert np.all(w == 0.0)
    hands, w = M.fuse(fallback, fit, 0.65)  # halfway: in between, per joint
    np.testing.assert_allclose(hands, M.blend(fallback, np.broadcast_to(fit, fallback.shape), 0.5), atol=1e-9)
    hands, w = M.fuse(fallback, fit, 0.95, strength=0.4)
    assert np.allclose(w, 0.4)


def test_fuse_a_clip_with_a_dropout_falls_back_there_and_eases_in_and_out():
    n = 40
    fallback = np.broadcast_to(named_pose("relaxed"), (n, 15, 3)).copy()
    fit = np.broadcast_to(named_pose("pinch"), (n, 15, 3)).copy()
    conf = np.full(n, 0.95)
    conf[15:25] = 0.0  # the hand left the frame
    hands, w = M.fuse(fallback, fit, conf, window=5)
    np.testing.assert_allclose(hands[0], fit[0], atol=1e-9)
    np.testing.assert_allclose(hands[19], fallback[19], atol=1e-9)  # the middle of the gap: the original
    assert w[19] == 0 and w[0] == 1
    assert np.all(np.diff(w[8:20]) <= 1e-12)  # eased down, no jump back up
    steps = np.abs(np.diff(hands, axis=0)).max(axis=(1, 2))
    assert steps.max() < 0.5 * np.abs(fit[0] - fallback[0]).max()  # no single-frame snap between the two poses


def test_fuse_a_photo_gives_every_frame_the_same_hand():
    fallback = np.broadcast_to(named_pose("relaxed"), (6, 15, 3)).copy()
    hands, _ = M.fuse(fallback, named_pose("fist"), 0.9)
    assert np.allclose(hands, hands[0])


def test_clip_series_to_motion_takes_the_nearest_sample_and_drops_far_ones():
    times = np.array([0.0, 0.5, 1.0])
    poses = np.stack([named_pose("relaxed"), named_pose("pinch"), named_pose("fist")])
    p, c = M.clip_series_to_motion(poses, np.array([0.9, 0.8, 0.7]), times, motion_fps=10, n_frames=20)
    assert p.shape == (20, 15, 3)
    np.testing.assert_allclose(p[0], poses[0])
    np.testing.assert_allclose(p[5], poses[1])
    assert c[0] == 0.9 and c[5] == 0.8 and c[10] == 0.7
    assert c[15] == 0.0 and c[19] == 0.0  # 0.5 s past the last sample


def test_plausible_cuts_wild_fingers_and_the_confidence_with_them():
    hand = named_pose("relaxed").copy()
    hand[1] = [0.0, 1.4, 3.0]
    fixed, conf = M.plausible(hand, "right", 0.9)
    assert conf == pytest.approx(0.9 * (1 - 1 / 15))
    assert not (fixed[1] == hand[1]).all()
    same, conf = M.plausible(named_pose("fist"), "right", 0.9)
    np.testing.assert_allclose(same, named_pose("fist"))
    assert conf == pytest.approx(0.9)


def test_with_hands_sets_only_the_fingers_and_stays_a_valid_motion():
    m = idle_loop(betas=np.zeros(10), seconds=1.0, fps=30)
    left, right = named_pose("pinch", "left"), named_pose("fist", "right")
    out = M.with_hands(m, left, right)
    np.testing.assert_allclose(out.pose[:, LEFT_HAND], np.broadcast_to(left, (m.num_frames, 15, 3)))
    np.testing.assert_allclose(out.pose[:, RIGHT_HAND], np.broadcast_to(right, (m.num_frames, 15, 3)))
    np.testing.assert_allclose(out.pose[:, :25], m.pose[:, :25])
    assert validate_motion_dict(out.to_dict()) == []
    per_frame = M.with_hands(m, np.stack([left] * m.num_frames), right)
    np.testing.assert_allclose(per_frame.pose, out.pose)
    with pytest.raises(ValueError):
        M.with_hands(m, np.zeros((3, 15, 3)), right)


def test_low_confidence_everywhere_leaves_digs_hand_mean_exactly():
    mean = RNG.normal(size=90) * 0.2
    m = with_hand_mean(idle_loop(betas=np.zeros(10), seconds=1.0, fps=30), mean)
    fused_l, _ = M.fuse(m.pose[:, LEFT_HAND], named_pose("pinch", "left"), 0.1)
    fused_r, _ = M.fuse(m.pose[:, RIGHT_HAND], named_pose("pinch", "right"), 0.1)
    out = M.with_hands(m, fused_l, fused_r)
    np.testing.assert_allclose(out.pose, m.pose, atol=1e-12)
    assert len(HAND_JOINTS) == 15


def det(box, is_right, conf):
    return {"box": list(box), "is_right": is_right, "conf": conf}


def test_size_factor():
    assert M.size_factor((0, 0, 96, 120)) == 1.0
    assert M.size_factor((0, 0, 24, 100)) == pytest.approx(0.5)
    assert M.size_factor((0, 0, 0, 0)) == 0.0


def test_best_per_side_takes_the_most_confident_of_each_hand():
    dets = [det((0, 0, 50, 50), True, 0.6), det((200, 0, 250, 50), True, 0.9), det((400, 0, 450, 50), False, 0.7)]
    got = M.best_per_side(dets)
    assert got["right"]["conf"] == 0.9 and got["left"]["conf"] == 0.7
    assert M.best_per_side([]) == {"left": None, "right": None}


def test_best_per_side_keeps_other_peoples_hands_out():
    dets = [det((0, 0, 50, 50), True, 0.95), det((300, 300, 350, 350), True, 0.7), det((410, 320, 460, 370), False, 0.8)]
    got = M.best_per_side(dets, person_box=(250, 250, 500, 500))
    assert got["right"]["box"] == [300, 300, 350, 350] and got["left"]["conf"] == 0.8


def test_one_hand_called_both_left_and_right_keeps_the_surer_call():
    got = M.best_per_side([det((0, 0, 60, 60), True, 0.7), det((5, 5, 65, 65), False, 0.9)])
    assert got["right"] is None and got["left"]["conf"] == 0.9


def test_apply_fits_photo_replaces_the_hand_mean_on_one_hand_and_keeps_it_where_unfit():
    mean = RNG.normal(size=90) * 0.2
    m = with_hand_mean(idle_loop(betas=np.zeros(10), seconds=1.0, fps=30), mean)
    out, rep = M.apply_fits(m, M.SideFit(named_pose("pinch", "left"), 0.95), None)
    np.testing.assert_allclose(out.pose[:, LEFT_HAND], np.broadcast_to(named_pose("pinch", "left"), (30, 15, 3)),
                               atol=1e-9)
    np.testing.assert_allclose(out.pose[:, RIGHT_HAND], m.pose[:, RIGHT_HAND])
    assert rep["left"] == {"meanWeight": 1.0, "framesFitted": 30} and rep["right"]["framesFitted"] == 0
    low, rep = M.apply_fits(m, M.SideFit(named_pose("pinch", "left"), 0.3), M.SideFit(named_pose("fist"), 0.4))
    np.testing.assert_allclose(low.pose, m.pose)
    assert rep["left"]["meanWeight"] == 0.0


def test_apply_fits_clip_follows_the_time_series_and_the_clip_offset():
    m = idle_loop(betas=np.zeros(10), seconds=2.0, fps=10)
    times = np.array([1.0, 1.5, 2.0, 2.5])  # the motion starts at clip time 1.0 s
    poses = np.stack([named_pose("relaxed", "left"), named_pose("pinch", "left"), named_pose("fist", "left"),
                      named_pose("pinch", "left")])
    out, rep = M.apply_fits(m, M.SideFit(poses, np.array([0.95, 0.95, 0.95, 0.2]), times), None,
                            clip_offset_s=1.0, window=1)
    np.testing.assert_allclose(out.pose[0, LEFT_HAND], poses[0], atol=1e-9)
    np.testing.assert_allclose(out.pose[5, LEFT_HAND], poses[1], atol=1e-9)
    np.testing.assert_allclose(out.pose[10, LEFT_HAND], poses[2], atol=1e-9)
    np.testing.assert_allclose(out.pose[15, LEFT_HAND], m.pose[15, LEFT_HAND], atol=1e-9)  # low confidence: original
    assert validate_motion_dict(out.to_dict()) == []
