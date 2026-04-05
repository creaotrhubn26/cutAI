#!/usr/bin/env python3
"""
Face-based shot analysis with subject tracking persistence.

Implements two features:
  Feature 3 — Subject tracking persistence
    Track when subject exits frame; mark those windows as "do not cut"
    until the subject returns (continuity-aware trimming).

  Feature 6 — Auto-detect talking-head vs B-roll
    Classify each clip by face-presence density over time:
      talking_head : face present >= 55% of sampled frames
      mixed        : face present 20–55%
      b_roll       : face present < 20%

Algorithm:
  1. Extract frames at sample_fps (default 2 fps) with OpenCV
  2. Run both frontal-face + profile-face Haar cascades per frame
     (profile catches side-on interviewees that frontal misses)
  3. Apply 1-second temporal smoothing window to handle blinks /
     momentary look-aways — prevents spurious absence events
  4. Group smoothed results into subject segments (contiguous
     present/absent blocks)
  5. Apply grace period (default 1.5 s): a subject is still
     considered "present" for grace_seconds after face disappears —
     this is the continuity buffer that prevents premature cuts
  6. Build safe-cut-windows: periods where subject has been
     continuously present for > min_presence_before_cut seconds
  7. Output JSON with full timeline, segments, classification, and
     continuity-aware cut recommendations

Usage:
  python3 analyze_faces.py <video_path> [sample_fps] [grace_seconds]
  video_path    : path to video file
  sample_fps    : frames per second to analyse (default 2.0)
  grace_seconds : continuity grace period in seconds (default 1.5)
"""

import sys
import json
import os
import math

import cv2
import numpy as np

# ─── Constants ────────────────────────────────────────────────────────────────

CASCADE_DIR = cv2.data.haarcascades

# Primary: frontal face (works for on-camera interviews)
FRONTAL_XML  = os.path.join(CASCADE_DIR, "haarcascade_frontalface_default.xml")
# Secondary: profile face (catches side-on, 3/4-angle shots)
PROFILE_XML  = os.path.join(CASCADE_DIR, "haarcascade_profileface.xml")
# Alt: higher-recall frontal variant
FRONTAL_ALT2 = os.path.join(CASCADE_DIR, "haarcascade_frontalface_alt2.xml")

# Shot classification thresholds
THRESHOLD_TALKING_HEAD = 0.55   # >= 55% frames with face → talking_head
THRESHOLD_BROLL        = 0.20   # < 20% frames with face  → b_roll

# ─── Face detector ────────────────────────────────────────────────────────────

class MultiCascadeDetector:
    """
    Combines frontal + profile Haar cascade detections.
    Returns list of (x, y, w, h) for all faces found in a frame.
    """
    def __init__(self):
        self.frontal  = cv2.CascadeClassifier(FRONTAL_XML)
        self.frontal2 = cv2.CascadeClassifier(FRONTAL_ALT2)
        self.profile  = cv2.CascadeClassifier(PROFILE_XML)

    def detect(self, frame: np.ndarray, min_face_pct: float = 0.03) -> list:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        min_size = (int(w * min_face_pct), int(h * min_face_pct))

        results = []

        for cascade in (self.frontal, self.frontal2):
            faces = cascade.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=4,
                minSize=min_size,
                flags=cv2.CASCADE_SCALE_IMAGE,
            )
            if len(faces):
                results.extend(faces.tolist())

        # Profile (flip for right-facing profiles)
        for flip in (False, True):
            g = cv2.flip(gray, 1) if flip else gray
            faces = self.profile.detectMultiScale(
                g, scaleFactor=1.1, minNeighbors=4, minSize=min_size,
            )
            if len(faces):
                results.extend(faces.tolist())

        # Deduplicate overlapping detections
        return self._nms(results, iou_threshold=0.4)

    @staticmethod
    def _nms(boxes: list, iou_threshold: float = 0.4) -> list:
        """Non-maximum suppression: remove heavily overlapping boxes."""
        if not boxes:
            return []
        boxes = sorted(boxes, key=lambda b: b[2] * b[3], reverse=True)
        kept = []
        for box in boxes:
            x1, y1, w1, h1 = box
            dominated = False
            for kx, ky, kw, kh in kept:
                # IoU
                ix = max(0, min(x1+w1, kx+kw) - max(x1, kx))
                iy = max(0, min(y1+h1, ky+kh) - max(y1, ky))
                inter = ix * iy
                union = w1*h1 + kw*kh - inter
                if union > 0 and inter / union > iou_threshold:
                    dominated = True
                    break
            if not dominated:
                kept.append(box)
        return kept


