#!/usr/bin/env bash
# Vendor the MediaPipe runtime assets served by the webcam view.
#
# The webcam engine (src/client/engine.ts) hard-codes the assembly facts
#   MODEL_URL = /mediapipe/selfie_segmenter.tflite
#   WASM_BASE = /mediapipe/wasm
# which are paired with apps/web/public/mediapipe (public/ contents are copied
# to the dist root verbatim by the web app build). This script reproduces that
# directory from node_modules + the upstream model URL.
#
# Usage: pnpm exec bash packages/client/ui-webcam/scripts/vendor-assets.sh
set -euo pipefail
cd "$(dirname "$0")/../../../.." # repo root

WASM_SRC="packages/client/ui-webcam/node_modules/@mediapipe/tasks-vision/wasm"
OUT_DIR="apps/web/public/mediapipe"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"

if [ ! -d "$WASM_SRC" ]; then
  echo "error: $WASM_SRC missing — run 'pnpm install' first" >&2
  exit 1
fi

mkdir -p "$OUT_DIR/wasm"
cp "$WASM_SRC"/* "$OUT_DIR/wasm/"

# Skip the download when the model is already vendored (keeps offline rebuilds
# fast and deterministic).
MODEL_PATH="$OUT_DIR/selfie_segmenter.tflite"
if [ -s "$MODEL_PATH" ]; then
  echo "model already vendored: $MODEL_PATH"
else
  curl -fsSL --retry 3 -o "$MODEL_PATH" "$MODEL_URL"
  echo "downloaded: $MODEL_PATH"
fi

# The replaced selfie_multiclass_256x256 model (16 MB float32) is retired: the
# engine reads the selfie segmenter's person plane (confidenceMasks[1]).
if [ -f "$OUT_DIR/selfie_multiclass_256x256.tflite" ]; then
  rm "$OUT_DIR/selfie_multiclass_256x256.tflite"
  echo "removed retired model: $OUT_DIR/selfie_multiclass_256x256.tflite"
fi

echo "vendored mediapipe assets:"
ls -la "$OUT_DIR" "$OUT_DIR/wasm"
