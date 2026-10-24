"""Backend contract for accessible Lucid Dreams captions.

This module deliberately keeps presentation separate from ``captions.vtt``.
WebVTT carries words and timing; a player consumes the optional
``caption-accessibility.json`` sidecar for font, colour, spacing and placement.
No preset changes transcript text or moves a word before it is spoken.

    python -m lucid.caption_accessibility --preset focus --out /tmp/caption-accessibility.json
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys


class AccessibilityError(ValueError):
    """A configuration is unsafe or cannot be represented by the contract."""


SCHEMA_VERSION = 1
_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")
_POSITIONS = {"top", "middle", "bottom", "auto"}
_PRESETS = {
    "standard": {
        "presentation": {"fontFamily": "system-ui", "fontScale": 1.0, "letterSpacingEm": 0.0,
                         "lineSpacing": 1.15, "foreground": "#F5F5F7", "background": "#161617",
                         "backgroundOpacity": 0.88, "position": "bottom"},
        "cueLimits": {"maxLines": 2, "maxCharsPerLine": 42, "minDurationS": 1.0,
                       "maxDurationS": 6.0, "oneGroupAtATime": False},
    },
    "reading-friendly": {
        "presentation": {"fontFamily": "Atkinson Hyperlegible, system-ui", "fontScale": 1.15,
                         "letterSpacingEm": 0.04, "lineSpacing": 1.35, "foreground": "#FFFFFF",
                         "background": "#101010", "backgroundOpacity": 0.92, "position": "bottom"},
        "cueLimits": {"maxLines": 2, "maxCharsPerLine": 38, "minDurationS": 1.0,
                       "maxDurationS": 6.0, "oneGroupAtATime": True},
    },
    "low-vision": {
        "presentation": {"fontFamily": "system-ui", "fontScale": 1.45, "letterSpacingEm": 0.02,
                         "lineSpacing": 1.3, "foreground": "#FFFFFF", "background": "#000000",
                         "backgroundOpacity": 1.0, "position": "middle"},
        "cueLimits": {"maxLines": 2, "maxCharsPerLine": 34, "minDurationS": 1.0,
                       "maxDurationS": 6.0, "oneGroupAtATime": True},
    },
    "focus": {
        "presentation": {"fontFamily": "system-ui", "fontScale": 1.2, "letterSpacingEm": 0.02,
                         "lineSpacing": 1.25, "foreground": "#FFFFFF", "background": "#101010",
                         "backgroundOpacity": 0.94, "position": "bottom"},
        "cueLimits": {"maxLines": 1, "maxCharsPerLine": 28, "minDurationS": 1.0,
                       "maxDurationS": 3.5, "oneGroupAtATime": True},
    },
}


def presets() -> list[str]:
    return list(_PRESETS)


def _copy(value):
    return json.loads(json.dumps(value))


def _merge(base: dict, override: dict) -> dict:
    result = _copy(base)
    for key, value in override.items():
        if key in ("presentation", "cueLimits"):
            if not isinstance(value, dict):
                raise AccessibilityError(f"{key} must be an object.")
            result[key].update(value)
        elif key in ("preset", "schemaVersion", "timingPolicy", "rendererNotes", "captions"):
            continue
        else:
            raise AccessibilityError(f"Unknown accessibility setting {key!r}.")
    return result


def _number(name: str, value, low: float, high: float) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise AccessibilityError(f"{name} must be a finite number between {low:g} and {high:g}.")
    return float(value)


def _validate(contract: dict) -> None:
    p, c = contract["presentation"], contract["cueLimits"]
    if not isinstance(p.get("fontFamily"), str) or not p["fontFamily"].strip() or len(p["fontFamily"]) > 160:
        raise AccessibilityError("presentation.fontFamily must be a non-empty string up to 160 characters.")
    _number("presentation.fontScale", p.get("fontScale"), 0.75, 3.0)
    _number("presentation.letterSpacingEm", p.get("letterSpacingEm"), 0.0, 0.2)
    _number("presentation.lineSpacing", p.get("lineSpacing"), 1.0, 2.5)
    for field in ("foreground", "background"):
        if not isinstance(p.get(field), str) or not _COLOUR.fullmatch(p[field]):
            raise AccessibilityError(f"presentation.{field} must be a #RRGGBB colour.")
    _number("presentation.backgroundOpacity", p.get("backgroundOpacity"), 0.0, 1.0)
    if p.get("position") not in _POSITIONS:
        raise AccessibilityError("presentation.position must be top, middle, bottom, or auto.")
    for field, low, high in (("maxLines", 1, 2), ("maxCharsPerLine", 12, 80)):
        value = c.get(field)
        if type(value) is not int or not low <= value <= high:
            raise AccessibilityError(f"cueLimits.{field} must be an integer between {low} and {high}.")
    minimum = _number("cueLimits.minDurationS", c.get("minDurationS"), 0.25, 6.0)
    maximum = _number("cueLimits.maxDurationS", c.get("maxDurationS"), minimum, 10.0)
    if type(c.get("oneGroupAtATime")) is not bool:
        raise AccessibilityError("cueLimits.oneGroupAtATime must be true or false.")
    if maximum < minimum:
        raise AccessibilityError("cueLimits.maxDurationS must not be shorter than minDurationS.")


def resolve(preset: str = "standard", overrides: dict | None = None, *, captions: str = "captions.vtt") -> dict:
    """Return a validated, JSON-serializable sidecar contract.

    ``overrides`` only changes presentation/cue-limit values. It cannot add
    transcript text, timestamps, or renderer-specific executable code.
    """
    if preset == "custom":
        base_name = "standard"
    else:
        base_name = preset
    if base_name not in _PRESETS:
        raise AccessibilityError(f"Unknown preset {preset!r}; choose one of: {', '.join([*presets(), 'custom'])}.")
    if not isinstance(captions, str) or not captions or Path(captions).is_absolute() or ".." in Path(captions).parts:
        raise AccessibilityError("captions must be a relative bundle filename.")
    contract = _merge(_PRESETS[base_name], overrides or {})
    contract.update({
        "schemaVersion": SCHEMA_VERSION,
        "preset": preset,
        "captions": captions,
        "timingPolicy": "preserve-word-timestamps; never-show-before-speech",
        "rendererNotes": "Presentation values are player preferences. WebVTT alone cannot guarantee fonts, spacing, colours, or placement in Quest.",
    })
    _validate(contract)
    return contract


def cue_limits(contract: dict) -> dict:
    """Validated integer-millisecond limits for generation-time cue grouping."""
    _validate(contract)
    c = contract["cueLimits"]
    return {"max_lines": c["maxLines"], "max_chars": c["maxCharsPerLine"],
            "min_ms": round(c["minDurationS"] * 1000), "max_ms": round(c["maxDurationS"] * 1000)}


def read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AccessibilityError(f"Cannot read accessibility configuration: {exc}") from exc
    if not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA_VERSION:
        raise AccessibilityError(f"Accessibility configuration must use schemaVersion {SCHEMA_VERSION}.")
    preset = data.get("preset")
    if preset not in {*presets(), "custom"}:
        raise AccessibilityError("Accessibility configuration has an unknown preset.")
    expected = resolve(preset, {"presentation": data.get("presentation"), "cueLimits": data.get("cueLimits")},
                       captions=data.get("captions", "captions.vtt"))
    return expected


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", default="standard", choices=[*presets(), "custom"])
    parser.add_argument("--overrides", help="JSON object with presentation and/or cueLimits overrides")
    parser.add_argument("--captions", default="captions.vtt")
    parser.add_argument("--out", type=Path, help="write contract; refuses to overwrite")
    parser.add_argument("--list", action="store_true", help="list preset names")
    args = parser.parse_args(argv)
    try:
        if args.list:
            print("\n".join([*presets(), "custom"]))
            return 0
        overrides = json.loads(args.overrides) if args.overrides else None
        if overrides is not None and not isinstance(overrides, dict):
            raise AccessibilityError("--overrides must be a JSON object.")
        contract = resolve(args.preset, overrides, captions=args.captions)
        body = json.dumps(contract, indent=2) + "\n"
        if args.out:
            if args.out.exists():
                raise AccessibilityError(f"Refusing to overwrite {args.out}.")
            args.out.write_text(body, encoding="utf-8")
        else:
            print(body, end="")
    except AccessibilityError as exc:
        print(f"caption accessibility: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
