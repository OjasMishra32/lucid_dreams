"""Generate bundle-local WebVTT with whisper.cpp; no Python packages required.

From pipeline/: python3 -m lucid.captions /path/to/dream --model /path/to/ggml-large-v3-turbo.bin
Audio must already share the bundle's clock (0 = its first frame). Never reapply source startS.
Whisper CLI format/flags: https://github.com/ggml-org/whisper.cpp/tree/master/examples/cli
"""

from __future__ import annotations

import argparse
from array import array
from dataclasses import dataclass
from html import escape
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import wave

from . import caption_accessibility as accessibility


class CaptionError(Exception):
    """An actionable failure; do not publish incomplete captions."""


@dataclass(frozen=True)
class Cue:
    start: int  # integer milliseconds, as emitted in whisper.cpp JSON offsets
    end: int
    text: str


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CaptionError(f"Cannot read JSON from {path.name}: {exc}") from exc
    if not isinstance(data, dict):
        raise CaptionError(f"{path.name} must contain a JSON object.")
    return data


def audio_path(bundle: Path, dream: dict) -> Path:
    bundle = bundle.resolve()
    for field, fallback in (("voice", "voice.m4a"), ("audio", "audio.m4a")):
        name = dream.get(field) or fallback
        if not isinstance(name, str):
            raise CaptionError(f"dream.json {field} must be a relative filename or null.")
        path = (bundle / name).resolve()
        if Path(name).is_absolute() or bundle not in path.parents:
            raise CaptionError(f"dream.json {field} must stay inside the bundle.")
        if path.is_file():
            return path
    raise CaptionError("No voice or audio track found. Add voice.m4a or audio.m4a on the bundle's clock.")


def executable(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise CaptionError(f"Missing executable {name!r}. Install ffmpeg and whisper.cpp "
                           "(macOS: brew install ffmpeg whisper-cpp), or pass --ffmpeg/--whisper.")
    return found


def run_tool(command: list[str], timeout: float) -> None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise CaptionError(f"{Path(command[0]).name} timed out after {timeout:g}s; increase --timeout.") from exc
    except OSError as exc:
        raise CaptionError(f"Cannot run {Path(command[0]).name}: {exc}") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout or "No diagnostic output")[-1200:].strip()
        raise CaptionError(f"{Path(command[0]).name} failed (exit {result.returncode}): {detail}")


def read_pcm(path: Path) -> array:
    try:
        with wave.open(str(path), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, "NONE"):
                raise CaptionError("Converted audio must be 16 kHz mono, 16-bit PCM WAV.")
            frames = wav.getnframes()
            raw = wav.readframes(frames)
        if not frames or len(raw) != frames * 2:
            raise CaptionError("Converted audio is empty or truncated.")
        samples = array("h", raw)
        if sys.byteorder != "little":
            samples.byteswap()
        return samples
    except (OSError, EOFError, wave.Error) as exc:
        raise CaptionError(f"Cannot read converted WAV: {exc}") from exc


def rms_db(samples: array, start: int, end: int) -> float:
    # Exact sample interval; no silence trimming or normalization that could move or amplify a cue.
    lo, hi = max(0, start * 16), min(len(samples), end * 16)
    if hi <= lo:
        return -math.inf
    power = sum(v * v for v in samples[lo:hi]) / (hi - lo)
    return 10 * math.log10(power / (32768 ** 2)) if power else -math.inf


