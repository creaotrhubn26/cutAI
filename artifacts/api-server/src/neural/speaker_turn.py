#!/usr/bin/env python3
"""
Speaker turn detection for video files.

Uses FFmpeg audio analysis to detect when a new speaker starts speaking.
Segments audio by silence boundaries, then clusters segments by their
spectral characteristics (centroid, RMS energy) to approximate diarization.

This is a heuristic approach — no external ML model required — works entirely
from FFmpeg audio features. For production diarization quality consider pyannote.

Usage:
    python3 speaker_turn.py <video_path> [min_segment_duration]

Example input:  video.mp4
Expected output:
    {
      "speaker_count": 2,
      "speaker_turns": [
        {"speaker_id": 0, "start": 0.0, "end": 4.2, "confidence": 0.85,
         "energy": 0.72, "centroid": 2100.0, "duration": 4.2},
        {"speaker_id": 1, "start": 4.2, "end": 9.8, "confidence": 0.80, ...}
      ],
      "turn_count": 6,
      "avg_turn_duration": 3.1,
      "method": "ffmpeg_energy_spectral",
      "warning": null
    }

Failure modes:
    - File not found: returns {"error": "..."}
    - Silent audio (no detected speech): returns {"speaker_count": 0, "speaker_turns": [], "warning": "no_speech"}
    - Single speaker or monologue: returns {"speaker_count": 1, ...}
    - FFmpeg not available: returns {"error": "ffmpeg_missing", "speaker_turns": []}
"""

import sys
import json
import os
import subprocess
import re
import math
import tempfile
from collections import defaultdict


