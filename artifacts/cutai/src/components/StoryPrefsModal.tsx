import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { Sparkles, Zap, Heart, Film, Mic2, Music, BookOpen, Clock, ChevronRight, Info } from "lucide-react";

export interface StoryPreferences {
  tone: "euphoric" | "emotional" | "elegant" | "documentary" | "dynamic";
  focus: "dialogue" | "action" | "music" | "mixed";
  pacing: "fast" | "medium" | "slow";
  targetDuration: number | null;
  speakerFocus: string;
  storyStyle: string;
}

const DEFAULT_PREFS: StoryPreferences = {
  tone: "emotional",
  focus: "mixed",
  pacing: "medium",
  targetDuration: null,
  speakerFocus: "",
  storyStyle: "",
};

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (prefs: StoryPreferences) => void;
  projectFormat?: string;
}

const TONES: { id: StoryPreferences["tone"]; label: string; desc: string; icon: React.ReactNode; color: string }[] = [
  { id: "euphoric", label: "Euphoric", desc: "Joy, celebration, energy peaks", icon: <Sparkles className="h-4 w-4" />, color: "border-yellow-400 bg-yellow-400/10 text-yellow-400" },
  { id: "emotional", label: "Emotional", desc: "Deep feeling, tears, heartfelt moments", icon: <Heart className="h-4 w-4" />, color: "border-rose-400 bg-rose-400/10 text-rose-400" },
  { id: "elegant", label: "Elegant", desc: "Cinematic, slow, sophisticated", icon: <Film className="h-4 w-4" />, color: "border-violet-400 bg-violet-400/10 text-violet-400" },
  { id: "documentary", label: "Documentary", desc: "Authentic, story-driven, interview-led", icon: <BookOpen className="h-4 w-4" />, color: "border-blue-400 bg-blue-400/10 text-blue-400" },
  { id: "dynamic", label: "Dynamic", desc: "Fast-cut, high energy, action-forward", icon: <Zap className="h-4 w-4" />, color: "border-orange-400 bg-orange-400/10 text-orange-400" },
];

const FOCUSES: { id: StoryPreferences["focus"]; label: string; icon: React.ReactNode }[] = [
  { id: "dialogue", label: "Dialogue / Speech", icon: <Mic2 className="h-3.5 w-3.5" /> },
  { id: "action", label: "Action / B-Roll", icon: <Film className="h-3.5 w-3.5" /> },
  { id: "music", label: "Music-Driven", icon: <Music className="h-3.5 w-3.5" /> },
  { id: "mixed", label: "Balanced Mix", icon: <Sparkles className="h-3.5 w-3.5" /> },
];

const PACING_LABELS: Record<StoryPreferences["pacing"], string> = {
  fast: "Fast — tight cuts, high energy",
  medium: "Medium — balanced pacing",
  slow: "Slow — breathing room, cinematic",
};

const DURATION_OPTIONS = [
  { label: "Auto", value: null },
  { label: "30s", value: 30 },
  { label: "60s", value: 60 },
  { label: "90s", value: 90 },
  { label: "2 min", value: 120 },
  { label: "3 min", value: 180 },
  { label: "5 min", value: 300 },
];

