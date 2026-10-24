import json
import struct
import zlib
from pathlib import Path

import pytest

from lucid_avatars import results_page as R

TABLE = ("| Held-out views | One photo (DiGS) | + fine-tune on 4DAnyone views | Change |\n"
         "| --- | --- | --- | --- |\n| PSNR (dB) | 26.10 | 28.40 | +2.30 |\n")
README = f"# avatars\n\nIntro.\n\n## Results\n\n{R.START}\nold\n{R.END}\n\n## What's here\n\nRest.\n"


def _png(path: Path, w: int, h: int) -> None:
    """A tiny valid RGB PNG, no Pillow needed."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\0" + b"\x80" * 3 * w for _ in range(h))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _work(tmp_path: Path, detail: bool = False) -> Path:
    work = tmp_path / "jump-shot-tuned.work"
    work.mkdir()
    (work / "results.md").write_text(TABLE)
    (work / "results.json").write_text(json.dumps({"setup": {"heldOutViews": [0, 12, 24, 36], "trainViews": 44,
                                                             "frames": 8, "steps": 800}}))
    _png(work / "compare.png", 8, 6)
    if detail:
        _png(work / "compare_detail.png", 4, 4)
    return work


def test_fill_puts_the_table_first_then_the_renders_and_leaves_the_rest_alone(tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text(README)
    R.fill(_work(tmp_path), readme, tmp_path / "results")
    text = readme.read_text()
    body = text.split(R.START)[1].split(R.END)[0]
    assert "old" not in body and "being measured" not in body
    assert body.index("| PSNR (dB) | 26.10 | 28.40 | +2.30 |") < body.index("](results/compare.png)")
    assert "`jump-shot`" in body and "4 held-out views" in body and "44 training views" in body
    assert "compare_detail" not in body
    assert text.startswith("# avatars\n\nIntro.\n\n## Results\n\n") and text.endswith("\n\n## What's here\n\nRest.\n")
    assert (tmp_path / "results" / "compare.png").read_bytes() == (tmp_path / "jump-shot-tuned.work" / "compare.png").read_bytes()


def test_fill_is_idempotent(tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text(README)
    work = _work(tmp_path)
    R.fill(work, readme, tmp_path / "results")
    once = readme.read_text()
    R.fill(work, readme, tmp_path / "results")
    assert readme.read_text() == once


def test_detail_render_is_shown_when_present_and_a_stale_one_removed_when_not(tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text(README)
    out = tmp_path / "results"
    R.fill(_work(tmp_path, detail=True), readme, out)
    assert "](results/compare_detail.png)" in readme.read_text() and (out / "compare_detail.png").exists()
    other = tmp_path / "again"
    other.mkdir()
    R.fill(_work(other), readme, out)
    assert "compare_detail" not in readme.read_text() and not (out / "compare_detail.png").exists()


def test_detail_caption_names_the_pass_row_only_when_the_pass_ran(tmp_path):
    work = _work(tmp_path, detail=True)
    assert "+ hands and face pass" not in R.section(work, ["compare_detail.png"])
    data = json.loads((work / "results.json").read_text())
    (work / "results.json").write_text(json.dumps({**data, "tuned": {"psnr": 28.0}}))
    assert "fine-tuned, + hands and face pass" in R.section(work, ["compare_detail.png"])


def test_missing_results_leave_the_readme_untouched(tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text(README)
    work = _work(tmp_path)
    (work / "results.md").unlink()
    with pytest.raises(FileNotFoundError, match="results.md"):
        R.fill(work, readme, tmp_path / "results")
    assert readme.read_text() == README


def test_markers_must_be_there_once_and_in_order():
    for bad in ("no markers", f"{R.END}\n{R.START}", f"{R.START}{R.END}{R.START}{R.END}"):
        with pytest.raises(ValueError, match="marker"):
            R.replace_section(bad, "x")


def test_png_width_reads_the_header_and_small_renders_are_copied_unchanged(tmp_path):
    _png(tmp_path / "a.png", 8, 6)
    assert R.png_size(tmp_path / "a.png") == (8, 6)
    R.shrink_png(tmp_path / "a.png", tmp_path / "b.png", max_width=1600)
    assert (tmp_path / "b.png").read_bytes() == (tmp_path / "a.png").read_bytes()


def test_the_real_readme_has_one_results_section_with_numbers_or_being_measured():
    text = (Path(__file__).parents[1] / "README.md").read_text()
    body = text.split(R.START)[1].split(R.END)[0] if R.START in text else ""
    R.replace_section(text, "x")
    assert R.PENDING in body or "| PSNR (dB) |" in body
