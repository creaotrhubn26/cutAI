#!/usr/bin/env python3
"""
CNN-based shot boundary detector using MobileNetV2 ONNX feature extraction.

Architecture:
  1. Extract frames at configurable sample rate using OpenCV
  2. Push every sampled frame through pre-trained MobileNetV2 (ONNX Runtime)
     to get a 1000-dim semantic feature vector from the classifier layer
  3. Compute cosine DISSIMILARITY between consecutive frame feature vectors
  4. Adaptive thresholding: mu + k*sigma of the dissimilarity distribution
     (auto-calibrates per video — works for slow docs AND fast action equally)
  5. Filter adjacent cuts closer than min_scene_seconds (prevents micro-cuts)
  6. Return rich JSON: scene boundaries, per-boundary confidence, model metadata

Why CNN over FFmpeg histogram / PySceneDetect ContentDetector:
  - Histogram diff mistakes lighting changes in same scene for cuts
  - CNN features are semantic: forest->interview = high dissimilarity even with
    similar hue distributions; same room with different lighting = low dissimilarity
  - Adaptive threshold self-calibrates per video vs fixed global threshold

Fallback chain (automatic):
  MobileNetV2 ONNX (downloaded on first run, ~14MB) -> Multi-scale HSV+edge hybrid

Usage:
  python3 detect_scenes.py <video_path> [sensitivity] [frame_skip]
  sensitivity : 1-10 (default 5). Higher = more boundaries detected.
  frame_skip  : sample 1-in-N frames (default 4 = 7.5 FPS from 30fps source)
"""

import sys
import json
import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

# ─── Model storage ────────────────────────────────────────────────────────────

MODELS_DIR = Path(os.environ.get("CUTAI_MODELS_DIR", Path.home() / ".cutai" / "models"))
MODELS_DIR.mkdir(parents=True, exist_ok=True)

MOBILENET_ONNX_URL  = "https://github.com/onnx/models/raw/main/validated/vision/classification/mobilenet/model/mobilenetv2-12.onnx"
MOBILENET_ONNX_PATH = MODELS_DIR / "mobilenetv2-12.onnx"

# ImageNet channel mean/std for normalisation
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# ─── Model download ────────────────────────────────────────────────────────────

def download_model(url: str, dest: Path, timeout: int = 90) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CutAI/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            with open(dest, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded / total * 100
                        print(f"  Downloading MobileNetV2: {pct:.0f}% ({downloaded//1024}KB)", file=sys.stderr)
        return True
    except Exception as e:
        print(f"  Download failed: {e}", file=sys.stderr)
        if dest.exists():
            dest.unlink()
        return False

# ─── CNN feature extraction ────────────────────────────────────────────────────

def preprocess(frame_bgr: np.ndarray, size: int = 224) -> np.ndarray:
    """Resize, normalise, convert to NCHW float32 for MobileNetV2."""
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_LINEAR)
    norm = (resized.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
    return norm.transpose(2, 0, 1)[np.newaxis]   # (1, 3, H, W)

def cnn_features(session, frame_bgr: np.ndarray) -> np.ndarray:
    """Run frame through ONNX model; return L2-normalised feature vector."""
    tensor = preprocess(frame_bgr)
    inp    = session.get_inputs()[0].name
    out    = session.get_outputs()[0].name
    logits = session.run([out], {inp: tensor})[0].flatten().astype(np.float32)
    norm   = np.linalg.norm(logits)
    return logits / norm if norm > 1e-9 else logits

# ─── Fallback: multi-scale HSV + edge descriptor ──────────────────────────────

def hybrid_features(frame_bgr: np.ndarray) -> np.ndarray:
    """
    When ONNX is unavailable: HSV histogram (100 bins) + edge density (2 values).
    Substantially better than single-channel pixel diff; graceful CNN fallback.
    """
    small = cv2.resize(frame_bgr, (128, 72), interpolation=cv2.INTER_AREA)
    hsv   = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    h_h   = cv2.calcHist([hsv], [0], None, [36], [0, 180]).flatten()
    s_h   = cv2.calcHist([hsv], [1], None, [32], [0, 256]).flatten()
    v_h   = cv2.calcHist([hsv], [2], None, [32], [0, 256]).flatten()
    gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150).flatten().astype(np.float32)
    vec   = np.concatenate([h_h, s_h, v_h, [edges.mean(), edges.std()]]).astype(np.float32)
    norm  = np.linalg.norm(vec)
    return vec / norm if norm > 1e-9 else vec

# ─── Core detection ────────────────────────────────────────────────────────────

def cosine_dissim(a: np.ndarray, b: np.ndarray) -> float:
    return max(0.0, 1.0 - float(np.dot(a, b)))

def adaptive_threshold(dissims: list, sensitivity: float) -> float:
    """
    sensitivity [1, 10] maps to k [3.0, 0.5] in mean + k*std.
    Low sensitivity = only detect very obvious hard cuts.
    High sensitivity = detect subtle cuts and dissolves.
    """
    arr = np.array(dissims, dtype=np.float32)
    mu, sigma = float(arr.mean()), float(arr.std())
    k = 3.0 - (sensitivity - 1.0) * (2.5 / 9.0)
    return mu + k * sigma