export function StoryPrefsModal({ open, onClose, onApply, projectFormat }: Props) {
  const [prefs, setPrefs] = useState<StoryPreferences>(DEFAULT_PREFS);

  const set = <K extends keyof StoryPreferences>(key: K, val: StoryPreferences[K]) =>
    setPrefs(p => ({ ...p, [key]: val }));

  const handleApply = () => {
    onApply(prefs);
    onClose();
  };

  const selectedTone = TONES.find(t => t.id === prefs.tone)!;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl bg-zinc-950 border-border/60 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/40 bg-gradient-to-r from-primary/5 to-violet-500/5">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <DialogTitle className="text-base font-bold">Story Preferences</DialogTitle>
          </div>
          <DialogDescription className="text-[11px] text-zinc-400">
            Configure how the AI shapes your story before generating the edit plan. These preferences guide emotional tone, pacing, focus, and structure.
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">

          {/* Emotional Tone */}
          <section className="space-y-3">
            <h3 className="text-[10px] uppercase font-bold text-zinc-400 tracking-widest flex items-center gap-1.5">
              <Heart className="h-3 w-3" /> Emotional Tone
            </h3>
            <div className="grid grid-cols-5 gap-2">
              {TONES.map(t => (
                <button
                  key={t.id}
                  onClick={() => set("tone", t.id)}
                  className={cn(
                    "flex flex-col items-center gap-2 p-3 rounded-lg border text-center transition-all",
                    prefs.tone === t.id
                      ? t.color + " shadow-lg"
                      : "border-border/40 bg-zinc-900/50 text-zinc-500 hover:border-border hover:text-zinc-300"
                  )}
                >
                  {t.icon}
                  <span className="text-[10px] font-bold leading-tight">{t.label}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-500 pl-1">
              <span className="text-zinc-300 font-medium">{selectedTone.label}:</span> {selectedTone.desc}
            </p>
          </section>

          {/* Story Focus */}
          <section className="space-y-3">
            <h3 className="text-[10px] uppercase font-bold text-zinc-400 tracking-widest flex items-center gap-1.5">
              <Film className="h-3 w-3" /> Story Focus
            </h3>
            <div className="grid grid-cols-4 gap-2">
              {FOCUSES.map(f => (
                <button
                  key={f.id}
                  onClick={() => set("focus", f.id)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border text-[10px] font-medium transition-all",
                    prefs.focus === f.id
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/40 bg-zinc-900/50 text-zinc-400 hover:border-border hover:text-zinc-200"
                  )}
                >
                  {f.icon}
                  <span className="leading-tight">{f.label}</span>
                </button>
              ))}
            </div>
          </section>

          <div className="grid grid-cols-2 gap-5">
            {/* Pacing */}
            <section className="space-y-3">
              <h3 className="text-[10px] uppercase font-bold text-zinc-400 tracking-widest flex items-center gap-1.5">
                <Zap className="h-3 w-3" /> Pacing
              </h3>
              <div className="flex flex-col gap-1.5">
                {(["fast", "medium", "slow"] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => set("pacing", p)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all",
                      prefs.pacing === p
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border/30 bg-zinc-900/40 text-zinc-400 hover:border-border hover:text-zinc-200"
                    )}
                  >
                    <div className={cn("w-1.5 h-1.5 rounded-full", prefs.pacing === p ? "bg-primary" : "bg-zinc-700")} />
                    <span className="text-[10px] font-medium capitalize">{p}</span>
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-zinc-600 pl-1">{PACING_LABELS[prefs.pacing]}</p>
            </section>

            {/* Target Duration */}
            <section className="space-y-3">
              <h3 className="text-[10px] uppercase font-bold text-zinc-400 tracking-widest flex items-center gap-1.5">
                <Clock className="h-3 w-3" /> Target Duration
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {DURATION_OPTIONS.map(d => (
                  <button
                    key={String(d.value)}
                    onClick={() => set("targetDuration", d.value)}
                    className={cn(
                      "px-3 py-2 rounded-lg border text-[10px] font-medium transition-all",
                      prefs.targetDuration === d.value
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border/30 bg-zinc-900/40 text-zinc-400 hover:border-border hover:text-zinc-200"
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </section>
          </div>

          {/* Speaker Focus (optional) */}
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase font-bold text-zinc-400 tracking-widest flex items-center gap-1.5">
              <Mic2 className="h-3 w-3" /> Speaker / Subject Focus <span className="text-zinc-600 font-normal normal-case">(optional)</span>
            </h3>
            <input
              type="text"
              value={prefs.speakerFocus}
              onChange={e => set("speakerFocus", e.target.value)}
              placeholder="e.g. Bride & groom, exclude officiant, prioritize vows..."
              className="w-full bg-zinc-900/70 border border-border/50 rounded-lg px-3 py-2 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-primary/50 focus:outline-none"
            />
          </section>

          {/* Creative Brief (optional) */}
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase font-bold text-zinc-400 tracking-widest flex items-center gap-1.5">
              <BookOpen className="h-3 w-3" /> Creative Brief <span className="text-zinc-600 font-normal normal-case">(optional)</span>
            </h3>
            <input
              type="text"
              value={prefs.storyStyle}
              onChange={e => set("storyStyle", e.target.value)}
              placeholder="e.g. Cinematic wedding film, tears during vows, end on a dance floor moment..."
              className="w-full bg-zinc-900/70 border border-border/50 rounded-lg px-3 py-2 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-primary/50 focus:outline-none"
            />
          </section>

          {/* Summary */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
            <p className="text-[9px] uppercase text-primary font-bold tracking-wider">AI will create a {prefs.tone} edit</p>
            <p className="text-[10px] text-zinc-300">
              {selectedTone.desc} · {FOCUSES.find(f => f.id === prefs.focus)!.label} · {prefs.pacing} pacing
              {prefs.targetDuration ? ` · ~${prefs.targetDuration}s target` : " · auto duration"}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-border/40 bg-zinc-950">
          <button onClick={onClose} className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">Cancel</button>
          <Button onClick={handleApply} className="gap-2 text-sm">
            <Sparkles className="h-3.5 w-3.5" />
            Generate Edit Plan
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
