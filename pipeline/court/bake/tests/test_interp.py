"""interp.py on the synthetic clip: DIS-flow in-betweens vs ground truth (SSIM), no ghosting, the RIFE cache.

    /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_interp.py -q -s   (-s prints the SSIM table)
"""
import json

import cv2
import numpy as np
import pytest

from bake import interp, synth

SPEC = synth.Spec(n_frames=48)


class CachedClip(synth.SynthClip):
    """Renders each ground truth once (the tests ask for the same real frames many times)."""

    def __init__(self, spec):
        super().__init__(spec)
        self._gt = {}

    def gt(self, src):
        if src not in self._gt:
            self._gt[src] = super().gt(src)
        return self._gt[src]


@pytest.fixture(scope="module")
def clip():
    return CachedClip(SPEC)


def gray(img):
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def moving(clip, a, b):
    """Pixels that change between the two real frames' truths (where an in-between can go wrong)."""
    d = np.abs(gray(clip.gt(a)).astype(int) - gray(clip.gt(b)).astype(int)) > 6
    return cv2.dilate(d.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)


def pairs(clip, gap):
    uniq = [s for s in clip.unique if s not in clip.flash_srcs]
    return [(uniq[i], uniq[i + gap]) for i in range(2, len(uniq) - gap, 5)]


def score(clip, a, b, w, method):
    A, B = clip.gt(a), clip.gt(b)
    truth = clip.gt_at(a, b, w)
    out = interp.interpolate(A, B, w, method=method)
    m = moving(clip, a, b)
    smap = interp.ssim_map(gray(out), gray(truth))
    err = np.abs(out.astype(int) - truth.astype(int)).max(axis=2)
    return float(smap.mean()), float(smap[m].mean()), float((err[m] > 40).mean())


def test_endpoints(clip):
    a, b = pairs(clip, 1)[0]
    A, B = clip.gt(a), clip.gt(b)
    assert np.array_equal(interp.interpolate(A, B, 0.0), A)
    assert np.array_equal(interp.interpolate(A, B, 1.0), B)


@pytest.mark.parametrize("gap", [1, 2, 4])
def test_flow_inbetweens_match_truth_and_beat_a_dissolve(clip, gap):
    rows = []
    for a, b in pairs(clip, gap):
        for w in (0.25, 0.5, 0.75):
            rows.append((score(clip, a, b, w, "dis"), score(clip, a, b, w, "dissolve")))
    flow = np.array([r[0] for r in rows])
    diss = np.array([r[1] for r in rows])
    print(f"\ngap {gap} capture(s), {len(rows)} in-betweens: SSIM full {flow[:, 0].mean():.4f} (min {flow[:, 0].min():.4f}), "
          f"moving {flow[:, 1].mean():.4f} (min {flow[:, 1].min():.4f}), ghost px {flow[:, 2].mean():.4f} | "
          f"dissolve: full {diss[:, 0].mean():.4f}, moving {diss[:, 1].mean():.4f}, ghost px {diss[:, 2].mean():.4f}")
    assert flow[:, 0].min() > (0.93 if gap <= 2 else 0.9)  # the bake only bridges 1-3 captures
    assert flow[:, 1].mean() > 0.85
    assert flow[:, 1].mean() > diss[:, 1].mean()
    assert flow[:, 2].mean() < 0.5 * diss[:, 2].mean() + 1e-3


def test_no_ghost_person(clip):
    """A jersey colour found in the in-between is one blob where the truth has it, not two half-strength ones."""
    a, b = pairs(clip, 4)[1]
    w = 0.5
    truth = clip.gt_at(a, b, w)
    out = interp.interpolate(clip.gt(a), clip.gt(b), w)
    diss = interp.interpolate(clip.gt(a), clip.gt(b), w, method="dissolve")
    cov = clip.render((1 - w) * clip.time_of(a) + w * clip.time_of(b), masks=True)
    for person in clip.people:
        pid = person.id
        t = cov[pid] > 0.5
        if t.sum() < 200:
            continue
        ref = np.array(person.shirt) * 0.85  # the sprite's shirt colour (texture noise is +-12%)

        def iou(img):
            x = np.abs(img.astype(int) - ref).max(axis=2) < 40
            near = cv2.dilate(t.astype(np.uint8), np.ones((31, 31), np.uint8)).astype(bool)
            x &= near
            tt = np.abs(truth.astype(int) - ref).max(axis=2) < 40
            tt &= near
            return (x & tt).sum() / max((x | tt).sum(), 1)

        assert iou(out) > 0.75, (pid, iou(out))
        assert iou(out) > iou(diss), (pid, iou(out), iou(diss))


def test_rife_cache_round_trip(tmp_path, clip):
    a, b = pairs(clip, 1)[0]
    needs = [(a, b, 0.5), (a, b, 0.123456789)]
    man = interp.write_needs(needs, tmp_path / "needs.json")
    data = json.loads((tmp_path / "needs.json").read_text())
    assert len(data["pairs"]) == 2 and data["pairs"][0]["out"] != data["pairs"][1]["out"]
    assert man == data
    # the job writes each listed `out` under rife/; then the bake reads it back by (a, b, w)
    (tmp_path / "rife").mkdir()
    marker = np.full((SPEC.height, SPEC.width, 3), 77, np.uint8)
    cv2.imwrite(str(tmp_path / "rife" / data["pairs"][0]["out"]), marker)
    (tmp_path / "rife" / "needs.json").write_text(json.dumps(data))
    ib = interp.Inbetweens(lambda s: clip.gt(s), rife_dir=tmp_path / "rife")
    img, how = ib.get(a, b, 0.5)
    assert how == "rife" and np.array_equal(img, marker)
    img, how = ib.get(a, b, 0.5004)  # within the lookup tolerance (the timeline may nudge w slightly)
    assert how == "rife" and np.array_equal(img, marker)
    img, how = ib.get(a, b, 0.123456789)
    assert how == "dis" and img.shape == marker.shape
    assert ib.get(a, b, 0.51)[1] == "dis"
    ib2 = interp.Inbetweens(lambda s: clip.gt(s), rife_dir=None)
    assert ib2.get(a, b, 0.5)[1] == "dis"
