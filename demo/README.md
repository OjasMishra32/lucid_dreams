# Lucid Dreams demo preparation

Anyone from any video, standing in your room.

Owner: Atina. This folder holds story, capture, consent and demo materials. It contains no source media or private consent evidence.

## First milestone — Friday, October 23, 10 PM ET

Deliver three test clips to Ojasva, select a family photo or video, and request written family consent. Preparation is ready; the physical deliveries below remain unconfirmed.

| Deliverable | Current state | Evidence needed to mark done |
| --- | --- | --- |
| Three test clips recorded and checked | Pending | Actual filenames and completed quality checks in the clip register |
| Three test clips handed to Ojasva | Pending | Transfer time and confirmation the files reached his Mac |
| Family photo or video selected | Pending | Asset ID and private storage reference in the consent record |
| Written family consent requested | Pending; template ready, request not sent | Date, requested uses, and private evidence reference |

A sent request satisfies the request part of Friday's milestone. It does **not** authorize processing or showing the family asset; wait for written agreement to the intended uses.

## Use this kit

1. Follow the [capture guide](capture-guide.md) to record three short takes with consenting teammates.
2. Replace planned entries in the [clip register](clips.md) with actual details. Check sharpness, full-body framing and consent before transfer.
3. AirDrop or copy the accepted files into `~/Downloads/lucid-clips/` on **Ojasva's Mac**. This folder automatically starts processing, so only put approved inputs there. Record the handoff; Ojasva handles pipeline or GPU issues.
4. Select the family asset and use the request in [consent.md](consent.md). Keep its approval state explicit.
5. When the evidence above exists, update these records and append the completed milestone to the Status log in [AGENTS.md](../AGENTS.md).

## Handoff note

Fill this in after transfer; this is a template, not a sent message.

> Atina → Ojasva: [filenames] are in your `~/Downloads/lucid-clips/`, transferred at [time ET]. Subject consent and local quality checks: [record IDs and results]. Intended use: replay test. Watch for [specific issue or “none observed”]. Family asset: [not selected / awaiting permission / approved for listed uses].

The autopilot processes inputs asynchronously. A transfer is not proof that reconstruction succeeded. Record processing results separately and leave all fidelity numbers unreported until measured.

## Next milestones

| Deadline (ET) | Delivery |
| --- | --- |
| Saturday, October 24, 10 AM | Quest UI mockups for Ian, matching Raami's design tokens |
| Saturday noon | Hero clips, Devpost draft, video script |
| Saturday 8 PM | README and credits, slide draft |
| Sunday, October 25, 1 PM | Edited video and final Devpost copy |
| Sunday 3 PM | Submission complete |

Keep raw clips, family photos, consent screenshots, contact details and large outputs in private shared storage outside this public checkout. Use anonymous record IDs here. Do not add private share links or access tokens.

## Caption pipeline

Atina owns [captions.py](../pipeline/lucid/captions.py) and its [tests](../pipeline/tests/test_captions.py).
The implementation uses the existing optional `"captions": "captions.vtt"` field; no bundle schema or player changes are needed for ordinary speech captions. Restoration is separate and has not been started.

### Run locally

