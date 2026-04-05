import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  Zap, 
  AudioWaveform, 
  Play, 
  RotateCcw, 
  Square, 
  TrendingUp, 
  Check,
  Volume2,
  Ear,
  Sun,
  Type,
  Film,
  Scissors,
  AlignStartVertical,
  Eye,
  EyeOff,
  SplitSquareHorizontal,
  Pause,
  Headphones,
  Sparkles,
  LayoutTemplate,
  X
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Segment, SegmentSpeedCurve, useUpdateSegment } from "@workspace/api-client-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

const COLOR_GRADES = [
  { id: "none", label: "None", bg: "bg-zinc-700", filter: "none" },
  { id: "warm", label: "Warm", bg: "bg-orange-600", filter: "sepia(0.4) saturate(1.3) hue-rotate(-15deg)" },
  { id: "cool", label: "Cool", bg: "bg-blue-600", filter: "saturate(0.8) hue-rotate(30deg) brightness(1.05)" },
  { id: "cinematic", label: "Cinema", bg: "bg-amber-900", filter: "sepia(0.2) contrast(1.15) saturate(0.85)" },
  { id: "bw", label: "B&W", bg: "bg-zinc-500", filter: "grayscale(1) contrast(1.2)" },
  { id: "vivid", label: "Vivid", bg: "bg-emerald-600", filter: "saturate(1.8) contrast(1.1)" },
  { id: "muted", label: "Muted", bg: "bg-stone-500", filter: "saturate(0.5) brightness(0.95)" },
  { id: "sunset", label: "Sunset", bg: "bg-rose-600", filter: "sepia(0.5) saturate(1.5) hue-rotate(-30deg) brightness(1.05)" },
  { id: "teal_orange", label: "Teal+Org", bg: "bg-teal-700", filter: "saturate(1.3) hue-rotate(5deg) contrast(1.1)" },
  { id: "desaturated", label: "Desatur.", bg: "bg-neutral-600", filter: "saturate(0.25) brightness(1.05)" },
];

const TRANSITIONS = [
  { id: "cut", label: "Cut", icon: "⊘" },
  { id: "dissolve", label: "Dissolve", icon: "◌" },
  { id: "fade_black", label: "Fade ↓", icon: "●" },
  { id: "fade_white", label: "Fade ↑", icon: "○" },
  { id: "flash", label: "Flash", icon: "✦" },
  { id: "wipe_right", label: "Wipe →", icon: "▶" },
  { id: "zoom_in", label: "Zoom In", icon: "⊕" },
];

const CAPTION_STYLES = [
  { id: "none", label: "None" },
  { id: "subtitle", label: "Subtitle" },
  { id: "title", label: "Title" },
  { id: "lower_third", label: "Lower 3rd" },
  { id: "kinetic", label: "Kinetic" },
];

interface ClipPropertiesPanelProps {
  segment: Segment;
  currentTime?: number;
  sourceDuration?: number;
  videoId?: string;
  apiBase?: string;
  onUpdate?: () => void;
  onSplit?: (segmentId: string, at: number) => void;
}

