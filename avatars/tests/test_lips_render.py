"""lips_render.py end to end on a synthetic voice-driven bundle, with the Gaussian renderer swapped for a recorder (the
real one needs gsplat and a GPU): the gate, the camera, the posing, before vs after, and the files ffmpeg writes."""

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from test_arkit import a2e_json  # noqa: F401
from test_lips import _lips, _setup, _weights_json

ROOT = Path(__file__).parents[1]
sys.path[:0] = [str(ROOT), str(ROOT.parent / "pipeline")]
_spec = importlib.util.spec_from_file_location("lips_render", ROOT / "lips_render.py")
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs ffmpeg")


def _tone(path, seconds=2.2):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}",
                    "-c:a", "aac", str(path)], check=True)


def _probe(path, what):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                          f"stream={what}", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def _bundle(tmp_path):
    out, *_rest, voice = _setup(tmp_path)
    a2e, _w = _weights_json(tmp_path, T=60, fps=30.0)
    new = _lips(tmp_path, out, voice, a2e)
    _tone(new / "voice.m4a")
    return new


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, g, viewmat, width, height, bg, device):
        self.calls.append((g.means.copy(), g.quats.copy(), np.asarray(viewmat), width, height))
        return np.full((height, width, 3), 120, dtype=np.uint8)


def _run(monkeypatch, tmp_path, bundle, *argv):
    import head_swap_render as HR
    import lucid.export as E
    from lucid.gaussians import Gaussians as LG

    from lucid_avatars.gaussian_ply import read_ply
    from lucid_avatars.smplx_layout import J

    def load(b):  # lucid.gaussians.read_ply needs plyfile; the bundle's own reader gives the same Gaussians
        dream = json.loads((b / "dream.json").read_text())
        g = read_ply(b / dream["avatar"]["file"])
        rest = np.asarray(json.loads((b / dream["avatar"]["skeleton"]).read_text())["rest"])
        n = len(g.xyz)
        return dream, LG(g.xyz.astype(np.float32), g.scale.astype(np.float32), g.rotation.astype(np.float32),
                         g.opacity.astype(np.float32), g.f_dc.reshape(n, 1, 3).astype(np.float32),
                         np.zeros((n, 0, 3), np.float32)), rest[J["head"]]

    rec = Recorder()
    monkeypatch.setattr(HR, "load", load)
    monkeypatch.setattr(E, "render", rec)
    monkeypatch.setattr(sys, "argv", ["lips_render.py", str(bundle), *argv])
    return R.main(), rec


def test_renders_before_and_after_from_one_front_camera_and_writes_syncnet_inputs(tmp_path, monkeypatch):
    bundle = _bundle(tmp_path)
    out = tmp_path / "sync"
    code, rec = _run(monkeypatch, tmp_path, bundle, "--person", "vishal", "--out", str(out), "--factor", "1",
                     "--device", "cpu")
    assert code == 0
    info = json.loads((out / "render.json").read_text())
    n = info["frames"]
    assert n == 51 and info["fps"] == 25 and info["crop"] == "224x224"
    before, after = rec.calls[:n], rec.calls[n:2 * n]
    assert all(np.array_equal(c[2], before[0][2]) for c in rec.calls)  # one fixed camera for every frame
    # the camera is in front of the face (the idle's yaw-pi pose faces -Z) and looks back at it
    c2w = np.linalg.inv(before[0][2])
    assert c2w[2, 3] < -0.3 and c2w[:3, 2] @ [0, 0, 1] > 0.99
    # only the mouth differs between before and after (the blink is in both); the mouth moves the head Gaussians
    moved = max(np.abs(a[0] - b[0]).max() for a, b in zip(after, before))
    assert moved > 1e-4
    assert all(np.isfinite(c[0]).all() and np.allclose(np.linalg.norm(c[1], axis=1), 1, atol=1e-3) for c in rec.calls[:3])
    # files: watch video with the voice, SyncNet crops 224 px at 25 fps with audio
    for name in ("before", "after"):
        assert _probe(out / f"{name}_crops.avi", "width,height,nb_read_frames") == f"224,224,{n}"
        assert _probe(out / f"{name}.mp4", "nb_read_frames") == str(n)
        audio = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,"
                                "channels", "-of", "csv=p=0", str(out / f"{name}_crops.avi")], capture_output=True,
                               text=True).stdout.strip()
        assert audio == "16000,1"


def test_refuses_without_voice_consent_before_reading_anything(tmp_path, monkeypatch, capsys):
    bundle = _bundle(tmp_path)
    dream = json.loads((bundle / "dream.json").read_text())
    ian = tmp_path / "dreams" / "ian-grandma-head-voice"
    shutil.copytree(bundle, ian)
    (ian / "dream.json").write_text(json.dumps({**dream, "id": "ian-grandma-head-voice"}))
    code, rec = _run(monkeypatch, tmp_path, ian, "--person", "ian-grandma", "--out", str(tmp_path / "x"))
    assert code == 2 and not rec.calls and not (tmp_path / "x").exists()
    assert "REFUSED" in capsys.readouterr().out