Install ffmpeg and whisper.cpp if needed (`brew install ffmpeg whisper.cpp` on macOS). Download the
`ggml-large-v3-turbo.bin` model using the [upstream model instructions](https://github.com/ggml-org/whisper.cpp/tree/master/models)
**outside this repository**. Nothing is downloaded automatically. Python 3.9+ is sufficient; no pip packages are required.

From the repository root, on an existing private bundle with consented speech:

```sh
PYTHONPATH=pipeline python3 -m lucid.captions /absolute/path/to/dreams/my-dream --model /absolute/private/path/ggml-large-v3-turbo.bin
```

Alternatively set `WHISPER_MODEL` to that model path. The command prefers `voice.m4a`, then `audio.m4a`, and honors
custom relative `voice`/`audio` filenames in `dream.json`. A missing voice file falls back to audio; a corrupt voice
file reports a decoding error so it can be inspected. `--whisper` and `--ffmpeg` accept explicit executable paths.
`--language en` fixes the spoken language; the default is auto-detection and transcription never translates.
`--timeout 600` is the limit in seconds **per tool invocation**.

### Timing and publication

- Audio must already be trimmed to the bundle's playback window. Zero means its first frame, including any leading silence.
  Do not supply the untrimmed source video or reapply `startS`; the script cannot infer a missing upstream trim.
- ffmpeg decodes 16 kHz mono PCM without removing silence, changing speed or normalizing levels. Whisper runs with
  word-level segmentation (`-oj -ml 1 -sow`); its integer millisecond offsets are kept on that audio clock.
- Cleaning removes bracketed annotations, known parenthesized sound labels and music symbols, then rejects words whose
  audio intervals are below the RMS threshold (default **−50 dBFS**). `--silence-db -60` retains quieter speech, but may
  also retain more noise. An energy check cannot prove that a sound is speech or that a transcription is correct.
- Cues start at actual word boundaries, span 1–6 seconds, contain at most two 42-character lines, and do not overlap
  or run beyond the audio/bundle duration. Short cues may hold after speech for readability, without shifting their start.
  A scored partition favors sentence endings, punctuation, pauses and clause boundaries; two-line captions use the same
  phrase preferences. English function-word hints discourage dangling endings such as “my” or “to.” These are soft
  preferences: they never override timestamps, duration, layout or preservation of the spoken words.
  Impossible cases (such as a lone word in a half-second clip or speech too dense for these limits) fail clearly instead
  of discarding spoken words or inventing timing. A valid no-speech result produces an empty `WEBVTT` file.
- `captions.vtt` and the manifest are staged before publication. Only the manifest's `captions` value changes;
  unrelated metadata is preserved. Tool, parsing and cue-layout errors leave existing outputs unchanged. If manifest
  replacement fails, the prior VTT is restored. Each file replacement is atomic; the two-file update is not crash-atomic.
  Run on a finished bundle while no exporter or bridge process is writing it. A changed manifest detected during the run causes an error.
- The module exits **0** on success, **1** for a handled processing error, and **2** for invalid CLI syntax.
  Missing tools/models, corrupt audio, malformed transcription and timeouts produce actionable messages without a traceback.

### Tests and real-audio acceptance

Run the standard-library suite from the repository root:

```sh
PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v
```

Tests cover timestamps, Unicode, cue limits, noise tags, silence rejection, metadata preservation, file rollback,
dependency failures and subprocess errors. The 3,244-byte WAV fixture contains only generated silence and a 440 Hz tone,
not a person's voice. A subprocess integration test uses fake external executables to exercise the complete CLI; it does
**not** verify ffmpeg decoding or speech recognition. A real ffmpeg/AAC timing test runs automatically when ffmpeg is on PATH.
Opt into the actual Whisper silence test after installing tools and the model:

```sh
LUCID_CAPTIONS_REAL_TOOLS=1 WHISPER_MODEL=/absolute/private/path/ggml-large-v3-turbo.bin PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v
```

**Three-clip and headset acceptance remain open.** One private voice memo has been reviewed. Test three consented talking clips, run the command on each
finished bundle, listen to the selected source audio and compare every cue's wording and start/end. Check the web dream
page and WebXR viewer, including pause, scrub, looping and 0.25×/0.5× playback. Record corrections or rejected results;
automated tests do not establish transcription accuracy. Native Unity caption display remains Ian's integration work.

One existing WebXR edge case needs owner review: its VTT parser strips tags but does not decode entities. Standard VTT
escaping of literal `&`, `<` or `>` may display as entity text there; the web page uses the browser's VTT parser. No player
code was changed here. Avoid declaring display acceptance until this and the actual speech bundles are checked.

Local review result on Python 3.9.6: **52 tests passed, none skipped**, including real ffmpeg/AAC timing and real Whisper
silence inference. Ten new segmentation regressions cover sentence/phrase boundaries, pauses, abbreviations, two-line
wrapping and constraints that must override linguistic preferences. A private voice memo was successfully transcribed;
its wording and revised segmentation were accepted by Atina. The three-speech-bundle
and viewer acceptance checklist remains open. No private audio, transcript or model is stored in the repository.

| Speech bundle | Consent + source | Every word reviewed | Timing + viewer checked |
| --- | --- | --- | --- |
| Private voice memo (temporary bundle) | Atina's own recording | Wording and segmentation accepted | Automated timing checks passed; viewer review pending |
| 2 | Pending | Pending | Pending |
| 3 | Pending | Pending | Pending |
