"""Read-only Lucid Dreams dream-bundle readiness validator.

    python -m lucid.validate_bundle dreams/example
    python -m lucid.validate_bundle dreams --json

The validator never rewrites a bundle. Exit 0 means no critical errors,
2 means at least one bundle is not demo-ready, and 1 is an invocation error.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime
import json
import math
from pathlib import Path
import re
import sys

from . import caption_accessibility as accessibility


@dataclass
class Report:
    bundle: str
    checks: list[dict] = field(default_factory=list)

    def add(self, level: str, check: str, message: str) -> None:
        self.checks.append({"level": level, "check": check, "message": message})

    def passed(self, check: str, message: str = "OK") -> None:
        self.add("pass", check, message)

    def warn(self, check: str, message: str) -> None:
        self.add("warn", check, message)

    def error(self, check: str, message: str) -> None:
        self.add("error", check, message)

    @property
    def ready(self) -> bool:
        return not any(item["level"] == "error" for item in self.checks)

    def as_dict(self) -> dict:
        return {"bundle": self.bundle, "ready": self.ready, "checks": self.checks,
                "errors": sum(c["level"] == "error" for c in self.checks),
                "warnings": sum(c["level"] == "warn" for c in self.checks)}


def _read_json(path: Path, report: Report, check: str) -> dict | None:
    if not path.is_file():
        report.error(check, f"Missing {path.name}.")
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        report.error(check, f"Cannot parse {path.name}: {exc}")
        return None
    if not isinstance(value, dict):
        report.error(check, f"{path.name} must contain a JSON object.")
        return None
    return value


def _inside(bundle: Path, name, report: Report, check: str, label: str) -> Path | None:
    if not isinstance(name, str) or not name:
        report.error(check, f"{label} must be a non-empty relative path.")
        return None
    candidate = (bundle / name).resolve()
    if Path(name).is_absolute() or bundle not in candidate.parents:
        report.error(check, f"{label} escapes the bundle.")
        return None
    return candidate


def _number(value, label: str, report: Report, check: str, *, positive=False) -> float | None:
    if type(value) not in (int, float) or not math.isfinite(value) or (positive and value <= 0):
        report.error(check, f"{label} must be a {'positive ' if positive else ''}finite number.")
        return None
    return float(value)


def _triple(value) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(type(n) in (int, float) and math.isfinite(n) for n in value)


_STAMP = re.compile(r"^(\d{2}:)?\d{2}:\d{2}\.\d{3}$")


def _stamp(value: str) -> int | None:
    if not _STAMP.fullmatch(value):
        return None
    pieces = value.split(":")
    if len(pieces) == 2:
        hours, minutes, second = 0, int(pieces[0]), pieces[1]
    else:
        hours, minutes, second = int(pieces[0]), int(pieces[1]), pieces[2]
    seconds, millis = second.split(".")
    if minutes >= 60 or int(seconds) >= 60:
        return None
    return ((hours * 60 + minutes) * 60 + int(seconds)) * 1000 + int(millis)


def _vtt(path: Path, duration_ms: int | None, report: Report) -> None:
    check = "Captions"
    try:
        lines = path.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")
    except OSError as exc:
        report.error(check, f"Cannot read {path.name}: {exc}")
        return
    if not lines or lines[0].strip() != "WEBVTT":
        report.error(check, f"{path.name} must begin with WEBVTT.")
        return
    prior_end, cues, i = -1, 0, 1
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        if lines[i].startswith("NOTE"):
            while i < len(lines) and lines[i].strip():
                i += 1
            continue
        if "-->" not in lines[i]:
            i += 1  # optional cue identifier
        if i >= len(lines) or "-->" not in lines[i]:
            report.error(check, f"Malformed cue near line {i + 1}.")
            return
        left, right = [part.strip().split()[0] for part in lines[i].split("-->", 1)]
        start, end = _stamp(left), _stamp(right)
        if start is None or end is None or end <= start:
            report.error(check, f"Invalid cue timing near line {i + 1}.")
            return
        if start < prior_end:
            report.error(check, "Caption cues overlap.")
            return
        if duration_ms is not None and end > duration_ms + 100:
            report.warn(check, "A caption ends after dream.json durationS.")
        i += 1
        text = []
        while i < len(lines) and lines[i].strip():
            text.append(lines[i])
            i += 1
        if not text:
            report.error(check, f"Cue at {left} has no text.")
            return
        prior_end, cues = end, cues + 1
    report.passed(check, f"{cues} non-overlapping WebVTT cue(s) validated.")


def _frames(bundle: Path, dream: dict, report: Report) -> None:
    check = "Reconstruction assets"
    frame_count = dream.get("frameCount")
    if type(frame_count) is not int or frame_count < 1:
        report.error(check, "dream.json frameCount must be a positive integer.")
        return
    frames = dream.get("frames")
    if dream.get("kind") != "replay":
        if frames is not None:
            report.error(check, "Avatar bundles must set frames to null.")
        return
    if not isinstance(frames, dict):
        report.error(check, "Replay bundle is missing frames metadata.")
        return
    directory = _inside(bundle, frames.get("dir"), report, check, "frames.dir")
    if directory is None or not directory.is_dir():
        if directory is not None:
            report.error(check, f"Missing frame directory {frames.get('dir')!r}.")
        return
    patterns = [p for p in (frames.get("spz"), frames.get("pattern")) if isinstance(p, str) and "%" in p]
    if not patterns:
        report.error(check, "frames must declare an SPZ or PLY printf pattern.")
        return
    found = False
    for pattern in patterns:
        missing, empty = [], []
        for index in range(frame_count):
            try:
                path = directory / (pattern % index)
            except (TypeError, ValueError):
                report.error(check, f"Invalid frame pattern {pattern!r}.")
                return
            if path.is_file():
                found = True
                if path.stat().st_size == 0:
                    empty.append(path.name)
            elif pattern == frames.get("spz"):
                missing.append(path.name)
        if empty:
            report.error(check, f"Corrupted zero-byte frame asset(s): {', '.join(empty[:3])}.")
        if pattern == frames.get("spz") and missing:
            report.error(check, f"Missing {len(missing)} streamed SPZ frame(s), first: {missing[0]}.")
    if not found:
        report.error(check, "No reconstruction frames found.")
    elif not any(c["level"] == "error" and c["check"] == check for c in report.checks):
        report.passed(check, f"{frame_count} replay frame(s) available.")


def _avatar(bundle: Path, dream: dict, report: Report) -> None:
    if dream.get("kind") != "avatar":
        return
    check, avatar = "Avatar assets", dream.get("avatar")
    if not isinstance(avatar, dict):
        report.error(check, "Avatar bundle is missing avatar metadata.")
        return
    for key in ("file", "motion", "skin", "skeleton"):
        path = _inside(bundle, avatar.get(key), report, check, f"avatar.{key}")
        if path is not None and (not path.is_file() or path.stat().st_size == 0):
            report.error(check, f"Missing or empty {avatar.get(key)!r}.")
    if avatar.get("rig") != "smplx":
        report.error(check, "avatar.rig must be smplx.")
    if not any(c["level"] == "error" and c["check"] == check for c in report.checks):
        report.passed(check, "Avatar PLY, motion, skinning, and skeleton assets exist.")


def _metadata(dream: dict, report: Report) -> tuple[int | None, int | None]:
    check = "Metadata"
    for key in ("id", "name", "kind", "units", "upAxis", "createdAt", "metrics", "source", "avatar"):
        if key not in dream:
            report.error(check, f"dream.json is missing {key}.")
    if not isinstance(dream.get("id"), str) or not dream.get("id").strip(): report.error(check, "id must be a non-empty string.")
    if not isinstance(dream.get("name"), str) or not dream.get("name").strip(): report.error(check, "name must be a non-empty string.")
    if dream.get("kind") not in {"replay", "avatar"}: report.error(check, "kind must be replay or avatar.")
    if dream.get("units") != "meters": report.error(check, "units must be meters.")
    if dream.get("upAxis") != "+Y": report.error(check, "upAxis must be +Y.")
    fps = _number(dream.get("fps"), "fps", report, check, positive=True)
    duration = _number(dream.get("durationS"), "durationS", report, check, positive=True)
    bounds = dream.get("bounds")
    if not isinstance(bounds, dict) or not _triple(bounds.get("min")) or not _triple(bounds.get("max")):
        report.error(check, "bounds.min and bounds.max must be numeric triples.")
    elif any(lo > hi for lo, hi in zip(bounds["min"], bounds["max"])):
        report.error(check, "bounds.min must not exceed bounds.max.")
    if not isinstance(dream.get("metrics"), dict):
        report.error(check, "metrics must be an object.")
    else:
        for key in ("psnr", "ssim", "lpips", "views"):
            if key not in dream["metrics"]:
                report.error(check, f"metrics is missing {key}.")
    if dream.get("source") is not None and not isinstance(dream.get("source"), dict):
        report.error(check, "source must be an object or null.")
    if dream.get("kind") == "replay" and dream.get("avatar") is not None:
        report.error(check, "Replay bundles must set avatar to null.")
    if not isinstance(dream.get("createdAt"), str): report.error(check, "createdAt must be a timestamp string.")
    else:
        try: datetime.fromisoformat(dream["createdAt"].replace("Z", "+00:00"))
        except ValueError: report.warn(check, "createdAt is not an ISO-8601 timestamp.")
    count = dream.get("frameCount")
    if type(count) is not int or count < 1: report.error(check, "frameCount must be a positive integer.")
    if fps and duration and isinstance(count, int):
        expected = count / fps
        if abs(expected - duration) > max(0.06, 1 / fps + 0.01):
            report.warn("Frame synchronization", f"frameCount/fps is {expected:.3f}s but durationS is {duration:.3f}s.")
        else:
            report.passed("Frame synchronization", f"{count} frame(s) at {fps:g} fps match {duration:.3f}s.")
    if not any(c["level"] == "error" and c["check"] == check for c in report.checks):
        report.passed(check, "Required dream.json fields are valid.")
    return count if isinstance(count, int) else None, round(duration * 1000) if duration else None


def _referenced(bundle: Path, dream: dict, field: str, check: str, report: Report, *, required=False) -> Path | None:
    value = dream.get(field)
    if value is None:
        if required: report.error(check, f"dream.json must reference {field}.")
        else: report.warn(check, f"Optional {field} unavailable.")
        return None
    path = _inside(bundle, value, report, check, field)
    if path is not None and (not path.is_file() or path.stat().st_size == 0):
        report.error(check, f"Missing or empty referenced asset {value!r}.")
    return path


def _joints(bundle: Path, dream: dict, count: int | None, report: Report) -> None:
    path = _referenced(bundle, dream, "joints", "Joints", report)
    if path is None or not path.is_file(): return
    data = _read_json(path, report, "Joints")
    if data is None: return
    names, frames = data.get("names"), data.get("frames")
    if not isinstance(names, list) or not names or len(set(names)) != len(names) or not all(isinstance(x, str) for x in names):
        report.error("Joints", "joints.json names must be unique strings.")
    if not isinstance(frames, list) or (count is not None and len(frames) != count):
        report.error("Joints", "joints.json frames must match frameCount.")
    elif any(not isinstance(frame, list) or len(frame) != len(names) or not all(_triple(x) for x in frame) for frame in frames):
        report.error("Joints", "Each joints frame must contain one numeric triple per joint.")
    else: report.passed("Joints", f"{len(frames)} joint frame(s) match the replay.")


def _props(bundle: Path, dream: dict, count: int | None, report: Report) -> None:
    path = _referenced(bundle, dream, "props", "Props", report)
    if path is None or not path.is_file(): return
    data = _read_json(path, report, "Props")
    if data is None: return
    objects = data.get("objects")
    if not isinstance(objects, list): report.error("Props", "props.json objects must be a list."); return
    for obj in objects:
        if not isinstance(obj, dict) or not isinstance(obj.get("kind"), str): report.error("Props", "Each prop needs a string kind."); continue
        if obj["kind"] == "basketball":
            track = obj.get("track")
            if not isinstance(track, list) or (count is not None and len(track) != count) or any(x is not None and not _triple(x) for x in track):
                report.error("Props", "Basketball track must contain one triple or null per replay frame.")
        if obj["kind"] == "hoop" and (not _triple(obj.get("rim")) or not _triple(obj.get("facing"))):
            report.error("Props", "Hoop needs numeric rim and facing triples.")
    if not any(c["level"] == "error" and c["check"] == "Props" for c in report.checks): report.passed("Props", f"{len(objects)} prop(s) validated.")


def _experience(bundle: Path, dream: dict, duration_ms: int | None, report: Report) -> None:
    path = _referenced(bundle, dream, "experience", "Experience", report)
    if path is None:
        if isinstance(dream.get("intent"), str) and dream["intent"].strip(): report.warn("Experience", "Intent is present but no experience.json has been generated.")
        return
    if not path.is_file(): return
    data = _read_json(path, report, "Experience")
    if data is None: return
    if data.get("mode") not in {"teach", "companion", "watch", "play"}: report.error("Experience", "experience mode is invalid.")
    if data.get("place", "facing") not in {"facing", "beside", "ahead"}: report.error("Experience", "experience place is invalid.")
    for step in data.get("steps", []):
        if not isinstance(step, dict) or not all(type(step.get(k)) in (int, float) for k in ("start", "end")) or step["end"] <= step["start"]:
            report.error("Experience", "Every lesson step needs increasing numeric start/end seconds."); break
        if duration_ms is not None and step["end"] * 1000 > duration_ms + 1: report.error("Experience", "Lesson step ends after bundle duration."); break
    else:
        if not any(c["level"] == "error" and c["check"] == "Experience" for c in report.checks): report.passed("Experience", "Experience plan is valid.")


def validate(bundle: Path) -> Report:
    bundle = bundle.expanduser().resolve()
    report = Report(str(bundle))
    if not bundle.is_dir(): report.error("Bundle", "Bundle directory does not exist."); return report
    dream = _read_json(bundle / "dream.json", report, "Metadata")
    if dream is None: return report
    count, duration = _metadata(dream, report)
    _frames(bundle, dream, report)
    _avatar(bundle, dream, report)
    for field, check in (("preview", "Visual assets"), ("thumb", "Visual assets")):
        _referenced(bundle, dream, field, check, report, required=True)
    if not any(c["level"] == "error" and c["check"] == "Visual assets" for c in report.checks): report.passed("Visual assets", "Preview and thumbnail exist.")
    for field in ("audio", "voice"):
        _referenced(bundle, dream, field, "Audio references", report)
    if not any(c["level"] == "error" and c["check"] == "Audio references" for c in report.checks): report.passed("Audio references", "Referenced audio assets exist or are intentionally absent.")
    caption = _referenced(bundle, dream, "captions", "Captions", report)
    if caption is not None and caption.is_file(): _vtt(caption, duration, report)
    config = bundle / "caption-accessibility.json"
    if config.exists():
        try: accessibility.read(config); report.passed("Caption accessibility", "Accessibility sidecar is valid.")
        except accessibility.AccessibilityError as exc: report.error("Caption accessibility", str(exc))
    _joints(bundle, dream, count, report); _props(bundle, dream, count, report); _experience(bundle, dream, duration, report)
    return report


def discover(path: Path) -> list[Path]:
    path = path.expanduser().resolve()
    if (path / "dream.json").is_file(): return [path]
    if not path.is_dir(): return [path]
    bundles = sorted(p for p in path.iterdir() if p.is_dir() and (p / "dream.json").is_file())
    return bundles or [path]


def terminal(report: Report) -> str:
    names = {"pass": "PASS", "warn": "WARN", "error": "FAIL"}
    lines = ["LUCID DREAMS — DEMO READINESS", report.bundle, ""]
    lines.extend(f"[{names[item['level']]}] {item['check']}: {item['message']}" for item in report.checks)
    lines += ["", f"STATUS: {'READY FOR DEMO' if report.ready else 'NOT READY FOR DEMO'}"]
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="one bundle or a directory containing bundle directories")
    parser.add_argument("--json", action="store_true", help="emit machine-readable report JSON")
    args = parser.parse_args(argv)
    reports = [validate(path) for path in discover(args.path)]
    if args.json: print(json.dumps({"reports": [r.as_dict() for r in reports], "ready": all(r.ready for r in reports)}, indent=2))
    else: print("\n\n".join(terminal(report) for report in reports))
    return 0 if all(report.ready for report in reports) else 2


if __name__ == "__main__":
    sys.exit(main())