def words_from_json(data: dict, samples: array, duration: int, silence_db: float) -> list[Cue]:
    segments = data.get("transcription")
    if not isinstance(segments, list):
        raise CaptionError("Whisper JSON is missing its transcription array. Use whisper-cli JSON output.")
    for segment in segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            raise CaptionError("Malformed Whisper transcription entry.")
    # Mask annotations across word boundaries without moving any retained text to another timestamp.
    combined = " ".join(s["text"] for s in segments)
    if re.search(r"\[[^\]]*$", combined):
        raise CaptionError("Whisper returned an unfinished non-speech annotation; review the transcription.")
    tags = r"\[[^\]]*\]|\((?:(?:soft|background|quiet|loud)\s+)?(?:music|laughs|laughter|laughing|applause|silence|inaudible|coughs|sighs)(?:\s+(?:softly|loudly))?\)"
    cleaned = re.sub(tags, lambda m: " " * len(m[0]), combined, flags=re.IGNORECASE)
    words, last_start, position = [], -1, 0
    for segment in segments:
        raw = cleaned[position:position + len(segment["text"])]
        position += len(segment["text"]) + 1
        text = " ".join("".join(c for c in raw if c not in "♪♫" and (c.isprintable() or c.isspace())).split())
        if not text:
            continue
        offsets = segment.get("offsets")
        if not isinstance(offsets, dict):
            raise CaptionError("Whisper entry is missing millisecond offsets.")
        start, end = offsets.get("from"), offsets.get("to")
        if (type(start) is not int or type(end) is not int or start < 0 or end < start or start < last_start):
            raise CaptionError("Whisper returned invalid or unordered millisecond offsets; rerun transcription.")
        last_start = start
        if start >= duration:
            continue
        end = min(end, duration)
        # Punctuation-only segments inherit the preceding word; do not gate them against silent tails.
        if not any(c.isalnum() for c in text):
            if words and text[0] in ",.!?:;…。！？、”’\"":
                previous = words[-1]
                words[-1] = Cue(previous.start, max(previous.end, end), previous.text + text)
            continue
        # A zero-length word has no energy interval. Use a small local window without changing its timestamp.
        gate_start, gate_end = (start, end) if end > start else (max(0, start - 20), min(duration, start + 20))
        if rms_db(samples, gate_start, gate_end) < silence_db:
            continue
        words.append(Cue(start, end, text))
    return words


