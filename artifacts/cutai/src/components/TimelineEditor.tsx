import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Scissors, Eye, EyeOff, Layers, RotateCcw } from "lucide-react";

// ─── Waveform ────────────────────────────────────────────────────────────────
function WaveformBar({ videoId, apiBase, color }: { videoId: string; apiBase: string; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/videos/${videoId}/waveform?points=80`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !canvasRef.current || !data?.waveform) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        const samples: number[] = data.waveform;
        const barW = width / samples.length;
        ctx.fillStyle = color + "80";
        for (let i = 0; i < samples.length; i++) {
          const amp = Math.min(1, samples[i]);
          const barH = Math.max(1, amp * height);
          ctx.fillRect(i * barW, (height - barH) / 2, Math.max(1, barW - 0.5), barH);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [videoId, apiBase, color]);
  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  speech: "#3b82f6", interview: "#6366f1", narration: "#8b5cf6",
  a_roll: "#3b82f6", music: "#a855f7", music_only: "#a855f7",
  highlight: "#eab308", action: "#f97316", transition: "#14b8a6",
  silence: "#6b7280", establishing: "#22c55e", reaction: "#ec4899",
  b_roll: "#0ea5e9", resolution: "#6366f1", opening: "#10b981",
  climax: "#ef4444", hook: "#f59e0b", build: "#3b82f6", resolve: "#6366f1",
};

function segColor(type: string, included: boolean): string {
  if (!included) return "#3a3a3a";
  return TYPE_COLORS[type] ?? "#4b5563";
}

const MIN_CLIP_SEC   = 0.5;
const HANDLE_WIDTH   = 8;
const TRACK_HEIGHT   = 68;   // video clip row height (was 60)
const AUDIO_TRACK_H  = 34;   // A1 audio waveform row
const MUSIC_TRACK_H  = 22;   // M music row
const HEADER_COL_W   = 52;   // fixed left label column
const RULER_HEIGHT   = 26;
const EXCL_HEIGHT    = 26;
const CLIP_GAP       = 2;   // visual gap between clips (px)
const SNAP_PX        = 8;   // pixel snap threshold

// ─── Types ───────────────────────────────────────────────────────────────────
interface SilenceTrimInfo {
  originalStart: number;
  originalEnd: number;
  startTrimmedSec: number;
  endTrimmedSec: number;
  trimmedAt: string;
}
function parseTrimInfo(raw: string | null | undefined): SilenceTrimInfo | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as SilenceTrimInfo; } catch { return null; }
}

export interface TLSegment {
  id: string;
  videoId: string;
  orderIndex: number;
  startTime: number;
  endTime: number;
  label?: string | null;
  segmentType: string;
  included: boolean;
  confidence?: number | null;
  silenceTrimInfo?: string | null;
}

export interface TLVideo {
  id: string;
  originalName: string;
  durationSeconds?: number | null;
}

interface ContextMenu { segId: string; x: number; y: number; }

// ─── Lane definitions ─────────────────────────────────────────────────────────
const LANE_DEFS = [
  { key: "dialogue", label: "DIALOGUE",  color: "#3b82f6", types: new Set(["speech","interview","narration","a_roll","talking_head","primary"]) },
  { key: "broll",    label: "B-ROLL",    color: "#0ea5e9", types: new Set(["b_roll","broll","establishing","reaction","hook"]) },
  { key: "music",    label: "MUSIC",     color: "#a855f7", types: new Set(["music","music_only","silence"]) },
  { key: "graphics", label: "GRAPHICS",  color: "#22c55e", types: new Set(["transition","action","climax","build","resolve","opening","highlight","motion_graphic","graphic","compound"]) },
] as const;
type LaneKey = typeof LANE_DEFS[number]["key"];
function laneFor(segmentType: string): LaneKey {
  const t = segmentType?.toLowerCase() ?? "";
  for (const lane of LANE_DEFS) {
    if (lane.types.has(t)) return lane.key;
  }
  return "dialogue"; // default
}

// ─── AI Job Labels ─────────────────────────────────────────────────────────
const JOB_LABELS: Record<string, { label: string; color: string }> = {
  analyze:              { label: "Analyserer video",         color: "#f59e0b" },
  generate_edit_plan:   { label: "Genererer redigeringsplan", color: "#a78bfa" },
  trim_silence:         { label: "Trimmer stillhet",         color: "#34d399" },
  render:               { label: "Renderer video",           color: "#60a5fa" },
  auto_assemble:        { label: "Setter sammen klipp",      color: "#fb923c" },
  detect_speech:        { label: "Gjenkjenner tale",         color: "#c084fc" },
  score_segments:       { label: "Vurderer segmenter",       color: "#f472b6" },
  apply_rules:          { label: "Bruker regler",            color: "#4ade80" },
  enhance_audio:        { label: "Forbedrer lyd",            color: "#38bdf8" },
  add_captions:         { label: "Legger til teksting",      color: "#fbbf24" },
  cut_intro:            { label: "Kutter intro",             color: "#f87171" },
  cut_outro:            { label: "Kutter outro",             color: "#f87171" },
  color_grade:          { label: "Fargegraderer",            color: "#fb923c" },
  stabilize:            { label: "Stabiliserer",             color: "#a3e635" },
};

interface TimelineEditorProps {
  segments: TLSegment[];
  videos: TLVideo[];
  selectedSegmentId?: string | null;
  onSelectSegment?: (id: string | null) => void;
  onTrimSegment?: (id: string, startTime: number, endTime: number) => void;
  onToggleIncluded?: (id: string, included: boolean) => void;
  onReorderSegments?: (orderedIds: string[]) => void;
  onScrubTo?: (outputTimeSec: number) => void;
  onResetTrim?: (id: string) => void;
  currentSegIndex?: number;
  segmentProgress?: number;
  liveBuilding?: boolean;
  activeJobType?: string;
  newestSegId?: string;
  apiBase?: string;
  className?: string;
  showLanes?: boolean;
  zoomToFitTrigger?: number;
  activeTool?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────
export function TimelineEditor({
  segments,
  videos,
  selectedSegmentId,
  onSelectSegment,
  onTrimSegment,
  onToggleIncluded,
  onReorderSegments,
  onScrubTo,
  onResetTrim,
  currentSegIndex = 0,
  segmentProgress = 0,
  liveBuilding = false,
  activeJobType,
  newestSegId,
  apiBase = "/api",
  className,
  showLanes = false,
  zoomToFitTrigger,
  activeTool = "select",
}: TimelineEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(1);
  const [localTimes, setLocalTimes] = useState<Record<string, { start: number; end: number }>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [skimPreview, setSkimPreview] = useState<{
    segId: string; videoId: string;
    t: number;          // source time in the video file
    outputTime: number; // output time in the edit sequence
    clientX: number; clientY: number;
  } | null>(null);
  // Skim preview is active when the trim/blade tool is selected
  const skimEnabled = activeTool === "trim" || activeTool === "blade";

  // Clear skim preview when tool changes away from trim/blade
  useEffect(() => {
    if (!skimEnabled) setSkimPreview(null);
  }, [skimEnabled]);

  // ── Scan-line animation when AI is running ────────────────────────────────
  const [scanX, setScanX] = useState(0);
  const scanRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!liveBuilding) {
      if (scanRafRef.current) cancelAnimationFrame(scanRafRef.current);
      setScanX(0);
      return;
    }
    const trackW = trackRef.current?.scrollWidth ?? 800;
    let x = 0;
    const SPEED = 80; // px per second
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      x = (x + SPEED * dt) % Math.max(1, trackW);
      setScanX(x);
      scanRafRef.current = requestAnimationFrame(tick);
    };
    scanRafRef.current = requestAnimationFrame(tick);
    return () => { if (scanRafRef.current) cancelAnimationFrame(scanRafRef.current); };
  }, [liveBuilding]);

  const videoById = useMemo(() => Object.fromEntries(videos.map(v => [v.id, v])), [videos]);
  const sorted = useMemo(() => [...segments].sort((a, b) => a.orderIndex - b.orderIndex), [segments]);
  const includedSegs = useMemo(() => sorted.filter(s => s.included), [sorted]);
  const excludedSegs = useMemo(() => sorted.filter(s => !s.included), [sorted]);

  const totalDuration = useMemo(
    () => includedSegs.reduce((acc, s) => acc + Math.max(0, s.endTime - s.startTime), 0),
    [includedSegs]
  );

  // ── pxPerSec accounts for visual gaps ─────────────────────────────────────
  const pxPerSec = useMemo(() => {
    const containerW = containerRef.current?.clientWidth ?? 800;
    const gapTotal = (includedSegs.length - 1) * CLIP_GAP;
    return ((containerW - gapTotal) / Math.max(0.1, totalDuration)) * zoom;
  }, [totalDuration, zoom, includedSegs.length, containerRef.current?.clientWidth]);

  const getSegTimes = useCallback((seg: TLSegment) => {
    const local = localTimes[seg.id];
    return { start: local?.start ?? seg.startTime, end: local?.end ?? seg.endTime };
  }, [localTimes]);

  // ── Total track width ──────────────────────────────────────────────────────
  const totalTrackWidthPx = useMemo(() => {
    const gapTotal = (includedSegs.length - 1) * CLIP_GAP;
    return Math.max(600, totalDuration * pxPerSec + gapTotal);
  }, [totalDuration, pxPerSec, includedSegs.length]);

  // ── Zoom-to-selection (fires when zoomToFitTrigger counter changes) ────────
  useEffect(() => {
    if (!zoomToFitTrigger || !selectedSegmentId) return;
    const seg = includedSegs.find(s => s.id === selectedSegmentId);
    if (!seg) return;
    const containerW = containerRef.current?.clientWidth ?? 800;
    const segDur = Math.max(0.1, seg.endTime - seg.startTime);
    let cumulativeDur = 0;
    for (const s of includedSegs) {
      if (s.id === selectedSegmentId) break;
      cumulativeDur += Math.max(0, s.endTime - s.startTime);
    }
    const newZoom = Math.min(12, Math.max(0.5, (0.5 * Math.max(0.1, totalDuration)) / segDur));
    setZoom(newZoom);
    setTimeout(() => {
      if (!trackRef.current) return;
      const newPxPerSec = (containerW / Math.max(0.1, totalDuration)) * newZoom;
      const clipStartPx = cumulativeDur * newPxPerSec;
      const clipWidthPx = segDur * newPxPerSec;
      trackRef.current.scrollLeft = Math.max(0, clipStartPx - (containerW - clipWidthPx) / 2);
    }, 30);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomToFitTrigger]);

  // ── Lane layout (for showLanes mode) ──────────────────────────────────────
  const activeLanes = useMemo(() => {
    if (!showLanes) return [];
    const usedKeys = new Set(includedSegs.map(s => laneFor(s.segmentType ?? "")));
    return LANE_DEFS.filter(l => usedKeys.has(l.key));
  }, [showLanes, includedSegs]);
  const LABEL_COL = showLanes ? 44 : 0; // px for lane label column

  // ── Snap points (all included clip edges) ─────────────────────────────────
  const snapPoints = useMemo(
    () => includedSegs.flatMap(s => [s.startTime, s.endTime]),
    [includedSegs]
  );
  function snapTime(t: number, excludeIds: string[], px: number): number {
    const threshold = SNAP_PX / px;
    for (const sp of snapPoints) {
      if (Math.abs(t - sp) < threshold) return sp;
    }
    return t;
  }

  // ── TRIM DRAG ──────────────────────────────────────────────────────────────
  const trimDrag = useRef<{
    segId: string; side: "left" | "right";
    startX: number; origStart: number; origEnd: number;
    pxPerSec: number; maxEnd: number;
  } | null>(null);

  const handleTrimDown = useCallback((e: React.MouseEvent, seg: TLSegment, side: "left" | "right") => {
    e.stopPropagation(); e.preventDefault();
    const times = getSegTimes(seg);
    const video = videoById[seg.videoId];
    trimDrag.current = {
      segId: seg.id, side, startX: e.clientX,
      origStart: times.start, origEnd: times.end,
      pxPerSec, maxEnd: video?.durationSeconds ?? times.end + 300,
    };
  }, [getSegTimes, videoById, pxPerSec]);

  // ── MOVE DRAG (reorder) ────────────────────────────────────────────────────
  const moveDrag = useRef<{
    segId: string; startX: number; startY: number; moved: boolean;
  } | null>(null);

  const handleClipDown = useCallback((e: React.MouseEvent, seg: TLSegment) => {
    if ((e.target as HTMLElement).dataset.handle) return; // trim handle
    moveDrag.current = { segId: seg.id, startX: e.clientX, startY: e.clientY, moved: false };
  }, []);

  // ── UNIFIED MOUSE EVENTS ───────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // Trim drag
      if (trimDrag.current) {
        const { segId, side, startX, origStart, origEnd, pxPerSec: px, maxEnd } = trimDrag.current;
        const delta = (e.clientX - startX) / px;
        setLocalTimes(prev => {
          const cur = prev[segId] ?? { start: origStart, end: origEnd };
          if (side === "left") {
            let ns = Math.max(0, Math.min(origStart + delta, cur.end - MIN_CLIP_SEC));
            ns = snapTime(ns, [segId], px);
            return { ...prev, [segId]: { start: parseFloat(ns.toFixed(3)), end: cur.end } };
          } else {
            let ne = Math.min(maxEnd, Math.max(cur.start + MIN_CLIP_SEC, origEnd + delta));
            ne = snapTime(ne, [segId], px);
            return { ...prev, [segId]: { start: cur.start, end: parseFloat(ne.toFixed(3)) } };
          }
        });
        return;
      }
      // Move drag (reorder)
      if (moveDrag.current) {
        const dx = e.clientX - moveDrag.current.startX;
        const dy = e.clientY - moveDrag.current.startY;
        if (!moveDrag.current.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        moveDrag.current.moved = true;
        setDraggingId(moveDrag.current.segId);
        // Compute which gap the cursor is nearest to
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const relX = e.clientX - rect.left + track.scrollLeft;
        // Walk through clips to find insert position
        let cx = 0;
        let foundIdx: number | null = null;
        for (let i = 0; i < includedSegs.length; i++) {
          const s = includedSegs[i];
          const dur = Math.max(0.1, (localTimes[s.id]?.end ?? s.endTime) - (localTimes[s.id]?.start ?? s.startTime));
          const w = dur * pxPerSec;
          const midX = cx + w / 2;
          if (relX < midX) { foundIdx = i; break; }
          cx += w + CLIP_GAP;
          foundIdx = i + 1;
        }
        setDropIdx(foundIdx);
      }
    };

    const onUp = (e: MouseEvent) => {
      // Commit trim
      if (trimDrag.current) {
        const { segId } = trimDrag.current;
        const local = localTimes[segId];
        if (local && onTrimSegment) onTrimSegment(segId, local.start, local.end);
        trimDrag.current = null;
        return;
      }
      // Commit move / select
      if (moveDrag.current) {
        const { segId, moved } = moveDrag.current;
        moveDrag.current = null;
        setDraggingId(null);
        if (moved && dropIdx !== null && onReorderSegments) {
          // Build new ordered array
          const seg = includedSegs.find(s => s.id === segId);
          if (seg) {
            const rest = includedSegs.filter(s => s.id !== segId);
            rest.splice(dropIdx > rest.indexOf(seg) ? Math.max(0, dropIdx - 1) : dropIdx, 0, seg);
            // Excluded segs keep their relative positions after included ones
            const newOrder = [...rest, ...excludedSegs].map(s => s.id);
            onReorderSegments(newOrder);
          }
        } else if (!moved) {
          // Plain click = select
          onSelectSegment?.(segId === selectedSegmentId ? null : segId);
        }
        setDropIdx(null);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [localTimes, onTrimSegment, onReorderSegments, onSelectSegment, selectedSegmentId, includedSegs, excludedSegs, pxPerSec, dropIdx, snapPoints]);

  // ── Close context menu on outside click ───────────────────────────────────
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler);
    document.addEventListener("contextmenu", handler);
    return () => {
      document.removeEventListener("click", handler);
      document.removeEventListener("contextmenu", handler);
    };
  }, [contextMenu]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!selectedSegmentId) return;
      const seg = sorted.find(s => s.id === selectedSegmentId);
      if (!seg) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onToggleIncluded?.(seg.id, !seg.included);
      }
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        onToggleIncluded?.(seg.id, !seg.included);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedSegmentId, sorted, onToggleIncluded]);

  // ── Scroll-wheel zoom ──────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      setZoom(z => parseFloat(Math.max(0.15, Math.min(12, z * factor)).toFixed(3)));
    }
  }, []);

  // ── Ruler click → scrub ───────────────────────────────────────────────────
  const handleRulerClick = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const scrollLeft = (trackRef.current?.scrollLeft ?? 0);
    const relX = e.clientX - rect.left + scrollLeft;
    const timeSec = relX / pxPerSec;
    onScrubTo?.(Math.max(0, Math.min(timeSec, totalDuration)));
  }, [pxPerSec, onScrubTo, totalDuration]);

  // ── Apple Pencil scrubbing ────────────────────────────────────────────────
  // Uses PointerEvent API: pointerType === "stylus" = Apple Pencil / Surface Pen
  const [pencilActive, setPencilActive] = useState(false);
  const [pencilCursorX, setPencilCursorX] = useState(0);
  const [pencilPressure, setPencilPressure] = useState(0);
  const pencilTiltPanRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });

  // Helper: compute output time from pointer X on ruler
  const rulerTimeFromPointer = useCallback((e: React.PointerEvent | PointerEvent, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    const scrollLeft = trackRef.current?.scrollLeft ?? 0;
    const relX = e.clientX - rect.left + scrollLeft;
    return Math.max(0, Math.min(relX / pxPerSec, totalDuration));
  }, [pxPerSec, totalDuration]);

  const handleRulerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "stylus") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setPencilActive(true);
    setPencilPressure(e.pressure);
    setPencilCursorX(e.clientX - e.currentTarget.getBoundingClientRect().left);
    const t = rulerTimeFromPointer(e, e.currentTarget);
    onScrubTo?.(t);
    pencilTiltPanRef.current = { active: true, lastX: e.clientX };
  }, [rulerTimeFromPointer, onScrubTo]);

  const handleRulerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "stylus") return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPencilCursorX(e.clientX - rect.left);
    setPencilPressure(e.pressure);

    if (!pencilActive) return;

    // Tilt-X panning: pencil tilted > 35° sideways scrolls timeline instead of scrubbing
    const absTilt = Math.abs(e.tiltX ?? 0);
    if (absTilt > 35 && trackRef.current) {
      const dx = e.clientX - pencilTiltPanRef.current.lastX;
      // Tilt magnitude scales pan speed (more tilt = faster pan)
      const panSpeed = 1 + (absTilt - 35) / 10;
      trackRef.current.scrollLeft -= dx * panSpeed;
      pencilTiltPanRef.current.lastX = e.clientX;
      return;
    }
    pencilTiltPanRef.current.lastX = e.clientX;

    // Pressure modulates scrub precision:
    // Low pressure (< 0.3): coarse scrub snapped to nearest marker
    // High pressure (>= 0.3): continuous fine scrub
    let t = rulerTimeFromPointer(e, e.currentTarget);
    if (e.pressure < 0.3 && e.pressure > 0) {
      // Snap to nearest time marker for coarse scrubbing
      const step = totalDuration < 30 ? 2 : totalDuration < 120 ? 5 : totalDuration < 300 ? 10 : 30;
      t = Math.round(t / step) * step;
    }
    onScrubTo?.(t);
  }, [pencilActive, rulerTimeFromPointer, onScrubTo, totalDuration]);

  const handleRulerPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "stylus") return;
    setPencilActive(false);
    setPencilPressure(0);
    pencilTiltPanRef.current.active = false;
  }, []);

  const handleRulerPointerLeave = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "stylus") return;
    if (!pencilActive) setPencilCursorX(-100);
  }, [pencilActive]);

  // ── Playhead offset ───────────────────────────────────────────────────────
  const playheadOffsetPx = useMemo(() => {
    let offset = 0;
    for (let i = 0; i < includedSegs.length; i++) {
      const seg = includedSegs[i];
      const dur = getSegTimes(seg).end - getSegTimes(seg).start;
      if (i < currentSegIndex) {
        offset += dur * pxPerSec + CLIP_GAP;
      } else if (i === currentSegIndex) {
        offset += dur * pxPerSec * segmentProgress;
        break;
      }
    }
    return offset;
  }, [includedSegs, currentSegIndex, segmentProgress, pxPerSec, getSegTimes]);

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const timeMarkers = useMemo(() => {
    const markers: number[] = [];
    const step = totalDuration < 30 ? 2 : totalDuration < 120 ? 5 : totalDuration < 300 ? 10 : 30;
    for (let t = 0; t <= totalDuration; t += step) markers.push(t);
    return markers;
  }, [totalDuration]);

  if (sorted.length === 0) {
    return (
      <div className={cn("flex items-center justify-center bg-[#0a0a0a] text-zinc-600 text-[11px] gap-2", className)}>
        <Scissors className="h-4 w-4" />
        <span>No clips yet — generate an edit plan first</span>
      </div>
    );
  }

  const numLaneRows = showLanes && activeLanes.length > 0 ? activeLanes.length : 1;
  const VIDEO_ROWS_H = TRACK_HEIGHT * numLaneRows;
  const TOTAL_HEIGHT = RULER_HEIGHT + VIDEO_ROWS_H + AUDIO_TRACK_H + MUSIC_TRACK_H + (excludedSegs.length > 0 ? 4 + EXCL_HEIGHT : 0) + 4;

  return (
    <div className={cn("flex flex-col bg-[#0a0a0a] select-none overflow-hidden relative", className)}>
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="h-7 flex items-center px-3 gap-3 border-b border-white/5 shrink-0">
        <Layers className="h-3 w-3 text-zinc-600" />
        <span className="text-[9px] uppercase font-bold tracking-wider text-zinc-600">Timeline</span>
        {liveBuilding && (
          <span className="flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
            </span>
            <span className="text-[8px] uppercase font-semibold tracking-wider text-red-400">Building</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-[8.5px] text-zinc-600">
          <span>{fmtTime(totalDuration)}</span>
          <span className="text-zinc-700">·</span>
          <span>{includedSegs.length} clips</span>
          {excludedSegs.length > 0 && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-700">{excludedSegs.length} excluded</span>
            </>
          )}
          {/* Lane color legend */}
          {showLanes && activeLanes.length > 0 && (
            <span className="flex items-center gap-1.5 ml-1">
              {activeLanes.map(l => (
                <span key={l.key} className="flex items-center gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: l.color }} />
                  <span className="text-[7.5px] text-zinc-600 uppercase tracking-wide">{l.label}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-3 bg-white/5 rounded px-1.5 py-0.5">
          <button onClick={() => setZoom(z => Math.max(0.15, z / 1.5))}
            className="text-[10px] text-zinc-500 hover:text-zinc-200 w-3.5 h-3.5 flex items-center justify-center">−</button>
          <span className="text-[8px] text-zinc-500 font-mono w-7 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(12, z * 1.5))}
            className="text-[10px] text-zinc-500 hover:text-zinc-200 w-3.5 h-3.5 flex items-center justify-center">+</button>
          <button onClick={() => setZoom(1)}
            className="text-[8px] text-zinc-500 hover:text-zinc-200 ml-1 font-mono">fit</button>
        </div>
        {skimEnabled && (
          <span className="flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 text-[8px] text-amber-400 font-medium">
            <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1" y="3" width="14" height="10" rx="1.5" />
              <path d="M6 6l4 2-4 2V6z" fill="currentColor" stroke="none" />
            </svg>
            Skim aktiv
          </span>
        )}
        {pencilActive && (
          <span className="flex items-center gap-1 bg-indigo-500/15 border border-indigo-500/30 rounded px-1.5 py-0.5">
            <svg className="h-2.5 w-2.5 text-indigo-400" viewBox="0 0 16 16" fill="currentColor">
              <path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207l6.5-6.5zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11l.178-.178z"/>
            </svg>
            <span className="text-[8px] text-indigo-300 font-semibold">
              {pencilPressure < 0.3 ? "Coarse" : "Fine"} · {Math.round(pencilPressure * 100)}%
            </span>
          </span>
        )}
        <span className="text-[7.5px] text-zinc-700 hidden lg:block">
          Del=exclude · drag=reorder · ctrl+scroll=zoom · ✏ pencil=scrub
        </span>
      </div>

      {/* ── Track area (fixed header col + scrollable content) ──────────────── */}
      <div className="flex overflow-hidden" style={{ height: TOTAL_HEIGHT }}>

        {/* ── Fixed left track-name column ─────────────────────────────────── */}
        <div className="shrink-0 flex flex-col" style={{ width: HEADER_COL_W, background: "#0e0e0e", borderRight: "1px solid #222", zIndex: 30 }}>
          {/* Ruler spacer */}
          <div style={{ height: RULER_HEIGHT, borderBottom: "1px solid #1c1c1c" }} />
          {/* Video lane rows */}
          {showLanes && activeLanes.length > 0 ? (
            activeLanes.map((lane, li) => (
              <div key={lane.key} className="flex items-center justify-center shrink-0"
                style={{ height: TRACK_HEIGHT, borderBottom: "1px solid #1a1a1a", background: `${lane.color}09`, borderLeft: `2px solid ${lane.color}55` }}>
                <span className="text-[6px] font-black uppercase tracking-widest" style={{ color: lane.color, writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                  {lane.label}
                </span>
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center shrink-0"
              style={{ height: TRACK_HEIGHT, borderBottom: "1px solid #1a1a1a", background: "#0d1117" }}>
              <span className="text-[8px] font-bold" style={{ color: "#4a5568" }}>V1</span>
              <span className="text-[5px] uppercase tracking-wider mt-0.5" style={{ color: "#2d3748" }}>Video</span>
            </div>
          )}
          {/* A1 audio row */}
          <div className="flex flex-col items-center justify-center shrink-0"
            style={{ height: AUDIO_TRACK_H, borderBottom: "1px solid #1a1a1a", background: "#080c12" }}>
            <span className="text-[8px] font-bold" style={{ color: "#2563eb99" }}>A1</span>
            <span className="text-[5px] uppercase tracking-wider mt-0.5" style={{ color: "#1e2a3a" }}>Audio</span>
          </div>
          {/* Music row */}
          <div className="flex flex-col items-center justify-center shrink-0"
            style={{ height: MUSIC_TRACK_H, borderBottom: "1px solid #1a1a1a", background: "#0b0a0e" }}>
            <span className="text-[9px]" style={{ color: "#7c3aed88" }}>♪</span>
          </div>
        </div>

        {/* ── Scrollable track content ──────────────────────────────────────── */}
      <div
        ref={trackRef}
        className="flex-1 overflow-x-auto overflow-y-hidden relative"
        style={{ height: TOTAL_HEIGHT }}
        onWheel={handleWheel}
      >
        <div ref={containerRef} className="relative" style={{ width: totalTrackWidthPx, height: TOTAL_HEIGHT }}>

          {/* ── Ruler ─────────────────────────────────────────────────────────── */}
          <div
            className="absolute top-0 left-0 right-0 bg-[#111] cursor-crosshair"
            style={{ height: RULER_HEIGHT, touchAction: "none" }}
            onClick={handleRulerClick}
            onPointerDown={handleRulerPointerDown}
            onPointerMove={handleRulerPointerMove}
            onPointerUp={handleRulerPointerUp}
            onPointerCancel={handleRulerPointerUp}
            onPointerLeave={handleRulerPointerLeave}
            title="Click to scrub · Apple Pencil: drag to scrub, tilt sideways to pan"
          >
            {timeMarkers.map(t => (
              <div
                key={t}
                className="absolute top-0 bottom-0 flex flex-col items-start"
                style={{ left: t * pxPerSec }}
              >
                <div className="w-px h-2.5 bg-white/15 mt-1" />
                <span className="text-[7.5px] font-mono text-zinc-600 ml-0.5">{fmtTime(t)}</span>
              </div>
            ))}
            {/* Ruler playhead triangle */}
            {totalDuration > 0 && (
              <div
                className="absolute top-0 pointer-events-none"
                style={{ left: playheadOffsetPx, transform: "translateX(-50%)" }}
              >
                <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-white/70 mt-0.5" />
              </div>
            )}
            {/* Apple Pencil cursor — glowing vertical line that follows the stylus tip */}
            {pencilCursorX > 0 && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none z-50 flex flex-col items-center"
                style={{
                  left: pencilCursorX,
                  transform: "translateX(-50%)",
                  transition: pencilActive ? "none" : "opacity 0.3s",
                  opacity: pencilActive ? 1 : 0.4,
                }}
              >
                {/* Pressure dot at tip */}
                <div
                  style={{
                    width: Math.max(4, pencilPressure * 10),
                    height: Math.max(4, pencilPressure * 10),
                    borderRadius: "50%",
                    backgroundColor: pencilPressure < 0.3 ? "#f59e0b" : "#818cf8",
                    boxShadow: `0 0 ${4 + pencilPressure * 8}px ${pencilPressure < 0.3 ? "#f59e0b" : "#818cf8"}`,
                    marginTop: 2,
                    transition: "all 0.05s",
                  }}
                />
                {/* Vertical line */}
                <div
                  style={{
                    width: 1,
                    flex: 1,
                    background: pencilPressure < 0.3
                      ? "linear-gradient(to bottom, #f59e0b88, transparent)"
                      : "linear-gradient(to bottom, #818cf888, transparent)",
                  }}
                />
              </div>
            )}
          </div>

          {/* ── Lane / main-track backgrounds ─────────────────────────────────── */}
          {showLanes && activeLanes.length > 0 ? (
            activeLanes.map((lane, li) => (
              <div key={lane.key}>
                {/* Lane background */}
                <div
                  className="absolute left-0 right-0 border-t border-white/[0.04]"
                  style={{
                    top: RULER_HEIGHT + li * TRACK_HEIGHT,
                    height: TRACK_HEIGHT,
                    backgroundColor: li % 2 === 0 ? "#0d0d0d" : "#0a0a0a",
                    borderBottom: li === activeLanes.length - 1 ? "1px solid rgba(255,255,255,0.04)" : undefined,
                  }}
                />
                {/* Sticky lane label */}
                <div
                  className="absolute z-20 flex items-center justify-center"
                  style={{
                    left: 0,
                    top: RULER_HEIGHT + li * TRACK_HEIGHT + 1,
                    width: 40,
                    height: TRACK_HEIGHT - 2,
                    background: `linear-gradient(to right, ${lane.color}22, transparent)`,
                    borderLeft: `2px solid ${lane.color}66`,
                    borderRadius: "0 2px 2px 0",
                  }}
                >
                  <span
                    className="text-[7px] font-bold uppercase tracking-wider"
                    style={{
                      color: lane.color,
                      writingMode: "vertical-rl",
                      transform: "rotate(180deg)",
                    }}
                  >
                    {lane.label}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div
              className="absolute left-0 right-0 bg-[#0d0d0d] border-t border-b border-white/[0.04]"
              style={{ top: RULER_HEIGHT, height: TRACK_HEIGHT }}
            />
          )}

          {/* ── Included clips ────────────────────────────────────────────────── */}
          {(() => {
            let cursorX = 0;
            let outputTimeAcc = 0;
            return includedSegs.map((seg, idx) => {
              const times = getSegTimes(seg);
              const dur = Math.max(0.1, times.end - times.start);
              const w = dur * pxPerSec;
              const x = cursorX;
              cursorX += w + CLIP_GAP;
              const clipOutputStart = outputTimeAcc;
              outputTimeAcc += dur;

              const isSelected = seg.id === selectedSegmentId;
              const isDragging = seg.id === draggingId;
              const color = showLanes
                ? (activeLanes.find(l => l.key === laneFor(seg.segmentType ?? ""))?.color ?? segColor(seg.segmentType, true))
                : segColor(seg.segmentType, true);
              const video = videoById[seg.videoId];
              const isPlaying = idx === currentSegIndex;
              const trimInfo = parseTrimInfo(seg.silenceTrimInfo);
              const wasStartTrimmed = trimInfo && trimInfo.startTrimmedSec > 0.05;
              const wasEndTrimmed = trimInfo && trimInfo.endTrimmedSec > 0.05;
              // Lane-aware vertical position
              const laneIdx = showLanes && activeLanes.length > 0
                ? activeLanes.findIndex(l => l.key === laneFor(seg.segmentType ?? ""))
                : 0;
              const clipTopY = RULER_HEIGHT + (laneIdx >= 0 ? laneIdx : 0) * TRACK_HEIGHT;

              return (
                <React.Fragment key={seg.id}>
                  {/* Drop indicator BEFORE this clip */}
                  {draggingId && dropIdx === idx && (
                    <div
                      className="absolute z-50 pointer-events-none"
                      style={{
                        left: x - CLIP_GAP,
                        top: clipTopY + 2,
                        width: 3,
                        height: TRACK_HEIGHT - 4,
                        background: "#3b82f6",
                        borderRadius: 2,
                        boxShadow: "0 0 6px #3b82f6",
                      }}
                    />
                  )}

                  <div
                    className={cn(
                      "absolute cursor-pointer group transition-opacity duration-75",
                      isSelected ? "ring-2 ring-white/60 ring-inset z-20" : "z-10",
                      isPlaying ? "ring-2 ring-primary/80 ring-inset z-20" : "",
                      isDragging ? "opacity-40 z-30" : "opacity-100",
                    )}
                    style={{
                      left: x,
                      top: clipTopY + 4,
                      width: Math.max(HANDLE_WIDTH * 2 + 4, w),
                      height: TRACK_HEIGHT - 8,
                      backgroundColor: color + "22",
                      borderLeft: `2px solid ${color}`,
                      borderRight: `1px solid ${color}30`,
                      borderRadius: 3,
                    }}
                    onMouseDown={e => handleClipDown(e, seg)}
                    onMouseMove={e => {
                      if (!video || !skimEnabled) return;
                      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                      const relX = Math.max(0, Math.min(w, e.clientX - rect.left - HANDLE_WIDTH));
                      const frac = relX / Math.max(1, w - HANDLE_WIDTH * 2);
                      const t = times.start + frac * dur;
                      const outputTime = clipOutputStart + frac * dur;
                      setSkimPreview({ segId: seg.id, videoId: video.id, t, outputTime, clientX: e.clientX, clientY: rect.top });
                    }}
                    onMouseLeave={() => setSkimPreview(prev => prev?.segId === seg.id ? null : prev)}
                    onContextMenu={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ segId: seg.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    {/* ── FCP-style thumbnail strip ─────────────────────────── */}
                    {video && w > 30 && (() => {
                      const clipH = TRACK_HEIGHT - 12; // height inside the clip
                      const thumbW = Math.round(clipH * (16 / 9)); // 16:9 per thumb
                      const count  = Math.max(1, Math.min(10, Math.floor(w / thumbW)));
                      const dur    = Math.max(0.1, times.end - times.start);
                      return (
                        <div className="absolute inset-0 flex overflow-hidden pointer-events-none rounded-sm">
                          {Array.from({ length: count }, (_, i) => {
                            const t = times.start + (dur / count) * (i + 0.5);
                            return (
                              <img
                                key={i}
                                src={`${apiBase}/videos/${video.id}/frames?t=${t.toFixed(2)}`}
                                alt=""
                                style={{ width: w / count, height: "100%", objectFit: "cover", opacity: 0.55, flexShrink: 0 }}
                                onError={e => { (e.target as HTMLImageElement).style.opacity = "0"; }}
                              />
                            );
                          })}
                          {/* dark overlay so label text is readable */}
                          <div className="absolute inset-0 bg-black/30" />
                        </div>
                      );
                    })()}

                    {/* Waveform */}
                    {video && w > 30 && (
                      <WaveformBar videoId={video.id} apiBase={apiBase} color={color} />
                    )}

                    {/* Silence-trim glow — start */}
                    {wasStartTrimmed && (
                      <div className="absolute top-0 bottom-0 z-10 pointer-events-none" style={{
                        left: HANDLE_WIDTH,
                        width: Math.min(w * 0.3, 12),
                        background: "linear-gradient(to right, rgba(251,191,36,0.5), transparent)",
                      }} />
                    )}
                    {/* Silence-trim glow — end */}
                    {wasEndTrimmed && (
                      <div className="absolute top-0 bottom-0 z-10 pointer-events-none" style={{
                        right: HANDLE_WIDTH,
                        width: Math.min(w * 0.3, 12),
                        background: "linear-gradient(to left, rgba(251,191,36,0.5), transparent)",
                      }} />
                    )}

                    {/* Left trim handle */}
                    <div
                      data-handle="true"
                      className="absolute left-0 top-0 bottom-0 cursor-ew-resize z-30 flex items-center justify-center hover:bg-white/20 transition-colors"
                      style={{ width: HANDLE_WIDTH }}
                      onMouseDown={e => handleTrimDown(e, seg, "left")}
                    >
                      <div className="w-0.5 h-5 bg-white/40 rounded-full" />
                    </div>

                    {/* Clip label + trim badge */}
                    {w > 40 && (
                      <div className="absolute inset-x-2.5 top-1 bottom-1 flex flex-col justify-between pointer-events-none overflow-hidden">
                        <div className="flex items-center gap-1">
                          <span className="text-[8px] font-bold truncate leading-tight flex-1" style={{ color }}>
                            {seg.label ?? seg.segmentType}
                          </span>
                          {(wasStartTrimmed || wasEndTrimmed) && (
                            <span
                              className="shrink-0"
                              title={[
                                wasStartTrimmed ? `Start −${trimInfo!.startTrimmedSec.toFixed(2)}s` : "",
                                wasEndTrimmed ? `End −${trimInfo!.endTrimmedSec.toFixed(2)}s` : "",
                              ].filter(Boolean).join(" | ")}
                            >
                              <Scissors className="h-2 w-2 text-amber-400" />
                            </span>
                          )}
                        </div>
                        {w > 80 && (
                          <span className="text-[7px] font-mono text-zinc-500 truncate">
                            {times.start.toFixed(1)}→{times.end.toFixed(1)}s
                            {trimInfo && (
                              <span className="text-amber-600/60 ml-1">
                                (was {trimInfo.originalStart.toFixed(1)}→{trimInfo.originalEnd.toFixed(1)})
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Right trim handle */}
                    <div
                      data-handle="true"
                      className="absolute right-0 top-0 bottom-0 cursor-ew-resize z-30 flex items-center justify-center hover:bg-white/20 transition-colors"
                      style={{ width: HANDLE_WIDTH }}
                      onMouseDown={e => handleTrimDown(e, seg, "right")}
                    >
                      <div className="w-0.5 h-5 bg-white/40 rounded-full" />
                    </div>

                    {/* Playing needle */}
                    {isPlaying && (
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-white z-40 pointer-events-none"
                        style={{ left: Math.max(HANDLE_WIDTH, Math.min(w - HANDLE_WIDTH, w * segmentProgress)) }}
                      />
                    )}
                  </div>
                </React.Fragment>
              );
            });
          })()}

          {/* Drop indicator at END */}
          {draggingId && dropIdx === includedSegs.length && (
            <div
              className="absolute z-50 pointer-events-none"
              style={{
                left: totalTrackWidthPx - 3,
                top: RULER_HEIGHT + 2,
                width: 3,
                height: TRACK_HEIGHT * numLaneRows - 4,
                background: "#3b82f6",
                borderRadius: 2,
                boxShadow: "0 0 6px #3b82f6",
              }}
            />
          )}

          {/* ── FCP-style connection lines between primary and B-roll lanes ─── */}
          {showLanes && activeLanes.length >= 2 && (() => {
            const primaryLaneIdx = activeLanes.findIndex(l => l.key === "dialogue" || l.key === "main");
            const brollLaneIdx   = activeLanes.findIndex(l => l.key === "broll" || l.key === "graphics");
            if (primaryLaneIdx < 0 || brollLaneIdx < 0) return null;
            // Build position maps for each lane
            const clipPositions: Map<string, { x: number; w: number; laneIdx: number }> = new Map();
            let cursorX = 0;
            for (const seg of includedSegs) {
              const times = getSegTimes(seg);
              const dur   = Math.max(0.1, times.end - times.start);
              const w     = dur * pxPerSec;
              const laneIdx = activeLanes.findIndex(l => l.key === laneFor(seg.segmentType ?? ""));
              clipPositions.set(seg.id, { x: cursorX, w, laneIdx });
              cursorX += w + CLIP_GAP;
            }
            const primaryClips = includedSegs.filter(s => {
              const pos = clipPositions.get(s.id);
              return pos && pos.laneIdx === primaryLaneIdx;
            });
            const brollClips = includedSegs.filter(s => {
              const pos = clipPositions.get(s.id);
              return pos && pos.laneIdx === brollLaneIdx;
            });
            if (brollClips.length === 0 || primaryClips.length === 0) return null;
            const svgH = TRACK_HEIGHT * activeLanes.length + RULER_HEIGHT;
            return (
              <svg
                className="absolute inset-0 pointer-events-none z-15"
                style={{ width: totalTrackWidthPx, height: svgH }}
                xmlns="http://www.w3.org/2000/svg"
              >
                {brollClips.map(broll => {
                  const brollPos = clipPositions.get(broll.id)!;
                  const brollTop = RULER_HEIGHT + brollPos.laneIdx * TRACK_HEIGHT + 4;
                  const brollCenterX = brollPos.x + brollPos.w / 2;
                  // Find the primary clip that overlaps or is nearest in sequence
                  let nearest = primaryClips[0];
                  let minDist = Infinity;
                  for (const pc of primaryClips) {
                    const pp = clipPositions.get(pc.id)!;
                    const d = Math.abs((pp.x + pp.w / 2) - brollCenterX);
                    if (d < minDist) { minDist = d; nearest = pc; }
                  }
                  const pp = clipPositions.get(nearest.id)!;
                  const primaryBottom = RULER_HEIGHT + (primaryLaneIdx + 1) * TRACK_HEIGHT - 4;
                  const primaryCenterX = pp.x + pp.w / 2;
                  const cp1y = (brollTop + primaryBottom) / 2;
                  return (
                    <g key={`conn-${broll.id}`}>
                      <path
                        d={`M ${brollCenterX},${brollTop} C ${brollCenterX},${cp1y} ${primaryCenterX},${cp1y} ${primaryCenterX},${primaryBottom}`}
                        fill="none"
                        stroke="rgba(255,255,255,0.2)"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                      <circle cx={brollCenterX}   cy={brollTop}      r="2.5" fill="rgba(255,255,255,0.3)" />
                      <circle cx={primaryCenterX} cy={primaryBottom} r="2.5" fill="rgba(255,255,255,0.3)" />
                    </g>
                  );
                })}
              </svg>
            );
          })()}

          {/* ── A1 Audio waveform track ───────────────────────────────────────── */}
          <div className="absolute left-0 right-0" style={{ top: RULER_HEIGHT + VIDEO_ROWS_H, height: AUDIO_TRACK_H, background: "#070b10", borderTop: "1px solid #141e2a", borderBottom: "1px solid #141e2a" }}>
            {/* Per-clip waveform bars */}
            {(() => {
              let cx = 0;
              return includedSegs.map(seg => {
                const times = getSegTimes(seg);
                const dur = Math.max(0.1, times.end - times.start);
                const w = dur * pxPerSec;
                const x = cx;
                cx += w + CLIP_GAP;
                const video = videoById[seg.videoId];
                const isSelected = seg.id === selectedSegmentId;
                return (
                  <div key={seg.id} className="absolute" style={{ left: x, top: 3, width: Math.max(HANDLE_WIDTH * 2, w), height: AUDIO_TRACK_H - 6, background: isSelected ? "#1e2d45" : "#0f1a28", borderRadius: 2, border: isSelected ? "1px solid #3b82f6" : "1px solid #1a2a3a" }}>
                    {video && <WaveformBar videoId={video.id} apiBase={apiBase} color="#3b82f6" />}
                  </div>
                );
              });
            })()}
          </div>

          {/* ── Music track ───────────────────────────────────────────────────── */}
          <div className="absolute left-0 right-0 flex items-center" style={{ top: RULER_HEIGHT + VIDEO_ROWS_H + AUDIO_TRACK_H, height: MUSIC_TRACK_H, background: "#0a0910", borderBottom: "1px solid #1a1a2a" }}>
            {totalDuration > 0 && (
              <div className="absolute left-0 top-1 bottom-1 rounded" style={{ width: totalTrackWidthPx - 2, background: "#7c3aed0d", border: "1px solid #7c3aed25" }}>
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[6px] font-semibold uppercase tracking-widest" style={{ color: "#7c3aed60" }}>Music Track</span>
              </div>
            )}
          </div>

          {/* ── Excluded shelf ────────────────────────────────────────────────── */}
          {excludedSegs.length > 0 && (
            <div
              className="absolute left-0 right-0"
              style={{ top: RULER_HEIGHT + VIDEO_ROWS_H + AUDIO_TRACK_H + MUSIC_TRACK_H + 2, height: EXCL_HEIGHT }}
            >
              <div className="absolute inset-0 bg-[#0a0a0a] border-t border-white/[0.04] flex items-center px-2 gap-1 overflow-x-hidden">
                <span className="text-[7px] uppercase tracking-wider text-zinc-700 font-bold shrink-0 mr-1">
                  Excl
                </span>
                {excludedSegs.map(seg => {
                  const color = segColor(seg.segmentType, false);
                  const isSelected = seg.id === selectedSegmentId;
                  return (
                    <div
                      key={seg.id}
                      className={cn(
                        "shrink-0 rounded h-[18px] cursor-pointer transition-all border hover:opacity-80 flex items-center px-1.5 gap-1",
                        isSelected ? "border-white/40 bg-white/10" : "border-white/10 bg-white/5",
                      )}
                      style={{ minWidth: 40 }}
                      onClick={() => onSelectSegment?.(isSelected ? null : seg.id)}
                      onContextMenu={e => {
                        e.preventDefault();
                        setContextMenu({ segId: seg.id, x: e.clientX, y: e.clientY });
                      }}
                      title={`${seg.label ?? seg.segmentType} (excluded) — right-click to include`}
                    >
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="text-[7px] text-zinc-500 truncate max-w-[60px]">{seg.label ?? seg.segmentType}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Playhead ─── FCP red line ─────────────────────────────────────── */}
          {totalDuration > 0 && (
            <div
              className="absolute pointer-events-none z-50"
              style={{ left: playheadOffsetPx, top: 0, bottom: 0 }}
            >
              {/* Triangle indicator on ruler */}
              <div className="absolute" style={{ top: RULER_HEIGHT - 10, left: -4, width: 0, height: 0, borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderTop: "8px solid #ef4444" }} />
              <div className="absolute" style={{ top: RULER_HEIGHT, bottom: 0, left: -0.5, width: 1, background: "rgba(239,68,68,0.85)" }} />
            </div>
          )}
        </div>
      </div>
      </div> {/* end flex track area */}

      {/* ── Skim hover preview ───────────────────────────────────────────────── */}
      {skimPreview && skimEnabled && (
        <div
          className="fixed z-[300] pointer-events-none"
          style={{
            left: skimPreview.clientX - 88,
            top: skimPreview.clientY - 120,
          }}
        >
          {/* Frame thumbnail */}
          <div className="rounded-lg overflow-hidden shadow-2xl border border-white/20" style={{ width: 176, background: "#000" }}>
            <img
              src={`${apiBase}/videos/${skimPreview.videoId}/frames?t=${skimPreview.t.toFixed(2)}`}
              alt="preview"
              style={{ width: 176, height: 99, objectFit: "cover", display: "block" }}
              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <div
              className="flex items-center justify-between px-2 py-1"
              style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
            >
              <span className="font-mono text-[9px] text-amber-400">{fmtTime(skimPreview.t)}</span>
              <span className="text-[8px] text-zinc-400">Kildetid</span>
            </div>
          </div>
          {/* Arrow pointer */}
          <div
            className="mx-auto"
            style={{
              width: 0, height: 0,
              borderLeft: "6px solid transparent",
              borderRight: "6px solid transparent",
              borderTop: "6px solid rgba(255,255,255,0.2)",
              marginLeft: 82,
            }}
          />
        </div>
      )}

      {/* ── Right-click context menu ─────────────────────────────────────────── */}
      {contextMenu && (() => {
        const seg = sorted.find(s => s.id === contextMenu.segId);
        if (!seg) return null;
        const trimInfo = parseTrimInfo(seg.silenceTrimInfo);
        const hasTrimInfo = trimInfo && (trimInfo.startTrimmedSec > 0.05 || trimInfo.endTrimmedSec > 0.05);
        return (
          <div
            className="fixed z-[200] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[170px]"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-3 py-1 border-b border-zinc-800 mb-1">
              <p className="text-[9px] font-bold text-zinc-300 truncate">{seg.label ?? seg.segmentType}</p>
              <p className="text-[8px] text-zinc-600 font-mono">{seg.startTime.toFixed(2)}s → {seg.endTime.toFixed(2)}s</p>
            </div>
            <button
              className="w-full text-left px-3 py-1.5 text-[10px] hover:bg-white/5 flex items-center gap-2 transition-colors"
              onClick={() => { onToggleIncluded?.(seg.id, !seg.included); setContextMenu(null); }}
            >
              {seg.included
                ? <><EyeOff className="h-3 w-3 text-zinc-500" />Exclude clip</>
                : <><Eye className="h-3 w-3 text-green-400" />Include clip</>
              }
            </button>
            {hasTrimInfo && onResetTrim && (
              <button
                className="w-full text-left px-3 py-1.5 text-[10px] hover:bg-white/5 flex items-center gap-2 transition-colors text-amber-400"
                onClick={() => { onResetTrim(seg.id); setContextMenu(null); }}
              >
                <RotateCcw className="h-3 w-3" />
                Reset silence trim
              </button>
            )}
            <div className="border-t border-zinc-800 mt-1 pt-1">
              <button
                className="w-full text-left px-3 py-1.5 text-[10px] hover:bg-white/5 flex items-center gap-2 transition-colors text-zinc-500"
                onClick={() => { onSelectSegment?.(seg.id); setContextMenu(null); }}
              >
                Select clip
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
