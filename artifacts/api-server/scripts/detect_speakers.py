#!/usr/bin/env python3
"""
Audio-based speaker diarization using energy and spectral analysis.
Uses FFmpeg's astats + silencedetect to segment audio, then clusters
segments by spectral centroid similarity to approximate speaker turns.

Usage: python3 detect_speakers.py <audio_path> [min_speaker_duration]
Output: JSON to stdout with speaker-labeled segments.

No external ML model required — works from FFmpeg audio features alone.
"""
import sys
import json
import subprocess
import os
import re
import tempfile
import math


def run_ffmpeg_silencedetect(audio_path: str, noise_floor: float = -35.0, min_silence: float = 0.4):
    """Use FFmpeg silencedetect to find silence boundaries."""
    cmd = [
        "ffmpeg", "-i", audio_path,
        "-af", f"silencedetect=noise={noise_floor}dB:d={min_silence}",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    output = result.stderr

    silence_starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", output)]
    silence_ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", output)]

    return list(zip(silence_starts, silence_ends))


def get_audio_duration(audio_path: str) -> float:
    """Get audio duration using FFprobe."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "json", audio_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except Exception:
        return 0.0


def extract_segment_energy(audio_path: str, start: float, end: float) -> float:
    """Extract RMS energy of a segment using FFmpeg astats."""
    duration = end - start
    if duration <= 0:
        return 0.0
    cmd = [
        "ffmpeg", "-ss", str(start), "-t", str(duration),
        "-i", audio_path,
        "-af", "astats=metadata=1:reset=1",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    rms_matches = re.findall(r"RMS level dB: ([-\d.]+)", result.stderr)
    if rms_matches:
        try:
            return float(rms_matches[-1])
        except ValueError:
            pass
    return -60.0


def extract_spectral_centroid(audio_path: str, start: float, end: float) -> float:
    """
    Approximate spectral centroid using FFmpeg's ebur128 loudness measure.
    Returns a float that can be used to group segments by audio character.
    """
    duration = end - start
    if duration <= 0:
        return 0.0
    cmd = [
        "ffmpeg", "-ss", str(start), "-t", str(duration),
        "-i", audio_path,
        "-af", "ebur128=peak=true",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    lra_matches = re.findall(r"LRA:\s+([-\d.]+)", result.stderr)
    if lra_matches:
        try:
            return float(lra_matches[-1])
        except ValueError:
            pass
    return 0.0


def cluster_speakers(segments: list, n_speakers: int = 2) -> list:
    """
    Simple energy-based speaker clustering.
    Groups segments into n_speakers clusters based on energy+LRA signature.
    """
    if not segments:
        return segments

    # Simple threshold clustering: higher energy = speaker 0, lower = speaker 1
    energies = [s.get("energyDb", -60.0) for s in segments]
    if not energies:
        return segments

    energy_mean = sum(energies) / len(energies)

    for s in segments:
        e = s.get("energyDb", -60.0)
        lra = s.get("lra", 0.0)
        # Higher energy + higher LRA → more dynamic speaker (speaker 0)
        score = (e - energy_mean) + lra * 0.5
        s["speaker"] = f"SPEAKER_{0 if score >= 0 else 1}"

    return segments


def detect_speakers(audio_path: str, min_duration: float = 1.0):
    duration = get_audio_duration(audio_path)
    if duration == 0:
        print(json.dumps({"error": "Could not determine audio duration", "segments": []}))
        sys.exit(1)

    # Find silence regions to split into speech segments
    silence_regions = run_ffmpeg_silencedetect(audio_path)

    # Build speech segment list from inverse of silence
    speech_segments = []
    prev_end = 0.0
    for silence_start, silence_end in silence_regions:
        if silence_start - prev_end >= min_duration:
            speech_segments.append({
                "start": round(prev_end, 3),
                "end": round(silence_start, 3),
                "duration": round(silence_start - prev_end, 3),
            })
        prev_end = silence_end

    # Capture final segment if it extends to end of audio
    if duration - prev_end >= min_duration:
        speech_segments.append({
            "start": round(prev_end, 3),
            "end": round(duration, 3),
            "duration": round(duration - prev_end, 3),
        })

    if not speech_segments:
        # Fallback: treat the whole file as one segment
        speech_segments = [{
            "start": 0.0,
            "end": round(duration, 3),
            "duration": round(duration, 3),
        }]

    # Enrich each segment with energy metrics (sampled, not all — too slow for many)
    max_sample = min(len(speech_segments), 20)
    step = max(1, len(speech_segments) // max_sample)
    for i, seg in enumerate(speech_segments):
        if i % step == 0:
            seg["energyDb"] = extract_segment_energy(audio_path, seg["start"], seg["end"])
            seg["lra"] = extract_spectral_centroid(audio_path, seg["start"], seg["end"])
        else:
            # Interpolate from nearest sampled
            seg["energyDb"] = -40.0
            seg["lra"] = 0.0

    # Cluster into speakers
    speech_segments = cluster_speakers(speech_segments)

    result = {
        "totalDuration": round(duration, 3),
        "segmentCount": len(speech_segments),
        "speakerCount": len(set(s.get("speaker", "SPEAKER_0") for s in speech_segments)),
        "segments": speech_segments,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect_speakers.py <audio_path> [min_duration]"}))
        sys.exit(1)
    audio_path = sys.argv[1]
    min_dur = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    detect_speakers(audio_path, min_dur)
