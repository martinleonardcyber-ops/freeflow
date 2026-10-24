# Composants tiers

Le code de OxoFlow est sous licence MIT (voir `LICENSE`). L'installateur Windows et l'application Mac embarquent aussi les composants suivants, chacun sous sa propre licence.

| Composant | Rôle | Licence |
|---|---|---|
| [Electron](https://github.com/electron/electron) (Chromium, Node.js) | application de bureau | MIT ; licences de Chromium dans `LICENSES.chromium.html` à côté de `OxoFlow.exe` |
| [uiohook-napi](https://github.com/SnosMe/uiohook-napi) / [libuiohook](https://github.com/kwhat/libuiohook) | raccourci « maintenir pour parler » | MIT / LGPL-3.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | transcription | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | moteur d'inférence | MIT |
| [Whisper](https://github.com/openai/whisper), poids convertis par [Systran](https://huggingface.co/Systran) | modèle de reconnaissance vocale, téléchargé au premier lancement | MIT |
| [PyAV](https://github.com/PyAV-Org/PyAV) / FFmpeg | décodage audio | BSD-3-Clause / LGPL |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | détection de la voix (VAD Silero) | MIT |
| [Hugging Face Hub](https://github.com/huggingface/huggingface_hub), [tokenizers](https://github.com/huggingface/tokenizers) | téléchargement du modèle, tokenisation | Apache-2.0 |
| [NumPy](https://numpy.org/) | calcul | BSD-3-Clause |
| Python 3.11 | moteur compilé avec PyInstaller | PSF License |
| NVIDIA cuBLAS 12 et cuDNN 9 | calcul sur carte graphique | redistribués selon le CUDA Toolkit EULA et le cuDNN Software License Agreement de NVIDIA |
| [Figtree](https://github.com/erikdkennedy/figtree) | police de l'interface | SIL Open Font License 1.1 |
| [Instrument Serif](https://github.com/Instrument/instrument-serif) | police des titres | SIL Open Font License 1.1 |
| [MLX](https://github.com/ml-explore/mlx) / [mlx-whisper](https://github.com/ml-explore/mlx-examples) | transcription sur Mac (Apple Silicon) | MIT |
| Poids Whisper convertis par [mlx-community](https://huggingface.co/mlx-community/whisper-large-v3-turbo) | modèle sur Mac, téléchargé au premier lancement | MIT |

Les textes complets de licence des paquets Python sont fournis dans `resources\freeflow-stt\_internal\*.dist-info` du dossier installé.
