"""lips_sync_score.py with a stand-in SyncNet checkout (a demo_syncnet.py that logs like the real one)."""

import importlib.util
import json
import shutil
import sys
from pathlib import Path

import pytest
from test_lips import _lips, _setup, _weights_json

ROOT = Path(__file__).parents[1]
_spec = importlib.util.spec_from_file_location("lips_sync_score", ROOT / "lips_sync_score.py")
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

FAKE = '''
import argparse, logging
p = argparse.ArgumentParser()
for k in ("initial_model", "videofile", "tmp_dir", "reference", "vshift"):
    p.add_argument("--" + k)
a = p.parse_args()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s: %(message)s")
log = logging.getLogger("SyncNetInstance")
conf, dist, off = {"before": (1.5, 9.25, -4), "after": (5.25, 7.5, 2)}[a.reference]
assert a.initial_model == "data/syncnet_v2.model" and a.vshift == "15", (a.initial_model, a.vshift)
log.info("AV offset: \\t%d", off)
log.info("Min dist: \\t%.3f", dist)
log.info("Confidence: \\t%.3f", conf)
'''


def _fixture(tmp_path):
    out, *_rest, voice = _setup(tmp_path)
    a2e, _ = _weights_json(tmp_path, T=60, fps=30.0)
    bundle = _lips(tmp_path, out, voice, a2e)
    sn = tmp_path / "syncnet_python"
    sn.mkdir()
    (sn / "demo_syncnet.py").write_text(FAKE)
    renders = tmp_path / "renders"
    renders.mkdir()
    for n in ("before", "after"):
        (renders / f"{n}_crops.avi").write_bytes(b"x")
    (renders / "render.json").write_text(json.dumps({"bundle": bundle.name, "person": "vishal", "frames": 51,
                                                     "clipS": 2.05}))
    return bundle, sn, renders


def _run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["lips_sync_score.py", *argv])
    return M.main()


def test_scores_both_renders_and_writes_lips_sync_json(tmp_path, monkeypatch, capsys):
    bundle, sn, renders = _fixture(tmp_path)
    assert _run(monkeypatch, str(bundle), "--person", "vishal", "--renders", str(renders), "--syncnet", str(sn)) == 0
    r = json.loads((bundle / "lips_sync.json").read_text())
    assert r["before"] == {"conf": 1.5, "dist": 9.25, "offset": -4}
    assert r["after"] == {"conf": 5.25, "dist": 7.5, "offset": 2}
    assert r["deltaConf"] == 3.75 and r["improved"] and r["model"] == "syncnet_v2.model"
    assert r["fps"] == 25 and r["clipS"] == 2.05 and r["frames"] == 51 and r["person"] == "vishal"
    assert "SYNC conf before 1.50 after 5.25" in capsys.readouterr().out
    assert (renders / "syncnet_after.log").read_text().count("Confidence") == 1  # the raw log is kept


def test_refuses_before_running_syncnet_without_consent(tmp_path, monkeypatch, capsys):
    bundle, sn, renders = _fixture(tmp_path)
    ian = tmp_path / "dreams" / "ian-grandma-head-voice"
    shutil.copytree(bundle, ian)
    d = json.loads((ian / "dream.json").read_text())
    (ian / "dream.json").write_text(json.dumps({**d, "id": "ian-grandma-head-voice"}))
    (sn / "demo_syncnet.py").write_text("raise SystemExit('must not run')")
    assert _run(monkeypatch, str(ian), "--person", "ian-grandma", "--renders", str(renders), "--syncnet", str(sn)) == 2
    assert "REFUSED" in capsys.readouterr().out and not (ian / "lips_sync.json").exists()


def test_check_runs_the_gate_alone(tmp_path, monkeypatch, capsys):
    bundle, *_ = _fixture(tmp_path)
    assert _run(monkeypatch, str(bundle), "--person", "vishal", "--check") == 0
    assert "consent OK" in capsys.readouterr().out and not (bundle / "lips_sync.json").exists()


def test_a_failing_syncnet_stops_with_its_output(tmp_path, monkeypatch):
    bundle, sn, renders = _fixture(tmp_path)
    (sn / "demo_syncnet.py").write_text("import sys; print('boom'); sys.exit(3)")
    with pytest.raises(SystemExit, match="boom"):
        _run(monkeypatch, str(bundle), "--person", "vishal", "--renders", str(renders), "--syncnet", str(sn))
    assert not (bundle / "lips_sync.json").exists()


def test_renders_of_another_bundle_are_refused(tmp_path, monkeypatch):
    bundle, sn, renders = _fixture(tmp_path)
    (renders / "render.json").write_text(json.dumps({"bundle": "other", "person": "vishal", "frames": 5, "clipS": 3}))
    with pytest.raises(SystemExit, match="other"):
        _run(monkeypatch, str(bundle), "--person", "vishal", "--renders", str(renders), "--syncnet", str(sn))
