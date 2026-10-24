import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import video_frames as V  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def make_clip(path: Path, vf: str = "", seconds: int = 8, size: str = "320x240") -> Path:
    """A synthetic moving clip: ffmpeg's mandelbrot zoom (changes all the time, has detail everywhere)."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"mandelbrot=size={size}:rate=15",
           "-t", str(seconds), "-pix_fmt", "yuv420p"]
    if vf:
        cmd += ["-vf", vf]
    subprocess.run(cmd + [str(path)], check=True)
    return path


def test_clip_to_photo_folder_with_pick_json(tmp_path):
    clip = make_clip(tmp_path / "clip.mp4")
    out = tmp_path / "photos" / "grandma"
    sheet = tmp_path / "sheet.png"
    assert V.main([str(clip), "--out", str(out), "--count", "9", "--contact", str(sheet), "--crops",
                   "--box", "0.1,0.1,0.9,0.9"]) == 0
    jpgs = sorted(out.glob("frame-*.jpg"))
    assert 8 <= len(jpgs) <= 9 and jpgs[0].name == "frame-01.jpg"
    assert all(p.read_bytes()[:2] == b"\xff\xd8" for p in jpgs)
    pick = json.loads((out / "pick.json").read_text())
    assert pick["source"] == "clip.mp4" and pick["boxSource"] == "given"
    times = [f["t"] for f in pick["frames"]]
    assert times == sorted(times) and len(set(times)) == len(times) == len(jpgs)
    assert all(f["sharpness"] > 0 for f in pick["frames"])
    assert set(json.loads((out / "crops.json").read_text())) == {p.name for p in jpgs}
    assert sheet.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert sorted(p.name for p in out.iterdir()) == sorted([p.name for p in jpgs] + ["pick.json", "crops.json"])


def test_jpegs_are_full_resolution_and_upright_for_a_rotated_clip(tmp_path):
    clip = make_clip(tmp_path / "wide.mp4", size="320x180")
    portrait = tmp_path / "portrait.mp4"  # displaymatrix says rotate 90: players show it 180 wide x 320 tall
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-display_rotation", "90", "-i", str(clip), "-c", "copy", str(portrait)],
                   check=True)
    out = tmp_path / "p"
    assert V.main([str(portrait), "--out", str(out), "--count", "3", "--min-gap", "0.5"]) == 0
    shape = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out / "frame-01.jpg"), "-f", "image2pipe", "-c:v", "ppm", "-"],
                           capture_output=True, check=True).stdout.split(b"\n", 2)[1].split()
    assert int(shape[1]) > int(shape[0])  # taller than wide


def test_refuses_a_folder_with_other_photos_and_reruns_only_with_overwrite(tmp_path):
    clip = make_clip(tmp_path / "clip.mp4", seconds=4)
    out = tmp_path / "photos"
    out.mkdir()
    (out / "mom.jpg").write_bytes(b"x")
    with pytest.raises(SystemExit, match="other photos"):
        V.main([str(clip), "--out", str(out)])
    (out / "mom.jpg").unlink()
    assert V.main([str(clip), "--out", str(out), "--count", "4"]) == 0
    with pytest.raises(SystemExit, match="--overwrite"):
        V.main([str(clip), "--out", str(out)])
    assert V.main([str(clip), "--out", str(out), "--count", "3", "--overwrite"]) == 0
    assert len(list(out.glob("frame-*.jpg"))) == 3


def test_contact_sheet_inside_the_photos_folder_is_refused_before_anything_is_written(tmp_path):
    clip = make_clip(tmp_path / "clip.mp4", seconds=2)
    out = tmp_path / "photos"
    with pytest.raises(SystemExit, match="outside"):
        V.main([str(clip), "--out", str(out), "--contact", str(out / "sheet.png")])
    assert not out.exists()


def test_black_clip_picks_nothing_and_writes_nothing(tmp_path):
    clip = tmp_path / "black.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:size=160x120:rate=10", "-t", "3",
                    "-pix_fmt", "yuv420p", str(clip)], check=True)
    out = tmp_path / "photos"
    assert V.main([str(clip), "--out", str(out)]) == 1
    assert not out.exists()


def test_bad_inputs(tmp_path):
    with pytest.raises(SystemExit, match="no video"):
        V.main([str(tmp_path / "nope.mp4"), "--out", str(tmp_path / "o")])
    clip = make_clip(tmp_path / "clip.mp4", seconds=1)
    with pytest.raises(SystemExit, match="--count"):
        V.main([str(clip), "--out", str(tmp_path / "o"), "--count", "17"])
    with pytest.raises(ValueError):
        V.main([str(clip), "--out", str(tmp_path / "o"), "--box", "0.9,0,0.1,1"])
