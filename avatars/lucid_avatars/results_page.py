"""The README's Results section from a fine-tune's work dir: `python -m lucid_avatars results <run>-tuned.work`.

Copies results.md's table and the before/after renders (compare.png, compare_detail.png when the hands and face pass
ran) into avatars/results/, shrunk to at most `max_width` px so the repo stays small, and rewrites the section between
the markers in avatars/README.md. Nothing else in the README changes; running it twice gives the same README.
"""

from __future__ import annotations

import json
import shutil
import struct
import subprocess
from pathlib import Path

START = "<!-- results:start (written by `python -m lucid_avatars results`) -->"
END = "<!-- results:end -->"
PENDING = ("Being measured: the one-photo avatar vs the same avatar fine-tuned on 4DAnyone's views, PSNR / SSIM / "
           "LPIPS on held-out views, with before/after renders. The table lands here when verified.")
RENDERS = ("compare.png", "compare_detail.png")
CAPTIONS = {
    "compare.png": "Held-out views of the first frame. Rows: 4DAnyone's view (the target), one photo (DiGS), "
                   "fine-tuned.",
    "compare_detail.png": "Face close-ups (2x) on the held-out views. Rows: 4DAnyone's view, one photo, fine-tuned.",
}
PASS_ROW = ", + hands and face pass."  # compare_detail.png's last row, only when the pass ran (results.json "tuned")


def replace_section(text: str, body: str) -> str:
    """`text` with everything between START and END replaced by `body` (markers kept, on their own lines)."""
    if text.count(START) != 1 or text.count(END) != 1 or text.index(START) > text.index(END):
        raise ValueError(f"the README needs exactly one {START!r} marker followed by one {END!r} marker")
    head, rest = text.split(START)
    return f"{head}{START}\n{body.strip()}\n{END}{rest.split(END)[1]}"


def png_size(path: str | Path) -> tuple[int, int]:
    """(width, height) from a PNG's IHDR chunk."""
    data = Path(path).read_bytes()[:24]
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError(f"{path} is not a PNG")
    return struct.unpack(">II", data[16:24])


def shrink_png(src: str | Path, dst: str | Path, max_width: int = 1600) -> None:
    """Copy a PNG, scaled down to `max_width` px wide if wider (Pillow, else macOS sips, else copied as is)."""
    src, dst = Path(src), Path(dst)
    width, height = png_size(src)
    if width <= max_width:
        shutil.copyfile(src, dst)
        return
    try:
        from PIL import Image

        with Image.open(src) as im:
            im.resize((max_width, round(height * max_width / width)), Image.LANCZOS).save(dst, optimize=True)
        return
    except ImportError:
        pass
    if shutil.which("sips"):
        subprocess.run(["sips", "--resampleWidth", str(max_width), str(src), "--out", str(dst)],
                       check=True, capture_output=True)
        return
    print(f"warning: no Pillow or sips, {src.name} copied at full size ({width} px)")
    shutil.copyfile(src, dst)


def section(work: str | Path, renders: list[str], image_dir: str = "results") -> str:
    """The Results section's body: the research table first, then how it was measured, then the renders."""
    work = Path(work)
    run = work.name.removesuffix(".work").removesuffix("-tuned")
    lines = [f"Fine-tune on 4DAnyone's views, run `{run}` (`{work.name}/results.md`):", "",
             (work / "results.md").read_text().strip(), ""]
    data = json.loads((work / "results.json").read_text()) if (work / "results.json").exists() else {}
    setup = data.get("setup", {})
    facts = []
    if setup.get("heldOutViews") is not None:
        facts.append(f"{len(setup['heldOutViews'])} held-out views never trained on")
    for key, label in (("trainViews", "training views"), ("frames", "frames"), ("steps", "steps")):
        if setup.get(key) is not None:
            facts.append(f"{setup[key]} {label}")
    if facts:
        lines += [(f"Measured on {', '.join(facts)}; full frames composited on white, so absolute PSNR runs high: "
                   "the before/after change is the claim."), ""]
    for name in renders:
        caption = CAPTIONS[name]
        if name == "compare_detail.png" and "tuned" in data:
            caption = caption.removesuffix(".") + PASS_ROW
        lines += [f"![{caption}]({image_dir}/{name})", "", f"*{caption}*", ""]
    return "\n".join(lines)


def fill(work: str | Path, readme: str | Path, out_dir: str | Path, max_width: int = 1600) -> list[Path]:
    """Copy the work dir's renders into `out_dir` and rewrite the README's Results section. Returns the copies."""
    work, readme, out_dir = Path(work), Path(readme), Path(out_dir)
    if not (work / "results.md").exists():
        raise FileNotFoundError(f"{work / 'results.md'} is missing: has the fine-tune finished?")
    text = readme.read_text()
    renders = [n for n in RENDERS if (work / n).exists()]
    image_dir = out_dir.resolve().relative_to(readme.parent.resolve()).as_posix()
    new = replace_section(text, section(work, renders, image_dir))  # raises before anything is copied
    out_dir.mkdir(parents=True, exist_ok=True)
    copies = []
    for name in RENDERS:
        if name in renders:
            shrink_png(work / name, out_dir / name, max_width)
            copies.append(out_dir / name)
        else:
            (out_dir / name).unlink(missing_ok=True)
    readme.write_text(new)
    return copies
