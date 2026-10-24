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
The implementation uses the existing optional `"captions": "captions.vtt"` field; no bundle schema or player changes are needed for ordinary speech captions. Restoration is a separate standalone tool, documented below.

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

## Standalone video restoration — implementation ready for review

Atina owns [restore.py](../pipeline/lucid/restore.py) and [test_restore.py](../pipeline/tests/test_restore.py).
This tool is run manually before submission to Ojasva. It does not call or change clip prep, upload jobs, reconstruction,
export, any player or the dream bundle contract. Automatic restoration remains disabled.

### Setup and use

ffmpeg/ffprobe are installed on Atina's Mac. The official
[Real-ESRGAN macOS release](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0) was downloaded and tested outside
the repository. Its universal binary runs natively on Apple Silicon, using the Apple GPU through Vulkan/MoltenVK.
Use the portable executable and its `models/` folder together; explicitly select `realesrgan-x4plus`, not the package's
default anime model. Dependencies are never installed or downloaded by the Python script.

From the repository root:

```sh
PYTHONPATH=pipeline python3 -m lucid.restore /private/clips/input.mp4 /private/clips/restored.mp4 --esrgan /private/tools/realesrgan-ncnn-vulkan --models /private/tools/models --report /private/clips/restored.json
```

Alternatively set `REALESRGAN_BIN` and `REALESRGAN_MODELS`. All paths above are placeholders. `--tile 128` bounds GPU
memory use (`0` selects automatic tiling); `--timeout 600` limits each external command. Progress goes to stderr and a
verification report goes to stdout, plus an optional JSON file. Models, media, reports and frame caches belong outside
this public checkout. No face restoration, colorization, voice processing or frame interpolation is performed.

### Preservation and failure behavior

- ffprobe validates decoded frame timestamps, exact rational frame rate, video dimensions, sample aspect ratio and
  audio offsets before extracting frames. The initial version accepts one 8-bit SDR video stream at constant frame rate.
  Variable/discontinuous frame timing, partial final frames, HDR/high-bit-depth video, rotation, unsupported color matrices,
  audio beginning before the first video frame, and unknown/invalid required metadata are rejected explicitly.
- `bwdif=mode=send_frame:parity=auto:deint=interlaced` keeps one frame per input frame and leaves progressive frames
  alone. `hqdn3d=2:1:3:3` lightly denoises before PNG extraction. If source interlacing flags are wrong, use an informed
  `--field-order tff` or `bff` override; neither frame doubling nor automatic parity guessing is introduced.
- Real-ESRGAN processes numbered PNGs at exactly 4x. The complete output sequence and every PNG's dimensions are
  checked before assembly. Source framing and sample aspect ratio are retained, including non-square pixels.
- Output video uses H.264 CRF 14, the exact input frame rate (including `30000/1001`) and original frame count.
  A common timeline normalization places the first video frame at zero while retaining audio/video offsets. There
  is no crop, speed change, trim or `-shortest` truncation. Clip prep may later resample to 25 fps independently.
- Original audio streams are mapped explicitly and stream-copied. Audio codec/rate/channels/layout, packet hashes
  and packet times relative to the video are validated after muxing. Silent footage remains silent. A codec the
  requested MP4/MOV/MKV container cannot carry causes an error; audio is never silently converted to AAC.
- Timestamp comparisons allow container time-base rounding, not accumulated drift. Output is decoded and checked
  before publication. Source size, identity and modification time must remain unchanged throughout the run.
- Existing outputs, reports, the original itself and its existing aliases are never overwritten. Exclusive file
  publication also protects against another file appearing during processing. On ordinary errors staging is cleaned;
  if report publication fails, the tool removes only its own newly published video. Hard termination can leave staging
  files; publication of video plus report is not a two-file crash-atomic transaction.
- Errors include missing executables/models, bad media, low disk space, incomplete frames, GPU failure, timeout and
  changed audio/timing. Exit codes are 0 for success, 1 for handled failures and 2 for invalid command-line syntax.