export function ClipPropertiesPanel({ segment, currentTime = 0, sourceDuration, videoId, apiBase = "", onUpdate, onSplit }: ClipPropertiesPanelProps) {
  const { toast } = useToast();
  const updateSegment = useUpdateSegment();
  const trimBarRef = useRef<HTMLDivElement>(null);
  const draggingHandle = useRef<'in' | 'out' | null>(null);
  const originalAudioRef = useRef<HTMLAudioElement>(null);
  const enhancedAudioRef = useRef<HTMLAudioElement>(null);

  const [speed, setSpeed] = useState<number>(segment.speedFactor ?? 1.0);
  const [isRampEnabled, setIsRampEnabled] = useState<boolean>(!!(segment.speedRampStart || segment.speedRampEnd));
  const [rampStart, setRampStart] = useState<number>(segment.speedRampStart ?? 1.0);
  const [rampEnd, setRampEnd] = useState<number>(segment.speedRampEnd ?? 1.0);
  const [curve, setCurve] = useState<string>(segment.speedCurve ?? "linear");
  const [isReverse, setIsReverse] = useState<boolean>(!!segment.reverse);
  const [isFreeze, setIsFreeze] = useState<boolean>(!!segment.freeze);
  const [trimIn, setTrimIn] = useState<number>(segment.startTime ?? 0);
  const [trimOut, setTrimOut] = useState<number>(segment.endTime ?? 5);
  
  const [noiseReduction, setNoiseReduction] = useState<boolean>(false);
  const [voiceBoost, setVoiceBoost] = useState<boolean>(false);
  const [inheritProject, setInheritProject] = useState<boolean>(true);
  const [colorGrade, setColorGrade] = useState<string>(segment.colorGrade ?? "none");
  const [transitionIn, setTransitionIn] = useState<string>(segment.transitionIn ?? "cut");
  const [transitionDuration, setTransitionDuration] = useState<number>(segment.transitionInDuration ?? 0.5);
  const [captionText, setCaptionText] = useState<string>(segment.captionText ?? "");
  const [captionStyle, setCaptionStyle] = useState<string>(segment.captionStyle ?? "none");
  const [audioMixLevel, setAudioMixLevel] = useState<number>(segment.audioMixLevel ?? 1.0);
  const [musicDuckLevel, setMusicDuckLevel] = useState<number>(segment.musicDuckLevel ?? 1.0);

  // Before/after and enable/disable states
  const [colorBeforeMode, setColorBeforeMode] = useState(false);
  const [lutEnabled, setLutEnabled] = useState<boolean>((segment.colorGrade ?? "none") !== "none");
  const [prevColorGrade, setPrevColorGrade] = useState<string>(segment.colorGrade && segment.colorGrade !== "none" ? segment.colorGrade : "warm");
  const [captionEnabled, setCaptionEnabled] = useState<boolean>((segment.captionStyle ?? "none") !== "none");
  const [prevCaptionStyle, setPrevCaptionStyle] = useState<string>(segment.captionStyle && segment.captionStyle !== "none" ? segment.captionStyle : "subtitle");
  const [audioPlayingOriginal, setAudioPlayingOriginal] = useState(false);
  const [audioPlayingEnhanced, setAudioPlayingEnhanced] = useState(false);
  const [hasEnhancedAudio, setHasEnhancedAudio] = useState<boolean | null>(null);

  useEffect(() => {
    setSpeed(segment.speedFactor ?? 1.0);
    setIsRampEnabled(!!(segment.speedRampStart || segment.speedRampEnd));
    setRampStart(segment.speedRampStart ?? 1.0);
    setRampEnd(segment.speedRampEnd ?? 1.0);
    setCurve(segment.speedCurve ?? "linear");
    setIsReverse(!!segment.reverse);
    setIsFreeze(!!segment.freeze);
    const grade = segment.colorGrade ?? "none";
    setColorGrade(grade);
    setLutEnabled(grade !== "none");
    if (grade !== "none") setPrevColorGrade(grade);
    setTransitionIn(segment.transitionIn ?? "cut");
    setTransitionDuration(segment.transitionInDuration ?? 0.5);
    setCaptionText(segment.captionText ?? "");
    const cStyle = segment.captionStyle ?? "none";
    setCaptionStyle(cStyle);
    setCaptionEnabled(cStyle !== "none");
    if (cStyle !== "none") setPrevCaptionStyle(cStyle);
    setAudioMixLevel(segment.audioMixLevel ?? 1.0);
    setMusicDuckLevel(segment.musicDuckLevel ?? 1.0);
    setTrimIn(segment.startTime ?? 0);
    setTrimOut(segment.endTime ?? 5);
    setColorBeforeMode(false);
    
    if (segment.audioEnhancement) {
      try {
        const audio = JSON.parse(segment.audioEnhancement);
        setNoiseReduction(!!audio.noiseReduction);
        setVoiceBoost(!!audio.voiceBoost);
        setInheritProject(audio.inherit !== false);
      } catch (e) {
        // Fallback
      }
    }
  }, [segment]);

  // Check if enhanced audio exists for this video
  useEffect(() => {
    if (!videoId || !apiBase) { setHasEnhancedAudio(false); return; }
    fetch(`${apiBase}/videos/${videoId}/enhanced-audio`, { method: "HEAD" })
      .then(r => setHasEnhancedAudio(r.ok))
      .catch(() => setHasEnhancedAudio(false));
  }, [videoId, apiBase]);

  const handleToggleLut = () => {
    const newEnabled = !lutEnabled;
    setLutEnabled(newEnabled);
    const newGrade = newEnabled ? prevColorGrade : "none";
    setColorGrade(newGrade);
    updateSegment.mutate({ id: segment.id, data: { colorGrade: newGrade } }, {
      onSuccess: () => { toast({ title: newEnabled ? `LUT enabled: ${prevColorGrade}` : "Color grade disabled" }); onUpdate?.(); }
    });
  };

  const handleToggleCaption = () => {
    const newEnabled = !captionEnabled;
    setCaptionEnabled(newEnabled);
    const newStyle = newEnabled ? prevCaptionStyle : "none";
    setCaptionStyle(newStyle);
    updateSegment.mutate({ id: segment.id, data: { captionStyle: newStyle } }, {
      onSuccess: () => { toast({ title: newEnabled ? "Captions enabled" : "Captions disabled" }); onUpdate?.(); }
    });
  };

  function playAudioSegment(ref: React.RefObject<HTMLAudioElement | null>, url: string, setPlaying: (v: boolean) => void) {
    if (!ref.current) return;
    if (!ref.current.paused) {
      ref.current.pause();
      setPlaying(false);
      return;
    }
    ref.current.src = url;
    ref.current.currentTime = segment.startTime;
    const dur = Math.min(segment.endTime - segment.startTime, 30);
    ref.current.play().then(() => {
      setPlaying(true);
      const timeout = setTimeout(() => {
        ref.current?.pause();
        setPlaying(false);
      }, dur * 1000);
      ref.current!.onpause = () => { clearTimeout(timeout); setPlaying(false); };
    }).catch(() => setPlaying(false));
  }

  const srcDuration = sourceDuration && sourceDuration > 0 ? sourceDuration : Math.max(trimOut + 2, 10);

  const handleTrimBarMouseDown = useCallback((e: React.MouseEvent, handle: 'in' | 'out') => {
    e.preventDefault();
    e.stopPropagation();
    draggingHandle.current = handle;

    const onMouseMove = (ev: MouseEvent) => {
      if (!trimBarRef.current) return;
      const rect = trimBarRef.current.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const time = parseFloat((frac * srcDuration).toFixed(2));
      if (draggingHandle.current === 'in') {
        setTrimIn(prev => Math.min(time, trimOut - 0.1));
      } else {
        setTrimOut(prev => Math.max(time, trimIn + 0.1));
      }
    };
    const onMouseUp = () => {
      draggingHandle.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [srcDuration, trimIn, trimOut]);

  const handleApplySpeed = () => {
    const data: any = {
      speedFactor: speed,
      reverse: isReverse,
      freeze: isFreeze,
      speedCurve: curve,
    };

    if (isRampEnabled) {
      data.speedRampStart = rampStart;
      data.speedRampEnd = rampEnd;
    } else {
      data.speedRampStart = null;
      data.speedRampEnd = null;
    }

    updateSegment.mutate({
      id: segment.id,
      data
    }, {
      onSuccess: () => {
        toast({ title: "Speed properties updated" });
        onUpdate?.();
      }
    });
  };

  const handleApplyColorGrade = (grade: string) => {
    setColorGrade(grade);
    if (grade !== "none") {
      setLutEnabled(true);
      setPrevColorGrade(grade);
    }
    updateSegment.mutate({ id: segment.id, data: { colorGrade: grade } }, {
      onSuccess: () => { toast({ title: grade === "none" ? "Color grade cleared" : "Color grade applied" }); onUpdate?.(); }
    });
  };

  const handleApplyTransition = (transition: string) => {
    setTransitionIn(transition);
    updateSegment.mutate({ id: segment.id, data: { transitionIn: transition, transitionInDuration: transitionDuration } }, {
      onSuccess: () => { toast({ title: "Transition saved" }); onUpdate?.(); }
    });
  };

  const handleSaveCaption = () => {
    let styleToSave = captionStyle;
    // Auto-enable caption if text is provided but style was "none"
    if (captionText.trim() && captionStyle === "none") {
      styleToSave = prevCaptionStyle;
      setCaptionStyle(prevCaptionStyle);
      setCaptionEnabled(true);
    }
    updateSegment.mutate({ id: segment.id, data: { captionText, captionStyle: styleToSave } }, {
      onSuccess: () => { toast({ title: "Caption saved" }); onUpdate?.(); }
    });
  };

  const handleApplyAudio = () => {
    const audioEnhancement = JSON.stringify({
      noiseReduction,
      voiceBoost,
      inherit: inheritProject
    });

    updateSegment.mutate({
      id: segment.id,
      data: { audioEnhancement, audioMixLevel, musicDuckLevel }
    }, {
      onSuccess: () => {
        toast({ title: "Audio properties updated" });
        onUpdate?.();
      }
    });
  };

  const CurveIcon = ({ type }: { type: string }) => {
    switch (type) {
      case "linear":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" strokeWidth="2" />
          </svg>
        );
      case "ease-in":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 14C2 14 8 14 14 2" stroke="currentColor" strokeWidth="2" />
          </svg>
        );
      case "ease-out":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 14C8 2 14 2 14 2" stroke="currentColor" strokeWidth="2" />
          </svg>
        );
      case "s-curve":
        return (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 14C8 14 8 2 14 2" stroke="currentColor" strokeWidth="2" />
          </svg>
        );
      default:
        return null;
    }
  };

  const activeGrade = COLOR_GRADES.find(g => g.id === colorGrade) ?? COLOR_GRADES[0];

  const canSplit = currentTime > segment.startTime && currentTime < segment.endTime;
  const handleApplyTrim = () => {
    if (trimIn >= trimOut) { toast({ title: "Invalid trim", description: "In point must be before Out point", variant: "destructive" }); return; }
    updateSegment.mutate({ id: segment.id, data: { startTime: trimIn, endTime: trimOut } }, {
      onSuccess: () => { toast({ title: "Trim applied" }); onUpdate?.(); }
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Tabs defaultValue="trim" className="flex-1 flex flex-col">
        <TabsList className="grid w-full grid-cols-6 rounded-none border-b bg-transparent h-9 p-0">
          <TabsTrigger value="trim" className="rounded-none text-[8px] uppercase font-bold tracking-wider data-[state=active]:border-b-2 data-[state=active]:border-cyan-400 data-[state=active]:shadow-none flex items-center gap-0.5">
            <Scissors className="h-2.5 w-2.5" />Trim
          </TabsTrigger>
          <TabsTrigger value="speed" className="rounded-none text-[8px] uppercase font-bold tracking-wider data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none flex items-center gap-0.5">
            <Zap className="h-2.5 w-2.5" />Speed
          </TabsTrigger>
          <TabsTrigger value="color" className="rounded-none text-[8px] uppercase font-bold tracking-wider data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none flex items-center gap-0.5">
            <Sun className="h-2.5 w-2.5" />Color
          </TabsTrigger>
          <TabsTrigger value="transition" className="rounded-none text-[8px] uppercase font-bold tracking-wider data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none flex items-center gap-0.5">
            <Film className="h-2.5 w-2.5" />Trans
          </TabsTrigger>
          <TabsTrigger value="audio" className="rounded-none text-[8px] uppercase font-bold tracking-wider data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none flex items-center gap-0.5">
            <AudioWaveform className="h-2.5 w-2.5" />Audio
          </TabsTrigger>
          <TabsTrigger value="gfx" className="rounded-none text-[8px] uppercase font-bold tracking-wider data-[state=active]:border-b-2 data-[state=active]:border-violet-400 data-[state=active]:shadow-none flex items-center gap-0.5">
            <Sparkles className="h-2.5 w-2.5" />Gfx
          </TabsTrigger>
        </TabsList>

        <TabsContent value="trim" className="flex-1 p-4 m-0 overflow-auto space-y-4">
          {canSplit && (
            <div className="p-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 space-y-2">
              <div className="flex items-center gap-1.5">
                <Scissors className="h-3 w-3 text-cyan-400" />
                <span className="text-[10px] font-bold uppercase text-cyan-400">Split at Playhead</span>
              </div>
              <p className="text-[9px] text-muted-foreground">Playhead at <span className="font-mono text-cyan-300">{currentTime.toFixed(2)}s</span></p>
              <Button
                size="sm"
                className="w-full h-7 text-[10px] bg-cyan-600 hover:bg-cyan-700 text-white"
                onClick={() => onSplit?.(segment.id, currentTime)}
              >
                <Scissors className="h-3 w-3 mr-1.5" /> Split Here
              </Button>
            </div>
          )}

          {/* ── Visual Trim Bar ────────────────────────────────── */}
          <div className="space-y-2">
            <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center justify-between">
              <span className="flex items-center gap-1.5"><AlignStartVertical className="h-3 w-3" /> Trim</span>
              <span className="font-mono text-primary">{Math.max(0, trimOut - trimIn).toFixed(2)}s</span>
            </h4>

            {/* Bar */}
            <div
              ref={trimBarRef}
              className="relative h-11 bg-zinc-800 rounded-lg overflow-visible select-none cursor-crosshair"
              style={{ userSelect: 'none' }}
            >
              {/* Full source duration background */}
              <div className="absolute inset-0 bg-zinc-800 rounded-lg overflow-hidden">
                {/* Stripes for excluded regions */}
                <div
                  className="absolute top-0 bottom-0 bg-zinc-900/70"
                  style={{ left: 0, width: `${(trimIn / srcDuration) * 100}%` }}
                />
                <div
                  className="absolute top-0 bottom-0 bg-zinc-900/70"
                  style={{ left: `${(trimOut / srcDuration) * 100}%`, right: 0 }}
                />
              </div>

              {/* Selected region highlight */}
              <div
                className="absolute top-0 bottom-0 bg-primary/20 border-y border-primary/40"
                style={{
                  left: `${(trimIn / srcDuration) * 100}%`,
                  width: `${((trimOut - trimIn) / srcDuration) * 100}%`,
                }}
              />

              {/* Playhead */}
              {currentTime >= 0 && currentTime <= srcDuration && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-blue-400/80 pointer-events-none z-20"
                  style={{ left: `${(currentTime / srcDuration) * 100}%` }}
                />
              )}

              {/* IN handle */}
              <div
                className="absolute top-0 bottom-0 w-4 flex items-center justify-center cursor-ew-resize z-10 group"
                style={{ left: `calc(${(trimIn / srcDuration) * 100}% - 8px)` }}
                onMouseDown={e => handleTrimBarMouseDown(e, 'in')}
              >
                <div className="w-3 h-full bg-green-500 rounded-l-sm flex items-center justify-center opacity-90 group-hover:opacity-100 transition-opacity">
                  <div className="w-0.5 h-5 bg-white/60 rounded" />
                </div>
              </div>

              {/* OUT handle */}
              <div
                className="absolute top-0 bottom-0 w-4 flex items-center justify-center cursor-ew-resize z-10 group"
                style={{ left: `calc(${(trimOut / srcDuration) * 100}% - 8px)` }}
                onMouseDown={e => handleTrimBarMouseDown(e, 'out')}
              >
                <div className="w-3 h-full bg-red-500 rounded-r-sm flex items-center justify-center opacity-90 group-hover:opacity-100 transition-opacity">
                  <div className="w-0.5 h-5 bg-white/60 rounded" />
                </div>
              </div>

              {/* IN / OUT labels */}
              <div className="absolute -bottom-4 inset-x-0 flex pointer-events-none">
                <span
                  className="text-[8px] font-mono text-green-400 absolute"
                  style={{ left: `${(trimIn / srcDuration) * 100}%`, transform: 'translateX(-50%)' }}
                >
                  {trimIn.toFixed(2)}
                </span>
                <span
                  className="text-[8px] font-mono text-red-400 absolute"
                  style={{ left: `${(trimOut / srcDuration) * 100}%`, transform: 'translateX(-50%)' }}
                >
                  {trimOut.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Source duration label */}
            <div className="mt-5 flex justify-between text-[8px] text-zinc-600 font-mono">
              <span>0.00s</span>
              <span>{srcDuration.toFixed(2)}s</span>
            </div>
          </div>

          {/* Set In/Out from playhead */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[9px] border-green-500/30 text-green-400 hover:bg-green-500/10"
              onClick={() => setTrimIn(parseFloat(currentTime.toFixed(2)))}
            >
              Set In ({currentTime.toFixed(1)}s)
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[9px] border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={() => setTrimOut(parseFloat(currentTime.toFixed(2)))}
            >
              Set Out ({currentTime.toFixed(1)}s)
            </Button>
          </div>

          {/* Timecodes */}
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <div className="bg-zinc-900 rounded p-1.5 border border-border/40">
              <p className="text-[8px] text-zinc-500 uppercase">In</p>
              <input
                type="number"
                min={0}
                max={trimOut - 0.1}
                step={0.01}
                value={trimIn}
                onChange={e => setTrimIn(parseFloat(e.target.value) || 0)}
                className="w-full bg-transparent text-[10px] font-mono text-green-400 text-center focus:outline-none"
              />
            </div>
            <div className="bg-zinc-900 rounded p-1.5 border border-primary/30">
              <p className="text-[8px] text-zinc-500 uppercase">Dur</p>
              <p className="text-[10px] font-mono text-primary font-bold">{Math.max(0, trimOut - trimIn).toFixed(2)}</p>
            </div>
            <div className="bg-zinc-900 rounded p-1.5 border border-border/40">
              <p className="text-[8px] text-zinc-500 uppercase">Out</p>
              <input
                type="number"
                min={trimIn + 0.1}
                step={0.01}
                value={trimOut}
                onChange={e => setTrimOut(parseFloat(e.target.value) || 0)}
                className="w-full bg-transparent text-[10px] font-mono text-red-400 text-center focus:outline-none"
              />
            </div>
          </div>

          <Button
            size="sm"
            className="w-full text-[10px] uppercase font-bold"
            onClick={handleApplyTrim}
            disabled={updateSegment.isPending || trimIn >= trimOut}
          >
            {updateSegment.isPending ? "Applying..." : "Apply Trim"}
          </Button>
        </TabsContent>

        <TabsContent value="speed" className="flex-1 p-4 m-0 overflow-auto space-y-6">
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">Uniform Speed</span>
              <span className="text-xl font-bold font-mono">{speed.toFixed(1)}x</span>
            </div>
            <Slider
              value={[speed]}
              min={0.1}
              max={4.0}
              step={0.1}
              onValueChange={([v]) => setSpeed(v)}
              disabled={isRampEnabled}
              className={isRampEnabled ? "opacity-30" : ""}
            />
          </div>

          <div className="space-y-4 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-3 w-3 text-primary" />
                <Label htmlFor="speed-ramp" className="text-[10px] uppercase font-bold">Speed Ramp</Label>
              </div>
              <Switch 
                id="speed-ramp" 
                checked={isRampEnabled} 
                onCheckedChange={setIsRampEnabled}
              />
            </div>

            {isRampEnabled && (
              <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-[9px] text-muted-foreground uppercase">
                      <span>Start</span>
                      <span className="font-mono">{rampStart.toFixed(1)}x</span>
                    </div>
                    <Slider
                      value={[rampStart]}
                      min={0.1}
                      max={4.0}
                      step={0.1}
                      onValueChange={([v]) => setRampStart(v)}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-[9px] text-muted-foreground uppercase">
                      <span>End</span>
                      <span className="font-mono">{rampEnd.toFixed(1)}x</span>
                    </div>
                    <Slider
                      value={[rampEnd]}
                      min={0.1}
                      max={4.0}
                      step={0.1}
                      onValueChange={([v]) => setRampEnd(v)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-[9px] text-muted-foreground uppercase">Curve</span>
                  <ToggleGroup 
                    type="single" 
                    value={curve} 
                    onValueChange={(v) => v && setCurve(v)}
                    className="justify-start gap-1"
                  >
                    <ToggleGroupItem value="linear" size="sm" className="h-8 w-8 p-0" title="Linear">
                      <CurveIcon type="linear" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="ease-in" size="sm" className="h-8 w-8 p-0" title="Ease In">
                      <CurveIcon type="ease-in" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="ease-out" size="sm" className="h-8 w-8 p-0" title="Ease Out">
                      <CurveIcon type="ease-out" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="s-curve" size="sm" className="h-8 w-8 p-0" title="S-Curve">
                      <CurveIcon type="s-curve" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="h-3 w-3 text-muted-foreground" />
                <Label htmlFor="reverse" className="text-[10px] uppercase font-bold">Reverse</Label>
              </div>
              <Switch 
                id="reverse" 
                checked={isReverse} 
                onCheckedChange={setIsReverse}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Square className="h-3 w-3 text-muted-foreground" />
                <Label htmlFor="freeze" className="text-[10px] uppercase font-bold">Freeze Frame</Label>
              </div>
              <Switch 
                id="freeze" 
                checked={isFreeze} 
                onCheckedChange={setIsFreeze}
              />
            </div>
          </div>

          <Button 
            className="w-full mt-4 text-[10px] uppercase font-bold" 
            size="sm"
            onClick={handleApplySpeed}
            disabled={updateSegment.isPending}
          >
            {updateSegment.isPending ? "Applying..." : "Apply Speed Changes"}
          </Button>
        </TabsContent>

        <TabsContent value="color" className="flex-1 p-4 m-0 overflow-auto space-y-5">
          <div className="space-y-3">
            {/* LUT header with enable/disable and before/after */}
            <div className="flex items-center justify-between">
              <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-2">
                <Sun className="h-3 w-3" /> Color Grade
              </h4>
              <div className="flex items-center gap-2">
                {/* Before/After toggle — only show if a grade is selected */}
                {lutEnabled && colorGrade !== "none" && (
                  <div className="flex items-center gap-0.5 bg-zinc-800 rounded border border-zinc-700 p-0.5">
                    <button
                      onClick={() => setColorBeforeMode(true)}
                      className={`text-[8px] px-1.5 py-0.5 rounded transition-colors ${colorBeforeMode ? "bg-zinc-600 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                    >Before</button>
                    <button
                      onClick={() => setColorBeforeMode(false)}
                      className={`text-[8px] px-1.5 py-0.5 rounded transition-colors ${!colorBeforeMode ? "bg-primary/80 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                    >After</button>
                  </div>
                )}
                {/* LUT on/off switch */}
                <div className="flex items-center gap-1">
                  <span className="text-[8px] text-zinc-500">{lutEnabled ? "On" : "Off"}</span>
                  <Switch checked={lutEnabled} onCheckedChange={handleToggleLut} className="scale-75" />
                </div>
              </div>
            </div>

            {/* Preview box */}
            <div
              className="relative h-20 rounded-lg border border-border/50 overflow-hidden flex items-center justify-center text-sm font-medium text-white/80 mb-4 transition-all"
              style={{
                background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
                filter: lutEnabled && !colorBeforeMode ? activeGrade.filter : "none"
              }}
            >
              <span className="drop-shadow-lg">{colorBeforeMode ? "Before" : (colorGrade !== "none" ? activeGrade.label : "No Grade")}</span>
              {colorBeforeMode ? (
                <Badge className="absolute top-2 right-2 text-[9px] h-4 bg-zinc-700 text-zinc-300 border-0">BEFORE</Badge>
              ) : lutEnabled && colorGrade !== "none" ? (
                <Badge className="absolute top-2 right-2 text-[9px] h-4 bg-white/20 text-white border-0">AFTER</Badge>
              ) : null}
              {!lutEnabled && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <EyeOff className="h-4 w-4 text-zinc-500" />
                </div>
              )}
            </div>

            <div className={`grid grid-cols-5 gap-2 transition-opacity ${!lutEnabled ? "opacity-40 pointer-events-none" : ""}`}>
              {COLOR_GRADES.filter(g => g.id !== "none").map(grade => (
                <button
                  key={grade.id}
                  onClick={() => { setPrevColorGrade(grade.id); handleApplyColorGrade(grade.id); }}
                  className={`flex flex-col items-center gap-1 p-1.5 rounded-md border transition-all ${
                    colorGrade === grade.id
                      ? "border-primary ring-1 ring-primary bg-primary/10"
                      : "border-border/50 hover:border-primary/30 bg-accent/20"
                  }`}
                >
                  <div className={`w-8 h-8 rounded ${grade.bg}`} />
                  <span className="text-[8px] text-muted-foreground truncate w-full text-center">{grade.label}</span>
                </button>
              ))}
            </div>
            {!lutEnabled && (
              <p className="text-[9px] text-zinc-600 text-center">Toggle on to apply a color grade to this clip</p>
            )}
            <p className="text-[9px] text-muted-foreground">Grading is exported to FCPXML as a named filter effect.</p>
          </div>
        </TabsContent>

        <TabsContent value="transition" className="flex-1 p-4 m-0 overflow-auto space-y-5">
          <div className="space-y-3">
            <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-2">
              <Film className="h-3 w-3" /> Transition In
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {TRANSITIONS.map(t => (
                <button
                  key={t.id}
                  onClick={() => handleApplyTransition(t.id)}
                  className={`flex items-center gap-2 p-2.5 rounded-md border text-left transition-all ${
                    transitionIn === t.id
                      ? "border-primary ring-1 ring-primary bg-primary/10"
                      : "border-border/50 hover:border-primary/30 bg-accent/20"
                  }`}
                >
                  <span className="text-base">{t.icon}</span>
                  <span className="text-[10px] font-medium">{t.label}</span>
                  {transitionIn === t.id && <Check className="h-3 w-3 ml-auto text-primary" />}
                </button>
              ))}
            </div>

            {transitionIn !== "cut" && (
              <div className="space-y-2 pt-2 border-t border-border/50">
                <div className="flex justify-between text-[10px] text-muted-foreground uppercase">
                  <span>Duration</span>
                  <span className="font-mono">{transitionDuration.toFixed(1)}s</span>
                </div>
                <Slider
                  value={[transitionDuration]}
                  min={0.1}
                  max={2.0}
                  step={0.1}
                  onValueChange={([v]) => {
                    setTransitionDuration(v);
                    updateSegment.mutate({ id: segment.id, data: { transitionIn, transitionInDuration: v } }, {
                      onSuccess: () => onUpdate?.()
                    });
                  }}
                />
              </div>
            )}

            <div className="pt-2 border-t border-border/50 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-2">
                  <Type className="h-3 w-3" /> Caption Overlay
                </h4>
                <div className="flex items-center gap-1">
                  <span className="text-[8px] text-zinc-500">{captionEnabled ? "On" : "Off"}</span>
                  <Switch checked={captionEnabled} onCheckedChange={handleToggleCaption} className="scale-75" disabled={!captionText && !captionEnabled} />
                </div>
              </div>
              <div className={`space-y-2 transition-opacity ${!captionEnabled ? "opacity-40" : ""}`}>
                <div className="grid grid-cols-4 gap-1 mb-2">
                  {CAPTION_STYLES.filter(s => s.id !== "none").map(s => (
                    <button
                      key={s.id}
                      onClick={() => { setCaptionStyle(s.id); setPrevCaptionStyle(s.id); }}
                      disabled={!captionEnabled}
                      className={`text-[8px] p-1.5 rounded border transition-all ${
                        captionStyle === s.id && captionEnabled
                          ? "border-yellow-500/60 bg-yellow-500/10 text-yellow-400"
                          : "border-border/40 text-muted-foreground hover:border-primary/30"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <Textarea
                  placeholder="Type caption text here..."
                  value={captionText}
                  onChange={e => setCaptionText(e.target.value)}
                  rows={3}
                  className="text-xs resize-none"
                  disabled={!captionEnabled && !captionText}
                />
                <Button
                  size="sm"
                  className="w-full text-[10px] uppercase font-bold h-7"
                  onClick={handleSaveCaption}
                  disabled={updateSegment.isPending}
                >
                  Save Caption
                </Button>
              </div>
              {!captionText && !captionEnabled && (
                <p className="text-[8px] text-zinc-600">No caption set — type text above and save, or run "Auto-Generate Captions" from the AI panel.</p>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="audio" className="flex-1 p-4 m-0 overflow-auto space-y-6">
          {/* Per-clip volume and music ducking */}
          <div className="space-y-4">
            <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-2">
              <Volume2 className="h-3 w-3" /> Volume Mix
            </h4>
            <div className="space-y-3">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-medium">Clip Volume</span>
                  <span className="text-[10px] font-mono text-primary">{Math.round(audioMixLevel * 100)}%</span>
                </div>
                <Slider
                  value={[audioMixLevel]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={([v]) => setAudioMixLevel(v)}
                />
                <p className="text-[9px] text-muted-foreground">Clip's own audio track level in the final render.</p>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-medium">Music Level</span>
                  <span className="text-[10px] font-mono text-cyan-400">{Math.round(musicDuckLevel * 100)}%</span>
                </div>
                <Slider
                  value={[musicDuckLevel]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={([v]) => setMusicDuckLevel(v)}
                />
                <p className="text-[9px] text-muted-foreground">Background music volume during this clip (0% = silent, 100% = full).</p>
              </div>
            </div>
          </div>

          <div className="space-y-4 pt-3 border-t border-border/50">
            <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-2">
              <AudioWaveform className="h-3 w-3" /> Enhancement Tools
            </h4>
            
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2 rounded border bg-accent/20 border-border/50">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">Noise Reduction</span>
                  <span className="text-[9px] text-muted-foreground">Remove background hiss and hum</span>
                </div>
                <Switch 
                  checked={noiseReduction} 
                  onCheckedChange={setNoiseReduction}
                />
              </div>

              <div className="flex items-center justify-between p-2 rounded border bg-accent/20 border-border/50">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">Voice Boost</span>
                  <span className="text-[9px] text-muted-foreground">Enhance clarity of spoken words</span>
                </div>
                <Switch 
                  checked={voiceBoost} 
                  onCheckedChange={setVoiceBoost}
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-border/50">
            <div className="flex items-start space-x-2">
              <Checkbox 
                id="inherit" 
                checked={inheritProject} 
                onCheckedChange={(v) => setInheritProject(!!v)} 
              />
              <div className="grid gap-1.5 leading-none">
                <label
                  htmlFor="inherit"
                  className="text-[10px] font-bold uppercase leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Inherit Project Settings
                </label>
                <p className="text-[9px] text-muted-foreground">
                  Apply global project audio enhancement recipes to this clip.
                </p>
              </div>
            </div>
          </div>

          {/* A/B audio comparison */}
          <div className="pt-3 border-t border-border/50 space-y-3">
            <h4 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider flex items-center gap-2">
              <SplitSquareHorizontal className="h-3 w-3" /> A/B Listen Comparison
            </h4>
            {hasEnhancedAudio === false && (
              <p className="text-[9px] text-zinc-500 bg-zinc-800/60 rounded p-2">
                No enhanced audio found for this source file. Run "AI Enhance Audio" from the AI tools panel first, then come back here to compare.
              </p>
            )}
            {hasEnhancedAudio === true && videoId && apiBase && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    if (originalAudioRef.current) {
                      playAudioSegment(originalAudioRef, `${apiBase}/videos/${videoId}/stream`, setAudioPlayingOriginal);
                      if (!originalAudioRef.current.paused) {
                        enhancedAudioRef.current?.pause();
                        setAudioPlayingEnhanced(false);
                      }
                    }
                  }}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all ${
                    audioPlayingOriginal
                      ? "border-amber-500/60 bg-amber-500/10 text-amber-400"
                      : "border-border/50 bg-accent/20 text-muted-foreground hover:border-amber-500/30"
                  }`}
                >
                  {audioPlayingOriginal ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  <span className="text-[9px] font-bold uppercase">Original</span>
                  <span className="text-[8px] opacity-60">Unprocessed</span>
                </button>
                <button
                  onClick={() => {
                    if (enhancedAudioRef.current) {
                      playAudioSegment(enhancedAudioRef, `${apiBase}/videos/${videoId}/enhanced-audio`, setAudioPlayingEnhanced);
                      if (!enhancedAudioRef.current.paused) {
                        originalAudioRef.current?.pause();
                        setAudioPlayingOriginal(false);
                      }
                    }
                  }}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all ${
                    audioPlayingEnhanced
                      ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-400"
                      : "border-border/50 bg-accent/20 text-muted-foreground hover:border-cyan-500/30"
                  }`}
                >
                  {audioPlayingEnhanced ? <Pause className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
                  <span className="text-[9px] font-bold uppercase">Enhanced</span>
                  <span className="text-[8px] opacity-60">AI Processed</span>
                </button>
              </div>
            )}
            {hasEnhancedAudio === null && (
              <p className="text-[9px] text-zinc-500 animate-pulse">Checking for enhanced audio...</p>
            )}
          </div>

          <Button 
            className="w-full mt-4 text-[10px] uppercase font-bold" 
            size="sm"
            variant="secondary"
            onClick={handleApplyAudio}
            disabled={updateSegment.isPending}
          >
            {updateSegment.isPending ? "Applying..." : "Save Audio Settings"}
          </Button>

          {/* Hidden audio elements for A/B playback */}
          <audio ref={originalAudioRef} preload="none" style={{ display: "none" }} />
          <audio ref={enhancedAudioRef} preload="none" style={{ display: "none" }} />
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* GRAPHICS TAB — AI suggested text overlays per segment               */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="gfx" className="flex-1 p-3 m-0 overflow-auto space-y-3">
          {(() => {
            let overlays: Array<{
              id: string;
              type: string;
              text: string;
              subtext?: string | null;
              position: string;
              fontFamily: string;
              fontSize: string;
              textColor: string;
              backgroundColor: string;
              backgroundStyle: string;
              colorScheme: string;
              animationIn: string;
              reason?: string;
              applied: boolean;
            }> = [];
            try {
              if (segment.graphicOverlays) overlays = JSON.parse(segment.graphicOverlays as string);
            } catch {}

            const toggleOverlay = async (overlayId: string, applied: boolean) => {
              const updated = overlays.map(o => o.id === overlayId ? { ...o, applied } : o);
              await updateSegment.mutateAsync({ id: segment.id, data: { graphicOverlays: JSON.stringify(updated) } });
            };

            if (!overlays.length) {
              return (
                <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
                  <LayoutTemplate className="h-8 w-8 text-violet-400/40" />
                  <p className="text-xs text-muted-foreground/60 max-w-[160px]">
                    Run <span className="text-violet-400 font-semibold">AI Graphic Overlays</span> in the pipeline to get commercial overlay suggestions for this clip.
                  </p>
                </div>
              );
            }

            return (
              <div className="space-y-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Sparkles className="h-3 w-3 text-violet-400" />
                  <span className="text-[9px] font-bold uppercase tracking-widest text-violet-300">AI Graphic Suggestions</span>
                  <span className="ml-auto text-[8px] text-muted-foreground">{overlays.filter(o => o.applied).length}/{overlays.length} applied</span>
                </div>
                {overlays.map(ov => {
                  const typeColors: Record<string, string> = {
                    headline:      "bg-orange-500/20 text-orange-300 border-orange-500/30",
                    lower_third:   "bg-blue-500/20 text-blue-300 border-blue-500/30",
                    cta_badge:     "bg-green-500/20 text-green-300 border-green-500/30",
                    social_handle: "bg-pink-500/20 text-pink-300 border-pink-500/30",
                    product_label: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
                    quote:         "bg-purple-500/20 text-purple-300 border-purple-500/30",
                  };
                  const typeBadge = typeColors[ov.type] ?? "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";
                  return (
                    <div
                      key={ov.id}
                      className={`rounded-lg border p-2.5 space-y-1.5 transition-all ${
                        ov.applied
                          ? "border-violet-500/50 bg-violet-500/10"
                          : "border-border/40 bg-accent/10 hover:border-border/60"
                      }`}
                    >
                      {/* Type badge + position */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[7px] font-bold uppercase px-1.5 py-0.5 rounded border ${typeBadge}`}>
                          {ov.type.replace("_", " ")}
                        </span>
                        <span className="text-[7px] text-muted-foreground bg-accent/30 px-1.5 py-0.5 rounded">
                          {ov.position}
                        </span>
                        <span className="text-[7px] text-muted-foreground bg-accent/30 px-1.5 py-0.5 rounded">
                          {ov.fontFamily}
                        </span>
                        {ov.applied && (
                          <span className="ml-auto text-[7px] font-bold text-violet-400 uppercase">● Live</span>
                        )}
                      </div>

                      {/* Overlay preview */}
                      <div
                        className="rounded px-2 py-1 text-center"
                        style={{
                          fontFamily: ov.fontFamily === "playfair" ? "'Playfair Display', serif"
                            : ov.fontFamily === "montserrat" ? "'Montserrat', sans-serif"
                            : ov.fontFamily === "oswald" ? "'Oswald', sans-serif"
                            : ov.fontFamily === "bebas-neue" ? "'Bebas Neue', sans-serif"
                            : "Impact, sans-serif",
                          color: ov.textColor ?? "#fff",
                          background: ov.backgroundStyle === "gradient-bar"
                            ? `linear-gradient(to right, ${ov.backgroundColor ?? "rgba(0,0,0,0.8)"}, transparent)`
                            : ov.backgroundColor ?? "transparent",
                          fontSize: ov.fontSize === "hero" ? "16px" : ov.fontSize === "large" ? "13px" : ov.fontSize === "medium" ? "11px" : "9px",
                          fontWeight: ["impact","bebas-neue","oswald"].includes(ov.fontFamily) ? 900 : 700,
                          textTransform: ["impact","bebas-neue","oswald"].includes(ov.fontFamily) ? "uppercase" : undefined,
                          letterSpacing: ["oswald","bebas-neue"].includes(ov.fontFamily) ? "0.1em" : undefined,
                          textShadow: ov.backgroundStyle === "none" ? "0 1px 3px rgba(0,0,0,0.9)" : undefined,
                        }}
                      >
                        {ov.text}
                        {ov.subtext && <div style={{ fontSize: "75%", opacity: 0.8, fontWeight: 400 }}>{ov.subtext}</div>}
                      </div>

                      {/* Reason */}
                      {ov.reason && (
                        <p className="text-[8px] text-muted-foreground/70 italic leading-tight">
                          {ov.reason}
                        </p>
                      )}

                      {/* Apply / Dismiss */}
                      <div className="flex gap-1.5 pt-0.5">
                        <Button
                          size="sm"
                          variant={ov.applied ? "secondary" : "default"}
                          className={`flex-1 text-[8px] uppercase font-bold h-6 ${ov.applied ? "" : "bg-violet-600 hover:bg-violet-700 text-white"}`}
                          onClick={() => toggleOverlay(ov.id, !ov.applied)}
                          disabled={updateSegment.isPending}
                        >
                          {ov.applied ? (
                            <><X className="h-2.5 w-2.5 mr-1" />Remove</>
                          ) : (
                            <><Check className="h-2.5 w-2.5 mr-1" />Apply</>
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </TabsContent>
      </Tabs>
    </div>
  );
}