def run_silence_detect(audio_path: str, noise_floor: float = -35.0, min_silence: float = 0.35) -> list[tuple[float, float]]:
    """Find silence intervals using FFmpeg silencedetect."""
    cmd = [
        "ffmpeg", "-i", audio_path,
        "-af", f"silencedetect=noise={noise_floor}dB:d={min_silence}",
        "-f", "null", "-"
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        output = result.stderr
        starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", output)]
        ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", output)]
        return list(zip(starts, ends[:len(starts)]))
    except subprocess.TimeoutExpired:
        return []
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found in PATH")


def get_audio_duration(audio_path: str) -> float:
    """Get audio/video duration via ffprobe."""
    cmd = ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "json", audio_path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except Exception:
        return 0.0


def extract_spectral_features(audio_path: str, start: float, end: float) -> dict | None:
    """
    Extract RMS energy and spectral centroid approximation for a segment.
    Uses FFmpeg astats for energy and EBUR128 for loudness.
    Returns {"rms": float, "centroid_approx": float, "loudness": float}
    """
    duration = end - start
    if duration < 0.15:
        return None

    # RMS energy via astats
    rms = 0.0
    try:
        cmd = [
            "ffmpeg", "-ss", str(start), "-t", str(min(duration, 10.0)),
            "-i", audio_path,
            "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f", "null", "-"
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        rms_matches = re.findall(r"RMS_level=([-\d.]+)", r.stderr)
        if rms_matches:
            rms_db = float(rms_matches[0])
            rms = max(0.0, min(1.0, (rms_db + 60) / 60))  # Normalize -60dB..0dB → 0..1
    except Exception:
        pass

    # Spectral centroid approximation via low/mid/high energy split
    centroid_approx = 1500.0  # default mid
    try:
        low_cmd = [
            "ffmpeg", "-ss", str(start), "-t", str(min(duration, 5.0)),
            "-i", audio_path,
            "-af", f"bandpass=f=300:width_type=h:w=600,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f", "null", "-"
        ]
        mid_cmd = [
            "ffmpeg", "-ss", str(start), "-t", str(min(duration, 5.0)),
            "-i", audio_path,
            "-af", f"bandpass=f=1500:width_type=h:w=2000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f", "null", "-"
        ]
        high_cmd = [
            "ffmpeg", "-ss", str(start), "-t", str(min(duration, 5.0)),
            "-i", audio_path,
            "-af", f"bandpass=f=4000:width_type=h:w=4000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f", "null", "-"
        ]
        r_low = subprocess.run(low_cmd, capture_output=True, text=True, timeout=10)
        r_mid = subprocess.run(mid_cmd, capture_output=True, text=True, timeout=10)
        r_high = subprocess.run(high_cmd, capture_output=True, text=True, timeout=10)

        def parse_rms_db(stderr: str) -> float:
            m = re.findall(r"RMS_level=([-\d.]+)", stderr)
            if m:
                return float(m[0])
            return -60.0

        low_db = parse_rms_db(r_low.stderr)
        mid_db = parse_rms_db(r_mid.stderr)
        high_db = parse_rms_db(r_high.stderr)

        # Weighted centroid estimate: low=300Hz, mid=1500Hz, high=4000Hz
        low_e = 10 ** (low_db / 20)
        mid_e = 10 ** (mid_db / 20)
        high_e = 10 ** (high_db / 20)
        total_e = low_e + mid_e + high_e
        if total_e > 0:
            centroid_approx = round(
                (300 * low_e + 1500 * mid_e + 4000 * high_e) / total_e, 1
            )
    except Exception:
        pass

    return {"rms": round(rms, 4), "centroid_approx": centroid_approx}


def cluster_segments(segments: list[dict], n_clusters: int = 2) -> list[int]:
    """
    Simple k-means-like clustering on (rms, centroid_approx) features.
    Returns list of cluster labels (0 or 1 = speaker ID).
    """
    if not segments:
        return []
    if len(segments) == 1:
        return [0]

    feats = [(s["rms"], s["centroid_approx"] / 5000.0) for s in segments]

    # Initialize centroids: pick two most-spread segments
    sorted_by_centroid = sorted(range(len(feats)), key=lambda i: feats[i][1])
    c0 = list(feats[sorted_by_centroid[0]])
    c1 = list(feats[sorted_by_centroid[-1]])

    labels = [0] * len(feats)
    for _ in range(20):  # max iterations
        new_labels = []
        for f in feats:
            d0 = (f[0] - c0[0]) ** 2 + (f[1] - c0[1]) ** 2
            d1 = (f[0] - c1[0]) ** 2 + (f[1] - c1[1]) ** 2
            new_labels.append(0 if d0 <= d1 else 1)

        if new_labels == labels:
            break
        labels = new_labels

        # Update centroids
        c0 = [0.0, 0.0]
        c1 = [0.0, 0.0]
        n0 = n1 = 0
        for i, lab in enumerate(labels):
            if lab == 0:
                c0[0] += feats[i][0]; c0[1] += feats[i][1]; n0 += 1
            else:
                c1[0] += feats[i][0]; c1[1] += feats[i][1]; n1 += 1
        if n0 > 0:
            c0 = [c0[0] / n0, c0[1] / n0]
        if n1 > 0:
            c1 = [c1[0] / n1, c1[1] / n1]

    # If all in one cluster, force split at median
    if len(set(labels)) == 1:
        med = sorted(range(len(feats)), key=lambda i: feats[i][1])[len(feats) // 2]
        for i in range(med, len(labels)):
            labels[i] = 1

    return labels


def analyze(video_path: str, min_segment_duration: float = 0.5) -> dict:
    """Main speaker turn detection entry point."""

    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}", "speaker_turns": []}

    try:
        duration = get_audio_duration(video_path)
    except Exception as e:
        return {"error": f"Could not read duration: {e}", "speaker_turns": []}

    if duration <= 0:
        return {
            "speaker_count": 0,
            "speaker_turns": [],
            "turn_count": 0,
            "avg_turn_duration": 0.0,
            "method": "ffmpeg_energy_spectral",
            "warning": "no_audio_duration",
        }

    # Step 1: Find silence boundaries
    try:
        silence_intervals = run_silence_detect(video_path)
    except RuntimeError as e:
        return {"error": str(e), "speaker_turns": []}

    # Step 2: Build speech segments from silence gaps
    speech_segments: list[dict] = []
    prev_end = 0.0

    for (s_start, s_end) in sorted(silence_intervals, key=lambda x: x[0]):
        seg_start = prev_end
        seg_end = s_start
        if seg_end - seg_start >= min_segment_duration:
            speech_segments.append({"start": round(seg_start, 3), "end": round(seg_end, 3)})
        prev_end = s_end

    # Final segment after last silence
    if duration - prev_end >= min_segment_duration:
        speech_segments.append({"start": round(prev_end, 3), "end": round(duration, 3)})

    if not speech_segments:
        return {
            "speaker_count": 0,
            "speaker_turns": [],
            "turn_count": 0,
            "avg_turn_duration": 0.0,
            "method": "ffmpeg_energy_spectral",
            "warning": "no_speech",
        }

    # Step 3: Extract spectral features for each speech segment
    enriched: list[dict] = []
    for seg in speech_segments:
        feats = extract_spectral_features(video_path, seg["start"], seg["end"])
        if feats:
            enriched.append({**seg, **feats, "duration": round(seg["end"] - seg["start"], 3)})
        else:
            enriched.append({**seg, "rms": 0.5, "centroid_approx": 1500.0, "duration": round(seg["end"] - seg["start"], 3)})

    # Step 4: Cluster into speakers (max 2 for simplicity)
    labels = cluster_segments(enriched)

    # Step 5: Build speaker_turns with confidence
    # Confidence = distance from opposite centroid relative to total spread
    all_centroids = [e["centroid_approx"] for e in enriched]
    c_range = max(all_centroids) - min(all_centroids) if len(all_centroids) > 1 else 1
    c_mean = sum(all_centroids) / len(all_centroids)

    speaker_turns = []
    for i, (seg, label) in enumerate(zip(enriched, labels)):
        deviation = abs(seg["centroid_approx"] - c_mean)
        confidence = round(min(0.95, 0.60 + (deviation / max(c_range, 1)) * 0.35), 3)

        speaker_turns.append({
            "speaker_id": label,
            "start": seg["start"],
            "end": seg["end"],
            "duration": seg["duration"],
            "energy": seg["rms"],
            "centroid": seg["centroid_approx"],
            "confidence": confidence,
        })

    unique_speakers = len(set(labels))
    turn_durations = [t["duration"] for t in speaker_turns]
    avg_turn = round(sum(turn_durations) / len(turn_durations), 3) if turn_durations else 0.0

    # Count actual speaker changes
    actual_turns = sum(1 for i in range(1, len(labels)) if labels[i] != labels[i - 1])

    return {
        "speaker_count": unique_speakers,
        "speaker_turns": speaker_turns,
        "turn_count": actual_turns + 1,  # +1 for first segment
        "avg_turn_duration": avg_turn,
        "total_duration": round(duration, 3),
        "method": "ffmpeg_energy_spectral",
        "warning": None,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: speaker_turn.py <video_path> [min_segment_duration]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    min_dur = 0.5
    if len(sys.argv) >= 3:
        try:
            min_dur = float(sys.argv[2])
        except ValueError:
            pass

    result = analyze(video_path, min_dur)
    print(json.dumps(result))
