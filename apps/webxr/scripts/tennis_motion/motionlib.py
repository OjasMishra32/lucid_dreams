"""Tennis motion library: GVHMR fits of freely licensed clips -> clean motion.json clips for the WebXR tennis game.

Plain numpy/scipy on the Mac. Uses avatars/lucid_avatars for the motion.json conventions, skinning maths, hand poses
and foot locking, so every clip plays exactly the way the WebXR viewer (avatar.ts) and the Quest app pose avatars.

Body: every clip is retargeted to one canonical body, SMPL-X neutral with betas = 0 (the rest skeleton of
dreams/test-avatar, a plain SMPL-X neutral). Joint rotations are body independent; the root path is scaled by leg
length (lucid_avatars.retarget), so another avatar plays a clip with retarget() and no foot sliding.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation as Rot

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "avatars"))

from lucid_avatars import hand_poses  # noqa: E402
from lucid_avatars.motion import Motion  # noqa: E402
from lucid_avatars.rotations import aa_to_quat, quat_mul, quat_to_aa, quat_to_matrix  # noqa: E402
from lucid_avatars.retarget import leg_length  # noqa: E402
from lucid_avatars.smplx_layout import JOINT_NAMES, NUM_JOINTS, SMPLX_PARENTS, J  # noqa: E402

TEST_AVATAR = REPO / "dreams" / "test-avatar"
FPS = 30


def neutral_rest() -> np.ndarray:
    sk = json.loads((TEST_AVATAR / "avatar" / "skeleton.json").read_text())
    assert sk["joints"] == JOINT_NAMES
    return np.asarray(sk["rest"], dtype=np.float64)


# ---------------------------------------------------------------- forward kinematics (vectorised over frames)

def fk(rest, root_q, root_t, pose):
    """World joint positions (T,55,3) and rotations (T,55,3,3); the same maths as skinning.skin_matrices."""
    pose = np.asarray(pose, dtype=np.float64)
    T = len(pose)
    R = Rot.from_rotvec(pose.reshape(-1, 3)).as_matrix().reshape(T, NUM_JOINTS, 3, 3)
    R[:, 0] = quat_to_matrix(quat_mul(root_q, aa_to_quat(pose[:, 0])))
    G = np.zeros((T, NUM_JOINTS, 3, 3))
    P = np.zeros((T, NUM_JOINTS, 3))
    for j, p in enumerate(SMPLX_PARENTS):
        if p < 0:
            G[:, j] = R[:, j]
            P[:, j] = rest[j] + root_t
        else:
            G[:, j] = G[:, p] @ R[:, j]
            P[:, j] = P[:, p] + np.einsum("tab,b->ta", G[:, p], rest[j] - rest[p])
    return P, G


def pose_points(rest, P, G, xyz, idx, w):
    """Skin rest points (N,3) with skin.bin records for every frame -> (T,N,3)."""
    w = np.asarray(w, dtype=np.float64) / 255.0
    out = np.zeros((len(P), len(xyz), 3))
    for k in range(4):
        j = np.asarray(idx[:, k], dtype=np.int64)
        Gk, Pk = G[:, j], P[:, j]
        local = xyz - rest[j]
        out += w[None, :, k, None] * (np.einsum("tnab,nb->tna", Gk, local) + Pk)
    return out


class SolePoints:
    """The test avatar's visible Gaussians on the soles: posed with its own skin weights they give the floor."""

    def __init__(self):
        from lucid_avatars.gaussian_ply import read_ply
        from lucid_avatars.skinning import read_skin_bin

        g = read_ply(TEST_AVATAR / "avatar" / "avatar.ply")
        idx, w = read_skin_bin(TEST_AVATAR / "avatar" / "skin.bin")
        rest = neutral_rest()
        dom = idx[np.arange(len(idx)), np.argmax(w, axis=1)]
        alpha = 1 / (1 + np.exp(-g.opacity))
        feet = np.isin(dom, [J["left_ankle"], J["right_ankle"], J["left_foot"], J["right_foot"]])
        low = g.xyz[:, 1] < rest[J["left_ankle"], 1] + 0.01
        sel = np.flatnonzero(feet & low & (alpha > 0.5))
        self.xyz, self.idx, self.w = g.xyz[sel], idx[sel], w[sel]
        self.rest = rest
        self.rest_floor = float(g.xyz[sel, 1].min())

    def lowest(self, P, G):
        return pose_points(self.rest, P, G, self.xyz, self.idx, self.w)[..., 1].min(axis=1)


