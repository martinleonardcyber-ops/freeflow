"""Build the OxoFlow STT sidecar with PyInstaller (onedir) and copy the CUDA 12
runtime DLLs (cuBLAS + cuDNN 9 from the nvidia-* pip wheels) next to it, so the
packaged exe runs on the GPU on a machine without Python or the CUDA toolkit.

Usage:  python stt/build_stt.py [--no-cuda]
Output: stt/dist/freeflow-stt/freeflow-stt.exe  (+ _internal/cuda/*.dll)
"""
import glob
import importlib.util
import os
import shutil
import site
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
BUILD = os.path.join(HERE, "build")
APP = os.path.join(DIST, "freeflow-stt")

# cuDNN sub-libraries CTranslate2 actually needs for Whisper (conv1d in the
# encoder); cudnn_adv (RNNs) is skipped to save ~100 MB.
CUDA_DLLS = [
    "cublas64_12.dll", "cublasLt64_12.dll",
    "cudnn_graph64_9.dll", "cudnn_ops64_9.dll", "cudnn_cnn64_9.dll",
    "cudnn_engines_precompiled64_9.dll", "cudnn_engines_runtime_compiled64_9.dll",
    "cudnn_heuristic64_9.dll",
]


def site_dirs():
    return list(site.getsitepackages()) + [site.getusersitepackages()]


def find_in_site(rel_glob):
    for root in site_dirs():
        hits = glob.glob(os.path.join(root, rel_glob))
        if hits:
            return hits
    return []


def main():
    no_cuda = "--no-cuda" in sys.argv
    t0 = time.time()
    cmd = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "freeflow-stt", "--distpath", DIST, "--workpath", BUILD, "--specpath", HERE,
        "--console",
        "--collect-all", "faster_whisper",
        "--collect-all", "ctranslate2",
        "--collect-all", "onnxruntime",
        "--collect-all", "av",
        "--collect-all", "tokenizers",
        # huggingface_hub imports hf_xet dynamically (faster model downloads): include it explicitly.
        *(["--collect-all", "hf_xet"] if importlib.util.find_spec("hf_xet") else []),
        "--collect-submodules", "huggingface_hub",
        "--hidden-import", "numpy",
    ]
    # Packages pulled in transitively but never used at runtime (saves ~200 MB).
    for mod in ("torch", "torchaudio", "matplotlib", "tkinter", "PIL", "scipy", "pandas",
                "rapidocr_onnxruntime", "sounddevice", "IPython", "jedi", "pytest", "nvidia",
                "numba", "llvmlite", "pyarrow", "pydantic", "pydantic_core", "cryptography",
                "win32com", "pythonwin", "pywin32", "win32api", "zstandard", "tzdata",
                "cv2", "sklearn", "sympy", "psutil"):
        cmd += ["--exclude-module", mod]
    # delvewheel-patched PyAV loads its FFmpeg DLLs from <site>/av.libs -> ship as _internal/av.libs
    for d in find_in_site("av.libs"):
        cmd += ["--add-data", f"{d}{os.pathsep}av.libs"]
    cmd.append(os.path.join(HERE, "stt_server.py"))
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=HERE)

    if not no_cuda:
        dst = os.path.join(APP, "_internal", "cuda")
        os.makedirs(dst, exist_ok=True)
        copied = []
        for name in CUDA_DLLS:
            src = find_in_site(os.path.join("nvidia", "*", "bin", name))
            if src:
                shutil.copy2(src[0], os.path.join(dst, name))
                copied.append(name)
            else:
                print("!! missing", name, "(pip install nvidia-cublas-cu12 nvidia-cudnn-cu12)")
        total = sum(os.path.getsize(os.path.join(dst, n)) for n in copied) / 1e6
        print(f"CUDA DLLs copied: {len(copied)}/{len(CUDA_DLLS)} ({total:.0f} MB) -> {dst}")

    # --collect-all copies stray __pycache__ folders from site-packages; their .pyc
    # embed the build machine's absolute paths (user name) and are never imported.
    for root, dirs, _ in os.walk(APP, topdown=False):
        for d in dirs:
            if d == "__pycache__":
                shutil.rmtree(os.path.join(root, d), ignore_errors=True)

    # onnxruntime extras (model tools, transformer / quantization scripts) are never
    # imported (the VAD only needs InferenceSession) and hold the deepest paths of the
    # app, too close to Windows' 260-character limit once installed.
    for sub in ("tools", "transformers", "quantization"):
        shutil.rmtree(os.path.join(APP, "_internal", "onnxruntime", sub), ignore_errors=True)

    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(APP) for f in fs) / 1e6
    print(f"done in {time.time() - t0:.0f}s, {APP} = {size:.0f} MB")


if __name__ == "__main__":
    main()
