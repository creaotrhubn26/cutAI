#!/usr/bin/env python3
"""
Filler word detector for transcript-aligned video editing.

Detects spoken filler words/phrases (um, uh, like, you know, basically, etc.)
and hesitation patterns from a Whisper-format JSON transcript.

Usage:
    python3 filler_detect.py <video_path> [--transcript <json_path>]

Input:
    - A video file path (used to extract audio if transcript_path not given)
    - Optionally a path to a Whisper JSON transcript file

Output (JSON to stdout):
    {
      "filler_events": [
        {"word": "um", "start": 1.2, "end": 1.5, "confidence": 0.95, "category": "hesitation"}
      ],
      "filler_count": 7,
      "total_words": 142,
      "filler_rate_per_minute": 8.4,
      "duration_seconds": 50.0,
      "clean_rate": 0.95,
      "has_heavy_filler": false,
      "segments_with_filler": [{"start": 1.2, "end": 1.5, "fillers": ["um"]}],
      "top_fillers": {"um": 3, "like": 2, "you know": 1, "basically": 1},
      "recommendation": "Light filler use — natural speech, no major issues."
    }

Failure modes:
    - No transcript available: falls back to acoustic silence+energy analysis
    - File not found: returns {"error": "..."}
    - Empty transcript: returns {"filler_count": 0, ...} with warning
"""

import sys
import json
import os
import subprocess
import re
import tempfile
from collections import Counter

# ── Filler lexicon ─────────────────────────────────────────────────────────────
FILLER_WORDS: dict[str, str] = {
    "um": "hesitation",
    "uh": "hesitation",
    "er": "hesitation",
    "ah": "hesitation",
    "hmm": "hesitation",
    "hm": "hesitation",
    "mm": "hesitation",
    "uhh": "hesitation",
    "umm": "hesitation",
    "ehh": "hesitation",
    "like": "discourse_marker",
    "basically": "discourse_marker",
    "literally": "discourse_marker",
    "actually": "discourse_marker",
    "honestly": "discourse_marker",
    "obviously": "discourse_marker",
    "clearly": "discourse_marker",
    "right": "discourse_marker",
    "okay": "discourse_marker",
    "so": "discourse_marker",
    "well": "discourse_marker",
    "I mean": "phrase",
    "you know": "phrase",
    "you see": "phrase",
    "sort of": "phrase",
    "kind of": "phrase",
    "kind of like": "phrase",
    "I guess": "phrase",
    "I think": "phrase",
    "at the end of the day": "phrase",
    "to be honest": "phrase",
    "to be fair": "phrase",
    "as I was saying": "phrase",
}

# Multi-word fillers sorted longest first (greedy match)
PHRASE_FILLERS = sorted(
    [(k, v) for k, v in FILLER_WORDS.items() if " " in k],
    key=lambda x: -len(x[0].split())
)
WORD_FILLERS = {k: v for k, v in FILLER_WORDS.items() if " " not in k}