# ---------------------------------------------------------------- loading and retargeting

def load_gvhmr(npz_path) -> dict:
    d = np.load(npz_path, allow_pickle=True)
    return {k: d[k] for k in d.files}


def gvhmr_motion(d: dict, rest_dst: np.ndarray) -> Motion:
    """GVHMR's world fit as a Motion for the canonical body: same rotations, pelvis path scaled by leg length."""
    T = len(d["transl"])
    pose = np.zeros((T, NUM_JOINTS, 3))
    pose[:, 1:22] = d["body_pose"].reshape(T, 21, 3)
    root_q = aa_to_quat(d["global_orient"])
    pelvis = d["transl"] + d["J0"]  # SMPL-X turns the body about J0, so the pelvis sits at transl + J0
    s = leg_length(rest_dst) / leg_length(d["rest_joints"])
    root_t = s * pelvis - rest_dst[0]
    return Motion(fps=float(d["fps"]), betas=np.zeros(10), root_t=root_t, root_q=root_q, pose=pose)


def mirror(m: Motion) -> Motion:
    """Left-right mirror (x -> -x): a left-hander's stroke as a right-hander's."""
    swap = np.arange(NUM_JOINTS)
    for i, n in enumerate(JOINT_NAMES):
        if n.startswith("left_"):
            swap[i] = JOINT_NAMES.index("right_" + n[5:])
        elif n.startswith("right_"):
            swap[i] = JOINT_NAMES.index("left_" + n[6:])
    pose = m.pose[:, swap].copy()
    pose[..., 1:] *= -1
    aa = quat_to_aa(m.root_q)
    aa[:, 1:] *= -1
    t = m.root_t.copy()
    t[:, 0] *= -1
    return replace(m, pose=pose, root_q=aa_to_quat(aa), root_t=t)


# ---------------------------------------------------------------- time

def _qcontinuous(q):
    q = q.copy()
    for i in range(1, len(q)):
        if np.sum(q[i] * q[i - 1]) < 0:
            q[i] = -q[i]
    return q


def _slerp(q0, q1, a):
    dot = np.sum(q0 * q1, axis=-1, keepdims=True)
    q1 = np.where(dot < 0, -q1, q1)
    dot = np.abs(dot)
    a = np.asarray(a, dtype=np.float64)[..., None] if np.ndim(a) else a
    lin = dot > 0.9995
    th = np.arccos(np.clip(dot, -1, 1))
    s = np.sin(th)
    w0 = np.where(lin, 1 - a, np.sin((1 - a) * th) / np.where(lin, 1, s))
    w1 = np.where(lin, a, np.sin(a * th) / np.where(lin, 1, s))
    q = w0 * q0 + w1 * q1
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def resample(m: Motion, start_f: float, end_f: float, time_scale: float = 1.0, fps: float = FPS) -> Motion:
    """Frames [start_f, end_f] of m (source frame numbers, fractional ok) at `fps` of real time. time_scale is how
    much slower the footage plays than life (2 for 50 fps footage conformed to 25 fps)."""
    dur_real = (end_f - start_f) / m.fps / time_scale
    n = int(round(dur_real * fps)) + 1
    src = start_f + np.arange(n) / fps * time_scale * m.fps
    src = np.clip(src, 0, m.num_frames - 1)
    i0 = np.floor(src).astype(int)
    i1 = np.minimum(i0 + 1, m.num_frames - 1)
    a = src - i0
    q = aa_to_quat(m.pose)
    pose = quat_to_aa(_slerp(q[i0], q[i1], a[:, None]))
    rq = _slerp(m.root_q[i0], m.root_q[i1], a)
    rt = m.root_t[i0] * (1 - a[:, None]) + m.root_t[i1] * a[:, None]
    return Motion(fps=float(fps), betas=m.betas.copy(), root_t=rt, root_q=rq, pose=pose)


