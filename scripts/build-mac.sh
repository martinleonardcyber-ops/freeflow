#!/bin/sh
# Builds release/OxoFlow-darwin-arm64/OxoFlow.app (Apple Silicon), self-contained:
#   Contents/Resources/engine/   relocatable Python 3.12 (uv / python-build-standalone)
#                                + MLX Whisper / faster-whisper in site-packages + stt_server.py
#   Contents/Resources/PasteHelperMac, FnKeyMac
# The speech model is not bundled: the app downloads it on first start (or reuses
# ~/Library/Application Support/OxoFlow/models).
# Usage: npm run package:mac [-- --install] [-- --dmg]
#   --install  copies the app to /Applications
#   --dmg      also makes release/OxoFlow-mac-arm64.dmg (drag-to-Applications disk image)
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD="$ROOT/build/mac"
rm -rf "$BUILD" && mkdir -p "$BUILD/engine"

echo "1/5 Helpers natifs"
swiftc -O -o native/PasteHelperMac native/PasteHelperMac.swift
swiftc -O -o native/FnKeyMac native/FnKeyMac.swift

echo "2/5 Moteur Python embarqué"
uv python install 3.12 >/dev/null
PYHOME="$(cd "$(dirname "$(dirname "$(uv python find 3.12)")")" && pwd -P)"   # uv's path is a symlink
cp -R "$PYHOME" "$BUILD/engine/python"
# mlx-whisper pulls PyTorch (~530 MB) for its model-conversion script only:
# install it without dependencies and list what transcription really needs.
uv pip install --quiet --python "$BUILD/engine/python/bin/python3" --target "$BUILD/engine/site-packages" --no-deps mlx-whisper
uv pip install --quiet --python "$BUILD/engine/python/bin/python3" --target "$BUILD/engine/site-packages" \
  faster-whisper mlx numpy numba scipy tqdm more-itertools tiktoken huggingface_hub
cp stt/stt_server.py "$BUILD/engine/"
find "$BUILD/engine" -name "__pycache__" -type d -prune -exec rm -rf {} +
du -sh "$BUILD/engine/python" "$BUILD/engine/site-packages" | awk '{print "   " $2 " : " $1}'
"$BUILD/engine/python/bin/python3" -s -c "import sys; sys.path.insert(0, '$BUILD/engine/site-packages'); import mlx_whisper, faster_whisper; from faster_whisper.vad import get_speech_timestamps; print('   moteur OK')"

echo "3/5 Icône"
ICONSET="$BUILD/OxoFlow.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d assets/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
cp assets/icon.png "$ICONSET/icon_256x256@2x.png"
iconutil -c icns "$ICONSET" -o "$BUILD/OxoFlow.icns"

echo "4/5 Application"
cat > "$BUILD/extra-info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSMicrophoneUsageDescription</key><string>OxoFlow transcrit ta voix sur ce Mac. Rien ne quitte ta machine.</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHumanReadableCopyright</key><string>OxoFlow, d'après FreeFlow d'Alan · licence MIT</string>
</dict></plist>
PLIST
npx --no-install @electron/packager . OxoFlow --platform=darwin --arch=arm64 --overwrite --out=release \
  --icon="$BUILD/OxoFlow.icns" --app-bundle-id=com.oxoria.oxoflow --extend-info="$BUILD/extra-info.plist" \
  --extra-resource=native/PasteHelperMac --extra-resource=native/FnKeyMac --extra-resource="$BUILD/engine" \
  --ignore='^/stt($|/)' --ignore='^/native/.*\.(swift|cs)$' --ignore='^/native/(PasteHelperMac|FnKeyMac)$' \
  --ignore='^/build($|/)' --ignore='^/release($|/)' --ignore='^/dist($|/)' --ignore='^/dev($|/)' --ignore='^/docs($|/)' \
  --ignore='^/installer($|/)' --ignore='^/scripts($|/)' --ignore='^/screenshots($|/)' --ignore='^/\.git' \
  --ignore='^/assets/make_.*\.py$' --ignore='^/README\.md$' >/dev/null
APP="$ROOT/release/OxoFlow-darwin-arm64/OxoFlow.app"

echo "5/5 Signature ad hoc"
# Editing Info.plist breaks Electron's signature; Apple Silicon refuses unsigned code.
codesign --force --deep --sign - "$APP" 2>/dev/null
codesign --verify --deep "$APP" && echo "   signature OK"
du -sh "$APP" | awk '{print "   taille : " $1}'

for arg in "$@"; do
  case "$arg" in
    --install)
      rm -rf /Applications/OxoFlow.app
      ditto "$APP" /Applications/OxoFlow.app
      echo "Installé : /Applications/OxoFlow.app" ;;
    --dmg)
      STAGE="$BUILD/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
      ditto "$APP" "$STAGE/OxoFlow.app"
      ln -s /Applications "$STAGE/Applications"
      DMG="$ROOT/release/OxoFlow-mac-arm64.dmg"; rm -f "$DMG"
      hdiutil create -quiet -volname "OxoFlow" -srcfolder "$STAGE" -fs HFS+ -format ULMO -ov "$DMG"
      du -sh "$DMG" | awk '{print "Image disque : " $2 " (" $1 ")"}' ;;
  esac
done
echo "Prêt : $APP"
