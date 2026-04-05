#!/usr/bin/env python3
"""
Visual diversity scoring using perceptual hashing and histogram comparison.
Detects repeated/near-duplicate footage and scene similarity.
Usage: python3 diversity.py <video_path> [--frames N]
"""
import sys
import json
import os
import subprocess
import tempfile


def extract_frames(video_path: str, tmpdir: str, n_frames: int = 12) -> list:
    """Extract evenly-spaced frames."""
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
            "-frames:v", "1", "-vf", "scale=128:128", "-q:v", "5", frame_path,
            "-loglevel", "error"
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode == 0 and os.path.exists(frame_path):
            frames.append((round(t, 2), frame_path))

    return frames


def phash(img_gray):
    """Compute perceptual hash of a grayscale image."""
    import cv2
    import numpy as np
    resized = cv2.resize(img_gray, (32, 32))
    dct = cv2.dct(resized.astype(np.float32))
    dct_low = dct[:8, :8]
    med = float(np.median(dct_low))
    hash_bits = (dct_low > med).flatten().tolist()
    return hash_bits


def hamming_distance(h1, h2):
    """Hamming distance between two hash bit arrays."""
    return sum(a != b for a, b in zip(h1, h2))


def compute_color_histogram(img_bgr):
    """Compute normalized color histogram for similarity comparison."""
    import cv2
    import numpy as np
    hist_r = cv2.calcHist([img_bgr], [2], None, [16], [0, 256]).flatten()
    hist_g = cv2.calcHist([img_bgr], [1], None, [16], [0, 256]).flatten()
    hist_b = cv2.calcHist([img_bgr], [0], None, [16], [0, 256]).flatten()
    hist = np.concatenate([hist_r, hist_g, hist_b])
    hist = hist / (hist.sum() + 1e-8)
    return hist


def analyze_diversity(video_path: str, n_frames: int = 12) -> dict:
    """
    Analyze visual diversity of a video.
    Returns:
    - diversity_score: 0-1 (1 = very diverse footage, 0 = repetitive)
    - similarity_pairs: timestamps of very similar frames
    - scene_count_estimate: estimated number of distinct scenes
    """
    try:
        import cv2
        import numpy as np
    except ImportError as e:
        return {"error": f"OpenCV not available: {e}", "diversity_score": 0.5}

    with tempfile.TemporaryDirectory() as tmpdir:
        frames = extract_frames(video_path, tmpdir, n_frames)

        if len(frames) < 2:
            return {"diversity_score": 1.0, "scene_count_estimate": 1, "frames_analyzed": len(frames)}

        frame_data = []
        for (t, frame_path) in frames:
            img = cv2.imread(frame_path)
            if img is None:
                continue
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            ph = phash(gray)
            hist = compute_color_histogram(img)
            frame_data.append({"t": t, "hash": ph, "hist": hist})

        if len(frame_data) < 2:
            return {"diversity_score": 1.0, "scene_count_estimate": 1}

        n = len(frame_data)
        similarity_pairs = []
        all_distances = []

        for i in range(n):
            for j in range(i + 1, n):
                ham = hamming_distance(frame_data[i]["hash"], frame_data[j]["hash"])
                ham_norm = ham / 64.0

                hist_sim = float(np.sum(np.minimum(frame_data[i]["hist"], frame_data[j]["hist"])))
                hist_dist = 1.0 - hist_sim

                combined = ham_norm * 0.5 + hist_dist * 0.5
                all_distances.append(combined)

                if combined < 0.25:
                    similarity_pairs.append({
                        "t1": frame_data[i]["t"],
                        "t2": frame_data[j]["t"],
                        "similarity": round(1.0 - combined, 4),
                    })

        mean_dist = float(np.mean(all_distances)) if all_distances else 0.5
        diversity_score = min(1.0, mean_dist * 2.0)

        scene_changes = 0
        for i in range(len(frame_data) - 1):
            ham = hamming_distance(frame_data[i]["hash"], frame_data[i+1]["hash"])
            if ham > 15:
                scene_changes += 1

        scene_count_estimate = scene_changes + 1

        return {
            "diversity_score": round(diversity_score, 4),
            "mean_frame_distance": round(mean_dist, 4),
            "scene_count_estimate": scene_count_estimate,
            "similarity_pairs": similarity_pairs[:10],
            "has_repeated_footage": len(similarity_pairs) > 0,
            "repeated_count": len(similarity_pairs),
            "frames_analyzed": len(frame_data),
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: diversity.py <video_path> [--frames N]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    n_frames = 12
    if "--frames" in sys.argv:
        try:
            n_frames = int(sys.argv[sys.argv.index("--frames") + 1])
        except Exception:
            pass

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    result = analyze_diversity(video_path, n_frames)
    print(json.dumps(result))
