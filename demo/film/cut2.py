"""Assemble the film from a timeline (demo/film/timeline.py writes it): one continuous picture with real transitions,
type, and a mixed soundtrack. Paths are relative to ~/Downloads/lucid-video.

  {"fps": 30, "length": 180,
   "video": [{"src": "selects/x.mp4", "in": 0.0, "start": 0.0, "end": 2.86, "x": "cut", "xd": 0.0, "speed": 1.0,
              "grade": true, "fit": "cover", "zoom": [1.0, 1.04]}, ...],          contiguous, in order
   "text":  [{"text": "...", "at": 8.0, "dur": 3.0, "pos": "lower", "size": 34, "color": "#f5f5f7"}, ...],
   "audio": [{"src": "music/stems/no_vocals.mp3", "in": 0, "at": 7.5, "dur": 22.5, "gain": -4, "fadein": 3,
              "fadeout": 0, "bus": "music"}, ...]}

Picture: each piece is conformed on its own first (cover-cropped to 1920x1080, 30 fps, slowed or sped, an optional slow
push-in, one gentle grade on headset footage only; the film's own graphics stay as designed), with handles so every
transition is centred on its cut point; then they're joined in one pass ("cut", "dissolve" or "dip" through black).
Sound: voices on one bus, music and room sound on another, ducked under the voices, the whole mix brought to -14 LUFS.
Writes ~/Downloads/lucid-video/film-v<N>.mp4 (pass the name with --out).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path.home() / "Downloads" / "lucid-video"
W, H = 1920, 1080
GRADE = "eq=contrast=1.06:saturation=1.06:gamma=0.98,vignette=angle=0.35:mode=forward"
TYPE = Path(__file__).with_name("text.swift")


def probe_dur(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                       capture_output=True, text=True)
    return float(r.stdout.strip() or 0)


def conform(k: int, v: dict, head: int, body: int, tail: int, fps: int, work: Path) -> tuple[Path, int]:
    """One piece, exactly head + body + tail frames: the body is its share of the film, the head and tail its halves of
    the transitions on either side (so every transition is centred on its cut, and every join lands on a frame)."""
    src = ROOT / v["src"]
    speed = float(v.get("speed", 1.0))
    frames = head + body + tail
    length = frames / fps
    hin = head / fps
    t_in = float(v.get("in", 0.0)) - hin * speed
    pre = 0.0
    if t_in < 0:  # not enough source before the in-point: hold the first frame
        pre, t_in = -t_in / speed, 0.0
    need = (length - pre) * speed
    zoom = v.get("zoom")
    if v.get("fit", "cover") == "cover":
        scale = f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H}"
    else:
        scale = f"scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black"
    f = [f"trim=start={t_in:.4f}:duration={need + 0.2:.4f}", "setpts=PTS-STARTPTS"]
    if v.get("interp"):  # smooth slow motion: frames made between the real ones, so slowing never stutters
        f.append("minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1")
    if speed != 1.0:
        f.append(f"setpts=PTS/{speed}")
    f += [f"fps={fps}", scale, "setsar=1"]
    if zoom:  # a slow push-in (or pull-out) across the piece, on a 2x canvas so it stays smooth
        z0, z1 = zoom
        f += [f"scale={W * 2}:{H * 2}:flags=lanczos",
              f"zoompan=z='{z0}+({z1}-{z0})*on/{max(1, round(length * fps))}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={fps}"]
    if v.get("grade"):
        f.append(GRADE)
    f += ["format=yuv420p", f"tpad=start_duration={pre:.4f}:start_mode=clone:stop_mode=clone:stop_duration=10",
          f"trim=end_frame={frames}", "setpts=PTS-STARTPTS"]
    out = work / f"{k:03d}.mp4"
    if v["src"] == "black":
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=black:s={W}x{H}:r={fps}",
                        "-frames:v", str(frames), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
                        str(out)], check=True)
        return out, frames
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", ",".join(f), "-an", "-c:v", "libx264",
                    "-preset", "veryfast", "-crf", "12", "-r", str(fps), "-frames:v", str(frames), str(out)], check=True)
    return out, frames


def main(timeline: str, out_name: str) -> None:
    tl = json.loads(Path(timeline).read_text())
    fps = int(tl.get("fps", 30))
    length = float(tl["length"])
    vids = tl["video"]
    work = ROOT / "work"
    work.mkdir(exist_ok=True)

    # everything in whole frames: cut points, transitions (a "cut" is a one-frame blend), each piece's head and tail
    cuts = [round(float(v["start"]) * fps) for v in vids] + [round(length * fps)]
    d = [0] + [max(1, round(float(v.get("xd", 0.0)) * fps)) if v.get("x", "cut") != "cut" else 1 for v in vids[1:]]
    head = [dk // 2 for dk in d]
    tail = [d[k + 1] - head[k + 1] if k + 1 < len(vids) else 0 for k in range(len(vids))]
    pieces = []
    for k, v in enumerate(vids):
        pieces.append(conform(k, v, head[k], cuts[k + 1] - cuts[k], tail[k], fps, work))
        print(f"\r  conformed {k + 1}/{len(vids)}", end="", flush=True)
    print()

    # the picture: every piece joined, each transition centred on its cut (offsets exact, in frames)
    args: list[str] = []
    for p, _ in pieces:
        args += ["-i", str(p)]
    graph = []
    last, total = "0:v", pieces[0][1]
    for k in range(1, len(pieces)):
        trans = {"cut": "fade", "dissolve": "fade", "dip": "fadeblack"}[vids[k].get("x", "cut")]
        graph.append(f"[{last}][{k}:v]xfade=transition={trans}:duration={d[k] / fps:.6f}:offset={(total - d[k]) / fps:.6f}[x{k}]")
        last = f"x{k}"
        total += pieces[k][1] - d[k]
    n_in = len(pieces)

    # type: each line drawn by text.swift (SF Pro) to a PNG, faded in and out
    for i, t in enumerate(tl.get("text", [])):
        png = work / f"type-{i:03d}.png"
        subprocess.run(["swift", str(TYPE), t["text"], str(t.get("size", 34)), str(png), t.get("color", "#f5f5f7"),
                        t.get("weight", "semibold")], check=True, capture_output=True)
        args += ["-loop", "1", "-t", str(t["dur"]), "-i", str(png)]
        pad = t.get("size", 34)
        x, y = {
            "lower": ("(W-w)/2", f"H-h-{110 - pad}"),
            "lower2": ("(W-w)/2", f"H-h-{60 - pad}"),
            "center": ("(W-w)/2", "(H-h)/2"),
            "lower-left": (f"{90 - pad}", f"H-h-{80 - pad}"),
            "lower-right": (f"W-w-{90 - pad}", f"H-h-{80 - pad}"),
            "upper": ("(W-w)/2", f"{100 - pad}"),
        }[t.get("pos", "lower")]
        d = float(t["dur"])
        fi, fo = float(t.get("fadein", 0.4)), float(t.get("fadeout", 0.4))
        graph.append(f"[{n_in + i}:v]format=rgba,fade=t=in:st=0:d={fi}:alpha=1,fade=t=out:st={max(0, d - fo)}:d={fo}:alpha=1,"
                     f"setpts=PTS+{t['at']}/TB[ty{i}]")
        graph.append(f"[{last}][ty{i}]overlay=x={x}:y={y}:enable='between(t,{t['at']},{t['at'] + d})':eof_action=pass[t{i}]")
        last = f"t{i}"
    graph.append(f"[{last}]trim=duration={length},format=yuv420p[vout]")

    # sound, mixed on its own first: voices on one bus, music and room sound on another, ducked under the voices
    agraph: list[str] = []
    aargs: list[str] = []
    voices, beds = [], []
    for i, a in enumerate(tl.get("audio", [])):
        aargs += ["-i", str(ROOT / a["src"])]
        ms = int(round(float(a["at"]) * 1000))
        dur = float(a["dur"])
        fi, fo = float(a.get("fadein", 0)), float(a.get("fadeout", 0))
        fades = (f",afade=t=in:st=0:d={fi}" if fi else "") + (f",afade=t=out:st={max(0, dur - fo)}:d={fo}" if fo else "")
        agraph.append(f"[{i}:a]atrim=start={a.get('in', 0)}:duration={dur},asetpts=PTS-STARTPTS,"
                      f"aformat=sample_rates=48000:channel_layouts=stereo,volume={a.get('gain', 0)}dB{fades},"
                      f"adelay={ms}|{ms},apad=whole_dur={length}[a{i}]")
        (voices if a.get("bus") == "voice" else beds).append(f"[a{i}]")
    silence = f"anullsrc=r=48000:cl=stereo:d={length}"
    if not voices:
        agraph.append(f"{silence}[vs]")
        voices = ["[vs]"]
    if not beds:
        agraph.append(f"{silence}[bs]")
        beds = ["[bs]"]
    agraph.append(f"{''.join(voices)}amix=inputs={len(voices)}:normalize=0,asplit=2[voice][key]")
    agraph.append(f"{''.join(beds)}amix=inputs={len(beds)}:normalize=0[bed]")
    agraph.append("[bed][key]sidechaincompress=threshold=0.02:ratio=10:attack=40:release=600:makeup=1[ducked]")
    agraph.append(f"[voice][ducked]amix=inputs=2:normalize=0,atrim=duration={length}[mix]")
    afile = work / "audio-graph.txt"
    afile.write_text(";\n".join(agraph))
    mix = work / "mix.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *aargs, "-filter_complex_script", str(afile), "-map", "[mix]",
                    "-c:a", "pcm_s24le", str(mix)], check=True)
    # one fixed gain for the whole film (quiet stays quiet), measured to -16 LUFS, a limiter only on the peaks
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(mix), "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    integrated = [ln for ln in r.stderr.splitlines() if ln.strip().startswith("I:")]
    lufs = float(integrated[-1].split()[1]) if integrated else -14.0
    gain = max(-12.0, min(10.0, -16.0 - lufs))
    print(f"  mix {lufs:.1f} LUFS, gain {gain:+.1f} dB")

    out = ROOT / out_name
    gfile = work / "graph.txt"
    gfile.write_text(";\n".join(graph))
    cmd = ["ffmpeg", "-v", "error", "-y", *args, "-i", str(mix), "-filter_complex_script", str(gfile),
           "-filter:a", f"volume={gain:.2f}dB,alimiter=limit=0.89:level=false", "-map", "[vout]", "-map", f"{len([x for x in args if x == '-i'])}:a",
           "-t", str(length), "-r", str(fps), "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
    print(out, f"{probe_dur(out):.2f} s")


if __name__ == "__main__":
    args = sys.argv[1:]
    out = "film.mp4"
    if "--out" in args:
        out = args[args.index("--out") + 1]
    main(args[0], out)
