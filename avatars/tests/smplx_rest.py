"""An SMPL-X-proportioned rest skeleton (zero pose, flat hands, faces +Z) for tests that need a real body's lengths.

Joint positions are approximate (about 1.7 m tall, the neutral model's layout); real avatars carry their own in
skeleton.json.
"""

import numpy as np

from lucid_avatars.smplx_layout import NUM_JOINTS, J

_BODY = {
    "pelvis": [0.003, -0.351, 0.012],
    "left_hip": [0.061, -0.445, -0.014], "right_hip": [-0.060, -0.455, -0.009],
    "spine1": [0.000, -0.241, -0.016],
    "left_knee": [0.116, -0.823, -0.005], "right_knee": [-0.104, -0.818, -0.010],
    "spine2": [0.010, -0.105, -0.006],
    "left_ankle": [0.073, -1.227, -0.047], "right_ankle": [-0.086, -1.225, -0.040],
    "spine3": [-0.002, -0.051, 0.022],
    "left_foot": [0.121, -1.285, 0.079], "right_foot": [-0.126, -1.280, 0.083],
    "neck": [-0.014, 0.110, -0.024],
    "left_collar": [0.045, 0.029, -0.002], "right_collar": [-0.049, 0.027, -0.008],
    "head": [0.011, 0.267, -0.001],
    "left_shoulder": [0.181, 0.088, -0.018], "right_shoulder": [-0.179, 0.088, -0.017],
    "left_elbow": [0.432, 0.044, -0.033], "right_elbow": [-0.429, 0.037, -0.036],
    "left_wrist": [0.677, 0.050, -0.027], "right_wrist": [-0.689, 0.043, -0.034],
    "jaw": [0.011, 0.220, 0.040],
    "left_eye": [0.040, 0.300, 0.080], "right_eye": [-0.020, 0.300, 0.080],
}
# Finger joints relative to the wrist, for the left hand (+X); the right hand mirrors x.
_FINGER_OFFSETS = {
    "index": [[0.090, -0.004, 0.025], [0.128, -0.006, 0.028], [0.152, -0.008, 0.029]],
    "middle": [[0.095, 0.000, 0.003], [0.137, -0.002, 0.003], [0.164, -0.004, 0.003]],
    "pinky": [[0.078, -0.010, -0.040], [0.102, -0.012, -0.044], [0.120, -0.013, -0.046]],
    "ring": [[0.090, -0.006, -0.020], [0.127, -0.008, -0.022], [0.152, -0.010, -0.023]],
    "thumb": [[0.025, -0.015, 0.030], [0.050, -0.020, 0.050], [0.075, -0.020, 0.065]],
}


def smplx_like_rest() -> np.ndarray:
    rest = np.zeros((NUM_JOINTS, 3))
    for name, xyz in _BODY.items():
        rest[J[name]] = xyz
    for finger, offsets in _FINGER_OFFSETS.items():
        for i, off in enumerate(offsets, start=1):
            rest[J[f"left_{finger}{i}"]] = rest[J["left_wrist"]] + off
            rest[J[f"right_{finger}{i}"]] = rest[J["right_wrist"]] + np.multiply(off, [-1, 1, 1])
    return rest
