#!/usr/bin/env python3
"""
Master neural analysis orchestrator.
Runs all available models on a video and returns comprehensive analysis.
Usage: python3 neural_analyze.py <video_path> [--mode full|fast|beats|aesthetic|emotion|diversity|shots]
"""
import sys
import json
import os
import subprocess
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def run_script(script_name: str, video_path: str, extra_args: list = [], timeout: int = 120) -> dict:
    """Run a neural analysis sub-script and return its JSON output."""
    script_path = os.path.join(SCRIPT_DIR, script_name)
    if not os.path.exists(script_path):
        return {"error": f"Script not found: {script_name}"}

    try:
        result = subprocess.run(
            [sys.executable, script_path, video_path] + extra_args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()[:400]
            return {"error": f"{script_name} failed (code {result.returncode}): {stderr}"}

        stdout = result.stdout.strip()
        if not stdout:
            return {"error": f"{script_name} produced no output"}

        return json.loads(stdout)
    except subprocess.TimeoutExpired:
        return {"error": f"{script_name} timed out after {timeout}s"}
    except json.JSONDecodeError as e:
        return {"error": f"{script_name} JSON parse error: {e}"}
    except Exception as e:
        return {"error": str(e)}


def run_all(video_path: str, mode: str = "full") -> dict:
    """Run all or subset of neural analyses."""
    results = {
        "video_path": video_path,
        "mode": mode,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    t0 = time.time()

    if mode in ("full", "clips", "shots"):
        t = time.time()
        shot_result = run_script("shot_detect.py", video_path, timeout=90)
        results["shots"] = shot_result
        results["shots_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "clips", "aesthetic"):
        t = time.time()
        aesthetic_result = run_script("aesthetic.py", video_path, timeout=60)
        results["aesthetic"] = aesthetic_result
        results["aesthetic_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "clips", "emotion"):
        t = time.time()
        emotion_result = run_script("emotion.py", video_path, timeout=120)
        results["emotion"] = emotion_result
        results["emotion_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "clips", "speech_emotion"):
        t = time.time()
        speech_result = run_script("speech_emotion.py", video_path, timeout=90)
        results["speech_emotion"] = speech_result
        results["speech_emotion_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "beats"):  # not in "clips" mode
        t = time.time()
        beat_result = run_script("beat_detect.py", video_path, timeout=120)
        results["beats"] = beat_result
        results["beats_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "clips", "diversity"):
        t = time.time()
        diversity_result = run_script("diversity.py", video_path, timeout=60)
        results["diversity"] = diversity_result
        results["diversity_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "clips", "speakers"):
        t = time.time()
        speaker_result = run_script("speaker_turn.py", video_path, timeout=90)
        results["speakers"] = speaker_result
        results["speakers_time_ms"] = round((time.time() - t) * 1000)

    if mode in ("full", "clips", "filler"):
        t = time.time()
        # filler_detect needs the transcript sidecar; it degrades gracefully without it
        filler_result = run_script("filler_detect.py", video_path, timeout=30)
        results["filler"] = filler_result
        results["filler_time_ms"] = round((time.time() - t) * 1000)

    results["total_time_ms"] = round((time.time() - t0) * 1000)

    # --- Synthesize top-level scores ---
    scores = {}

    aesthetic = results.get("aesthetic", {})
    if "visual_quality" in aesthetic:
        scores["visual_quality"] = aesthetic["visual_quality"]
    if "hook_score" in aesthetic:
        scores["hook_score_visual"] = aesthetic["hook_score"]
    if "has_faces" in aesthetic:
        scores["has_faces"] = aesthetic["has_faces"]

    emotion = results.get("emotion", {})
    if "emotion_score" in emotion:
        scores["emotion_score_face"] = emotion["emotion_score"]
    if "valence" in emotion:
        scores["face_valence"] = emotion["valence"]
    if "dominant_emotion" in emotion:
        scores["dominant_emotion"] = emotion["dominant_emotion"]

    speech = results.get("speech_emotion", {})
    if "emotion_score" in speech:
        scores["emotion_score_audio"] = speech["emotion_score"]
    if "arousal" in speech:
        scores["audio_arousal"] = speech["arousal"]
    if "valence" in speech:
        scores["audio_valence"] = speech["valence"]
    if "has_speech" in speech:
        scores["has_speech"] = speech["has_speech"]

    beats = results.get("beats", {})
    if "bpm" in beats:
        scores["bpm"] = beats["bpm"]
    if "method" in beats:
        scores["beat_method"] = beats["method"]

    diversity = results.get("diversity", {})
    if "diversity_score" in diversity:
        scores["diversity_score"] = diversity["diversity_score"]
    if "scene_count_estimate" in diversity:
        scores["scene_count"] = diversity["scene_count_estimate"]
    if "has_repeated_footage" in diversity:
        scores["has_repeated_footage"] = diversity["has_repeated_footage"]

    shots = results.get("shots", {})
    if "shot_count" in shots:
        scores["detected_shot_count"] = shots["shot_count"]

    speakers = results.get("speakers", {})
    if "speaker_count" in speakers:
        scores["speaker_count"] = speakers["speaker_count"]
    if "turn_count" in speakers:
        scores["speaker_turn_count"] = speakers["turn_count"]
    if "avg_turn_duration" in speakers:
        scores["avg_speaker_turn_duration"] = speakers["avg_turn_duration"]

    filler = results.get("filler", {})
    if "filler_count" in filler:
        scores["filler_count"] = filler["filler_count"]
    if "filler_rate_per_minute" in filler:
        scores["filler_rate_per_minute"] = filler["filler_rate_per_minute"]
    if "has_heavy_filler" in filler:
        scores["has_heavy_filler"] = filler["has_heavy_filler"]
    if "clean_rate" in filler:
        scores["clean_rate"] = filler["clean_rate"]

    # Synthesize combined emotion score (face + audio)
    emotion_values = []
    if "emotion_score_face" in scores:
        emotion_values.append(scores["emotion_score_face"])
    if "emotion_score_audio" in scores:
        emotion_values.append(scores["emotion_score_audio"])
    if emotion_values:
        scores["emotion_score"] = round(sum(emotion_values) / len(emotion_values), 4)

    # Synthesize combined hook score
    hook_values = []
    if "hook_score_visual" in scores:
        hook_values.append(scores["hook_score_visual"])
    hook_audio = speech.get("arousal", None)
    if hook_audio is not None:
        hook_values.append(hook_audio)
    if hook_values:
        scores["hook_score"] = round(sum(hook_values) / len(hook_values), 4)

    results["synthesized_scores"] = scores

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: neural_analyze.py <video_path> [--mode MODE]"}))
        sys.exit(1)

    video_path = sys.argv[1]
    mode = "full"
    if "--mode" in sys.argv:
        try:
            mode = sys.argv[sys.argv.index("--mode") + 1]
        except Exception:
            pass

    if not os.path.exists(video_path):
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    result = run_all(video_path, mode)
    print(json.dumps(result))