# ─── Temporal smoothing ────────────────────────────────────────────────────────

def smooth_presence(raw: list[bool], window_secs: float, sample_fps: float) -> list[bool]:
    """
    Median filter over a rolling window to suppress blink-level false absences.
    window_secs : half-width of the smoothing window in seconds
    """
    k = max(1, int(window_secs * sample_fps))
    n = len(raw)
    smoothed = []
    for i in range(n):
        lo = max(0, i - k)
        hi = min(n, i + k + 1)
        window = raw[lo:hi]
        # Present if majority vote says present
        smoothed.append(sum(window) >= len(window) / 2)
    return smoothed


# ─── Segment builder ──────────────────────────────────────────────────────────

def build_segments(presence: list[bool], times: list[float]) -> list[dict]:
    """Group consecutive same-state frames into segments."""
    if not presence:
        return []
    segments = []
    cur_state = presence[0]
    cur_start = times[0]

    for i in range(1, len(presence)):
        if presence[i] != cur_state:
            segments.append({
                "start":           round(cur_start, 3),
                "end":             round(times[i - 1], 3),
                "subjectPresent":  cur_state,
                "duration":        round(times[i - 1] - cur_start, 3),
            })
            cur_state  = presence[i]
            cur_start  = times[i]

    segments.append({
        "start":          round(cur_start, 3),
        "end":            round(times[-1], 3),
        "subjectPresent": cur_state,
        "duration":       round(times[-1] - cur_start, 3),
    })
    return segments


# ─── Continuity-aware cut windows ─────────────────────────────────────────────

def build_safe_cut_windows(
    segments: list[dict],
    grace_seconds: float,
    min_presence_before_cut: float = 1.0,
) -> list[dict]:
    """
    Returns windows that are SAFE for the editor to place a cut.

    Rules:
    - A cut is SAFE only while subject is continuously present
    - After subject exits: no cuts for grace_seconds (the "don't cut" buffer)
    - If subject re-enters within grace_seconds → resume safe-cut window
    - If subject is absent > grace_seconds → mark as B-roll gap (cuts allowed again)
    - First min_presence_before_cut seconds after re-entry are still unsafe
      (avoid cutting immediately after subject returns)
    """
    windows = []
    for seg in segments:
        if not seg["subjectPresent"]:
            if seg["duration"] > grace_seconds:
                # Long absence — safe to cut here (treat as B-roll interlude)
                windows.append({
                    "start":   round(seg["start"] + grace_seconds, 3),
                    "end":     round(seg["end"], 3),
                    "type":    "broll-gap",
                    "safeToCut": True,
                })
            # Short absence (< grace_seconds): no safe cuts — subject is "still present"
        else:
            # Subject is present — safe to cut after min_presence_before_cut
            safe_start = seg["start"] + min_presence_before_cut
            if safe_start < seg["end"]:
                windows.append({
                    "start":     round(safe_start, 3),
                    "end":       round(seg["end"], 3),
                    "type":      "subject-present",
                    "safeToCut": True,
                })
    return windows


# ─── Core analysis ────────────────────────────────────────────────────────────

