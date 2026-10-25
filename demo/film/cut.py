"""Assemble the film's rough cut from an edit list (demo/video.md has the script; Ojasva polishes it in CapCut).

The edit list is JSON:

  {
    "length": 180,                                  seconds, strict
    "video": [{"src": "quest/grandma-2.mp4", "in": 3.2, "at": 16.0, "dur": 8.0, "fit": "cover", "fade": 0.3}, ...],
    "audio": [{"src": "voice/vo-03.m4a", "in": 0.4, "at": 46.2, "dur": 4.1, "gain": 0, "voice": true},
              {"src": "quest/grandma-2.mp4", "in": 3.2, "at": 16.0, "dur": 8.0, "gain": -2, "voice": true},
              {"src": "music/track.mp3", "in": 0, "at": 0, "dur": 180, "gain": -10}],
    "text": [{"text": "AI voice", "at": 24.0, "dur": 7.0, "pos": "bottom-left", "size": 34}]
  }

Paths are relative to ~/Downloads/lucid-video. Video clips are scaled to 1920x1080 at 30 fps ("cover" crops to fill,
"contain" letterboxes on black); gaps are black. Audio marked "voice" ducks everything else under it (sidechain).
Writes ~/Downloads/lucid-video/rough-cut.mp4.

  python3 demo/film/cut.py demo/film/edl.json
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path.home() / "Downloads" / "lucid-video"
W, H, FPS = 1920, 1080, 30


def has_audio(path: Path) -> bool:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0",
                        str(path)], capture_output=True, text=True)
    return bool(r.stdout.strip())


def main(edl_path: str) -> None:
    edl = json.loads(Path(edl_path).read_text())
    length = float(edl.get("length", 180))
    inputs: list[str] = []
    filters: list[str] = []

    def add_input(src: str) -> int:
        inputs.extend(["-i", str(ROOT / src)])
        return inputs.count("-i") - 1

    # picture: black base, every clip overlaid at its time
    filters.append(f"color=c=black:s={W}x{H}:r={FPS}:d={length}[base]")
    last = "base"
    for k, v in enumerate(sorted(edl.get("video", []), key=lambda v: v["at"])):
        i = add_input(v["src"])
        dur = float(v["dur"])
        fit = v.get("fit", "cover")
        scale = (
            f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
            if fit == "cover"
            else f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black"
        )
        fade = float(v.get("fade", 0))
        fades = f",fade=t=in:st=0:d={fade},fade=t=out:st={dur - fade}:d={fade}" if fade > 0 else ""
        filters.append(
            f"[{i}:v]trim=start={v.get('in', 0)}:duration={dur},setpts=PTS-STARTPTS,fps={FPS},{scale},setsar=1,"
            f"format=yuv420p{fades},setpts=PTS+{v['at']}/TB[v{k}]"
        )
        filters.append(f"[{last}][v{k}]overlay=enable='between(t,{v['at']},{v['at'] + dur})':eof_action=pass[o{k}]")
        last = f"o{k}"
    # type: each line rendered to a transparent PNG (text.swift, SF Pro), faded in and out over the picture
    TYPE = ROOT / "type"
    TYPE.mkdir(exist_ok=True)
    for k, t in enumerate(edl.get("text", [])):
        size = t.get("size", 34)
        png = TYPE / f"{k:03d}.png"
        subprocess.run(["swift", str(Path(__file__).with_name("text.swift")), t["text"], str(size), str(png)], check=True)
        inputs.extend(["-loop", "1", "-t", str(t["dur"]), "-i", str(png)])
        i = len([x for x in inputs if x == "-i"]) - 1
        pad = size  # the PNG has one font size of padding on every side
        x, y = {
            "bottom-left": (f"{96 - pad}", f"H-h-{72 - pad}"),
            "bottom-center": ("(W-w)/2", f"H-h-{72 - pad}"),
            "center": ("(W-w)/2", "(H-h)/2"),
            "top-left": (f"{96 - pad}", f"{72 - pad}"),
        }[t.get("pos", "bottom-left")]
        d = float(t["dur"])
        filters.append(
            f"[{i}:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st={max(0, d - 0.3)}:d=0.3:alpha=1,"
            f"setpts=PTS+{t['at']}/TB[ty{k}]"
        )
        filters.append(f"[{last}][ty{k}]overlay=x={x}:y={y}:enable='between(t,{t['at']},{t['at'] + d})':eof_action=pass[t{k}]")
        last = f"t{k}"
    filters.append(f"[{last}]null[vout]")

    # sound: voices on one bus, everything else on another, ducked under the voices
    voices: list[str] = []
    beds: list[str] = []
    for k, a in enumerate(edl.get("audio", [])):
        if not has_audio(ROOT / a["src"]):
            print(f"no sound in {a['src']}, skipped", file=sys.stderr)
            continue
        i = add_input(a["src"])
        ms = int(round(float(a["at"]) * 1000))
        filters.append(
            f"[{i}:a]atrim=start={a.get('in', 0)}:duration={a['dur']},asetpts=PTS-STARTPTS,"
            f"aformat=sample_rates=48000:channel_layouts=stereo,volume={a.get('gain', 0)}dB,adelay={ms}|{ms},"
            f"apad=whole_dur={length}[a{k}]"
        )
        (voices if a.get("voice") else beds).append(f"[a{k}]")
    silence = f"anullsrc=r=48000:cl=stereo:d={length}"
    if not voices:
        filters.append(f"{silence}[vb]")
        voices = ["[vb]"]
    if not beds:
        filters.append(f"{silence}[bb]")
        beds = ["[bb]"]
    filters.append(f"{''.join(voices)}amix=inputs={len(voices)}:normalize=0,asplit=2[voice][key]")
    filters.append(f"{''.join(beds)}amix=inputs={len(beds)}:normalize=0[bed]")
    filters.append("[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]")
    filters.append(f"[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95,atrim=duration={length}[aout]")

    out = ROOT / "rough-cut.mp4"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters),
           "-map", "[vout]", "-map", "[aout]", "-t", str(length), "-c:v", "libx264", "-preset", "medium", "-crf", "16",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
    print(out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).with_name("edl.json")))