### Verified synthetic run and objective comparison

A three-second test pattern with synthetic audio was downsampled from a clean 640x480 reference to 160x120, given
light temporal uniform noise (level 6), and encoded at H.264 CRF 18. Restoration returned 640x480 in **9.222 seconds**
on Atina's Mac. Both versions have **30 frames, 10 fps, 3.000 seconds, 4:3 display aspect and 48 kHz mono AAC**.
All audio packet hashes and relative timestamps match. The comparison video and still remain outside the repository:
left = original enlarged with Lanczos; right = restored. Both display at 640x480 and encode at CRF 14 for a fair comparison.

| Metric at 640x480 | Lanczos baseline | Restored |
| --- | --- | --- |
| PSNR against clean reference | 27.799683 dB | 27.161587 dB |
| SSIM against clean reference | 0.882276 | 0.908371 |
| Mean normalized Laplacian variance, 10 sampled frames | 0.000208758 | 0.001751401 |
| LPIPS | Not measured | Not measured |

The result is mixed: sharper structure and higher SSIM, lower PSNR, and visible invented texture in the fine pattern.
Sharpness can reward noise or oversharpening. This verifies the engineering path, **not** restored identity or improved
3D reconstruction. Keep restoration manual and opt-in until real-footage evaluation supports it.

### Tests and the real-footage acceptance gate

The complete pipeline suite passed **80 tests, none skipped**: 52 existing caption tests and 28 restoration tests,
including real ffmpeg integration, real Whisper silence inference and real Real-ESRGAN x4plus inference. Restoration
tests include fractional frame rates, non-square pixels, interlaced/progressive footage, silent clips, audio delays,
nonzero video start, identical decoded audio samples, real VFR rejection, validation and safe failure/publication.

```sh
LUCID_RESTORE_REAL_TOOLS=1 REALESRGAN_BIN=/private/tools/realesrgan-ncnn-vulkan REALESRGAN_MODELS=/private/tools/models LUCID_CAPTIONS_REAL_TOOLS=1 WHISPER_MODEL=/private/models/ggml-large-v3-turbo.bin PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v
```

Without opt-in flags, GPU-specific tests skip explicitly; ffmpeg integration uses a labeled resize stand-in for the
upscaler. It validates media preservation, not learned restoration. The separate real-model test validates actual inference.

Next, use the credited Keaton/Baker cuts Ojasva can supply and a consenting teammate clip. Keep a clean high-resolution
teammate reference, degrade a copy to 480p, and compare restoration against interpolation at the same resolution,
timestamps and color space. Measure PSNR/SSIM and, when installed, LPIPS; inspect faces, hands, ringing, flicker and
identity changes through the whole motion. A real archival original is not clean high-resolution ground truth.

For downstream evaluation, Ojasva alone submits both variants using the same source window, fixed framing, random
seed, views, cameras/settings where controllable, training budget and held-out split. Prefer preparing the same crop
before branching so the person detector cannot change the framing between runs. Compare matching dreams in the viewer
and headset at 1.5 m. Read PSNR/SSIM and `heldOut` from `recon-*.json`; those measure reconstruction against its target
views and are not automatically evidence of fidelity to real footage. Existing reports do not measure sharpness or LPIPS;
evaluate matched renders separately and label unavailable measurements honestly. Do not change pipeline metrics code.

Acceptance still needs real person/archival footage, a side-by-side dream review and Ojasva's reconstruction results.
Use the original if restoration changes identity or introduces artifacts. Automatic `prep_clip.py` integration requires
a separate decision and permission after that evidence exists.

Credits: [Real-ESRGAN ncnn Vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) (MIT),
[Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (BSD-3-Clause) and [FFmpeg](https://ffmpeg.org/legal.html)
(license depends on build options; Atina's Homebrew build enables GPL components). No project licenses or contracts changed.