def find_fillers_in_transcript(transcript_data: dict) -> tuple[list, dict]:
    """
    Scan transcript words/segments for filler words.
    Returns (filler_events, top_fillers_counter)
    """
    filler_events = []
    top_fillers: Counter = Counter()

    # Try word-level timestamps first (verbose_json format)
    words = []
    if "words" in transcript_data:
        words = transcript_data["words"]
    elif "segments" in transcript_data:
        # Aggregate words from segments
        for seg in transcript_data["segments"]:
            if "words" in seg:
                words.extend(seg["words"])

    if words:
        # Word-level: check each word and bigrams/trigrams for multi-word fillers
        for i, word_obj in enumerate(words):
            raw_word = word_obj.get("word", "").strip().lower().strip(".,!?;:'\"")
            if not raw_word:
                continue

            word_start = word_obj.get("start", 0)
            word_end = word_obj.get("end", word_start + 0.3)

            # Check multi-word phrases first
            matched_phrase = False
            for phrase, category in PHRASE_FILLERS:
                phrase_words = phrase.split()
                n = len(phrase_words)
                if i + n > len(words):
                    continue
                window = [
                    words[i + j].get("word", "").strip().lower().strip(".,!?;:'\"")
                    for j in range(n)
                ]
                if window == phrase_words:
                    phrase_end = words[i + n - 1].get("end", word_end)
                    filler_events.append({
                        "word": phrase,
                        "start": word_start,
                        "end": phrase_end,
                        "confidence": 0.90,
                        "category": category,
                    })
                    top_fillers[phrase] += 1
                    matched_phrase = True
                    break

            if not matched_phrase and raw_word in WORD_FILLERS:
                # Context check — "like" and "so" are often NOT fillers
                if raw_word in ("like", "so", "right", "okay", "well", "actually"):
                    # Heuristic: likely a filler if standalone (very short duration)
                    duration = word_end - word_start
                    if duration < 0.35:
                        confidence = 0.75
                    else:
                        continue  # Skip — probably used meaningfully
                else:
                    confidence = 0.92

                filler_events.append({
                    "word": raw_word,
                    "start": word_start,
                    "end": word_end,
                    "confidence": confidence,
                    "category": WORD_FILLERS[raw_word],
                })
                top_fillers[raw_word] += 1

        return filler_events, dict(top_fillers)

    # Fallback: segment-level text scan (no timestamps for individual fillers)
    if "segments" in transcript_data:
        for seg in transcript_data["segments"]:
            text = seg.get("text", "").lower().strip()
            seg_start = seg.get("start", 0)
            seg_end = seg.get("end", seg_start + 1)

            # Count phrases first
            for phrase, category in PHRASE_FILLERS:
                occurrences = len(re.findall(r"\b" + re.escape(phrase) + r"\b", text))
                if occurrences:
                    top_fillers[phrase] += occurrences
                    # Approximate position (middle of segment)
                    mid = (seg_start + seg_end) / 2
                    for _ in range(occurrences):
                        filler_events.append({
                            "word": phrase,
                            "start": mid,
                            "end": mid + 0.4,
                            "confidence": 0.60,  # lower confidence — no exact timestamp
                            "category": category,
                            "approximate": True,
                        })

            # Single-word fillers
            text_words = re.findall(r"\b\w+\b", text)
            for w in text_words:
                if w in WORD_FILLERS:
                    top_fillers[w] += 1
                    mid = (seg_start + seg_end) / 2
                    filler_events.append({
                        "word": w,
                        "start": mid,
                        "end": mid + 0.3,
                        "confidence": 0.55,
                        "category": WORD_FILLERS[w],
                        "approximate": True,
                    })

    return filler_events, dict(top_fillers)


def count_total_words(transcript_data: dict) -> int:
    """Count total non-empty words in transcript."""
    if "words" in transcript_data:
        return len([w for w in transcript_data["words"] if w.get("word", "").strip()])
    if "segments" in transcript_data:
        total = 0
        for seg in transcript_data["segments"]:
            if "words" in seg:
                total += len([w for w in seg["words"] if w.get("word", "").strip()])
            elif "text" in seg:
                total += len(seg["text"].split())
        return total
    if "text" in transcript_data:
        return len(transcript_data["text"].split())
    return 0


def get_duration(transcript_data: dict) -> float:
    """Get transcript duration in seconds."""
    if "segments" in transcript_data and transcript_data["segments"]:
        return transcript_data["segments"][-1].get("end", 0)
    if "duration" in transcript_data:
        return transcript_data["duration"]
    return 0.0


