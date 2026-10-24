import math

import numpy as np
from smplx_rest import smplx_like_rest

from lucid_avatars import foot_contact as FC
from lucid_avatars.ik import world_joints
from lucid_avatars.motion import Motion, validate_motion_dict
from lucid_avatars.rotations import aa_to_quat
from lucid_avatars.smplx_layout import NUM_JOINTS, J

FPS = 60.0


def _rest():
    """SMPL-X-like rest with exactly vertical legs (hip 0.4 m above knee above ankle) and a toe joint ahead and down."""
    rest = smplx_like_rest()
    for s, x in (("left", 0.09), ("right", -0.09)):
        rest[J[f"{s}_hip"]] = [x, -0.45, 0.0]
        rest[J[f"{s}_knee"]] = [x, -0.85, 0.0]
        rest[J[f"{s}_ankle"]] = [x, -1.25, 0.0]
        rest[J[f"{s}_foot"]] = [x, -1.30, 0.13]
    return rest


def _x(angle):
    return np.array([angle, 0.0, 0.0])


def _ankle_toe(m, rest, side):
    out = np.array([world_joints(rest, m.root_q[f], m.root_t[f], m.pose[f])[0] for f in range(m.num_frames)])
    return out[:, J[f"{side}_ankle"]], out[:, J[f"{side}_foot"]]


def _hip_angle(rel_z, kappa):
    """Hip flexion (positive: thigh swings back) that puts the ankle rel_z ahead of the hip, knee flexed by kappa."""
    lo, hi = -1.3, 1.3
    for _ in range(60):
        mid = (lo + hi) / 2
        z = -0.4 * (math.sin(mid) + math.sin(mid + kappa))  # decreasing in mid
        lo, hi = (mid, hi) if z > rel_z else (lo, mid)
    return (lo + hi) / 2


def _walk(cycles=3, drift=0.025, v=0.9):
    """A walk at 60 fps, 1 s per cycle. Each foot is planted for half of it (knee a little bent, foot flat) but creeps
    `drift` metres over that stance; then it swings forward with the knee flexed (about 6 cm lift). The root's height
    keeps the stance ankle at 0.10 m. Right foot half a cycle behind the left."""
    rest = _rest()
    n = int(cycles * FPS)
    root_t = np.zeros((n, 3))
    pose = np.zeros((n, NUM_JOINTS, 3))
    k0 = math.radians(12)
    stance_z = lambda cyc, phi: v * (phi + cyc) + 0.23  # noqa: E731  where a foot lands in cycle `cyc`
    for f in range(n):
        t = f / FPS
        root_t[f, 2] = v * t
        for side, phi in (("left", 0.0), ("right", 0.5)):
            u = t - phi
            cyc, sp = math.floor(u), u - math.floor(u)
            if sp < 0.5:
                z, ka = stance_z(cyc, phi) + drift * sp / 0.5, k0
            else:
                s = (sp - 0.5) / 0.5
                z0, z1 = stance_z(cyc, phi) + drift, stance_z(cyc + 1, phi)
                z = z0 + (z1 - z0) * s * s * (3 - 2 * s)
                ka = k0 + math.radians(45) * math.sin(math.pi * s)
            al = _hip_angle(z - root_t[f, 2], ka)
            pose[f, J[f"{side}_hip"]] = _x(al)
            pose[f, J[f"{side}_knee"]] = _x(ka)
            pose[f, J[f"{side}_ankle"]] = _x(-(al + ka))  # foot flat
    m = Motion(fps=FPS, betas=np.zeros(10), root_t=root_t, root_q=np.tile([0, 0, 0, 1.0], (n, 1)), pose=pose)
    for f in range(n):
        u = f / FPS
        stance = "left" if u % 1.0 < 0.5 else "right"
        one = Motion(FPS, m.betas, m.root_t[f:f + 1], m.root_q[f:f + 1], m.pose[f:f + 1])
        m.root_t[f, 1] += 0.10 - _ankle_toe(one, rest, stance)[0][0, 1]
    return m, rest


def test_walk_fixture_slides_and_swings():
    m, rest = _walk()
    a, t = _ankle_toe(m, rest, "left")
    stance = a[:28]
    assert np.ptp(stance[:, 1]) < 1e-9  # planted: constant height
    assert abs(np.ptp(t[:28, 1])) < 1e-6  # flat foot
    assert np.hypot(*(stance[-1, [0, 2]] - stance[0, [0, 2]])) > 0.02 * 28 / 30 * 0.9  # but it skates
    assert a[30:60, 1].max() > 0.14  # and the swing lifts


