#!/usr/bin/env python3
"""
diarize_speakers_v2.py — Offline speaker diarization

Pipeline:
  1. Extract mono 16kHz WAV with ffmpeg
  2. Load waveform with librosa
  3. VAD: simple energy + ZCR thresholding to find speech frames
  4. Segment into speech windows (merge nearby active frames, min 0.5s)
  5. MFCC feature extraction (librosa, 40 coefficients, delta+delta2)
  6. Agglomerative clustering (sklearn) on mean-pooled segment embeddings
  7. Merge adjacent segments with same speaker label
  8. Output JSON with speaker-labelled timeline

Usage:
    python3 diarize_speakers_v2.py <audio_or_video_path> [--num_speakers N]
        [--max_speakers N] [--min_segment_sec F]

Output JSON:
    {
      "speakers": ["SPEAKER_0", "SPEAKER_1", ...],
      "num_speakers": 2,
      "segments": [
        {"speaker": "SPEAKER_0", "start": 0.0, "end": 4.2, "duration": 4.2},
        ...
      ],
      "duration": 60.0,
      "method": "mfcc_agglomerative"
    }
"""

import sys
import json
import argparse
import tempfile
import os
import subprocess

import numpy as np
import librosa
from sklearn.cluster import AgglomerativeClustering
from sklearn.preprocessing import StandardScaler


# ── Configuration ─────────────────────────────────────────────────────────────
SAMPLE_RATE     = 16000
FRAME_LENGTH    = 512       # ~32ms
HOP_LENGTH      = 256       # ~16ms overlap
N_MFCC          = 40
VAD_FRAME_SECS  = 0.03      # 30ms frames for VAD energy
VAD_ENERGY_PCT  = 15        # energy percentile threshold (below = silence)


# ── Step 1: Extract WAV ───────────────────────────────────────────────────────
def extract_wav(input_path: str, out_path: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", input_path,
         "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
         "-acodec", "pcm_s16le", out_path],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


