# Architecture de OxoFlow

OxoFlow est une application Electron (interface, raccourci, collage) qui pilote un petit serveur de transcription local en Python (faster-whisper). Les deux parlent en HTTP sur `127.0.0.1` uniquement : rien n'écoute sur le réseau.

```
                         Ctrl+Alt+Espace (globalShortcut)  ou  touche maintenue (uiohook-napi)
                                              │
┌──────────────── Electron (main.js) ─────────┴────────────────────────────────────────────┐
│  zone de notification · raccourci · états de la dictée · pipeline · fichiers JSON · logs  │
│                                                                                          │
│   ff:rec-start ─▶ ┌─ pastille (renderer/overlay) ──────────────────────────────────┐      │
│                   │ fenêtre transparente toujours au premier plan, non cliquable     │      │
│                   │ getUserMedia ─▶ AudioContext 16 kHz ─▶ AudioWorklet (PCM16)      │      │
│   ff:audio-done ◀─│ Écoute / Transcription / Mise en forme / Terminé ✓ / Erreur      │      │
│                   └──────────────────────────────────────────────────────────────────┘      │
│        │ PCM16 ─▶ WAV (lib/wav.js)                                                        │
│        ▼                                                                                   │
│   POST http://127.0.0.1:48123/transcribe?lang=auto&hints=mot1,mot2   (lib/sidecar.js)      │
│        │                                                                                   │
│        │     ┌──── moteur Python (stt/stt_server.py, compilé avec PyInstaller) ─────────┐  │
│        └────▶│ http.server · faster-whisper large-v3 · CUDA float16                     │  │
│              │ replis : int8_float16, int8, puis CPU int8 « small » · VAD · beam 5        │  │
│        ◀─────│ {text, language, duration_ms, audio_ms, segments}  · READY sur stdout    │  │
│              └──────────────────────────────────────────────────────────────────────────┘  │
│        ▼                                                                                   │
│   lib/format.js : « euh / hum » retirés, snippets, vocabulaire (lib/vocab.js),              │
│                   espaces fines avant ? ! ; :, majuscules                                   │
│        ▼                                                                                   │
│   presse-papiers sauvegardé ─▶ texte copié ─▶ native/PasteHelper.exe                        │
│   (SendInput Ctrl+V, ou Maj+Inser dans les terminaux, modificateurs relâchés d'abord)       │
│   ─▶ presse-papiers restauré ─▶ history.json (texte, mots, durée, latence)                  │
│        ▼                                                                                   │
│   fenêtre principale (renderer/hub) : état poussé par IPC (ff:state)                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Fichiers

```
freeflow/
├── package.json              scripts start / build:native / build:stt / package / release
├── main.js                   processus principal (zone de notification, raccourci, pastille, fenêtre, pipeline, IPC)
├── preload.js                pont contextIsolation (window.freeflow.invoke / on / send, canaux ff:*)
├── lib/
│   ├── sidecar.js            lance / adopte / arrête le moteur, /health (progression), /transcribe
│   ├── format.js             mise en forme (fillers, snippets, vocabulaire, typographie, majuscules)
│   ├── vocab.js              vocabulaire : variantes entendues → mot correct (accents, chiffres, séparateurs ignorés)
│   ├── paste.js              PasteHelper.exe + réglages par application
│   ├── wav.js                PCM16 → WAV
│   └── store.js              fichiers JSON écrits de façon atomique
├── renderer/
│   ├── hub/                  fenêtre principale : Accueil, Historique, Dictionnaire, Snippets, Paramètres
│   └── overlay/              pastille + capture du micro (pcm-worklet.js)
├── stt/
│   ├── stt_server.py         moteur faster-whisper (serveur HTTP de la bibliothèque standard)
│   └── build_stt.py          PyInstaller onedir + copie des DLL cuBLAS 12 / cuDNN 9
├── native/
│   └── PasteHelper.cs        collage simulé (SendInput), --dry-run, --info, --mask
├── installer/installer.nsh   règles de l'installateur (fermer OxoFlow avant mise à jour, nettoyage)
├── assets/                   icônes (make_icon.py) et police Figtree
├── dev/                      aperçu de l'interface dans un navigateur (faux pont, données de démo)
└── docs/                     cette page et les captures du README
```

## Données sur le disque

| Où | Quoi |
|---|---|
| `%LOCALAPPDATA%\Programs\OxoFlow` | l'application installée |
| `%LOCALAPPDATA%\OxoFlow\models` | le modèle téléchargé au premier lancement (cache Hugging Face) |
| `%APPDATA%\OxoFlow` | `settings.json`, `dictionary.json`, `snippets.json`, `history.json`, `logs\oxoflow.log` |

Le dossier du modèle se change dans `settings.json` (`modelCache`).

## Le moteur de transcription

Variables d'environnement reconnues par `stt_server.py` :

| Variable | Rôle | Défaut |
|---|---|---|
| `FREEFLOW_PORT` | port local | `48123` |
| `FREEFLOW_MODEL` | modèle sur GPU | `large-v3` |
| `FREEFLOW_CPU_MODEL` | modèle sur processeur | `small` |
| `FREEFLOW_DEVICE` | forcer `mlx`, `cuda` ou `cpu` | MLX sur Mac Apple Silicon, sinon essai GPU puis CPU |
| `FREEFLOW_MLX_MODEL` | modèle MLX sur Mac | `mlx-community/whisper-large-v3-turbo` |
| `FREEFLOW_TOKEN` | secret exigé (en-tête `X-FreeFlow-Token`) sur `POST /transcribe` et `/shutdown` | fourni par l'application (`%APPDATA%\OxoFlow\engine.token`) ; vide = pas de contrôle |
| `HF_HOME` | cache des modèles | fourni par l'application |

Le moteur n'écoute que sur `127.0.0.1`, refuse les requêtes dont l'en-tête `Host` n'est pas local (rebinding DNS) et n'envoie aucun en-tête CORS : une page web ouverte dans le navigateur ne peut ni l'arrêter ni s'en servir.

`GET /health` renvoie `phase` (`starting`, `downloading`, `loading`, `ready`, `error`) et, pendant le premier téléchargement, `download: {model, done, total}` en octets. L'application affiche cette progression dans la fenêtre et dans l'info-bulle de l'icône.

Sans carte NVIDIA détectée, le gros modèle n'est jamais téléchargé : OxoFlow charge directement `small` sur le processeur.

## Commandes de vérification

Aucune frappe n'est envoyée et le collage est désactivé pendant ces tests :

```powershell
# pipeline complet sur un fichier WAV : transcription → mise en forme → presse-papiers → historique
.\node_modules\.bin\electron.cmd . --test-pipeline="C:\chemin\vers\test.wav" --exit
# captures de la fenêtre et de la pastille
.\node_modules\.bin\electron.cmd . --screenshots="C:\dossier" --display-name= --wait-ready --exit
# plan du collage simulé, sans rien envoyer
.\native\PasteHelper.exe --dry-run
```

## Aperçu de l'interface sans Windows

Les deux fenêtres se dessinent dans un navigateur ordinaire, avec un faux pont `window.freeflow` et des données de démonstration (`dev/mock-bridge.js`, exclu du paquet) :

```bash
python -m http.server 3300
# http://localhost:3300/dev/preview.html?page=hub          (&engine=downloading, &empty=1)
# http://localhost:3300/dev/preview.html?page=overlay&phase=listening|transcribing|done|error
```

## Limites connues

- Le collage simulé est refusé par les fenêtres lancées en administrateur : le texte reste dans le presse-papiers.
- En mode « maintenir pour parler », la touche passe aussi à l'application en dessous (hook clavier global) : choisis une combinaison libre.
- La mise en forme suit des règles fixes, sans IA générative : pas de reformulation.
## macOS

| Windows | macOS |
|---|---|
| faster-whisper sur CUDA | MLX Whisper sur Metal (`MlxModel` dans `stt_server.py`), précédé de la détection de voix Silero de faster-whisper : sans voix, le modèle n'est pas appelé (pas d'« Amara.org » inventé sur un silence) |
| `PasteHelper.exe` (SendInput, Ctrl+V) | `PasteHelperMac` (CGEvent, ⌘V) ; renvoie `blocked` + `reason: accessibility` sans la permission Accessibilité |
| zone de notification | barre des menus (icônes *template* `trayTemplate.png`, `assets/make_tray_mac.py`), Dock masqué quand la fenêtre est fermée |
| fenêtre classique | `titleBarStyle: hiddenInset` + `vibrancy: sidebar` ; le hub lit `window.freeflow.platform` pour ses libellés (⌃⌥⇧⌘) |
| pastille | `type: panel` : elle n'active jamais OxoFlow, donc ⌘V arrive dans l'app de l'utilisateur |

- `PasteHelperMac` attend un peu après avoir posté ⌘V : macOS jette les événements d'un processus qui se termine aussitôt.
- Le mode « Maintenir pour parler » (uiohook) ne démarre qu'avec la permission Accessibilité.