def smooth(m: Motion, sigma: float) -> Motion:
    """Light Gaussian smoothing (sigma in frames) of every rotation (quaternion, sign-continuous) and the root path."""
    if sigma <= 0:
        return m
    q = aa_to_quat(m.pose)
    for j in range(NUM_JOINTS):
        q[:, j] = gaussian_filter1d(_qcontinuous(q[:, j]), sigma, axis=0, mode="nearest")
    q /= np.linalg.norm(q, axis=-1, keepdims=True)
    rq = gaussian_filter1d(_qcontinuous(m.root_q), sigma, axis=0, mode="nearest")
    rq /= np.linalg.norm(rq, axis=-1, keepdims=True)
    rt = gaussian_filter1d(m.root_t, sigma, axis=0, mode="nearest")
    return replace(m, pose=quat_to_aa(q), root_q=rq, root_t=rt)


# ---------------------------------------------------------------- space

def apply_world(m: Motion, R: np.ndarray, t: np.ndarray, rest) -> Motion:
    """Move the whole motion by the rigid world transform x -> R x + t (SMPL-X turns about rest[0])."""
    j0 = np.asarray(rest)[0]
    rq = quat_mul(np.broadcast_to(Rot.from_matrix(R).as_quat(), m.root_q.shape), m.root_q)
    rt = (m.root_t + j0) @ R.T + t - j0
    return replace(m, root_q=rq, root_t=rt)


