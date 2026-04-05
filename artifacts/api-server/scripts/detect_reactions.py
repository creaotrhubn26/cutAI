#!/usr/bin/env python3
"""
detect_reactions.py — Emotion-based reaction shot detector using HSEmotion ONNX

Identifies laughing, shocked, angry, disgusted and nodding moments in talking-head
footage.  These moments can be injected as cutaways in the final edit.

Usage:
    python3 detect_reactions.py <video_path> [--fps N] [--threshold F] [--grace F]

Output: JSON on stdout
    {
      "reaction_moments": [{"type": "laughing", "start": 3.2, "end": 4.1,
                            "duration": 0.9, "peak_score": 0.71}, ...],
      "total_reactions": 3,
      "avg_emotions": {"happiness": 0.12, "surprise": 0.05, ...},
      "dominant_emotion": "neutral",
      "frames_analyzed": 48,
      "duration": 27.4,
      "model": "hsemotion_onnx/enet_b0_8_best_vgaf"
    }
"""

import sys
import json
import argparse

import cv2
import numpy as np


EMOTIONS_8 = ["Anger", "Contempt", "Disgust", "Fear", "Happiness", "Neutral", "Sadness", "Surprise"]

REACTION_MAP = {
    "laughing":  "happiness",
    "shocked":   "surprise",
    "angry":     "anger",
    "disgusted": "disgust",
    "fearful":   "fear",
}


def load_face_cascade():
    return cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )


def detect_face(gray, cascade, min_size=(60, 60)):
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5,
        minSize=min_size, flags=cv2.CASCADE_SCALE_IMAGE
    )
    if len(faces) == 0:
        return None
    return max(faces, key=lambda f: f[2] * f[3])


def cosine_similarity_emotion(scores, emotion_key):
    return scores.get(emotion_key.lower(), 0.0)


def detect_nod(y_history, min_alternations=2, min_avg_delta=6.0):
    """Return (is_nodding, confidence) from a list of face-center Y positions."""
    if len(y_history) < 3:
        return False, 0.0
    deltas = [abs(y_history[i] - y_history[i - 1]) for i in range(1, len(y_history))]
    avg_delta = sum(deltas) / len(deltas) if deltas else 0
    alternations = sum(
        1 for i in range(1, len(y_history) - 1)
        if (y_history[i] - y_history[i - 1]) * (y_history[i + 1] - y_history[i]) < 0
    )
    is_nod = alternations >= min_alternations and avg_delta >= min_avg_delta
    confidence = min(0.85, avg_delta / 20.0) if is_nod else 0.0
    return is_nod, confidence


