"""hpg/: the RIFE job's input list (from bake-core's timeline on synth's config) and its runner's plumbing
(--fake blends instead of RIFE, so this runs on the Mac without torch).

    /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_hpg_rife.py -q
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from bake import captime, config, interp, synth
from bake.hpg import rife_needs

HPG = Path(__file__).resolve().parents[1] / "hpg"


@pytest.fixture(scope="module")
def written(tmp_path_factory):
    out = tmp_path_factory.mktemp("synth_rife")
    synth.write_clip(out, synth.SynthClip(synth.Spec()), layers=False)
    return out


def test_needs_cover_every_interp_frame_and_the_strobes(written, tmp_path):
    cfg = config.load(written / "bake_config.json")
    pairs, checks, counts = rife_needs.needs(cfg)
    assert set(counts) == set(cfg.display_hz) and all(c["interp"] > 0 for c in counts.values())
    cap = captime.CapTime.from_config(cfg)
    keys = {(a, b, round(w, 6)) for a, b, w in pairs}
    for s in cfg.strobes:
        if cap.is_real(s):
            assert any(a < s < b for a, b, _ in keys)
    for a, b, w in pairs:
        assert cap.is_usable(a) and cap.is_usable(b) and a < b and 0 < w < 1
    for a, m, c, w in checks:
        assert a < m < c and all(cap.is_usable(x) for x in (a, m, c)) and 0 < w < 1
    rc = subprocess.run([sys.executable, str(HPG / "rife_needs.py"), "--config", str(written / "bake_config.json"),
                         "--out", str(tmp_path), "--frames-dir", str(written / "frames"), "--pattern", "{src:06d}.png"],
                        capture_output=True, text=True)
    assert rc.returncode == 0, rc.stderr
    rep = json.loads(rc.stdout)
    man = json.loads((tmp_path / "needs.json").read_text())
    assert rep["inbetweens"] == len(man["pairs"]) == len(keys) and rep["missing"] == []
    assert (tmp_path / "frames.txt").read_text().split() == [f"{s:06d}.png" for s in man["frames"]]


def test_runner_writes_every_listed_file_and_the_bake_reads_them(written, tmp_path):
    cfg = config.load(written / "bake_config.json")
    pairs, checks, _ = rife_needs.needs(cfg)
    man = interp.write_needs(pairs[:12], tmp_path / "needs.json", frame_pattern="{src:06d}.png", ext=".jpg",
                             checks=checks[:3])
    out = tmp_path / "out"
    rc = subprocess.run([sys.executable, str(HPG / "rife_run.py"), "--fake", "--frames", str(written / "frames"),
                         "--needs", str(tmp_path / "needs.json"), "--out", str(out)], capture_output=True, text=True)
    assert rc.returncode == 0, rc.stderr
    assert "RIFE_OK" in rc.stdout
    for p in man["pairs"]:
        assert (out / p["out"]).exists()
    assert json.loads((out / "done.json").read_text())["written"] == len(man["pairs"])
    assert len(json.loads((out / "checks.json").read_text())["rows"]) == 3
    # rerun resumes (keeps every file)
    rc = subprocess.run([sys.executable, str(HPG / "rife_run.py"), "--fake", "--frames", str(written / "frames"),
                         "--needs", str(tmp_path / "needs.json"), "--out", str(out)], capture_output=True, text=True)
    assert json.loads((out / "done.json").read_text())["kept"] == len(man["pairs"])
    clip = synth.SynthClip(synth.Spec())
    ib = interp.Inbetweens(clip.frame, rife_dir=out)
    p = man["pairs"][0]
    img, how = ib.get(p["a"], p["b"], p["w"])
    assert how == "rife" and img.shape == (clip.H, clip.W, 3)
    blend = interp.interpolate(clip.frame(p["a"]), clip.frame(p["b"]), p["w"], method="dissolve")
    assert np.abs(img.astype(int) - blend).mean() < 3  # the fake job's blend, through jpeg q95


def test_scripts_parse():
    for f in ("rife.sbatch", "rife_setup.sh"):
        assert subprocess.run(["bash", "-n", str(HPG / f)]).returncode == 0
