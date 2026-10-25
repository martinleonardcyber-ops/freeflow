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
  sips -z $((s * 2)) $((s * 2)) assets/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/OxoFlow.icns"

echo "4/5 Application"
cat > "$BUILD/extra-info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSMicrophoneUsageDescription</key><string>OxoFlow transcrit ta voix sur ce Mac. Rien ne quitte ta machine.</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>NSHumanReadableCopyright</key><string>OxoFlow, d'après FreeFlow d'Alan · licence MIT</string>
</dict></plist>
PLIST
npx --no-install @electron/packager . OxoFlow --platform=darwin --arch=arm64 --overwrite --out=release \
  --icon="$BUILD/OxoFlow.icns" --app-bundle-id=com.oxoria.oxoflow --extend-info="$BUILD/extra-info.plist" \
  --extra-resource=native/PasteHelperMac --extra-resource=native/FnKeyMac --extra-resource="$BUILD/engine" \
  --ignore='^/stt($|/)' --ignore='^/native/.*\.(swift|cs)$' --ignore='^/native/(PasteHelperMac|FnKeyMac)$' \
  --ignore='^/build($|/)' --ignore='^/release($|/)' --ignore='^/dist($|/)' --ignore='^/dev($|/)' --ignore='^/test($|/)' --ignore='^/site($|/)' --ignore='^/\.github($|/)' --ignore='^/docs($|/)' \
  --ignore='^/installer($|/)' --ignore='^/scripts($|/)' --ignore='^/screenshots($|/)' --ignore='^/\.git' \
  --ignore='^/assets/make_.*\.py$' --ignore='^/assets/dmg-background' --ignore='^/README\.md$' >/dev/null
APP="$ROOT/release/OxoFlow-darwin-arm64/OxoFlow.app"
# @electron/packager turns the engine's relative symlinks (python3 -> python3.12...)
# into absolute paths into build/: once build/ is gone the app has no Python.
# Point them back at their sibling files, then refuse any link leaving the bundle.
find "$APP/Contents/Resources/engine" -type l | while read -r link; do
  target="$(readlink "$link")"
  case "$target" in /*) ln -sfn "$(basename "$target")" "$link" ;; esac
done
if find "$APP/Contents/Resources/engine" -type l -exec readlink {} \; | grep -q '^/'; then
  echo "!! lien absolu restant dans le moteur embarqué" >&2; exit 1
fi

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
      # Styled install window (background, icon layout, no toolbar): dmgbuild
      # writes the Finder .DS_Store itself, no GUI or AppleScript needed (CI-safe).
      tiffutil -cathidpicheck assets/dmg-background.png assets/dmg-background@2x.png -out "$BUILD/dmg-background.tiff" 2>/dev/null
      DMG="$ROOT/release/OxoFlow-mac-arm64.dmg"; rm -f "$DMG"
      uvx --quiet --from dmgbuild==1.6.7 dmgbuild -s scripts/dmg-settings.py -D app="$APP" \
        -D background="$BUILD/dmg-background.tiff" -D volicon="$BUILD/OxoFlow.icns" "OxoFlow" "$DMG"
      du -sh "$DMG" | awk '{print "Image disque : " $2 " (" $1 ")"}' ;;
  esac
done
echo "Prêt : $APP"
