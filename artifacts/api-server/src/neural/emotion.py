#!/usr/bin/env python3
"""
Facial emotion recognition using HSEmotion ONNX.
Predicts valence, arousal, and 8-class discrete emotions from video frames.
Usage: python3 emotion.py <video_path> [--frames N]
"""
import sys
import json
import os
import subprocess
import tempfile


EMOTION_LABELS = ["Anger", "Contempt", "Disgust", "Fear", "Happiness", "Neutral", "Sadness", "Surprise"]


def extract_frames(video_path: str, tmpdir: str, n_frames: int = 6) -> list:
    """Extract evenly-spaced frames from video."""
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
            frames.append((t, frame_path))

    return frames


def analyze_emotion_hsemotion(frame_path: str) -> dict | None:
    """Use HSEmotion ONNX to predict facial emotions."""
    try:
        import cv2
        from hsemotion_onnx.facial_emotions import HSEmotionRecognizer
    except ImportError as e:
        return None

    img = cv2.imread(frame_path)
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    face_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"

    if not os.path.exists(face_cascade_path):
        return None

    face_cascade = cv2.CascadeClassifier(face_cascade_path)
    faces = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(40, 40))

    if len(faces) == 0:
        return None

    try:
        fer = HSEmotionRecognizer(model_name="enet_b0_8_best_afew", device="cpu")
    except Exception as e:
        try:
            fer = HSEmotionRecognizer(model_name="enet_b0_8_va_mtl", device="cpu")
        except Exception:
            return None

    best_result = None
    largest_face_area = 0

    for (x, y, w, h) in faces:
        face_area = w * h
        face_img = img[y:y+h, x:x+w]

        try:
            emotion, scores = fer.predict_emotions(face_img, logits=False)

            score_dict = {}
            for i, label in enumerate(EMOTION_LABELS):
                if i < len(scores):
                    score_dict[label.lower()] = round(float(scores[i]), 4)

            valence = score_dict.get("happiness", 0) - score_dict.get("sadness", 0) * 0.7 - score_dict.get("anger", 0) * 0.5 - score_dict.get("disgust", 0) * 0.3
            arousal = score_dict.get("anger", 0) * 0.8 + score_dict.get("fear", 0) * 0.7 + score_dict.get("happiness", 0) * 0.6 + score_dict.get("surprise", 0) * 0.5 - score_dict.get("neutral", 0) * 0.3

            valence = max(-1.0, min(1.0, valence))
            arousal = max(0.0, min(1.0, arousal))

            result = {
                "emotion": emotion,
                "scores": score_dict,
                "valence": round(valence, 4),
                "arousal": round(arousal, 4),
                "face_bbox": [int(x), int(y), int(w), int(h)],
            }

            if face_area > largest_face_area:
                largest_face_area = face_area
                best_result = result

        except Exception as e:
            continue

    return best_result


def analyze_emotion_opencv_only(frame_path: str) -> dict | None:
    """Fallback: OpenCV face detection only, return existence signal."""
    try:
        import cv2
    except ImportError:
        return None

    img = cv2.imread(frame_path)
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    face_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"

    if not os.path.exists(face_cascade_path):
        return None

    face_cascade = cv2.CascadeClassifier(face_cascade_path)
    faces = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(40, 40))

    if len(faces) == 0:
        return None

    return {
        "emotion": "neutral",
        "scores": {"neutral": 1.0},
        "valence": 0.0,
        "arousal": 0.3,
        "face_bbox": [int(x) for x in faces[0]],
        "method": "opencv_only",
    }


def analyze_video_emotions(video_path: str, n_frames: int = 6) -> dict:
    """Analyze emotions across video frames."""
    import numpy as np

    with tempfile.TemporaryDirectory() as tmpdir:
        frames = extract_frames(video_path, tmpdir, n_frames)

        if not frames:
            return {
                "emotion_score": 0.5,
                "valence": 0.0,
                "arousal": 0.3,
                "face_detected": False,
                "dominant_emotion": "unknown",
                "frames_analyzed": 0,
            }

        frame_results = []
        for (t, frame_path) in frames:
            result = analyze_emotion_hsemotion(frame_path)
            if result is None:
                result = analyze_emotion_opencv_only(frame_path)
            if result:
                result["timestamp"] = round(t, 2)
                frame_results.append(result)

        if not frame_results:
            return {
                "emotion_score": 0.5,
                "valence": 0.0,
                "arousal": 0.3,
                "face_detected": False,
                "dominant_emotion": "no_face",
                "frames_analyzed": len(frames),
            }

        valences = [r["valence"] for r in frame_results]
        arousals = [r["arousal"] for r in frame_results]
        emotions = [r["emotion"] for r in frame_results]

        mean_valence = float(np.mean(valences))
        mean_arousal = float(np.mean(arousals))

        emotion_counts = {}
        for e in emotions:
            emotion_counts[e] = emotion_counts.get(e, 0) + 1
        dominant_emotion = max(emotion_counts, key=emotion_counts.get)

        emotion_score = (mean_valence + 1.0) / 2.0 * 0.5 + mean_arousal * 0.5
        emotion_score = max(0.0, min(1.0, emotion_score))

        return {
            "emotion_score": round(emotion_score, 4),
            "valence": round(mean_valence, 4),
            "arousal": round(mean_arousal, 4),
            "face_detected": True,
            "dominant_emotion": dominant_emotion,
            "emotion_distribution": emotion_counts,
            "frames_with_faces": len(frame_results),
            "frames_analyzed": len(frames),
            "frame_results": frame_results,
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: emotion.py <video_path> [--frames N]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    n_frames = 6
    if "--frames" in sys.argv:
        try:
            n_frames = int(sys.argv[sys.argv.index("--frames") + 1])
        except Exception:
            pass

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    result = analyze_video_emotions(video_path, n_frames)
    print(json.dumps(result))
