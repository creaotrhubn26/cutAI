#!/usr/bin/env python3
"""
Speech emotion analysis using librosa audio features.
Extracts spectral, temporal, and energy features to estimate
emotional valence and arousal from the audio track.
Usage: python3 speech_emotion.py <video_path>
"""
import sys
import json
import os
import subprocess
import tempfile


def extract_audio(input_path: str, tmpdir: str) -> str:
    """Extract audio from video to mono WAV."""
    wav_path = os.path.join(tmpdir, "audio.wav")
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-f", "wav", wav_path,
        "-loglevel", "error"
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if result.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr.decode()}")
    return wav_path


def analyze_speech_emotion(audio_path: str) -> dict:
    """
    Estimate emotional valence and arousal from audio features.
    High energy + high tempo → high arousal
    Bright timbre + major harmonics → positive valence
    Slow + dark timbre → low arousal, negative valence
    """
    try:
        import librosa
        import numpy as np
    except ImportError as e:
        return {"error": f"librosa not available: {e}"}

    try:
        y, sr = librosa.load(audio_path, sr=16000, mono=True)
        duration = float(len(y)) / sr

        if duration < 0.5:
            return {"error": "Audio too short", "valence": 0.0, "arousal": 0.3}

        # --- Energy / RMS ---
        rms = librosa.feature.rms(y=y)[0]
        mean_rms = float(np.mean(rms))
        rms_norm = min(1.0, mean_rms * 15)

        # --- Spectral features ---
        spec_centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
        mean_centroid = float(np.mean(spec_centroid))
        centroid_norm = min(1.0, mean_centroid / 4000.0)

        spec_rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, roll_percent=0.85)[0]
        mean_rolloff = float(np.mean(spec_rolloff))
        rolloff_norm = min(1.0, mean_rolloff / 8000.0)

        spec_bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr)[0]
        mean_bandwidth = float(np.mean(spec_bandwidth))
        bandwidth_norm = min(1.0, mean_bandwidth / 3000.0)

        # --- Zero crossing rate (roughness/noise indicator) ---
        zcr = librosa.feature.zero_crossing_rate(y=y)[0]
        mean_zcr = float(np.mean(zcr))
        zcr_norm = min(1.0, mean_zcr * 8)

        # --- MFCCs (speech content) ---
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        mfcc_means = [float(np.mean(mfcc[i])) for i in range(13)]

        # --- Tempo ---
        try:
            tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
            tempo = float(tempo_arr[0]) if hasattr(tempo_arr, '__len__') else float(tempo_arr)
            tempo_norm = min(1.0, max(0.0, (tempo - 60) / 120.0))
        except Exception:
            tempo = 120.0
            tempo_norm = 0.5

        # --- Speech detection ---
        has_speech = mean_rms > 0.01 and mean_zcr > 0.02

        # --- Voiced fraction (using RMS threshold) ---
        voiced_threshold = mean_rms * 0.5
        voiced_frames = float(np.mean(rms > voiced_threshold))

        # --- Map features to arousal ---
        arousal = (
            rms_norm * 0.35 +
            tempo_norm * 0.25 +
            centroid_norm * 0.20 +
            bandwidth_norm * 0.10 +
            zcr_norm * 0.10
        )
        arousal = max(0.0, min(1.0, arousal))

        # --- Map features to valence ---
        brightness = centroid_norm
        energy_moderate = 1.0 - abs(rms_norm - 0.5) * 2
        speech_richness = voiced_frames

        valence_raw = brightness * 0.40 + energy_moderate * 0.30 + speech_richness * 0.30
        valence = (valence_raw - 0.5) * 2.0
        valence = max(-1.0, min(1.0, valence))

        emotion_score = (valence + 1.0) / 2.0 * 0.5 + arousal * 0.5

        # --- Segment-level energy for temporal context ---
        segment_len = int(sr * 2.0)
        n_segments = max(1, len(y) // segment_len)
        segment_arousals = []
        for i in range(n_segments):
            seg = y[i*segment_len:(i+1)*segment_len]
            if len(seg) < sr * 0.5:
                continue
            seg_rms = float(np.mean(librosa.feature.rms(y=seg)[0]))
            seg_centroid = float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=sr)[0]))
            seg_arousal = min(1.0, seg_rms * 15) * 0.6 + min(1.0, seg_centroid / 4000) * 0.4
            segment_arousals.append({"t": round(i * 2.0, 2), "arousal": round(seg_arousal, 4)})

        return {
            "valence": round(valence, 4),
            "arousal": round(arousal, 4),
            "emotion_score": round(emotion_score, 4),
            "has_speech": has_speech,
            "tempo_bpm": round(tempo, 1),
            "mean_rms": round(mean_rms, 6),
            "spectral_centroid_hz": round(mean_centroid, 1),
            "spectral_rolloff_hz": round(mean_rolloff, 1),
            "spectral_bandwidth_hz": round(mean_bandwidth, 1),
            "zero_crossing_rate": round(mean_zcr, 6),
            "voiced_fraction": round(voiced_frames, 4),
            "mfcc_means": [round(v, 4) for v in mfcc_means],
            "segment_arousals": segment_arousals,
            "duration_seconds": round(duration, 2),
            "method": "librosa_features",
        }

    except Exception as e:
        return {"error": str(e), "valence": 0.0, "arousal": 0.3, "emotion_score": 0.5}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: speech_emotion.py <video_path>"}))
        sys.exit(1)

    input_path = sys.argv[1]

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File not found: {input_path}"}))
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            audio_path = extract_audio(input_path, tmpdir)
        except Exception as e:
            print(json.dumps({"error": f"Audio extraction failed: {str(e)}", "valence": 0.0, "arousal": 0.3}))
            sys.exit(1)

        result = analyze_speech_emotion(audio_path)
        print(json.dumps(result))
