#!/usr/bin/env python3
"""
Visual quality and aesthetic scoring for video frames.
Uses OpenCV-based analysis (colorfulness, sharpness, contrast, brightness)
mapped to aesthetic dimensions without requiring PyTorch.
Usage: python3 aesthetic.py <video_path> [--frames N]
"""
import sys
import json
import os
import subprocess
import tempfile


def extract_frames(video_path: str, tmpdir: str, n_frames: int = 8) -> list:
    """Extract N evenly-spaced frames from video as JPEGs."""
    frames = []
    duration_cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", video_path
    ]
    try:
        dur_result = subprocess.run(duration_cmd, capture_output=True, text=True, timeout=15)
        duration = float(dur_result.stdout.strip() or "10")
    except Exception:
        duration = 10.0

    step = max(0.5, duration / (n_frames + 1))
    for i in range(n_frames):
        t = step * (i + 1)
        if t >= duration:
            break
        frame_path = os.path.join(tmpdir, f"frame_{i:03d}.jpg")
        cmd = [
            "ffmpeg", "-y", "-ss", str(round(t, 2)), "-i", video_path,
            "-frames:v", "1", "-q:v", "3", frame_path, "-loglevel", "error"
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode == 0 and os.path.exists(frame_path):
            frames.append(frame_path)

    return frames


def score_frame(img_path: str) -> dict:
    """Score a single frame for visual quality metrics."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return {}

    img = cv2.imread(img_path)
    if img is None:
        return {}

    h, w = img.shape[:2]

    # --- Sharpness (Laplacian variance) ---
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    sharpness = min(1.0, lap_var / 800.0)

    # --- Colorfulness (Hasler & Süsstrunk 2003) ---
    b, g, r = cv2.split(img.astype(np.float32))
    rg = r - g
    yb = 0.5 * (r + g) - b
    colorfulness = float(np.sqrt(rg.std()**2 + yb.std()**2) + 0.3 * np.sqrt(rg.mean()**2 + yb.mean()**2))
    colorfulness_norm = min(1.0, colorfulness / 120.0)

    # --- Brightness & exposure ---
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    value = hsv[:, :, 2].astype(np.float32) / 255.0
    mean_bright = float(value.mean())
    overexposed = float((value > 0.95).mean())
    underexposed = float((value < 0.05).mean())
    exposure_ok = 1.0 - min(1.0, (overexposed + underexposed) * 5)

    # --- Contrast (std of grayscale) ---
    contrast = min(1.0, float(gray.std()) / 80.0)

    # --- Motion blur detection (FFT-based) ---
    f = np.fft.fft2(gray)
    fshift = np.fft.fftshift(f)
    magnitude = np.abs(fshift)
    rows, cols = gray.shape
    center_r, center_c = rows // 2, cols // 2
    mask = np.zeros_like(magnitude)
    mask[center_r-15:center_r+15, center_c-15:center_c+15] = 1
    high_freq = magnitude * (1 - mask)
    blur_score = 1.0 - min(1.0, float(high_freq.mean()) / 50.0)
    blur_ok = 1.0 - blur_score

    # --- Face detection (bonus for faces present) ---
    face_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    has_faces = False
    face_count = 0
    if os.path.exists(face_cascade_path):
        face_cascade = cv2.CascadeClassifier(face_cascade_path)
        faces = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(30, 30))
        face_count = len(faces)
        has_faces = face_count > 0

    # --- Composite visual quality score ---
    visual_quality = (
        sharpness * 0.30 +
        colorfulness_norm * 0.20 +
        exposure_ok * 0.20 +
        contrast * 0.15 +
        blur_ok * 0.15
    )

    # --- Hook score heuristic (faces + colorful + sharp) ---
    hook_bonus = 0.15 if has_faces else 0.0
    hook_score = min(1.0, visual_quality * 0.7 + colorfulness_norm * 0.15 + hook_bonus + contrast * 0.15)

    return {
        "sharpness": round(sharpness, 4),
        "colorfulness": round(colorfulness_norm, 4),
        "exposure_ok": round(exposure_ok, 4),
        "contrast": round(contrast, 4),
        "blur_ok": round(blur_ok, 4),
        "mean_brightness": round(mean_bright, 4),
        "overexposed_ratio": round(overexposed, 4),
        "underexposed_ratio": round(underexposed, 4),
        "has_faces": has_faces,
        "face_count": face_count,
        "visual_quality": round(visual_quality, 4),
        "hook_score": round(hook_score, 4),
    }


def score_video(video_path: str, n_frames: int = 8) -> dict:
    """Score a video by averaging frame scores."""
    import numpy as np

    with tempfile.TemporaryDirectory() as tmpdir:
        frames = extract_frames(video_path, tmpdir, n_frames)
        if not frames:
            return {"error": "No frames extracted", "visual_quality": 0.5, "hook_score": 0.5}

        frame_scores = [score_frame(f) for f in frames]
        frame_scores = [s for s in frame_scores if s]

        if not frame_scores:
            return {"error": "Frame scoring failed", "visual_quality": 0.5, "hook_score": 0.5}

        keys = ["sharpness", "colorfulness", "exposure_ok", "contrast", "blur_ok",
                "mean_brightness", "visual_quality", "hook_score", "face_count"]

        averaged = {}
        for k in keys:
            vals = [s.get(k, 0) for s in frame_scores if k in s]
            averaged[k] = round(float(np.mean(vals)), 4) if vals else 0.0

        averaged["has_faces"] = any(s.get("has_faces", False) for s in frame_scores)
        averaged["max_face_count"] = max((s.get("face_count", 0) for s in frame_scores), default=0)
        averaged["frames_analyzed"] = len(frame_scores)
        averaged["frame_count"] = n_frames
        averaged["per_frame"] = frame_scores

        return averaged


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: aesthetic.py <video_path> [--frames N]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    n_frames = 8
    if "--frames" in sys.argv:
        try:
            n_frames = int(sys.argv[sys.argv.index("--frames") + 1])
        except Exception:
            pass

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    result = score_video(video_path, n_frames)
    print(json.dumps(result))
