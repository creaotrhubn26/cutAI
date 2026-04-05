import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Play, Pause, Volume2, VolumeX, SkipBack, SkipForward, Maximize2, Minimize2, Grid3X3, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GraphicOverlay {
  id: string;
  type: "headline" | "lower_third" | "cta_badge" | "social_handle" | "product_label" | "quote";
  text: string;
  subtext?: string | null;
  position: "top-left" | "top-center" | "top-right" | "center" | "bottom-left" | "bottom-center" | "bottom-right";
  fontFamily: "impact" | "montserrat" | "playfair" | "oswald" | "bebas-neue";
  fontSize: "small" | "medium" | "large" | "hero";
  textColor: string;
  backgroundColor: string;
  backgroundStyle: "none" | "pill" | "box" | "gradient-bar";
  colorScheme: string;
  animationIn: "fade" | "slide-up" | "pop" | "none";
  reason?: string;
  applied: boolean;
}

export interface PlayerSegment {
  id: string;
  videoId: string;
  startTime: number;
  endTime: number;
  captionText?: string | null;
  colorGrade?: string | null;
  speedFactor?: number | null;
  orderIndex: number;
  graphicOverlays?: string | null;
}

export interface PlayerVideo {
  id: string;
  originalName: string;
  mimeType?: string | null;
  durationSeconds?: number | null;
}

interface VideoPlayerProps {
  segments: PlayerSegment[];
  videos: PlayerVideo[];
  activeSegmentId?: string | null;
  onSegmentChange?: (segmentId: string) => void;
  onSegmentIndexChange?: (index: number, progress: number) => void;
  liveBuilding?: boolean;
  apiBase?: string;
  className?: string;
  // #41 Safe area guides
  showSafeAreas?: boolean;
  onToggleSafeAreas?: () => void;
  // #42 Grid overlay
  showGrid?: boolean;
  onToggleGrid?: () => void;
  // target format hint for safe area calculations
  targetFormat?: string;
}