def test_detect_requires_low_slow_for_three_frames_with_hysteresis():
    n = 40
    ankle = np.zeros((n, 3)); toe = np.zeros((n, 3))
    ankle[:, 1], toe[:, 1] = 0.10, 0.05
    ankle[:, 2] = np.arange(n) * 0.004   # 0.24 m/s at 60 fps: slow
    toe[:, 2] = ankle[:, 2] + 0.13
    # airborne: frames 20..29
    ankle[20:30, 1] += 0.3; toe[20:30, 1] += 0.3
    segs = FC.detect_contacts(ankle, toe, FPS, 0.10, 0.05)
    assert segs == [(0, 19), (30, 39)]
    # two grounded frames only: not a contact
    ankle2, toe2 = ankle.copy(), toe.copy()
    ankle2[:, 1] += 0.3; toe2[:, 1] += 0.3
    ankle2[10:12, 1] -= 0.3; toe2[10:12, 1] -= 0.3
    assert FC.detect_contacts(ankle2, toe2, FPS, 0.10, 0.05) == []
    # a speed bump between the enter and exit thresholds inside a contact does not split it
    ankle3, toe3 = ankle.copy(), toe.copy()
    ankle3[:, 1], toe3[:, 1] = 0.10, 0.05
    ankle3[:, 2] = np.concatenate([np.arange(15) * 0.004, 0.056 + np.arange(1, 4) * 0.007 + 0.0,
                                   0.077 + np.arange(1, 23) * 0.004])
    toe3[:, 2] = ankle3[:, 2] + 0.13
    assert FC.detect_contacts(ankle3, toe3, FPS, 0.10, 0.05) == [(0, 39)]


def test_lock_walk_stance_feet_do_not_slide_and_swing_untouched():
    m, rest = _walk()
    before_pose, before_t = m.pose.copy(), m.root_t.copy()
    out, rep = FC.lock_feet(m, rest)
    assert validate_motion_dict(out.to_dict()) == []
    np.testing.assert_array_equal(m.pose, before_pose)  # the input is not modified
    np.testing.assert_array_equal(m.root_t, before_t)
    for side in ("left", "right"):
        info = rep[side]
        assert info["contactFrames"] >= 60
        assert info["slideMm"]["before"] > 15
        assert info["slideMm"]["after"] < 2.0
    assert rep["footSlideMm"]["after"] < 2.0 and rep["footSlideMm"]["before"] > 15
    # a foot's own swing frames, away from its contacts, are bit-identical (the root may still nudge for the other foot)
    for side in ("left", "right"):
        far = _far_from_contacts({"left": {"segments": []}, "right": {"segments": []}, side: rep[side]}, m.num_frames)
        assert far.sum() >= 15
        for j in ("hip", "knee", "ankle", "foot"):
            np.testing.assert_array_equal(out.pose[far, J[f"{side}_{j}"]], m.pose[far, J[f"{side}_{j}"]])


def test_lock_keeps_bone_lengths_floor_and_continuity():
    m, rest = _walk()
    out, rep = FC.lock_feet(m, rest)
    for side in ("left", "right"):
        L1 = np.linalg.norm(rest[J[f"{side}_knee"]] - rest[J[f"{side}_hip"]])
        L2 = np.linalg.norm(rest[J[f"{side}_ankle"]] - rest[J[f"{side}_knee"]])
        for f in range(out.num_frames):
            pos, _ = world_joints(rest, out.root_q[f], out.root_t[f], out.pose[f])
            assert abs(np.linalg.norm(pos[J[f"{side}_knee"]] - pos[J[f"{side}_hip"]]) - L1) < 1e-9
            assert abs(np.linalg.norm(pos[J[f"{side}_ankle"]] - pos[J[f"{side}_knee"]]) - L2) < 1e-9
        a0, t0 = _ankle_toe(m, rest, side)
        a1, t1 = _ankle_toe(out, rest, side)
        assert a1[:, 1].min() >= a0[:, 1].min() - 1e-3  # nothing through the floor
        assert t1[:, 1].min() >= t0[:, 1].min() - 1e-3
        dev = np.linalg.norm(a1 - a0, axis=1)  # no pops: the edit grows and fades smoothly
        assert np.abs(np.diff(dev)).max() < 0.02
    assert out.root_t[:, 1].min() >= m.root_t[:, 1].min() - 0.005
    assert np.abs(out.root_t - m.root_t).max() < 0.03  # root only nudged
    np.testing.assert_array_equal(out.root_q, m.root_q)
    np.testing.assert_allclose(out.pose[:, 0], 0)


