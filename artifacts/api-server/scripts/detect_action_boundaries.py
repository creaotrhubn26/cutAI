#!/usr/bin/env python3
"""
detect_action_boundaries.py — Optical flow action boundary detector

Computes dense Farneback optical flow between consecutive sampled frames and
identifies "settling events" (motion drops sharply after a peak = action just
completed) and "gap events" (sustained low-motion pauses between action bursts).
Both are ideal cut points — the editor should prefer these over mid-motion cuts.

Usage:
    python3 detect_action_boundaries.py <video_path> [--fps N]
        [--threshold_high F] [--threshold_low F] [--smooth_window N]

Output: JSON on stdout
    {
      "action_boundaries": [
        {"timestamp": 3.24, "type": "settle", "confidence": 0.85,
         "motion_before": 12.4, "motion_after": 1.2}
      ],
      "motion_profile": [{"ts": 0.1, "mag": 2.3}, ...],
      "avg_motion": 4.2,
      "max_motion": 18.7,
      "duration": 27.4,
      "frames_analyzed": 82
    }
"""

import sys
import json
import argparse

import cv2
import numpy as np


def smooth_moving_avg(values: list[float], window: int = 5) -> list[float]:
    """Box-car moving average smoother."""
    out = []
    half = window // 2
    n = len(values)
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def flow_magnitude(prev_gray: np.ndarray, curr_gray: np.ndarray) -> float:
    """Dense optical flow → mean pixel displacement in pixels/frame."""
    flow = cv2.calcOpticalFlowFarneback(
        prev_gray, curr_gray,
        None,
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=3, poly_n=5, poly_sigma=1.2,
        flags=0,
    )
    mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
    return float(np.mean(mag))


def find_settle_points(
    timestamps: list[float],
    magnitudes: list[float],
    threshold_high: float = 3.0,
    threshold_low: float = 1.0,
    min_gap_sec: float = 0.4,
) -> list[dict]:
    """
    Settle point: within a 3-frame look-back window the motion peaked above
    threshold_high, and the current frame is below threshold_low.
    This means 'action just completed / object just landed'.
    """
    settle_points: list[dict] = []
    last_ts = -999.0
    n = len(magnitudes)

    for i in range(3, n):
        ts = timestamps[i]
        if ts - last_ts < min_gap_sec:
            continue

        look_back = magnitudes[max(0, i - 4): i]
        prev_peak = max(look_back) if look_back else 0.0
        curr_val  = magnitudes[i]

        if prev_peak >= threshold_high and curr_val <= threshold_low:
            conf = min(1.0, (prev_peak - curr_val) / (prev_peak + 1e-6))
            settle_points.append({
                "timestamp":     round(ts, 3),
                "type":          "settle",
                "confidence":    round(conf, 3),
                "motion_before": round(prev_peak, 3),
                "motion_after":  round(curr_val, 3),
            })
            last_ts = ts

    return settle_points


def find_gap_points(
    timestamps: list[float],
    magnitudes: list[float],
    threshold_low: float = 1.0,
    min_gap_sec: float = 0.25,
    min_pause_sec: float = 0.3,
) -> list[dict]:
    """
    Gap point: a sustained low-motion interval between action bursts.
    Returns the midpoint of each gap as a candidate cut point.
    """
    gap_points: list[dict] = []
    in_gap = False
    gap_start_idx = 0
    last_ts = -999.0

    for i, (ts, mag) in enumerate(zip(timestamps, magnitudes)):
        if mag <= threshold_low:
            if not in_gap:
                in_gap = True
                gap_start_idx = i
        else:
            if in_gap:
                gap_end_idx = i - 1
                gap_dur = timestamps[gap_end_idx] - timestamps[gap_start_idx]

                if gap_dur >= min_pause_sec:
                    mid_idx = (gap_start_idx + gap_end_idx) // 2
                    mid_ts  = timestamps[mid_idx]

                    if mid_ts - last_ts >= min_gap_sec:
                        before_mag = magnitudes[max(0, gap_start_idx - 1)]
                        after_mag  = magnitudes[min(len(magnitudes) - 1, i)]
                        gap_points.append({
                            "timestamp":     round(mid_ts, 3),
                            "type":          "gap",
                            "confidence":    round(min(1.0, gap_dur * 2), 3),
                            "motion_before": round(before_mag, 3),
                            "motion_after":  round(after_mag, 3),
                        })
                        last_ts = mid_ts

                in_gap = False

    return gap_points