def sentence_end(word: str) -> bool:
    word = word.rstrip("\"'”’)]}")
    abbreviations = {"dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "e.g.", "i.e.", "vs.", "etc."}
    if word.lower() in abbreviations or re.fullmatch(r"(?:[A-Za-z]\.)+", word):
        return False
    return bool(re.search(r"[.!?…。！？]$", word))


def boundary_cost(previous: str, following: str) -> int:
    """Soft language hints only; timing and layout constraints always take precedence."""
    if sentence_end(previous):
        return 0
    before, after = previous.lower().strip("\"'”’()[]{},;:!?"), following.lower().strip("\"'“‘()[]{}")
    dangling = {"a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "i", "we", "you", "he", "she", "they",
                "to", "of", "for", "from", "with", "on", "at", "in", "into", "by", "and", "or", "but", "because", "if",
                "that", "which", "who", "is", "am", "are", "was", "were", "be", "been", "being", "have", "has", "had",
                "will", "would", "should", "can", "could", "may", "might", "must", "do", "does", "did", "can't", "won't",
                "don't", "i'm", "i'll", "gonna", "going", "want", "just", "very"}
    clauses = {"and", "but", "or", "so", "because", "while", "although", "then", "when", "after", "before", "until", "if"}
    cost = 6 if re.search(r"[,;:，；：—]$", previous) else 8 if after in clauses else 22
    if before in dangling or (previous.endswith(".") and not sentence_end(previous)):
        cost += 50
    return cost


def wrap(text: str, max_chars: int = 42, max_lines: int = 2) -> str | None:
    if len(text) <= max_chars:
        return text
    words = text.split()
    candidates = []
    for i in range(1, len(words)):
        left, right = " ".join(words[:i]), " ".join(words[i:])
        if max_lines >= 2 and max(len(left), len(right)) <= max_chars:
            # Balance lines without stranding function words or ignoring a useful phrase boundary.
            cost = boundary_cost(words[i - 1], words[i]) + abs(len(left) - len(right)) / 5
            candidates.append((cost, left + "\n" + right))
    if candidates:
        return min(candidates, key=lambda candidate: candidate[0])[1]
    lines = textwrap.wrap(text, width=max_chars, break_long_words=True, break_on_hyphens=False)
    return "\n".join(lines) if len(lines) <= max_lines else None


def make_cues(words: list[Cue], duration: int, *, max_chars: int = 42, max_lines: int = 2,
              min_ms: int = 1000, max_ms: int = 6000) -> list[Cue]:
    # Find the lowest-cost complete partition at real word boundaries, not the longest possible next cue.
    # Missing a sentence ending costs more than another cue. Pauses and clause starts guide necessary splits.
    choices: dict[int, tuple[Cue, int]] = {}
    costs = {len(words): 0}
    for i in range(len(words) - 1, -1, -1):
        text, speech_end, crossed = "", words[i].end, 0
        for j in range(i, len(words)):
            if j > i and words[j].start - words[j - 1].end > 1000:
                break
            if j > i:
                if sentence_end(words[j - 1].text):
                    crossed += 60
                elif re.search(r"[,;:，；：—]$", words[j - 1].text):
                    crossed += 20
                elif words[j].start - words[j - 1].end >= 300:
                    crossed += 18
            text = (text + " " + words[j].text).strip()
            speech_end = max(speech_end, words[j].end)
            wrapped = wrap(text, max_chars, max_lines)
            if wrapped is None or speech_end - words[i].start > max_ms:
                break
            limit = min(duration, words[j + 1].start if j + 1 < len(words) else duration)
            end = min(max(speech_end, words[i].start + min_ms), limit)
            if j + 1 in costs and end >= speech_end and min_ms <= end - words[i].start <= max_ms:
                boundary = 0 if j + 1 == len(words) else boundary_cost(words[j].text, words[j + 1].text)
                if j + 1 < len(words) and words[j + 1].start - speech_end >= 300:
                    boundary = min(boundary, 6)
                # A small per-cue and short-cue cost prevents needless one-word flashes.
                cost = costs[j + 1] + crossed + boundary + 10 + max(0, 1500 - (end - words[i].start)) / 100
                if cost < costs.get(i, math.inf):
                    costs[i] = cost
                    choices[i] = (Cue(words[i].start, end, wrapped), j + 1)
    if words and 0 not in costs:
        raise CaptionError("Cannot fit all speech into non-overlapping cues without shifting words. "
                           "Review word timestamps, clip length, or unusually dense speech; existing captions are unchanged.")
    result, i = [], 0
    while i < len(words):
        cue, i = choices[i]
        result.append(cue)
    return result


def timestamp(ms: int) -> str:
    seconds, millis = divmod(ms, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}.{millis:03}"


def webvtt(cues: list[Cue]) -> str:
    return "WEBVTT\n\n" + "".join(
        f"{i}\n{timestamp(c.start)} --> {timestamp(c.end)}\n{escape(c.text, quote=False)}\n\n"
        for i, c in enumerate(cues, 1)
    )


def publish(bundle: Path, original: bytes, vtt: str) -> None:
    manifest, target = bundle / "dream.json", bundle / "captions.vtt"
    if manifest.is_symlink() or target.is_symlink():
        raise CaptionError("Refusing to replace symlinked caption outputs.")
    if manifest.read_bytes() != original:
        raise CaptionError("dream.json changed during transcription; rerun against the finished bundle.")
    updated = json.loads(original)
    updated["captions"] = "captions.vtt"
    with tempfile.TemporaryDirectory(prefix=".captions-", dir=bundle) as directory:
        stage = Path(directory)
        (stage / "captions.vtt").write_text(vtt, encoding="utf-8")
        (stage / "dream.json").write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        existed = target.exists()
        if existed:
            shutil.copyfile(target, stage / "previous.vtt")
        os.replace(stage / "captions.vtt", target)
        try:
            os.replace(stage / "dream.json", manifest)
        except OSError:
            if existed:
                os.replace(stage / "previous.vtt", target)
            else:
                target.unlink()
            raise


def generate(bundle: Path, model: Path, *, whisper: str = "whisper-cli", ffmpeg: str = "ffmpeg",
             language: str = "auto", silence_db: float = -50, timeout: float = 600,
             accessibility_preset: str | None = None, accessibility_out: Path | None = None) -> int:
    if not math.isfinite(silence_db) or not -120 <= silence_db <= 0:
        raise CaptionError("--silence-db must be a finite dBFS value between -120 and 0.")
    if not math.isfinite(timeout) or timeout <= 0:
        raise CaptionError("--timeout must be a positive, finite number of seconds.")
    bundle = bundle.expanduser().resolve()
    contract = None
    if accessibility_preset is not None:
        contract = accessibility.resolve(accessibility_preset)
        accessibility_out = accessibility_out or bundle / "caption-accessibility.json"
        accessibility_out = accessibility_out.expanduser().resolve()
        if bundle not in accessibility_out.parents:
            raise CaptionError("Accessibility configuration must stay inside the bundle.")
        if accessibility_out.exists():
            raise CaptionError(f"Refusing to overwrite existing accessibility configuration {accessibility_out.name}.")
    original = (bundle / "dream.json").read_bytes()
    dream = read_json(bundle / "dream.json")
    source = audio_path(bundle, dream)
    if not model or not model.expanduser().is_file():
        raise CaptionError("Whisper model not found. Pass --model /private/path/ggml-large-v3-turbo.bin "
                           "or set WHISPER_MODEL. Models are not downloaded automatically.")
    decoder, transcriber = executable(ffmpeg), executable(whisper)
    with tempfile.TemporaryDirectory(prefix="lucid-captions-") as directory:
        wav, output = Path(directory) / "audio.wav", Path(directory) / "transcript"
        # Preserve leading silence and PTS gaps. No -ss, silence trimming, or playback-rate changes.
        run_tool([decoder, "-nostdin", "-y", "-v", "error", "-i", str(source), "-map", "0:a:0", "-vn",
                  "-af", "aresample=16000:async=1:first_pts=0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)], timeout)
        samples = read_pcm(wav)
        duration = len(samples) // 16
        if "durationS" in dream:
            value = dream["durationS"]
            if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                raise CaptionError("dream.json durationS must be a positive, finite number.")
            duration = min(duration, round(value * 1000))
        # -ml 1 + -sow produces word-level segments, whose offsets are already milliseconds (not seconds).
        run_tool([transcriber, "-m", str(model.expanduser().resolve()), "-f", str(wav), "-l", language,
                  "-oj", "-ml", "1", "-sow", "-of", str(output)], timeout)
        words = words_from_json(read_json(output.with_suffix(".json")), samples, duration, silence_db)
        limits = accessibility.cue_limits(contract) if contract else {"max_chars": 42, "max_lines": 2, "min_ms": 1000, "max_ms": 6000}
        cues = make_cues(words, duration, **limits)
        publish(bundle, original, webvtt(cues))
        if contract is not None:
            contract["captions"] = "captions.vtt"
            accessibility_out.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")
        return len(cues)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--model", type=Path, default=os.environ.get("WHISPER_MODEL"))
    parser.add_argument("--whisper", default="whisper-cli", help="whisper.cpp CLI executable or path")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable or path")
    parser.add_argument("--language", default="auto", help="spoken language code or auto; never translates")
    parser.add_argument("--silence-db", type=float, default=-50, help="reject word intervals below this RMS dBFS")
    parser.add_argument("--timeout", type=float, default=600, help="timeout per external command, seconds")
    parser.add_argument("--accessibility-preset", choices=[*accessibility.presets(), "custom"],
                        help="generate safely regrouped cues and an optional presentation sidecar")
    parser.add_argument("--accessibility-out", type=Path,
                        help="new sidecar path (default: bundle/caption-accessibility.json; never overwritten)")
    args = parser.parse_args(argv)
    try:
        count = generate(args.bundle, args.model, whisper=args.whisper, ffmpeg=args.ffmpeg,
                         language=args.language, silence_db=args.silence_db, timeout=args.timeout,
                         accessibility_preset=args.accessibility_preset, accessibility_out=args.accessibility_out)
    except (CaptionError, OSError) as exc:
        print(f"captions: {exc}", file=sys.stderr)
        return 1
    print(f"Wrote {count} cues to {args.bundle / 'captions.vtt'}; review every cue against the original audio.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