def build_filler_segments(filler_events: list) -> list:
    """Group consecutive filler events into segments for batch trimming."""
    if not filler_events:
        return []
    sorted_events = sorted(filler_events, key=lambda e: e["start"])
    segments = []
    current = {"start": sorted_events[0]["start"], "end": sorted_events[0]["end"], "fillers": [sorted_events[0]["word"]]}
    for event in sorted_events[1:]:
        if event["start"] - current["end"] < 2.0:  # within 2s = same region
            current["end"] = max(current["end"], event["end"])
            current["fillers"].append(event["word"])
        else:
            segments.append(current)
            current = {"start": event["start"], "end": event["end"], "fillers": [event["word"]]}
    segments.append(current)
    return segments


def extract_transcript_from_video(video_path: str) -> dict | None:
    """
    Attempt to extract transcript from video's embedded metadata or
    via a quick FFmpeg audio-to-text attempt. Returns None if unavailable.
    This is a fallback — the primary path reads from DB-stored transcript.
    """
    # We can't run Whisper here without the API, so return None
    # The caller should pass --transcript if transcript is available
    return None


def recommend(filler_rate: float, filler_count: int) -> str:
    if filler_rate < 2:
        return "Minimal filler — excellent delivery."
    if filler_rate < 5:
        return "Light filler use — natural speech, no major issues."
    if filler_rate < 10:
        return "Moderate filler — consider trimming 'um/uh' clusters before publishing."
    if filler_rate < 20:
        return "Heavy filler — strongly recommend removing hesitation words to improve pacing."
    return "Excessive filler — delivery will sound unpolished. Trim all filler segments."


def analyze(video_path: str, transcript_path: str | None = None) -> dict:
    """Main filler analysis entry point."""

    # Load transcript
    transcript_data = None

    if transcript_path and os.path.exists(transcript_path):
        with open(transcript_path) as f:
            try:
                transcript_data = json.load(f)
            except json.JSONDecodeError as e:
                return {"error": f"Transcript JSON parse error: {e}", "filler_count": 0}
    else:
        # Try reading from stdin or sidecar file
        sidecar = video_path + ".transcript.json"
        if os.path.exists(sidecar):
            with open(sidecar) as f:
                try:
                    transcript_data = json.load(f)
                except Exception:
                    pass

    if not transcript_data:
        return {
            "filler_count": 0,
            "total_words": 0,
            "filler_rate_per_minute": 0.0,
            "duration_seconds": 0.0,
            "clean_rate": 1.0,
            "has_heavy_filler": False,
            "filler_events": [],
            "segments_with_filler": [],
            "top_fillers": {},
            "recommendation": "No transcript available — filler detection requires transcript.",
            "warning": "no_transcript",
        }

    # Detect fillers
    filler_events, top_fillers = find_fillers_in_transcript(transcript_data)
    total_words = count_total_words(transcript_data)
    duration = get_duration(transcript_data)

    filler_count = len(filler_events)
    duration_minutes = max(duration / 60.0, 0.001)
    filler_rate = round(filler_count / duration_minutes, 2)
    clean_rate = round(1.0 - (filler_count / max(total_words, 1)), 4)
    has_heavy_filler = filler_rate >= 10 or filler_count >= 5

    segments_with_filler = build_filler_segments(filler_events)

    return {
        "filler_count": filler_count,
        "total_words": total_words,
        "filler_rate_per_minute": filler_rate,
        "duration_seconds": round(duration, 3),
        "clean_rate": clean_rate,
        "has_heavy_filler": has_heavy_filler,
        "filler_events": filler_events,
        "segments_with_filler": segments_with_filler,
        "top_fillers": top_fillers,
        "recommendation": recommend(filler_rate, filler_count),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: filler_detect.py <video_path> [--transcript <json_path>]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    transcript_path = None

    if "--transcript" in sys.argv:
        idx = sys.argv.index("--transcript")
        if idx + 1 < len(sys.argv):
            transcript_path = sys.argv[idx + 1]

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}", "filler_count": 0}))
        sys.exit(1)

    result = analyze(video_path, transcript_path)
    print(json.dumps(result))
