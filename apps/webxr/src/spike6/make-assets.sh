#!/bin/sh
# Writes the S6 test page's binary assets (H.264 streams and the 720p clip) into ./assets, which git ignores.
# Needs ffmpeg (with libx264) and node. About a minute on an M-series Mac.
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "ffmpeg not found: brew install ffmpeg" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
exec node make-assets.mjs