# ── Step 2: Voice activity detection ─────────────────────────────────────────
def compute_vad_mask(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Returns a boolean frame-level mask (same resolution as librosa frames
    at HOP_LENGTH) where True = speech.
    """
    # Short-time energy (using librosa's RMS)
    rms = librosa.feature.rms(y=y, frame_length=FRAME_LENGTH, hop_length=HOP_LENGTH)[0]

    # Zero-crossing rate (speech has moderate ZCR, music/silence differs)
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=FRAME_LENGTH, hop_length=HOP_LENGTH)[0]

    # Threshold: frames above energy percentile AND reasonable ZCR
    energy_thresh = np.percentile(rms, VAD_ENERGY_PCT)
    speech_mask = rms > energy_thresh

    # Morphological: fill gaps < 0.3s, remove bursts < 0.15s
    fps = sr / HOP_LENGTH
    min_speech_frames = int(0.15 * fps)
    min_silence_frames = int(0.30 * fps)

    # Fill short silences
    in_speech = False
    silence_run = 0
    for i in range(len(speech_mask)):
        if speech_mask[i]:
            if not in_speech:
                in_speech = True
                # Fill the silence run if it was short
                if silence_run < min_silence_frames and i > silence_run:
                    speech_mask[i - silence_run: i] = True
            silence_run = 0
        else:
            if in_speech:
                silence_run += 1
            if silence_run > min_silence_frames:
                in_speech = False
                silence_run = 0

    return speech_mask


# ── Step 3: Segment speech regions ───────────────────────────────────────────
def speech_segments(mask: np.ndarray, sr: int, min_seg_sec: float = 0.5) -> list[tuple[float, float]]:
    """
    Convert frame-level VAD mask to (start_sec, end_sec) speech segments.
    """
    fps = sr / HOP_LENGTH
    min_frames = int(min_seg_sec * fps)
    segments: list[tuple[float, float]] = []
    start_idx: int | None = None

    for i, active in enumerate(mask):
        if active and start_idx is None:
            start_idx = i
        elif not active and start_idx is not None:
            length = i - start_idx
            if length >= min_frames:
                segments.append((start_idx / fps, i / fps))
            start_idx = None

    # Flush open segment
    if start_idx is not None:
        length = len(mask) - start_idx
        if length >= min_frames:
            segments.append((start_idx / fps, len(mask) / fps))

    return segments


# ── Step 4: MFCC embedding per segment ───────────────────────────────────────
def embed_segment(y: np.ndarray, sr: int, start_sec: float, end_sec: float) -> np.ndarray:
    """
    Extract mean-pooled MFCC + delta + delta2 embedding for a segment.
    Returns a (N_MFCC * 3,) feature vector.
    """
    start_sample = int(start_sec * sr)
    end_sample   = int(end_sec   * sr)
    clip = y[start_sample:end_sample]

    if len(clip) < FRAME_LENGTH:
        return np.zeros(N_MFCC * 3)

    mfcc    = librosa.feature.mfcc(y=clip, sr=sr, n_mfcc=N_MFCC,
                                    n_fft=FRAME_LENGTH, hop_length=HOP_LENGTH)
    delta1  = librosa.feature.delta(mfcc, order=1)
    delta2  = librosa.feature.delta(mfcc, order=2)
    combined = np.concatenate([mfcc, delta1, delta2], axis=0)

    # Mean-pool across time
    return combined.mean(axis=1)


# ── Step 5: Cluster embeddings ────────────────────────────────────────────────
def cluster_speakers(
    embeddings: np.ndarray,
    num_speakers: int | None = None,
    max_speakers: int = 8,
) -> np.ndarray:
    """
    Agglomerative clustering with cosine affinity.
    If num_speakers is None: use distance_threshold = 0.5 (auto-detect).
    Returns integer label array (length = number of segments).
    """
    n = len(embeddings)
    if n == 0:
        return np.array([], dtype=int)
    if n == 1:
        return np.array([0])

    scaler = StandardScaler()
    X = scaler.fit_transform(embeddings)

    if num_speakers is not None:
        n_clusters = min(num_speakers, n)
        model = AgglomerativeClustering(
            n_clusters=n_clusters,
            metric="cosine",
            linkage="average",
        )
    else:
        # Auto-detect: distance_threshold picks number of clusters
        model = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=0.45,
            metric="cosine",
            linkage="average",
        )

    labels = model.fit_predict(X)

    # Cap at max_speakers by merging smallest clusters into nearest large one
    unique_labels, counts = np.unique(labels, return_counts=True)
    if len(unique_labels) > max_speakers:
        # Keep top max_speakers by count
        top_labels = unique_labels[np.argsort(-counts)[:max_speakers]]
        # Remap minority labels to the nearest centroid among top_labels
        centroids = {lbl: X[labels == lbl].mean(axis=0) for lbl in top_labels}
        for i, lbl in enumerate(labels):
            if lbl not in top_labels:
                # Assign to nearest top-label centroid
                dists = {tl: np.linalg.norm(X[i] - c) for tl, c in centroids.items()}
                labels[i] = min(dists, key=dists.get)  # type: ignore[arg-type]

    return labels


# ── Step 6: Merge adjacent same-speaker segments ──────────────────────────────
def merge_same_speaker(
    segs: list[tuple[float, float]],
    labels: np.ndarray,
    gap_sec: float = 0.5,
) -> list[dict]:
    """
    Merge consecutive segments with the same speaker if gap < gap_sec.
    """
    if not segs or len(labels) == 0:
        return []

    merged: list[dict] = []
    cur_start, cur_end = segs[0]
    cur_label = int(labels[0])

    for i in range(1, len(segs)):
        seg_start, seg_end = segs[i]
        seg_label = int(labels[i])
        gap = seg_start - cur_end

        if seg_label == cur_label and gap < gap_sec:
            cur_end = seg_end  # extend current
        else:
            merged.append({
                "speaker":  f"SPEAKER_{cur_label}",
                "start":    round(cur_start, 3),
                "end":      round(cur_end, 3),
                "duration": round(cur_end - cur_start, 3),
            })
            cur_start = seg_start
            cur_end   = seg_end
            cur_label = seg_label

    merged.append({
        "speaker":  f"SPEAKER_{cur_label}",
        "start":    round(cur_start, 3),
        "end":      round(cur_end, 3),
        "duration": round(cur_end - cur_start, 3),
    })

    return merged


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="Offline speaker diarization via MFCC + agglomerative clustering")
    parser.add_argument("input_path", help="Path to audio or video file")
    parser.add_argument("--num_speakers", type=int, default=None,
                        help="Known number of speakers (omit for auto-detect)")
    parser.add_argument("--max_speakers", type=int, default=8,
                        help="Maximum speakers to detect (default 8)")
    parser.add_argument("--min_segment_sec", type=float, default=0.5,
                        help="Minimum speech segment duration in seconds (default 0.5)")
    args = parser.parse_args()

    # Step 1: extract wav
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        try:
            extract_wav(args.input_path, tmp_path)
        except subprocess.CalledProcessError as e:
            print(json.dumps({"error": f"ffmpeg failed: {e}"}))
            sys.exit(1)

        # Step 2: load
        y, sr = librosa.load(tmp_path, sr=SAMPLE_RATE, mono=True)
        duration = len(y) / sr

        # Step 3: VAD
        vad_mask = compute_vad_mask(y, sr)
        speech_segs = speech_segments(vad_mask, sr, min_seg_sec=args.min_segment_sec)

        if len(speech_segs) == 0:
            print(json.dumps({
                "speakers": [],
                "num_speakers": 0,
                "segments": [],
                "duration": round(duration, 3),
                "method": "mfcc_agglomerative",
                "note": "No speech detected",
            }))
            return

        # Step 4: embed
        embeddings = np.stack([
            embed_segment(y, sr, s, e) for s, e in speech_segs
        ])

        # Step 5: cluster
        labels = cluster_speakers(
            embeddings,
            num_speakers=args.num_speakers,
            max_speakers=args.max_speakers,
        )

        # Step 6: merge
        merged = merge_same_speaker(speech_segs, labels)

        unique_speakers = sorted({seg["speaker"] for seg in merged})
        num_speakers_found = len(unique_speakers)

        print(json.dumps({
            "speakers":    unique_speakers,
            "num_speakers": num_speakers_found,
            "segments":    merged,
            "duration":    round(duration, 3),
            "method":      "mfcc_agglomerative",
        }))

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
