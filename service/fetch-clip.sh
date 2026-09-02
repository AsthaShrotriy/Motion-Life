#!/bin/bash
# Fetch a test clip from ANY direct video URL (e.g. a free Pexels/Pixabay/Coverr CC0 mp4),
# trim to ~8s + downscale (keeps extraction fast), and drop it in assets/videos/.
# Usage:  service/fetch-clip.sh <direct-mp4-url> <name>
#   then: curl -s -X POST -F file=@assets/videos/<name>.mp4 http://127.0.0.1:8765/analyze
set -e
cd "$(dirname "$0")/.."
URL="$1"; NAME="${2:-clip}"; OUT="assets/videos/${NAME}.mp4"
[ -z "$URL" ] && { echo "usage: fetch-clip.sh <direct-mp4-url> <name>"; exit 2; }
tmp="$(mktemp /tmp/ml-XXXXXX.mp4)"
echo "downloading $URL …"; curl -sSL -o "$tmp" "$URL"
if command -v ffmpeg >/dev/null; then
  ffmpeg -y -i "$tmp" -t 8 -vf "scale='min(960,iw)':-2" -an "$OUT" >/dev/null 2>&1 && rm -f "$tmp"
else mv "$tmp" "$OUT"; fi
echo "saved $OUT ($(du -h "$OUT" | cut -f1))"
