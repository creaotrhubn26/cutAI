#!/usr/bin/env python3
"""
High-accuracy beat/BPM detection using librosa with advanced analysis.
Includes beat tracking, downbeat estimation, onset detection, and tempo stability.
Usage: python3 beat_detect.py <audio_or_video_path>
"""
import sys
import json
import os
import subprocess
import tempfile


def extract_audio_wav(input_path: str, tmpdir: str) -> str:
    """Extract audio from video to mono WAV using ffmpeg."""
    wav_path = os.path.join(tmpdir, "audio.wav")
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vn", "-ac", "1", "-ar", "44100",
        "-f", "wav", wav_path,
        "-loglevel", "error"
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if result.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr.decode()}")
    return wav_path


def detect_beats_librosa(audio_path: str) -> dict:
    """
    Advanced librosa beat tracking with:
    - Multi-window tempo estimation
    - Downbeat estimation (every 4th beat)
    - Onset strength envelope
    - Energy-weighted BPM
    """
    try:
        import librosa
        import numpy as np
    except ImportError as e:
        return {"error": f"librosa not available: {e}"}

    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        duration = float(len(y)) / sr

        if duration < 1.0:
            return {"error": "Audio too short", "beats": [], "bpm": 120}

        # --- Primary beat tracking ---
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, aggregate=np.median)
        tempo_arr, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, units="frames",
            trim=True, tightness=100
        )
        bpm = float(tempo_arr[0]) if hasattr(tempo_arr, '__len__') else float(tempo_arr)

        # --- Tempogram for tempo stability ---
        tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr, win_length=400)
        tempo_local = librosa.beat.tempo(onset_envelope=onset_env, sr=sr, aggregate=None)
        tempo_std = float(np.std(tempo_local)) if len(tempo_local) > 1 else 0.0
        tempo_stability = max(0.0, min(1.0, 1.0 - tempo_std / 40.0))

        # --- Normalize BPM to 60-180 range ---
        if bpm < 60:
            bpm = bpm * 2
        elif bpm > 180:
            bpm = bpm / 2
        bpm = round(bpm, 1)

        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

        # --- Beat strength (onset envelope at beat positions) ---
        beat_strengths = [
            round(float(onset_env[min(f, len(onset_env)-1)]), 4)
            for f in beat_frames
        ]
        max_str = max(beat_strengths) if beat_strengths else 1.0
        beat_strengths = [round(s / max_str, 4) for s in beat_strengths]

        # --- Downbeat estimation (every 4 beats = one measure) ---
        downbeats = []
        if beat_times:
            downbeats = [round(beat_times[i], 3) for i in range(0, len(beat_times), 4)]

        # --- Energy envelope (50 samples) ---
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
        rms_times = librosa.frames_to_time(range(len(rms)), sr=sr, hop_length=512)
        step = max(1, len(rms) // 50)
        energy_times = [round(float(t), 3) for t in rms_times[::step]]
        energy_values = [round(float(v), 6) for v in rms[::step]]

        # --- Onset detection (for visual sync points) ---
        onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
        onset_times = librosa.frames_to_time(onset_frames, sr=sr).tolist()

        # --- Tempo segments (track BPM changes) ---
        segment_len = int(sr * 10.0)
        tempo_segments = []
        for i in range(0, len(y), segment_len):
            seg = y[i:i+segment_len]
            if len(seg) < sr * 2:
                break
            try:
                seg_onset = librosa.onset.onset_strength(y=seg, sr=sr)
                seg_tempo_arr, _ = librosa.beat.beat_track(onset_envelope=seg_onset, sr=sr)
                seg_bpm = float(seg_tempo_arr[0]) if hasattr(seg_tempo_arr, '__len__') else float(seg_tempo_arr)
                if seg_bpm < 60:
                    seg_bpm *= 2
                elif seg_bpm > 180:
                    seg_bpm /= 2
                tempo_segments.append({
                    "t_start": round(i / sr, 2),
                    "t_end": round(min((i + segment_len) / sr, duration), 2),
                    "bpm": round(seg_bpm, 1),
                })
            except Exception:
                pass

        # --- Spectral flux for cut-point detection ---
        spec = librosa.stft(y)
        spec_flux = librosa.onset.onset_strength(S=np.abs(spec), sr=sr)
        flux_times = librosa.frames_to_time(range(len(spec_flux)), sr=sr)
        flux_step = max(1, len(spec_flux) // 50)
        spectral_flux = {
            "times": [round(float(t), 3) for t in flux_times[::flux_step]],
            "values": [round(float(v), 4) for v in spec_flux[::flux_step]],
        }

        return {
            "method": "librosa_advanced",
            "bpm": bpm,
            "beats": [round(t, 3) for t in beat_times],
            "downbeats": [round(t, 3) for t in downbeats],
            "beat_strengths": beat_strengths,
            "beat_count": len(beat_times),
            "downbeat_count": len(downbeats),
            "onset_times": [round(t, 3) for t in onset_times[:100]],
            "tempo_stability": round(tempo_stability, 4),
            "tempo_segments": tempo_segments,
            "energy_times": energy_times,
            "energy_values": energy_values,
            "spectral_flux": spectral_flux,
            "duration_seconds": round(duration, 2),
        }

    except Exception as e:
        return {"error": str(e), "bpm": 120, "beats": []}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: beat_detect.py <audio_or_video_path>"}))
        sys.exit(1)

    input_path = sys.argv[1]

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File not found: {input_path}"}))
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            audio_path = extract_audio_wav(input_path, tmpdir)
        except Exception as e:
            print(json.dumps({"error": f"Audio extraction failed: {e}"}))
            sys.exit(1)

        result = detect_beats_librosa(audio_path)
        print(json.dumps(result))