def yaw_matrix(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def body_forward(P) -> np.ndarray:
    """(T,2) horizontal facing (x, z) from the hips and shoulders: perpendicular to left->right, pointing front."""
    lr = (P[:, J["right_hip"]] - P[:, J["left_hip"]]) + (P[:, J["right_shoulder"]] - P[:, J["left_shoulder"]])
    # SMPL-X rest: right is -x, front is +z, so front = up x (right - left) ... check: up x (-x) = +z
    f = np.cross(np.array([0.0, 1.0, 0.0]), lr)
    f = f[:, [0, 2]]
    return f / np.linalg.norm(f, axis=1, keepdims=True)


def face_minus_z(m: Motion, rest, frames=slice(0, 6), forward=None) -> Motion:
    """Turn about +Y so the body faces -Z over `frames` (or along the given horizontal `forward`), and put that
    frame's pelvis over x = z = 0."""
    P, _ = fk(rest, m.root_q, m.root_t, m.pose)
    f = body_forward(P)[frames].mean(axis=0) if forward is None else np.asarray(forward, dtype=np.float64)
    ang = math.atan2(f[0], f[1])  # heading of the body: 0 = +Z
    R = yaw_matrix(math.pi - ang)  # turn it to heading pi (= -Z)
    out = apply_world(m, R, np.zeros(3), rest)
    P2, _ = fk(rest, out.root_q, out.root_t, out.pose)
    c = P2[frames, J["pelvis"]].mean(axis=0)
    return apply_world(out, np.eye(3), np.array([-c[0], 0.0, -c[2]]), rest)


def to_floor(m: Motion, rest, soles: SolePoints, percentile: float = 1.0, frames=None) -> Motion:
    """Drop the motion so the soles touch y = 0 (a low percentile of the per-frame lowest sole point, so a single
    noisy frame doesn't lift the whole clip)."""
    P, G = fk(rest, m.root_q, m.root_t, m.pose)
    low = soles.lowest(P, G)
    sel = low if frames is None else low[frames]
    floor = float(np.percentile(sel, percentile))
    t = m.root_t.copy()
    t[:, 1] -= floor
    return replace(m, root_t=t)


def clamp_above_floor(m: Motion, rest, soles: SolePoints) -> Motion:
    """Lift any frame whose soles dip below y = 0 by just that much (smoothed), so nothing sinks into the floor."""
    P, G = fk(rest, m.root_q, m.root_t, m.pose)
    low = soles.lowest(P, G)
    lift = np.maximum(0.0, -low)
    if lift.max() <= 0:
        return m
    lift = np.maximum(lift, gaussian_filter1d(lift, 1.5))
    t = m.root_t.copy()
    t[:, 1] += lift
    return replace(m, root_t=t)


# ---------------------------------------------------------------- hands

# The racket in the right hand's frame (right_wrist joint, SMPL-X rest: fingers along -x, palm down, thumb toward +z):
# a shake-hands grip puts the shaft out of the thumb-index web, between the thumb direction and the fingers. Rough by
# nature (GVHMR has no fingers and no racket); the game should treat it as a starting point.
RACKET_DIR_LOCAL = np.array([-1.0, 0.0, 1.0]) / np.sqrt(2.0)  # 45 degrees between the fingers and the thumb
RACKET_GRIP_OFFSET = np.array([-0.08, -0.01, 0.0])  # wrist joint -> middle of the grip (in the palm), metres
RACKET_LENGTH = 0.685
RACKET_HEAD_CENTER = 0.50  # from the grip point along the shaft


def racket_points(P, G):
    """Grip point, racket head centre and tip (T,3) each from world joints and rotations."""
    R = G[:, J["right_wrist"]]
    grip = P[:, J["right_wrist"]] + R @ RACKET_GRIP_OFFSET
    d = R @ RACKET_DIR_LOCAL
    return grip, grip + RACKET_HEAD_CENTER * d, grip + (RACKET_LENGTH - 0.1) * d

def with_grip(m: Motion, right: str = "fist", left: str = "relaxed", right_amount: float = 0.9) -> Motion:
    """Racket grip on the right hand, relaxed left hand (GVHMR gives flat hands)."""
    pose = m.pose.copy()
    rq = hand_poses.blend(hand_poses.pose("relaxed", "right"), hand_poses.pose(right, "right"), right_amount)
    pose[:, 40:55] = rq
    pose[:, 25:40] = hand_poses.pose(left, "left")
    return replace(m, pose=pose)


# ---------------------------------------------------------------- loops

def make_loop(m: Motion, travel: bool = False):
    """A seamless loop from a motion whose LAST frame is the moment the cycle comes back to its first frame (so the
    loop is frames 0..N-1 and frame N is where it wraps). The mismatch between frame N and frame 0 is spread evenly
    over the cycle (every joint rotation, the root rotation and the root path), so frame N-1 flows into frame 0 with
    no pop and no joint moves more than its share of the error.

    travel=False: in place, the net root drift over the cycle is removed. travel=True: the mean horizontal velocity
    over the cycle is taken out of root_t (left as in-place sway, bob and lean) and returned as a constant velocity
    (m/s, x and z; y = 0) so a game can scale it. Returns (loop Motion, velocity (3,))."""
    n = m.num_frames - 1
    k = (np.arange(n) / n)[:, None]
    q = aa_to_quat(m.pose)                           # (N+1, 55, 4)
    err = _qpos(quat_mul(q[n], _qinv(q[0])))          # rotation taking frame 0's local rotation to frame N's
    err_aa = quat_to_aa(err)                          # (55, 3)
    corr = aa_to_quat(-k[:, :, None] * err_aa[None])  # undo k/N of it at frame k
    pose = quat_to_aa(quat_mul(corr, q[:n]))
    rerr = quat_to_aa(_qpos(quat_mul(m.root_q[n], _qinv(m.root_q[0]))))
    root_q = quat_mul(aa_to_quat(-k * rerr[None]), m.root_q[:n])
    d = m.root_t[n] - m.root_t[0]
    vel = np.zeros(3)
    if travel:
        vel[[0, 2]] = d[[0, 2]] / n * m.fps
    root_t = m.root_t[:n] - k * d[None]
    return replace(m, pose=pose, root_q=root_q, root_t=root_t), vel


def _qpos(q):
    return np.where(q[..., 3:] < 0, -q, q)


def split_root_motion(m: Motion, mean_vel: np.ndarray):
    """For a travel loop: take ALL horizontal pelvis motion out of root_t (x, z become 0) and return it as a
    per-frame velocity (N, 2) [vx, vz] in m/s = the cycle's mean velocity + the periodic surge (circular central
    difference), so a game integrates position += velocity * scale * dt and reproduces the footage at scale 1."""
    n = m.num_frames
    t = m.root_t
    d = (np.roll(t, -1, axis=0) - np.roll(t, 1, axis=0)) / 2 * m.fps  # periodic: the loop wraps
    vel = d[:, [0, 2]] + np.asarray(mean_vel)[[0, 2]][None]
    rt = t.copy()
    rt[:, 0] = 0.0
    rt[:, 2] = 0.0
    return replace(m, root_t=rt), vel


def center_xz(m: Motion, rest) -> Motion:
    """Shift the whole clip so the mean pelvis over the clip is over x = z = 0."""
    P, _ = fk(rest, m.root_q, m.root_t, m.pose)
    c = P[:, 0].mean(axis=0)
    t = m.root_t.copy()
    t[:, 0] -= c[0]
    t[:, 2] -= c[2]
    return replace(m, root_t=t)


def concat(a: Motion, b: Motion, blend: int) -> Motion:
    """a then b, the last `blend` frames of a cross-faded (slerp, smoothstep) into the first `blend` of b. b's root is
    moved so its first frame continues from a's (horizontal position and heading kept from a)."""
    # align b's start to a's frame len(a) - blend (horizontal offset only; GVHMR's heading is continuous in one clip)
    off = a.root_t[len(a.root_t) - blend] - b.root_t[0]
    off[1] = 0.0
    bt = b.root_t + off
    n = a.num_frames + b.num_frames - blend
    qa, qb = aa_to_quat(a.pose), aa_to_quat(b.pose)
    pose = np.zeros((n, NUM_JOINTS, 4))
    rq = np.zeros((n, 4))
    rt = np.zeros((n, 3))
    na = a.num_frames - blend
    pose[:na], rq[:na], rt[:na] = qa[:na], a.root_q[:na], a.root_t[:na]
    for k in range(blend):
        w = 0.5 - 0.5 * math.cos(math.pi * (k + 0.5) / blend)
        pose[na + k] = _slerp(qa[na + k], qb[k], np.full(NUM_JOINTS, w))
        rq[na + k] = _slerp(a.root_q[na + k], b.root_q[k], w)
        rt[na + k] = (1 - w) * a.root_t[na + k] + w * bt[k]
    pose[na + blend:], rq[na + blend:], rt[na + blend:] = qb[blend:], b.root_q[blend:], bt[blend:]
    return replace(a, pose=quat_to_aa(pose), root_q=rq, root_t=rt)


def _qinv(q):
    q = np.asarray(q, dtype=np.float64).copy()
    q[..., :3] *= -1
    return q


def best_cycle(m: Motion, rest, start_range, period_range, body_only: bool = True):
    """(start, period) in frames minimising the pose distance between frame start and start + period."""
    P, _ = fk(rest, m.root_q, m.root_t, m.pose)
    rel = P[:, :22] - P[:, [0]]
    fwd = body_forward(P)
    best = (1e9, None, None)
    for s in range(*start_range):
        for per in range(*period_range):
            e = s + per
            if e >= m.num_frames:
                break
            dpos = np.linalg.norm(rel[s] - rel[e], axis=1).mean()
            # matching velocities too, so the loop doesn't stutter
            vs = rel[min(s + 1, m.num_frames - 1)] - rel[s]
            ve = rel[min(e + 1, m.num_frames - 1)] - rel[e]
            dvel = np.linalg.norm(vs - ve, axis=1).mean()
            dyaw = 1 - float(np.dot(fwd[s], fwd[e]))
            cost = dpos + 0.5 * dvel + 0.2 * dyaw
            if cost < best[0]:
                best = (cost, s, per)
    return best[1], best[2], best[0]