def _jump():
    """Stand with both feet creeping 2.4 cm, jump forward 30 cm and 45 cm high, land and creep again; legs straight."""
    rest = _rest()
    n = 150
    root_t = np.zeros((n, 3))
    root_t[:, 1] = 0.10 - rest[J["left_ankle"]][1]  # ankles 0.10 above the floor
    z = np.zeros(n)
    z[:60] = np.arange(60) * 0.0004
    z[60:90] = z[59] + 0.3 * (np.arange(30) / 29)
    z[90:] = z[89] + np.arange(1, 61) * 0.0004
    t = np.arange(30) / 29
    root_t[60:90, 1] += 0.45 * 4 * t * (1 - t)
    root_t[:, 2] = z
    pose = np.zeros((n, NUM_JOINTS, 3))
    m = Motion(fps=FPS, betas=np.zeros(10), root_t=root_t, root_q=np.tile([0, 0, 0, 1.0], (n, 1)), pose=pose)
    return m, rest


def _far_from_contacts(rep, n, margin=None):
    blend = FC.FootLockParams().blend
    near = np.zeros(n, dtype=bool)
    for side in ("left", "right"):
        for s, e in rep[side]["segments"]:
            near[max(0, s - blend - 1): e + blend + 2] = True
    return ~near


def test_lock_jump_pins_both_feet_before_and_after_the_flight():
    m, rest = _jump()
    out, rep = FC.lock_feet(m, rest)
    assert validate_motion_dict(out.to_dict()) == []
    for side in ("left", "right"):
        segs = rep[side]["segments"]
        assert len(segs) == 2 and segs[0][0] == 0 and segs[1][1] == m.num_frames - 1
        assert rep[side]["slideMm"]["before"] > 20 and rep[side]["slideMm"]["after"] < 2.0
        a0, _ = _ankle_toe(m, rest, side)
        a1, _ = _ankle_toe(out, rest, side)
        air = _far_from_contacts(rep, m.num_frames)
        assert air.sum() >= 15
        np.testing.assert_allclose(a1[air], a0[air], atol=1e-9)  # the flight is untouched
        assert a1[:, 1].min() >= a0[:, 1].min() - 1e-3
    # a fully stretched leg cannot reach the held point: the root gave way, by millimetres
    assert 0 < np.abs(out.root_t - m.root_t).max() < 0.02


def test_no_contact_means_nothing_changes():
    m, rest = _jump()
    m.root_t[:, 1] += 0.5  # never touches the floor: all frames equally high, so the floor is the clip's own...
    m.root_t[::2, 1] += 0.3
    m.root_t[1::2, 1] += 0.6  # ...but alternate frames bounce too fast to be "slow and low"
    out, rep = FC.lock_feet(m, rest=rest)
    assert rep["footSlideMm"] == {"before": 0.0, "after": 0.0}
    np.testing.assert_array_equal(out.pose, m.pose)
    np.testing.assert_array_equal(out.root_t, m.root_t)


def test_short_clip_is_returned_as_is():
    m, rest = _jump()
    short = Motion(m.fps, m.betas, m.root_t[:2], m.root_q[:2], m.pose[:2])
    out, rep = FC.lock_feet(short, rest)
    assert out.num_frames == 2 and rep["footSlideMm"] == {"before": 0.0, "after": 0.0}


def test_slide_numbers_go_into_dream_json_metrics(tmp_path):
    import json

    (tmp_path / "dream.json").write_text(json.dumps({"id": "x", "metrics": {"psnr": None, "seenFraction": 0.4}}))
    m, rest = _walk(cycles=2)
    _, rep = FC.lock_feet(m, rest)
    metrics = FC.add_slide_metrics(tmp_path, rep)
    stored = json.loads((tmp_path / "dream.json").read_text())["metrics"]
    assert stored == metrics and stored["seenFraction"] == 0.4 and stored["psnr"] is None
    assert set(stored["footSlideMm"]) == {"before", "after"} and stored["footSlideMm"]["after"] < 2.0
    assert json.loads((tmp_path / "avatar" / "foot_lock.json").read_text())["left"]["contactFrames"] > 0


def test_the_report_formats_as_log_lines():
    m, rest = _walk(cycles=2)
    _, rep = FC.lock_feet(m, rest)
    text = FC.format_report(rep)
    assert "left foot" in text and "right foot" in text and "mm" in text
    assert isinstance(aa_to_quat(np.zeros(3)), np.ndarray)
