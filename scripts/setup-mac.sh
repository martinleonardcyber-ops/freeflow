#!/bin/sh
# OxoFlow on macOS (Apple Silicon): installs everything needed to run `npm start`.
#   - Node dependencies + the Electron binary (npm >= 11 skips install scripts)
#   - stt/.venv with MLX Whisper (GPU / Metal) and faster-whisper (voice detection, CPU fallback)
#   - native/PasteHelperMac (Cmd+V through CGEvent)
# The speech model (~1.6 GB) is downloaded by OxoFlow itself on first start.
set -e
cd "$(dirname "$0")/.."

echo "1/3 Node"
npm ci --no-audit --no-fund
node node_modules/electron/install.js

echo "2/3 Moteur de transcription (Python)"
if command -v uv >/dev/null 2>&1; then
  uv venv --allow-existing --python 3.12 stt/.venv
  uv pip install --python stt/.venv/bin/python -r stt/requirements-mac.txt
else
  python3 -m venv stt/.venv
  stt/.venv/bin/pip install -q -r stt/requirements-mac.txt
fi

echo "3/3 Collage (Swift)"
swiftc -O -o native/PasteHelperMac native/PasteHelperMac.swift
swiftc -O -o native/FnKeyMac native/FnKeyMac.swift

echo "Prêt. Lance OxoFlow avec : npm start"
