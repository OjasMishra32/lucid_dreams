# Caption accessibility backend contract

`captions.vtt` remains the canonical transcript and timing source. It stays compatible with every existing Lucid
Dreams bundle. Presentation belongs in an optional, bundle-local `caption-accessibility.json` sidecar, so a player can
choose accessible rendering without editing words or moving speech timestamps.

## Generate a contract

```bash
PYTHONPATH=pipeline python -m lucid.caption_accessibility --preset low-vision \
  --out dreams/example/caption-accessibility.json
```

Available presets are `standard`, `reading-friendly`, `low-vision`, `focus`, and `custom`.

To generate fresh captions with safe focus-mode regrouping from Whisper word timestamps:

```bash
PYTHONPATH=pipeline python -m lucid.captions dreams/example --model /private/models/ggml-large-v3-turbo.bin \
  --accessibility-preset focus
```

That command writes `captions.vtt` plus a new `caption-accessibility.json`. It never changes transcript wording and
never starts a cue before its first spoken word. It refuses to overwrite an existing accessibility sidecar.

## Player integration

The player fetches `caption-accessibility.json` if it exists, validates `schemaVersion: 1`, and applies:

- `presentation.fontFamily`, `fontScale`, `letterSpacingEm`, `lineSpacing`
- `presentation.foreground`, `background`, `backgroundOpacity`, `position`
- `cueLimits.oneGroupAtATime`

`cueLimits.maxLines`, `maxCharsPerLine`, `minDurationS`, and `maxDurationS` are generation-time preferences. They are
already applied only when a new transcript is generated with `--accessibility-preset`; players must not retime VTT
cues. WebVTT itself cannot reliably control fonts, spacing, colours, opacity, or 3D placement across Quest/WebXR,
which is why this sidecar exists.

`reading-friendly` is an optional readability preference, not a claim that any font or layout works for every person
with dyslexia. Players should expose preset selection and custom values only after validating them against this
contract.
