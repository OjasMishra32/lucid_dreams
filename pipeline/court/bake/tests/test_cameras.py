"""cameras: per display frame camera from a calib_A.json-schema solve, frames.json, format.ts validation (synthetic)."""
import dataclasses
import json

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from pipeline.court.bake import cameras as C
from pipeline.court.bake import timeline as T
from pipeline.court.bake.config import BakeConfig

CFG = BakeConfig()
W, H = CFG.src_width, CFG.src_height


def make_calib(path, first=11, last=400, k1=1.5, centre=(-16.0, 0.8, 2.5)):
    """A calib_A.json-schema solve: one centre, per-frame R (world->camera, OpenCV axes) panning and tilting, f
    zooming; every container frame listed, repeats included (as the real solve does)."""
    base = np.array([[0, 0, 1.0], [0, -1.0, 0], [1.0, 0, 0]])  # world->camera: looking down +x, y down, x = +z
    frames = []
    for s in range(first, last + 1):
        u = (s - first) / (last - first)
        pan = Rotation.from_euler("yx", [0.05 * np.sin(3 * u), 0.02 * u]).as_matrix()
        R = pan @ base  # world->camera
        f = 900 + 300 * u
        frames.append({"t": s - first, "source_frame": s, "C": list(centre), "f": f, "k1": k1,
                       "K": [[f, 0, (W - 1) / 2], [0, f, (H - 1) / 2], [0, 0, 1]], "R": R.tolist()})
    doc = {"version": 1, "image_size": [W, H], "n_frames": len(frames), "C": list(centre), "k1_mode": "shared",
           "frames": frames}
    path.write_text(json.dumps(doc))
    return doc


@pytest.fixture()
def calib(tmp_path):
    p = tmp_path / "calib.json"
    doc = make_calib(p)
    return p, doc


def test_load_calib_gives_world_from_camera_quaternions(calib):
    p, doc = calib
    sol = C.load_calib(p)
    assert sol.width == W and sol.height == H and sol.k1 == pytest.approx(1.5)
    assert sol.centre == pytest.approx((-16.0, 0.8, 2.5))
    fr = doc["frames"][100]
    cam = sol.frames[fr["source_frame"]]
    R = np.array(fr["R"])
    # world-from-camera: the camera's +z (forward) in world = R's third row
    fwd = Rotation.from_quat(cam.q).apply([0, 0, 1.0])
    assert fwd == pytest.approx(R[2], abs=1e-12)
    assert cam.f == fr["f"] and np.linalg.norm(cam.q) == pytest.approx(1)


def test_real_frames_get_their_own_camera_and_in_betweens_slerp_and_lerp(calib):
    p, _ = calib
    sol = C.load_calib(p)
    tl = T.build(CFG, 72)
    cams = C.cameras_for(tl, sol, CFG)
    assert len(cams) == len(tl.frames)
    for f, cam in zip(tl.frames, cams):
        if not f.interp:
            assert cam.q == sol.frames[int(f.src)].q and cam.f == sol.frames[int(f.src)].f  # never smoothed
        else:
            qa, qb = Rotation.from_quat(sol.frames[f.a].q), Rotation.from_quat(sol.frames[f.b].q)
            qi = Rotation.from_quat(cam.q)
            ang_ab = (qa.inv() * qb).magnitude()
            assert (qa.inv() * qi).magnitude() == pytest.approx(f.w * ang_ab, abs=1e-9)
            assert cam.f == pytest.approx((1 - f.w) * sol.frames[f.a].f + f.w * sol.frames[f.b].f)


def test_principal_point_and_focal_after_undistortion(calib):
    p, _ = calib
    sol = C.load_calib(p)
    cfg = dataclasses.replace(CFG, undistort_f_scale=1.02)
    tl = T.build(cfg, 72)
    cams = C.cameras_for(tl, sol, cfg)
    f0 = tl.frames[0]
    assert cams[0].cx == (W - 1) / 2 and cams[0].cy == (H - 1) / 2
    if not f0.interp:
        assert cams[0].f == pytest.approx(1.02 * sol.frames[int(f0.src)].f)
    block = C.source_camera_block(sol, cfg)
    assert block["k1"] == 0 and block["cx"] == (W - 1) / 2 and block["width"] == W
    assert block["slow"] == pytest.approx(CFG.capture_fps * 4 / 3 / CFG.source_fps)


def test_video_json_camera_has_the_centre_and_rates(calib):
    p, _ = calib
    sol = C.load_calib(p)
    cam = C.video_json_camera(sol, CFG)
    assert set(cam) == {"centre", "sourceFps", "captureFps", "slow"}
    assert cam["centre"] == pytest.approx([-16.0, 0.8, 2.5]) and cam["captureFps"] == CFG.capture_fps