export function VideoPlayer({
  segments,
  videos,
  activeSegmentId,
  onSegmentChange,
  onSegmentIndexChange,
  liveBuilding = false,
  apiBase = "/api",
  className,
  showSafeAreas = false,
  onToggleSafeAreas,
  showGrid = false,
  onToggleGrid,
  targetFormat,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [segLocalTime, setSegLocalTime] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const isPortrait = naturalSize ? naturalSize.h > naturalSize.w : false;

  const includedSegments = useMemo(() =>
    segments.filter(s => s.videoId).sort((a, b) => a.orderIndex - b.orderIndex),
    [segments]
  );

  const videoById = useMemo(() =>
    Object.fromEntries(videos.map(v => [v.id, v])),
    [videos]
  );

  const segOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const s of includedSegments) {
      offsets.push(acc);
      acc += Math.max(0, s.endTime - s.startTime);
    }
    return offsets;
  }, [includedSegments]);

  const totalDuration = useMemo(() =>
    includedSegments.reduce((sum, s) => sum + Math.max(0, s.endTime - s.startTime), 0),
    [includedSegments]
  );

  const currentSeg = includedSegments[currentSegIdx] ?? null;
  const currentVideo = currentSeg ? videoById[currentSeg.videoId] : null;

  const globalTime = (segOffsets[currentSegIdx] ?? 0) + Math.max(0, segLocalTime - (currentSeg?.startTime ?? 0));
  const globalProgress = totalDuration > 0 ? Math.min(1, globalTime / totalDuration) : 0;

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60).toString().padStart(2, "0");
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const loadSegment = useCallback((idx: number, startPlaying?: boolean) => {
    if (idx < 0 || idx >= includedSegments.length) return;
    setCurrentSegIdx(idx);
    const seg = includedSegments[idx];
    if (!seg || !videoRef.current) return;

    const shouldPlay = startPlaying ?? isPlaying;

    if (videoRef.current.dataset.videoId !== seg.videoId) {
      videoRef.current.dataset.videoId = seg.videoId;
      videoRef.current.src = `${apiBase}/videos/${seg.videoId}/stream`;
      videoRef.current.load();
    }
    videoRef.current.currentTime = seg.startTime;

    if (shouldPlay) {
      videoRef.current.play().catch(() => {});
    }

    onSegmentChange?.(seg.id);
    onSegmentIndexChange?.(idx, 0);
  }, [includedSegments, apiBase, isPlaying, onSegmentChange, onSegmentIndexChange]);

  useEffect(() => {
    if (!activeSegmentId) return;
    const idx = includedSegments.findIndex(s => s.id === activeSegmentId);
    if (idx >= 0 && idx !== currentSegIdx) loadSegment(idx);
  }, [activeSegmentId]);

  useEffect(() => {
    const seg = includedSegments[0];
    if (!seg || !videoRef.current) return;
    videoRef.current.dataset.videoId = seg.videoId;
    videoRef.current.src = `${apiBase}/videos/${seg.videoId}/stream`;
    videoRef.current.load();
    videoRef.current.currentTime = seg.startTime;
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const vid = videoRef.current;
    const seg = currentSeg;
    if (!vid || !seg) return;

    setSegLocalTime(vid.currentTime);

    const segDur = seg.endTime - seg.startTime;
    const progress = segDur > 0 ? Math.max(0, Math.min(1, (vid.currentTime - seg.startTime) / segDur)) : 0;
    onSegmentIndexChange?.(currentSegIdx, progress);

    if (vid.currentTime >= seg.endTime - 0.08) {
      const next = currentSegIdx + 1;
      if (next < includedSegments.length) {
        loadSegment(next, true);
      } else {
        vid.pause();
        setIsPlaying(false);
      }
    }
  }, [currentSeg, currentSegIdx, includedSegments, loadSegment, onSegmentIndexChange]);

  const handleLoadedMetadata = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.videoWidth && vid.videoHeight) {
      setNaturalSize({ w: vid.videoWidth, h: vid.videoHeight });
    }
  }, []);

  const handleLoadedData = useCallback(() => {
    if (!videoRef.current || !currentSeg) return;
    videoRef.current.currentTime = currentSeg.startTime;
    if (isPlaying) videoRef.current.play().catch(() => {});
  }, [currentSeg, isPlaying]);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setIsMuted(videoRef.current.muted);
  }, []);

  const handleGlobalScrub = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current || totalDuration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = frac * totalDuration;

    let segIdx = 0;
    for (let i = 0; i < segOffsets.length; i++) {
      const segEnd = (segOffsets[i] ?? 0) + Math.max(0, (includedSegments[i]?.endTime ?? 0) - (includedSegments[i]?.startTime ?? 0));
      if (targetTime <= segEnd) { segIdx = i; break; }
      if (i === segOffsets.length - 1) segIdx = i;
    }

    const seg = includedSegments[segIdx];
    if (!seg) return;
    const timeWithinSeg = Math.max(0, targetTime - (segOffsets[segIdx] ?? 0));
    const seekTarget = seg.startTime + timeWithinSeg;

    if (segIdx !== currentSegIdx) {
      setCurrentSegIdx(segIdx);
      if (videoRef.current.dataset.videoId !== seg.videoId) {
        videoRef.current.dataset.videoId = seg.videoId;
        videoRef.current.src = `${apiBase}/videos/${seg.videoId}/stream`;
        videoRef.current.load();
        videoRef.current.addEventListener("loadeddata", () => {
          if (videoRef.current) videoRef.current.currentTime = seekTarget;
        }, { once: true });
        return;
      }
    }

    videoRef.current.currentTime = seekTarget;
    onSegmentChange?.(seg.id);
  }, [totalDuration, segOffsets, includedSegments, currentSegIdx, apiBase, onSegmentChange]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 2500);
  }, [isPlaying]);

  useEffect(() => () => clearTimeout(controlsTimerRef.current), []);

  useEffect(() => {
    const onFull = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFull);
    return () => document.removeEventListener("fullscreenchange", onFull);
  }, []);

  if (includedSegments.length === 0) {
    return (
      <div className={cn("relative bg-black flex items-center justify-center text-zinc-500 text-xs", className)}>
        <div className="text-center">
          <div className="text-2xl mb-2">▶</div>
          <div>No segments — Generate Edit Plan first</div>
        </div>
      </div>
    );
  }

  const clipDuration = currentSeg ? Math.max(0, currentSeg.endTime - currentSeg.startTime) : 0;
  const clipProgress = clipDuration > 0
    ? Math.max(0, Math.min(1, (segLocalTime - (currentSeg?.startTime ?? 0)) / clipDuration))
    : 0;

  const portraitFrameStyle: React.CSSProperties = isPortrait && naturalSize
    ? {
        aspectRatio: `${naturalSize.w} / ${naturalSize.h}`,
        maxWidth: `calc(100% * ${naturalSize.w} / ${naturalSize.h})`,
        maxHeight: "100%",
        width: "auto",
        height: "100%",
      }
    : { width: "100%", height: "100%" };

  // ── #41 Safe area percentages (broadcast standard) ───────────────────────
  // Action safe = 5% margin on each side (90% of frame)
  // Title safe  = 10% margin (80% of frame)
  // For 9:16 (portrait), add a 16:9 "4K safe" box at centre
  const isPortraitFormat = isPortrait ||
    ["instagram_reel", "tiktok", "youtube_short"].includes(targetFormat ?? "");

  return (
    <div
      ref={containerRef}
      className={cn("relative bg-black group select-none flex items-center justify-center overflow-hidden", className)}
      onMouseMove={showControlsTemporarily}
      onMouseEnter={() => setShowControls(true)}
    >
      {/* Inner frame — portrait-constrained when needed */}
      <div className="relative" style={portraitFrameStyle}>
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={handleLoadedData}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onClick={togglePlay}
          muted={isMuted}
          style={{
            filter:
              currentSeg?.colorGrade === "warm" ? "sepia(0.4) saturate(1.2)" :
              currentSeg?.colorGrade === "cool" ? "hue-rotate(15deg) saturate(0.9)" :
              currentSeg?.colorGrade === "dramatic" ? "contrast(1.15) saturate(1.3)" :
              currentSeg?.colorGrade === "vintage" ? "sepia(0.6) contrast(0.9)" :
              currentSeg?.colorGrade === "cinematic" ? "contrast(1.1) brightness(0.95)" : "none",
          }}
        />

        {/* ── #42 GRID OVERLAY — rule of thirds ───────────────────────────── */}
        {showGrid && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none z-30"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {/* Rule-of-thirds: 2 vertical + 2 horizontal lines */}
            <line x1="33.33" y1="0" x2="33.33" y2="100" stroke="rgba(255,255,255,0.35)" strokeWidth="0.3" />
            <line x1="66.67" y1="0" x2="66.67" y2="100" stroke="rgba(255,255,255,0.35)" strokeWidth="0.3" />
            <line x1="0" y1="33.33" x2="100" y2="33.33" stroke="rgba(255,255,255,0.35)" strokeWidth="0.3" />
            <line x1="0" y1="66.67" x2="100" y2="66.67" stroke="rgba(255,255,255,0.35)" strokeWidth="0.3" />
            {/* Intersection crosshairs */}
            {[[33.33, 33.33], [66.67, 33.33], [33.33, 66.67], [66.67, 66.67]].map(([cx, cy], i) => (
              <g key={i}>
                <line x1={cx - 1.5} y1={cy} x2={cx + 1.5} y2={cy} stroke="rgba(255,220,0,0.8)" strokeWidth="0.4" />
                <line x1={cx} y1={cy - 1.5} x2={cx} y2={cy + 1.5} stroke="rgba(255,220,0,0.8)" strokeWidth="0.4" />
              </g>
            ))}
            {/* Centre cross */}
            <line x1="48" y1="50" x2="52" y2="50" stroke="rgba(255,255,255,0.4)" strokeWidth="0.3" />
            <line x1="50" y1="48" x2="50" y2="52" stroke="rgba(255,255,255,0.4)" strokeWidth="0.3" />
          </svg>
        )}

        {/* ── #41 SAFE AREA OVERLAYS ───────────────────────────────────────── */}
        {showSafeAreas && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none z-31"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {/* Action safe zone — 5% margin (90% frame) — cyan */}
            <rect
              x="5" y="5" width="90" height="90"
              fill="none"
              stroke="rgba(0,200,255,0.6)"
              strokeWidth="0.4"
              strokeDasharray="1,1"
            />
            {/* Title safe zone — 10% margin (80% frame) — yellow */}
            <rect
              x="10" y="10" width="80" height="80"
              fill="none"
              stroke="rgba(255,230,0,0.7)"
              strokeWidth="0.4"
              strokeDasharray="2,1"
            />
            {/* Centre mark */}
            <line x1="48.5" y1="50" x2="51.5" y2="50" stroke="rgba(255,255,255,0.5)" strokeWidth="0.3" />
            <line x1="50" y1="48.5" x2="50" y2="51.5" stroke="rgba(255,255,255,0.5)" strokeWidth="0.3" />
            {/* For portrait (9:16) — show the 16:9 "landscape safe" crop box in the centre third */}
            {isPortraitFormat && (
              <rect
                x="0" y="33.33" width="100" height="33.34"
                fill="rgba(255,0,0,0.04)"
                stroke="rgba(255,80,80,0.55)"
                strokeWidth="0.5"
                strokeDasharray="3,1.5"
              />
            )}
            {/* Labels (very small, positioned in corner) */}
            <text x="5.5" y="8.5" fill="rgba(0,200,255,0.8)" fontSize="3.2" fontFamily="monospace">Action safe</text>
            <text x="10.5" y="13.5" fill="rgba(255,230,0,0.8)" fontSize="3.2" fontFamily="monospace">Title safe</text>
            {isPortraitFormat && (
              <text x="1" y="46" fill="rgba(255,80,80,0.8)" fontSize="3" fontFamily="monospace">16:9 crop</text>
            )}
          </svg>
        )}

        {liveBuilding && (
          <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/70 px-2 py-1 rounded-full pointer-events-none z-10">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            <span className="text-white text-[10px] font-semibold tracking-wider uppercase">Live Edit</span>
          </div>
        )}

        {/* Portrait badge */}
        {isPortrait && (
          <div className="absolute top-2 right-2 bg-black/60 text-white/60 text-[8px] font-mono px-1.5 py-0.5 rounded pointer-events-none z-10">
            9:16
          </div>
        )}

        {/* Overlay toggle mini buttons — shown on hover in top-left */}
        <div className={cn(
          "absolute top-2 left-2 flex items-center gap-1 transition-opacity duration-200 z-40",
          showControls || !isPlaying ? "opacity-100" : "opacity-0"
        )}>
          {onToggleGrid && (
            <button
              onClick={e => { e.stopPropagation(); onToggleGrid(); }}
              className={cn(
                "h-5 w-5 rounded flex items-center justify-center transition-colors",
                showGrid ? "bg-amber-500/80 text-black" : "bg-black/50 text-white/50 hover:text-white hover:bg-black/70"
              )}
              title="#42 Rule-of-thirds grid overlay"
            >
              <Grid3X3 className="h-2.5 w-2.5" />
            </button>
          )}
          {onToggleSafeAreas && (
            <button
              onClick={e => { e.stopPropagation(); onToggleSafeAreas(); }}
              className={cn(
                "h-5 w-5 rounded flex items-center justify-center transition-colors",
                showSafeAreas ? "bg-cyan-500/80 text-black" : "bg-black/50 text-white/50 hover:text-white hover:bg-black/70"
              )}
              title="#41 Safe area guides — action safe (cyan) + title safe (yellow)"
            >
              <Shield className="h-2.5 w-2.5" />
            </button>
          )}
        </div>

        {currentSeg?.captionText && (
          <div className="absolute bottom-14 left-0 right-0 flex justify-center pointer-events-none">
            <div className="bg-black/75 text-white text-sm font-semibold px-3 py-1.5 rounded max-w-[80%] text-center leading-snug">
              {currentSeg.captionText}
            </div>
          </div>
        )}

        {/* Graphic overlays */}
        {(() => {
          if (!currentSeg?.graphicOverlays) return null;
          let overlays: GraphicOverlay[] = [];
          try { overlays = JSON.parse(currentSeg.graphicOverlays as string); } catch { return null; }
          const applied = overlays.filter(o => o.applied);
          if (!applied.length) return null;

          const posClass: Record<string, string> = {
            "top-left":     "top-3 left-3 items-start",
            "top-center":   "top-3 left-0 right-0 items-center",
            "top-right":    "top-3 right-3 items-end",
            "center":       "inset-0 items-center justify-center",
            "bottom-left":  "bottom-16 left-3 items-start",
            "bottom-center":"bottom-16 left-0 right-0 items-center",
            "bottom-right": "bottom-16 right-3 items-end",
          };
          const fontMap: Record<string, string> = {
            "impact":        "font-black uppercase tracking-wide",
            "montserrat":    "font-semibold tracking-tight",
            "playfair":      "font-semibold italic",
            "oswald":        "font-bold uppercase tracking-widest",
            "bebas-neue":    "font-black uppercase tracking-widest",
          };
          const sizeMap: Record<string, string> = {
            small:  "text-xs",
            medium: "text-base",
            large:  "text-xl",
            hero:   "text-3xl",
          };
          const bgStyleClass: Record<string, string> = {
            none:           "bg-transparent",
            pill:           "px-4 py-1.5 rounded-full",
            box:            "px-3 py-2 rounded",
            "gradient-bar": "px-4 py-2 rounded",
          };

          return applied.map(ov => {
            const pos = posClass[ov.position] ?? "bottom-16 left-0 right-0 items-center";
            const isAbsolute = ov.position !== "center";
            return (
              <div
                key={ov.id}
                className={`absolute flex flex-col pointer-events-none z-20 ${isAbsolute ? pos.split(" ").filter(c => !c.startsWith("items-")).join(" ") + " flex" : "inset-0 flex items-center justify-center"}`}
                style={{ pointerEvents: "none" }}
              >
                <div
                  className={`${bgStyleClass[ov.backgroundStyle] ?? "px-3 py-1.5 rounded"} ${fontMap[ov.fontFamily] ?? ""} ${sizeMap[ov.fontSize] ?? "text-base"}`}
                  style={{
                    color: ov.textColor ?? "#ffffff",
                    background: ov.backgroundStyle === "gradient-bar"
                      ? `linear-gradient(to right, ${ov.backgroundColor ?? "rgba(0,0,0,0.8)"}, transparent)`
                      : ov.backgroundColor ?? "transparent",
                    textShadow: ov.backgroundStyle === "none" ? "0 1px 4px rgba(0,0,0,0.9)" : undefined,
                  }}
                >
                  {ov.text}
                  {ov.subtext && (
                    <div className="text-xs opacity-80 font-normal normal-case tracking-normal mt-0.5">
                      {ov.subtext}
                    </div>
                  )}
                </div>
              </div>
            );
          });
        })()}

        {!isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className="w-14 h-14 bg-black/50 rounded-full flex items-center justify-center pointer-events-auto cursor-pointer hover:bg-black/70 transition-colors"
              onClick={togglePlay}
            >
              <Play className="h-7 w-7 text-white fill-current ml-1" />
            </div>
          </div>
        )}

        <div className={cn(
          "absolute inset-x-0 bottom-0 transition-opacity duration-300",
          showControls || !isPlaying ? "opacity-100" : "opacity-0"
        )}>
          <div className="bg-gradient-to-t from-black/90 via-black/50 to-transparent px-3 pt-8 pb-2.5">

            <div className="mb-2">
              <div
                className="h-1 bg-white/20 rounded-full cursor-pointer relative group/bar hover:h-1.5 transition-all"
                onClick={handleGlobalScrub}
              >
                <div
                  className="h-full bg-primary rounded-full absolute top-0 left-0 transition-[width] duration-100"
                  style={{ width: `${globalProgress * 100}%` }}
                />
                {includedSegments.map((_, i) => {
                  const pct = totalDuration > 0 ? ((segOffsets[i] ?? 0) / totalDuration) * 100 : 0;
                  return i === 0 ? null : (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0 w-px bg-white/30"
                      style={{ left: `${pct}%` }}
                    />
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="text-white/70 hover:text-white transition-colors p-0.5"
                onClick={() => loadSegment(currentSegIdx - 1)}
                disabled={currentSegIdx === 0}
              >
                <SkipBack className="h-3.5 w-3.5" />
              </button>

              <button
                className="text-white hover:text-primary transition-colors"
                onClick={togglePlay}
              >
                {isPlaying
                  ? <Pause className="h-5 w-5 fill-current" />
                  : <Play className="h-5 w-5 fill-current" />
                }
              </button>

              <button
                className="text-white/70 hover:text-white transition-colors p-0.5"
                onClick={() => loadSegment(currentSegIdx + 1)}
                disabled={currentSegIdx >= includedSegments.length - 1}
              >
                <SkipForward className="h-3.5 w-3.5" />
              </button>

              <button className="text-white/70 hover:text-white transition-colors p-0.5 ml-0.5" onClick={toggleMute}>
                {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>

              <span className="text-white/70 text-[11px] font-mono ml-1 tabular-nums">
                {formatTime(globalTime)} <span className="text-white/35">/</span> {formatTime(totalDuration)}
              </span>

              <div className="ml-auto flex items-center gap-2">
                <span className="text-white/40 text-[10px]">
                  {currentSegIdx + 1}<span className="text-white/25">/</span>{includedSegments.length}
                </span>
                {currentVideo && (
                  <span className="text-white/30 text-[9px] max-w-[90px] truncate hidden sm:block">{currentVideo.originalName}</span>
                )}
                {currentSeg?.colorGrade && currentSeg.colorGrade !== "none" && (
                  <span className="text-[8px] bg-white/10 text-white/50 px-1 rounded">{currentSeg.colorGrade}</span>
                )}
                <button className="text-white/50 hover:text-white transition-colors p-0.5" onClick={toggleFullscreen}>
                  {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div className="mt-1 px-0.5">
              <div className="h-0.5 bg-white/10 rounded-full relative overflow-hidden">
                <div
                  className="h-full bg-white/30 rounded-full absolute top-0 left-0 transition-[width] duration-100"
                  style={{ width: `${clipProgress * 100}%` }}
                />
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="text-white/20 text-[8px]">clip {currentSegIdx + 1}</span>
                <span className="text-white/20 text-[8px]">{formatTime(clipDuration)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
