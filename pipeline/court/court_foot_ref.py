"""Each player's feet at the freeze in court space from two calibrated cameras, the assembly's depth anchor
(players[].footRef). The source camera alone sees the floor at a graze, so its soles can't say how far away they are;
a steep camera can. Their rays cross at a wide angle: each one's image column fixes what the other's can't.

    python3 -I court_foot_ref.py --config <private json> --out <footref.json>

config: {"players": {"<id>": {"A": {"calib": <calib json>, "frame": <source frame>, "mask": <png>},
                              "C": {...the steep camera, same keys}}},
         "sigmaPx": 3, "bandY": <m>}   (paths, frames and the cameras' names live only in that private file)

Per player, the feet are the connected blobs in the bottom 12% of each mask. Each blob in the steep camera is one foot.
- "A+C": A shows as many feet as the steep camera, paired by the order whose column offsets agree best (each foot's
  steep-camera point projected into A; their common offset, shiftA, is the two calibrations' disagreement): the two
  blob centroids' rays are triangulated (closest approach); `gap` is how far apart the rays pass.
- "C": A shows the feet as one blob (or none): the steep camera's ray to the foot band's centroid height alone (the
  player's own triangulated feet when it has some, else bandY: a band centroid sits above the sole).
sigma is per court axis (x, z), in metres: the pixels moved by sigmaPx in each camera, plus what a centroid can't say
(3 cm for the same centroid in two views; for "C" alone also its height, 3 cm, along that camera's ray).
"""

from __future__ import annotations

import argparse
import json
import sys
from itertools import permutations
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import camgeom as cg  # noqa: E402
import stabilize as st  # noqa: E402

BAND = 0.12  # the bottom share of the mask's height where the feet are looked for
MIN_SHARE = 0.03  # a blob smaller than this share of the largest is noise
BAND_Y = 0.08  # the foot band's centroid height (m) for one camera alone, when the config gives none
CENTROID_M = 0.03  # what a centroid can't say: the same point in two views, or its height


def foot_blobs(mask: np.ndarray) -> list[dict]:
    """The feet in a mask: blobs in its bottom band, each {u, v (centroid), u0, u1 (its columns), area}."""
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return []
    y1, y0 = ys.max(), ys.min()
    m = np.zeros(mask.shape, np.uint8)
    top = y1 - int(BAND * (y1 - y0))
    m[top:y1 + 1] = mask[top:y1 + 1]
    n, lab, stt, cen = cv2.connectedComponentsWithStats(m)
    if n < 2:
        return []
    big = stt[1:, cv2.CC_STAT_AREA].max()
    out = [{"u": float(cen[i][0]), "v": float(cen[i][1]), "u0": int(stt[i, cv2.CC_STAT_LEFT]),
            "u1": int(stt[i, cv2.CC_STAT_LEFT] + stt[i, cv2.CC_STAT_WIDTH]), "area": int(stt[i, cv2.CC_STAT_AREA])}
           for i in range(1, n) if stt[i, cv2.CC_STAT_AREA] >= MIN_SHARE * big]
    return sorted(out, key=lambda b: b["u"])


def ray(cam: dict, u: float, v: float) -> np.ndarray:
    return cg.pixel_rays(np.array(u, float), np.array(v, float), cam["R"], cam["f"], cam["k1"], cam["cx"], cam["cy"])


def triangulate(Ca, da, Cc, dc) -> tuple[np.ndarray, float]:
    """The midpoint of the two rays' closest approach, and how far apart they pass there."""
    w = Ca - Cc
    a, b, c, d, e = da @ da, da @ dc, dc @ dc, da @ w, dc @ w
    den = a * c - b * b
    s, t = (b * e - c * d) / den, (a * e - b * d) / den
    p, q = Ca + s * da, Cc + t * dc
    return (p + q) / 2, float(np.linalg.norm(p - q))


def on_band(cam, u, v, y: float) -> np.ndarray:
    P, ok = cg.ray_floor(cam["C"], ray(cam, u, v), y)
    return P if ok else np.full(3, np.nan)


