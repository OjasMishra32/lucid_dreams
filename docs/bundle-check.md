# Dream bundle readiness check — 2026-10-25

## Local result

```bash
PYTHONPATH=pipeline /private/tmp/lucid-py312-tests/bin/python -m lucid.validate_bundle samples --json
```

`samples/synthetic-test` is **READY FOR DEMO**. Its metadata, four SPZ replay frames, frame timing, preview, and
thumbnail all pass. The validator reports six expected warnings for intentionally absent optional audio, voice,
captions, joints, props, and experience files. It did not modify the bundle.

The complete pipeline suite was also run with Python 3.12 in an isolated temporary environment:

```bash
PYTHONPATH=pipeline /private/tmp/lucid-py312-tests/bin/python -m unittest discover -s pipeline/tests -v
```

Result: **133 passed, 2 skipped**. The skips require separately installed real Whisper and Real-ESRGAN model tools.

## Bridge-Mac follow-up

This checkout has no fetched `dreams/` directory, so it cannot inspect the real library bundles. On Ojasva's Mac,
run this read-only command after the bundles finish fetching:

```bash
PYTHONPATH=pipeline python3 -m lucid.validate_bundle dreams --json > /private/tmp/lucid-bundle-report.json
PYTHONPATH=pipeline python3 -m lucid.validate_bundle dreams
```

Keep the JSON report outside the repository if it includes private dream names. Any `error` means that bundle is not
ready for the live demo; `warn` entries identify optional assets that the player can omit.