def analyze(video_path, fps=4.0, threshold=0.35, grace=0.5):
    # ── Load HSEmotion ────────────────────────────────────────────────────────
    try:
        from hsemotion_onnx.facial_emotions import HSEmotionRecognizer
        recognizer = HSEmotionRecognizer(model_name="enet_b0_8_best_vgaf")
    except Exception as e:
        return {"error": f"hsemotion_onnx unavailable: {e}", "model": "none"}

    cascade = load_face_cascade()

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": f"Cannot open video: {video_path}"}

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / video_fps if video_fps > 0 else 0

    frame_interval = max(1, int(round(video_fps / fps)))

    # ── Per-frame analysis ────────────────────────────────────────────────────
    frame_records = []   # {ts, face, emotion, scores, face_y}
    y_window = []        # recent face-center Y values (for nod detection)
    NOD_WINDOW = 8       # look-back window for nodding

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            ts = frame_idx / video_fps
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            face = detect_face(gray, cascade)

            if face is not None:
                x, y, w, h = face
                face_roi = frame[y: y + h, x: x + w]
                face_center_y = float(y + h / 2)

                try:
                    emotion_label, scores_arr = recognizer.predict_emotions(
                        face_roi, logits=False
                    )
                    scores = {
                        EMOTIONS_8[i].lower(): float(scores_arr[i])
                        for i in range(len(scores_arr))
                    }
                except Exception:
                    emotion_label = "neutral"
                    scores = {e.lower(): 0.0 for e in EMOTIONS_8}
                    scores["neutral"] = 1.0

                y_window.append(face_center_y)
                if len(y_window) > NOD_WINDOW:
                    y_window.pop(0)

                frame_records.append({
                    "ts": ts,
                    "face": True,
                    "emotion": emotion_label.lower() if emotion_label else "neutral",
                    "scores": scores,
                    "face_y": face_center_y,
                })
            else:
                y_window.clear()
                frame_records.append({"ts": ts, "face": False})

        frame_idx += 1

    cap.release()

    if not frame_records:
        return {
            "reaction_moments": [],
            "total_reactions": 0,
            "avg_emotions": {},
            "dominant_emotion": "neutral",
            "frames_analyzed": 0,
            "duration": round(duration, 3),
            "model": "hsemotion_onnx/enet_b0_8_best_vgaf",
        }

    # ── Label each frame with a reaction type ─────────────────────────────────
    labeled = []  # None | {"ts", "reaction", "score"}

    # Re-build y-history per frame for nod detection
    y_history_accum = []

    for fd in frame_records:
        if not fd.get("face"):
            y_history_accum.clear()
            labeled.append(None)
            continue

        scores = fd.get("scores", {})
        y_history_accum.append(fd["face_y"])
        if len(y_history_accum) > NOD_WINDOW:
            y_history_accum.pop(0)

        # Check emotion reactions
        best_reaction = None
        best_score = threshold  # must exceed threshold

        for rtype, emo_key in REACTION_MAP.items():
            s = scores.get(emo_key, 0.0)
            if s > best_score:
                best_score = s
                best_reaction = rtype

        # Nod detection (only if no emotion reaction)
        if best_reaction is None and len(y_history_accum) >= 4:
            is_nod, nod_conf = detect_nod(y_history_accum)
            if is_nod:
                best_reaction = "nodding"
                best_score = nod_conf

        if best_reaction:
            labeled.append({"ts": fd["ts"], "reaction": best_reaction, "score": best_score, "scores": scores})
        else:
            labeled.append(None)

    # ── Merge nearby frames into moments ──────────────────────────────────────
    grace_frames = max(1, int(round(grace * fps)))
    moments = []
    current = None
    last_hit_idx = -999

    for i, lf in enumerate(labeled):
        if lf and lf["reaction"]:
            gap = i - last_hit_idx

            if current and current["type"] == lf["reaction"] and gap <= grace_frames:
                # Extend
                current["end"] = lf["ts"]
                current["peak_score"] = max(current["peak_score"], lf["score"])
                current["frame_count"] += 1
            else:
                if current:
                    moments.append(current)
                current = {
                    "type": lf["reaction"],
                    "start": lf["ts"],
                    "end": lf["ts"],
                    "peak_score": lf["score"],
                    "frame_count": 1,
                    # Accumulate emotion distribution for this moment
                    "_scores_sum": {k: v for k, v in lf["scores"].items()},
                    "_n": 1,
                }

            last_hit_idx = i

        else:
            if current and (i - last_hit_idx) > grace_frames:
                moments.append(current)
                current = None

    if current:
        moments.append(current)

    # ── Finalise moments ──────────────────────────────────────────────────────
    MIN_DURATION = 0.25  # seconds
    final_moments = []
    for m in moments:
        dur = m["end"] - m["start"]
        if dur < MIN_DURATION:
            continue

        avg_emo = {}
        ss = m.pop("_scores_sum", {})
        n = m.pop("_n", 1)
        for k, v in ss.items():
            avg_emo[k] = round(v / n, 4)

        final_moments.append({
            "type": m["type"],
            "start": round(m["start"], 3),
            "end": round(m["end"], 3),
            "duration": round(dur, 3),
            "peak_score": round(m["peak_score"], 4),
            "avg_emotions": avg_emo,
        })

    # ── Overall emotion distribution ──────────────────────────────────────────
    face_records = [fd for fd in frame_records if fd.get("face")]
    avg_emotions = {}
    if face_records:
        for emo in [e.lower() for e in EMOTIONS_8]:
            vals = [fd["scores"].get(emo, 0.0) for fd in face_records if "scores" in fd]
            avg_emotions[emo] = round(sum(vals) / len(vals), 4) if vals else 0.0

    dominant_emotion = max(avg_emotions, key=avg_emotions.get) if avg_emotions else "neutral"

    return {
        "reaction_moments": final_moments,
        "total_reactions": len(final_moments),
        "avg_emotions": avg_emotions,
        "dominant_emotion": dominant_emotion,
        "frames_analyzed": len(face_records),
        "duration": round(duration, 3),
        "model": "hsemotion_onnx/enet_b0_8_best_vgaf",
    }


def main():
    parser = argparse.ArgumentParser(description="Detect reaction shots in video")
    parser.add_argument("video_path", help="Path to input video file")
    parser.add_argument("--fps", type=float, default=4.0,
                        help="Frames per second to sample (default 4)")
    parser.add_argument("--threshold", type=float, default=0.35,
                        help="Emotion confidence threshold 0-1 (default 0.35)")
    parser.add_argument("--grace", type=float, default=0.5,
                        help="Grace period in seconds to bridge nearby reactions")
    args = parser.parse_args()

    result = analyze(args.video_path, fps=args.fps,
                     threshold=args.threshold, grace=args.grace)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