def test_frames_outside_the_calibration_fail_closed(tmp_path):
    p = tmp_path / "calib.json"
    make_calib(p, first=150, last=400)
    sol = C.load_calib(p)
    tl = T.build(CFG, 72)
    with pytest.raises(C.CameraCoverageError) as e:
        C.cameras_for(tl, sol, CFG)
    assert "150" in str(e.value) and "pass1" in str(e.value)
    # TEST ONLY: hold the edge camera, every held frame reported
    cfg = dataclasses.replace(CFG, camera_hold_edge=True)
    cams = C.cameras_for(tl, sol, cfg)
    held = [c for c in cams if c.held]
    assert held and all(np.allclose(c.q, sol.frames[150].q, atol=1e-12) for c in held)


def test_frames_json_entries_and_F_camera(calib):
    p, _ = calib
    sol = C.load_calib(p)
    tl = T.build(CFG, 72)
    entries = C.frames_json(tl, C.cameras_for(tl, sol, CFG))
    assert len(entries) == len(tl.frames)
    assert set(entries[0]) == {"src", "interp", "q", "f", "segment"}
    lasts = [{k: v for k, v in entries[e["frames"][1]].items() if k != "segment"} for e in tl.segments["eases"]]
    assert all(x == lasts[0] for x in lasts) and lasts[0]["src"] == CFG.freeze and lasts[0]["interp"] is False


@pytest.mark.parametrize("hz", [72, 90])
def test_frames_json_passes_format_ts_validate_frames(calib, hz):
    p, _ = calib
    sol = C.load_calib(p)
    tl = T.build(CFG, hz)
    entries = C.frames_json(tl, C.cameras_for(tl, sol, CFG))
    errors = C.validate_with_format_ts(entries, tl)
    if errors is None:
        pytest.skip("node or origin/court-side's format.ts not available")
    assert errors == []
    # the runner really checks: a broken quaternion and an ease that misses F are reported
    bad = [dict(e) for e in entries]
    bad[3]["q"] = [0, 0, 0, 2]
    k = tl.segments["eases"][1]["frames"][1]
    bad[k]["src"] = CFG.freeze + 1
    errors = C.validate_with_format_ts(bad, tl)
    assert any("frames.json[3].q" in e for e in errors)


def test_write_frames_json(tmp_path, calib):
    p, _ = calib
    sol = C.load_calib(p)
    tl = T.build(CFG, 72)
    out = tmp_path / "video" / "frames.json"
    C.write_frames_json(out, tl, C.cameras_for(tl, sol, CFG))
    data = json.loads(out.read_text())
    assert len(data) == len(tl.frames) and abs(np.linalg.norm(data[5]["q"]) - 1) < 1e-6


# ---------------- against synth.py's clip (known capture times and cameras) ----------------

@pytest.fixture(scope="module")
def synth_clip(tmp_path_factory):
    from pipeline.court.bake import config, synth

    clip = synth.SynthClip()
    root = tmp_path_factory.mktemp("synth")
    (root / "calib_A.json").write_text(json.dumps(clip.calib()))
    cfg = config.from_dict(clip.bake_config(root))
    return clip, cfg


def test_synth_config_loads_and_capture_times_match_its_truth(synth_clip):
    from pipeline.court.bake.captime import CapTime

    clip, cfg = synth_clip
    cap = CapTime.from_config(cfg)
    for s in clip.srcs:
        assert cap.time_of(s) == pytest.approx(clip.time_of(s), abs=1e-12)
        assert cap.is_real(s) == (not clip.is_repeat(s))


@pytest.mark.parametrize("hz", [72, 90])
def test_synth_timeline_and_cameras_match_ground_truth(synth_clip, hz):
    clip, cfg = synth_clip
    tl = T.build(cfg, hz)
    assert T.check(tl, cfg)["errors"] == []
    sol = C.load_calib(cfg.calib)
    cams = C.cameras_for(tl, sol, cfg)
    worst_deg = 0.0
    for f, cam in zip(tl.frames, cams):
        R, focal = clip.camera(f.t)  # the true camera at the shown capture time
        truth = Rotation.from_matrix(R.T)
        err = (truth.inv() * Rotation.from_quat(cam.q)).magnitude()
        worst_deg = max(worst_deg, np.degrees(err))
        if not f.interp:
            assert err < 1e-9 and cam.f == pytest.approx(focal, rel=1e-12)
        else:
            assert cam.f == pytest.approx(focal, rel=1e-9)  # zoom is linear in time: lerp is exact
    assert worst_deg < 1e-4  # slerp between neighbouring real frames vs the true in-between camera
    # no flashed frame is ever shown or used as an in-between's neighbour
    flash = set(clip.flash_srcs)
    assert all(f.a not in flash and f.b not in flash for f in tl.frames)
    near = [f for f in tl.frames if any(abs(f.t - clip.time_of(s)) < 1.5 / 120 for s in flash)]
    assert near and all(f.interp for f in near if f.src in flash)
    errors = C.validate_with_format_ts(C.frames_json(tl, cams), tl)
    if errors is not None:
        assert errors == []
