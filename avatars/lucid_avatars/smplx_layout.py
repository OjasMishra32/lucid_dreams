"""SMPL-X joint order and the packed parameter layout DiGS-Avatar uses."""

_FINGERS = ["index", "middle", "pinky", "ring", "thumb"]

# The 55 SMPL-X joints that carry a rotation, in the model's order.
JOINT_NAMES: list[str] = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2",
    "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck",
    "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "jaw", "left_eye", "right_eye",
    *[f"left_{f}{i}" for f in _FINGERS for i in (1, 2, 3)],
    *[f"right_{f}{i}" for f in _FINGERS for i in (1, 2, 3)],
]
NUM_JOINTS = len(JOINT_NAMES)
J = {name: i for i, name in enumerate(JOINT_NAMES)}

BODY = slice(1, 22)
LEFT_HAND = slice(25, 40)
RIGHT_HAND = slice(40, 55)

# DiGS-Avatar packs one SMPL-X frame into 189 floats (see its lib/utils/infer_util.py).
# Hand poses are stored relative to the SMPL-X hand mean.
DIGS_SCALE = slice(0, 1)
DIGS_TRANS = slice(1, 4)
DIGS_ROOT = slice(4, 7)
DIGS_BODY = slice(7, 70)
DIGS_BETAS = slice(70, 80)
DIGS_HANDS = slice(80, 170)
DIGS_JAW = slice(170, 173)
DIGS_EYES = slice(173, 179)
DIGS_EXPR = slice(179, 189)
DIGS_PARAM_DIM = 189

# Parent of each joint (-1 for the pelvis), the SMPL-X kinematic tree. Each finger chain hangs off its wrist.
SMPLX_PARENTS: list[int] = [
    -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19,
    15, 15, 15,
    *[p for base in range(25, 40, 3) for p in (J["left_wrist"], base, base + 1)],
    *[p for base in range(40, 55, 3) for p in (J["right_wrist"], base, base + 1)],
]