def solve_feet(cam_a: dict, mask_a: np.ndarray, cam_c: dict, mask_c: np.ndarray, sigma_px: float = 3.0,
               band_y: float = BAND_Y) -> list[dict]:
    """The feet of one player: [{x, z, y, method, sigma [x, z], gap, px}], in the steep camera's left-to-right order."""
    blobs_a, blobs_c = foot_blobs(mask_a), foot_blobs(mask_c)

    hits, shift = [None] * len(blobs_c), None
    if blobs_a and len(blobs_a) == len(blobs_c):  # pair them: the order whose column offsets agree best
        u_c = [float(cg.project(on_band(cam_c, b["u"], b["v"], band_y), cam_a["R"], cam_a["C"], cam_a["f"], cam_a["k1"],
                                cam_a["cx"], cam_a["cy"])[0]) for b in blobs_c]
        best = min(permutations(range(len(blobs_a))),
                   key=lambda o: np.ptp([blobs_a[j]["u"] - u for j, u in zip(o, u_c)]))
        hits = list(best)
        shift = float(np.mean([blobs_a[j]["u"] - u for j, u in zip(best, u_c)]))
    feet = []
    for bc, ia in sorted(zip(blobs_c, hits), key=lambda t: t[1] is None):  # triangulated feet first: their height
        if ia is not None:
            ba = blobs_a[ia]

            def at(du_a=0.0, dv_a=0.0, du_c=0.0, dv_c=0.0):
                return triangulate(cam_a["C"], ray(cam_a, ba["u"] + du_a, ba["v"] + dv_a),
                                   cam_c["C"], ray(cam_c, bc["u"] + du_c, bc["v"] + dv_c))[0]
            P, gap = triangulate(cam_a["C"], ray(cam_a, ba["u"], ba["v"]), cam_c["C"], ray(cam_c, bc["u"], bc["v"]))
            moves = [dict(du_a=sigma_px), dict(dv_a=sigma_px), dict(du_c=sigma_px), dict(dv_c=sigma_px)]
            extra = np.array([CENTROID_M, CENTROID_M])
            px = {"A": [round(ba["u"], 1), round(ba["v"], 1)], "C": [round(bc["u"], 1), round(bc["v"], 1)],
                  "shiftA": round(shift, 1)}
            method = "A+C"
        else:
            y = float(np.mean([f["y"] for f in feet if f["method"] == "A+C"])) if any(
                f["method"] == "A+C" for f in feet) else band_y

            def at(du_c=0.0, dv_c=0.0):
                return on_band(cam_c, bc["u"] + du_c, bc["v"] + dv_c, y)
            P, gap = at(), None
            moves = [dict(du_c=sigma_px), dict(dv_c=sigma_px)]
            g = P[[0, 2]] - cam_c["C"][[0, 2]]
            g /= np.linalg.norm(g)
            along = CENTROID_M / np.tan(np.arctan2(cam_c["C"][1] - y, np.linalg.norm(P[[0, 2]] - cam_c["C"][[0, 2]])))
            extra = np.hypot(np.abs(g) * along, CENTROID_M)
            px = {"C": [round(bc["u"], 1), round(bc["v"], 1)]}
            method = "C"
        spread = np.array([at(**mv)[[0, 2]] - P[[0, 2]] for mv in moves])
        sig = np.sqrt((spread ** 2).sum(0) + extra ** 2)
        feet.append({"x": round(float(P[0]), 3), "z": round(float(P[2]), 3), "y": round(float(P[1]), 3), "uC": bc["u"],
                     "method": method, "sigma": [round(float(s), 3) for s in sig],
                     "gap": None if gap is None else round(gap, 3), "px": px, "areaC": bc["area"]})
    feet.sort(key=lambda f: f.pop("uC"))  # the steep camera's left to right
    return feet


def camera(spec: dict) -> tuple[dict, np.ndarray]:
    calib = json.loads(Path(spec["calib"]).expanduser().read_text())
    cam = st.frame_camera(calib, st.frame_index(calib, int(spec["frame"])))
    m = cv2.imread(str(Path(spec["mask"]).expanduser()), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise FileNotFoundError(spec["mask"])
    w, h = calib["image_size"]
    if m.shape != (h, w):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
    return cam, (m > 127).astype(np.uint8)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    cfg = json.loads(a.config.read_text())
    out = {"note": "court metres, floor (x, z) of each foot band's centroid (y: its height); sigma per axis; method A+C"
                   " = triangulated, C = the steep camera alone",
           "players": {}}
    for pid, p in cfg["players"].items():
        cam_a, mask_a = camera(p["A"])
        cam_c, mask_c = camera(p["C"])
        feet = solve_feet(cam_a, mask_a, cam_c, mask_c, cfg.get("sigmaPx", 3.0), cfg.get("bandY", BAND_Y))
        out["players"][pid] = {"footRef": [[f["x"], f["z"]] for f in feet], "feet": feet}
        for f in feet:
            print(f"{pid}: ({f['x']}, {f['z']}) +-({f['sigma'][0]}, {f['sigma'][1]}) m, {f['method']}, y {f['y']}"
                  + (f", rays {f['gap']} m apart" if f["gap"] is not None else ""))
    a.out.write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