def dedup_boundaries(boundaries: list[dict], min_sep: float = 0.3) -> list[dict]:
    """Remove boundaries within min_sep of each other — keep higher confidence."""
    result: list[dict] = []
    for b in sorted(boundaries, key=lambda x: x["timestamp"]):
        if result and abs(b["timestamp"] - result[-1]["timestamp"]) < min_sep:
            if b["confidence"] > result[-1]["confidence"]:
                result[-1] = b
        else:
            result.append(b)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Detect action completion boundaries via optical flow"
    )
    parser.add_argument("video_path")
    parser.add_argument("--fps",            type=float, default=10.0)
    parser.add_argument("--threshold_high", type=float, default=3.0,
                        help="High-motion threshold (px/frame)")
    parser.add_argument("--threshold_low",  type=float, default=1.0,
                        help="Low-motion threshold (px/frame)")
    parser.add_argument("--smooth_window",  type=int,   default=5)
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.video_path)
    if not cap.isOpened():
        print(json.dumps({"error": f"Cannot open video: {args.video_path}"}))
        sys.exit(1)

    video_fps     = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration      = total_frames / video_fps if video_fps > 0 else 0.0
    frame_interval = max(1, int(round(video_fps / args.fps)))

    timestamps:  list[float] = []
    magnitudes:  list[float] = []
    prev_gray:   "np.ndarray | None" = None
    frame_idx    = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            # Downsample to 360p to speed up flow computation
            h, w = frame.shape[:2]
            if w > 640:
                scale = 640 / w
                frame = cv2.resize(frame, (640, int(h * scale)))

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            ts   = frame_idx / video_fps

            if prev_gray is not None:
                mag = flow_magnitude(prev_gray, gray)
                timestamps.append(ts)
                magnitudes.append(mag)

            prev_gray = gray

        frame_idx += 1

    cap.release()

    if len(magnitudes) < 4:
        print(json.dumps({
            "action_boundaries": [],
            "motion_profile":    [],
            "avg_motion":        0.0,
            "max_motion":        0.0,
            "duration":          round(duration, 3),
            "frames_analyzed":   len(magnitudes),
        }))
        return

    smoothed = smooth_moving_avg(magnitudes, window=args.smooth_window)

    settle = find_settle_points(
        timestamps, smoothed,
        threshold_high=args.threshold_high,
        threshold_low=args.threshold_low,
    )
    gaps = find_gap_points(
        timestamps, smoothed,
        threshold_low=args.threshold_low,
    )

    all_boundaries = dedup_boundaries(settle + gaps)

    # Downsample motion profile for visualization (max 200 pts)
    step = max(1, len(timestamps) // 200)
    motion_profile = [
        {"ts": round(timestamps[i], 2), "mag": round(smoothed[i], 3)}
        for i in range(0, len(timestamps), step)
    ]

    avg_motion = sum(magnitudes) / len(magnitudes)
    max_motion = max(magnitudes)

    print(json.dumps({
        "action_boundaries": all_boundaries,
        "motion_profile":    motion_profile,
        "avg_motion":        round(avg_motion, 3),
        "max_motion":        round(max_motion, 3),
        "duration":          round(duration, 3),
        "frames_analyzed":   len(magnitudes),
    }))


if __name__ == "__main__":
    main()
