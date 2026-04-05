#!/usr/bin/env python3
"""
Shot boundary detection using PySceneDetect.
Returns JSON with detected shot cuts and scene boundaries.
Usage: python3 shot_detect.py <video_path>
"""
import sys
import json
import os

def detect_shots(video_path: str) -> dict:
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import ContentDetector, AdaptiveDetector
    except ImportError as e:
        return {"error": f"PySceneDetect not available: {e}", "shots": []}

    if not os.path.exists(video_path):
        return {"error": f"Video not found: {video_path}", "shots": []}

    try:
        video = open_video(video_path)
        scene_manager = SceneManager()
        scene_manager.add_detector(AdaptiveDetector(adaptive_threshold=3.0, min_scene_len=15))
        scene_manager.detect_scenes(video, show_progress=False)
        scenes = scene_manager.get_scene_list()

        shots = []
        for i, (start, end) in enumerate(scenes):
            shots.append({
                "index": i,
                "start_time": round(start.get_seconds(), 3),
                "end_time": round(end.get_seconds(), 3),
                "duration": round((end - start).get_seconds(), 3),
                "start_frame": start.get_frames(),
                "end_frame": end.get_frames(),
            })

        video_duration = None
        try:
            video2 = open_video(video_path)
            fps = video2.frame_rate
            total_frames = video2.duration.get_frames()
            video_duration = round(total_frames / fps, 3) if fps > 0 else None
        except Exception:
            pass

        return {
            "shots": shots,
            "shot_count": len(shots),
            "video_duration": video_duration,
            "detector": "AdaptiveDetector",
        }
    except Exception as e:
        return {"error": str(e), "shots": []}


def detect_shots_simple(video_path: str) -> dict:
    """Fallback: use ContentDetector with threshold."""
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import ContentDetector
    except ImportError as e:
        return {"error": str(e), "shots": []}

    try:
        video = open_video(video_path)
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=27.0, min_scene_len=15))
        scene_manager.detect_scenes(video, show_progress=False)
        scenes = scene_manager.get_scene_list()

        shots = []
        for i, (start, end) in enumerate(scenes):
            shots.append({
                "index": i,
                "start_time": round(start.get_seconds(), 3),
                "end_time": round(end.get_seconds(), 3),
                "duration": round((end - start).get_seconds(), 3),
            })

        return {"shots": shots, "shot_count": len(shots), "detector": "ContentDetector"}
    except Exception as e:
        return {"error": str(e), "shots": []}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: shot_detect.py <video_path>"}))
        sys.exit(1)

    video_path = sys.argv[1]
    result = detect_shots(video_path)

    if result.get("error") and not result.get("shots"):
        result = detect_shots_simple(video_path)

    print(json.dumps(result))