def detect(
    video_path: str,
    sensitivity: float = 5.0,
    frame_skip: int = 4,
    min_scene_secs: float = 0.4,
    session=None,
    use_cnn: bool = False,
) -> dict:

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": f"Cannot open: {video_path}", "sceneCount": 0, "scenes": []}

    fps          = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration     = total_frames / fps
    min_gap      = max(1, int(min_scene_secs * fps / frame_skip))

    feats, times = [], []
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % frame_skip == 0:
            feats.append(cnn_features(session, frame) if (use_cnn and session) else hybrid_features(frame))
            times.append(idx / fps)
        idx += 1
    cap.release()

    if len(feats) < 2:
        return {
            "sceneCount": 1,
            "scenes": [{"sceneIndex": 0, "startTime": 0.0, "endTime": round(duration, 3),
                        "duration": round(duration, 3), "startFrame": 0,
                        "endFrame": total_frames, "confidence": 1.0}],
            "duration": round(duration, 3), "fps": round(fps, 3),
            "model": "mobilenetv2-cnn" if use_cnn else "hybrid-hsv-edge",
        }

    dissims = [cosine_dissim(feats[i], feats[i + 1]) for i in range(len(feats) - 1)]
    thresh  = adaptive_threshold(dissims, sensitivity)

    # Collect boundary times AND their boundary dissimilarity values
    cuts      = [0.0]
    cut_dissims = [thresh]   # scene 0 always gets neutral confidence
    last = 0
    for i, d in enumerate(dissims):
        if d > thresh and (i - last) >= min_gap:
            cuts.append(times[i + 1])
            cut_dissims.append(d)   # store the actual boundary dissimilarity
            last = i
    cuts.append(duration)
    cut_dissims.append(thresh)

    scenes = []
    for i in range(len(cuts) - 1):
        start, end = cuts[i], cuts[i + 1]
        dur = end - start
        if dur < 0.1:
            continue

        # Confidence = how much boundary dissimilarity exceeds threshold, scaled 0-1
        raw_d = cut_dissims[i] if i < len(cut_dissims) else thresh
        conf  = min(1.0, max(0.0, (raw_d - thresh) / max(thresh, 1e-6)))

        scenes.append({
            "sceneIndex": len(scenes),
            "startTime":  round(start, 3),
            "endTime":    round(end, 3),
            "duration":   round(dur, 3),
            "startFrame": round(start * fps),
            "endFrame":   round(end * fps),
            "confidence": round(float(conf), 3),
        })

    return {
        "sceneCount":        len(scenes),
        "scenes":            scenes,
        "duration":          round(duration, 3),
        "fps":               round(fps, 3),
        "framesAnalysed":    len(feats),
        "threshold":         round(float(thresh), 4),
        "dissimilarityMean": round(float(np.mean(dissims)), 4),
        "dissimilaritySd":   round(float(np.std(dissims)), 4),
        "model":             "mobilenetv2-cnn" if use_cnn else "hybrid-hsv-edge",
        "sensitivity":       sensitivity,
    }

# ─── Entry point ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect_scenes.py <video_path> [sensitivity 1-10] [frame_skip]"}))
        sys.exit(1)

    video_path  = sys.argv[1]
    raw_thresh  = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    frame_skip  = int(sys.argv[3]) if len(sys.argv) > 3 else 4

    # Legacy compat: old callers pass PySceneDetect threshold (e.g. 27).
    # Remap values > 10 into [1, 10] sensitivity scale.
    if raw_thresh > 10:
        sensitivity = max(1.0, min(10.0, 10.0 - (raw_thresh - 10.0) * 0.15))
    else:
        sensitivity = max(1.0, min(10.0, raw_thresh))

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    # ── Try to load ONNX / MobileNetV2 ──────────────────────────────────────
    session  = None
    use_cnn  = False
    model_info = "hybrid-hsv-edge"

    try:
        import onnxruntime as ort

        if not MOBILENET_ONNX_PATH.exists():
            print("  First run: downloading MobileNetV2 CNN model (~14 MB)...", file=sys.stderr)
            ok = download_model(MOBILENET_ONNX_URL, MOBILENET_ONNX_PATH)
            if not ok:
                raise RuntimeError("Download failed")

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 2
        opts.intra_op_num_threads = 4
        opts.log_severity_level   = 3   # suppress ONNX Runtime info logs
        session  = ort.InferenceSession(
            str(MOBILENET_ONNX_PATH),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        use_cnn    = True
        model_info = "mobilenetv2-cnn"
        print("  ResNet/MobileNetV2 loaded — CNN semantic feature extraction active", file=sys.stderr)

    except Exception as e:
        print(f"  ONNX unavailable ({e}) — using HSV+edge hybrid fallback", file=sys.stderr)

    result = detect(
        video_path,
        sensitivity=sensitivity,
        frame_skip=frame_skip,
        session=session,
        use_cnn=use_cnn,
    )
    result["videoPath"] = video_path   # backward-compat field

    print(json.dumps(result))


if __name__ == "__main__":
    main()