def analyze(
    video_path: str,
    sample_fps: float = 2.0,
    grace_seconds: float = 1.5,
    smoothing_window: float = 0.75,
) -> dict:

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": f"Cannot open video: {video_path}"}

    src_fps      = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration     = total_frames / src_fps
    frame_step   = max(1, int(src_fps / sample_fps))

    detector = MultiCascadeDetector()

    raw_presence:  list[bool]  = []
    face_counts:   list[int]   = []
    face_areas:    list[float] = []   # max face area as % of frame
    frame_times:   list[float] = []

    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx % frame_step == 0:
            t = idx / src_fps
            h, w = frame.shape[:2]
            frame_area = w * h

            faces = detector.detect(frame)
            has_face = len(faces) > 0
            max_area_pct = 0.0
            if faces:
                max_area_pct = max(fw * fh for _, _, fw, fh in faces) / frame_area

            raw_presence.append(has_face)
            face_counts.append(len(faces))
            face_areas.append(round(max_area_pct, 4))
            frame_times.append(round(t, 3))
        idx += 1

    cap.release()

    if not raw_presence:
        return {"error": "No frames extracted", "sceneCount": 0}

    # ── Temporal smoothing ──────────────────────────────────────────────────
    smoothed = smooth_presence(raw_presence, smoothing_window, sample_fps)

    # ── Shot classification ─────────────────────────────────────────────────
    presence_pct = sum(smoothed) / len(smoothed)
    if presence_pct >= THRESHOLD_TALKING_HEAD:
        shot_type = "talking_head"
    elif presence_pct < THRESHOLD_BROLL:
        shot_type = "b_roll"
    else:
        shot_type = "mixed"

    # ── Face size classification ────────────────────────────────────────────
    # Close-up if max detected face is > 15% of frame area
    nonzero_areas = [a for a in face_areas if a > 0]
    avg_face_pct   = float(np.mean(nonzero_areas)) if nonzero_areas else 0.0
    framing = (
        "close_up"  if avg_face_pct > 0.15 else
        "medium"    if avg_face_pct > 0.06 else
        "wide"      if nonzero_areas else
        "no_subject"
    )

    # ── Subject segments ────────────────────────────────────────────────────
    # Grace-period aware: merge short absences into the surrounding present block
    grace_frames = max(1, int(grace_seconds * sample_fps))
    graced = list(smoothed)
    i = 0
    while i < len(graced):
        if not graced[i]:
            # Find the end of this absence run
            j = i
            while j < len(graced) and not graced[j]:
                j += 1
            run_len = j - i
            if run_len <= grace_frames:
                # Short enough absence — fill with "present" (grace period)
                for k in range(i, j):
                    graced[k] = True   # treat as still present
            i = j
        else:
            i += 1

    segments = build_segments(graced, frame_times)

    # ── Continuity-aware cut windows ────────────────────────────────────────
    raw_segments    = build_segments(smoothed, frame_times)  # without grace fill
    safe_cut_windows = build_safe_cut_windows(raw_segments, grace_seconds)

    # ── Build frame-level timeline (downsampled for payload size) ──────────
    # Report every 4th sample to keep JSON manageable
    step4 = max(1, len(frame_times) // 200)   # max ~200 timeline points
    timeline = [
        {
            "t":        frame_times[i],
            "face":     smoothed[i],
            "rawFace":  raw_presence[i],
            "faceArea": face_areas[i],
        }
        for i in range(0, len(frame_times), step4)
    ]

    return {
        "shotType":           shot_type,
        "framing":            framing,
        "facePresencePct":    round(float(presence_pct), 3),
        "avgFaceAreaPct":     round(avg_face_pct, 4),
        "duration":           round(duration, 3),
        "fps":                round(src_fps, 3),
        "sampleFps":          sample_fps,
        "framesAnalysed":     len(raw_presence),
        "gracePeriodSecs":    grace_seconds,
        "subjectSegments":    segments,
        "rawSubjectSegments": raw_segments,
        "safeCutWindows":     safe_cut_windows,
        "faceTimeline":       timeline,
        "model":              "haar-frontal+profile+alt2",
    }


# ─── Entry point ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: analyze_faces.py <video_path> [sample_fps] [grace_seconds]"}))
        sys.exit(1)

    video_path    = sys.argv[1]
    sample_fps    = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
    grace_seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    result = analyze(video_path, sample_fps=sample_fps, grace_seconds=grace_seconds)
    result["videoPath"] = video_path
    print(json.dumps(result))


if __name__ == "__main__":
    main()
