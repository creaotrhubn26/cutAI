import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, Loader2, Sparkles, Film, Mic2, Music, Zap, ChevronDown, ChevronUp, LockKeyhole, RotateCcw, TrendingUp, PenLine, Eye, Save, Trash2, Scissors } from "lucide-react";
import type { Segment } from "@workspace/api-client-react";

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

const EMOTION_LABEL = (confidence: number | null | undefined): { label: string; color: string; bg: string } => {
  const c = confidence ?? 0;
  if (c >= 0.85) return { label: "HIGH", color: "text-rose-400", bg: "bg-rose-400/10 border-rose-400/30" };
  if (c >= 0.65) return { label: "MED", color: "text-amber-400", bg: "bg-amber-400/10 border-amber-400/30" };
  return { label: "LOW", color: "text-zinc-500", bg: "bg-zinc-700/20 border-zinc-600/20" };
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  hook: <Sparkles className="h-3 w-3 text-yellow-400" />,
  highlight: <TrendingUp className="h-3 w-3 text-primary" />,
  speech: <Mic2 className="h-3 w-3 text-blue-400" />,
  action: <Zap className="h-3 w-3 text-orange-400" />,
  climax: <TrendingUp className="h-3 w-3 text-rose-400" />,
  resolution: <Film className="h-3 w-3 text-violet-400" />,
  buildup: <TrendingUp className="h-3 w-3 text-amber-400" />,
  transition: <Film className="h-3 w-3 text-zinc-400" />,
  music: <Music className="h-3 w-3 text-pink-400" />,
};

const TYPE_COLOR: Record<string, string> = {
  hook: "border-yellow-500/40 bg-yellow-500/5",
  highlight: "border-primary/30 bg-primary/5",
  speech: "border-blue-500/30 bg-blue-500/5",
  action: "border-orange-500/30 bg-orange-500/5",
  climax: "border-rose-500/30 bg-rose-500/5",
  resolution: "border-violet-500/30 bg-violet-500/5",
  buildup: "border-amber-500/30 bg-amber-500/5",
  transition: "border-zinc-600/30 bg-zinc-800/30",
  music: "border-pink-500/30 bg-pink-500/5",
};

interface BulkUpdate { id: string; label?: string; captionText?: string; included?: boolean }

interface Props {
  segments: Segment[];
  onLock: (approvedIds: string[]) => void;
  onBulkUpdate?: (updates: BulkUpdate[]) => Promise<void>;
  isLocking: boolean;
}

export function StoryScriptPanel({ segments, onLock, onBulkUpdate, isLocking }: Props) {
  const sorted = [...segments].sort((a, b) => a.orderIndex - b.orderIndex);
  const [approved, setApproved] = useState<Set<string>>(new Set(sorted.filter(s => s.included).map(s => s.id)));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editMode, setEditMode] = useState(false);
  const [editLabels, setEditLabels] = useState<Record<string, string>>({});
  const [editCaptions, setEditCaptions] = useState<Record<string, string>>({});
  const [editDeleted, setEditDeleted] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setApproved(new Set(sorted.filter(s => s.included).map(s => s.id)));
  }, [segments]);

  const enterEditMode = () => {
    const labels: Record<string, string> = {};
    const captions: Record<string, string> = {};
    for (const seg of sorted) {
      labels[seg.id] = seg.label ?? seg.segmentType ?? "";
      captions[seg.id] = seg.captionText ?? "";
    }
    setEditLabels(labels);
    setEditCaptions(captions);
    setEditDeleted(new Set());
    setEditMode(true);
  };

  const cancelEditMode = () => {
    setEditMode(false);
    setEditDeleted(new Set());
  };

  const handleSaveEdits = async () => {
    if (!onBulkUpdate) return;
    setIsSaving(true);
    try {
      const updates: BulkUpdate[] = [];
      for (const seg of sorted) {
        const patch: BulkUpdate = { id: seg.id };
        let changed = false;
        if (editDeleted.has(seg.id)) {
          patch.included = false;
          changed = true;
        } else {
          if (editLabels[seg.id] !== undefined && editLabels[seg.id] !== (seg.label ?? seg.segmentType ?? "")) {
            patch.label = editLabels[seg.id];
            changed = true;
          }
          if (editCaptions[seg.id] !== undefined && editCaptions[seg.id] !== (seg.captionText ?? "")) {
            patch.captionText = editCaptions[seg.id];
            changed = true;
          }
        }
        if (changed) updates.push(patch);
      }
      if (updates.length > 0) {
        await onBulkUpdate(updates);
      }
      setEditMode(false);
      setEditDeleted(new Set());
    } finally {
      setIsSaving(false);
    }
  };

  const toggleApprove = (id: string) => {
    setApproved(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const approvedCount = approved.size;
  const totalDuration = sorted.filter(s => approved.has(s.id)).reduce((acc, s) => acc + (s.endTime - s.startTime), 0);
  const pendingEditCount = editDeleted.size + Object.keys(editLabels).filter(id => editLabels[id] !== (sorted.find(s => s.id === id)?.label ?? sorted.find(s => s.id === id)?.segmentType ?? "")).length;

  const handleSelectAll = () => setApproved(new Set(sorted.map(s => s.id)));
  const handleSelectNone = () => setApproved(new Set());
  const handleSelectHigh = () => setApproved(new Set(sorted.filter(s => (s.confidence ?? 0) >= 0.85).map(s => s.id)));

  if (!segments.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-3">
        <Sparkles className="h-8 w-8 text-zinc-700" />
        <p className="text-[11px] text-zinc-500 max-w-48 leading-relaxed">Run <strong className="text-zinc-400">Generate Edit Plan</strong> to see your AI-curated story script here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="shrink-0 px-3 py-2 border-b border-border/50 bg-gradient-to-r from-primary/5 to-transparent">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-primary">Story Script</span>
            {editMode && (
              <span className="text-[8px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold">
                EDIT MODE
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-zinc-500 font-mono">{approvedCount}/{sorted.length} · {totalDuration.toFixed(0)}s</span>
            {onBulkUpdate && !editMode && (
              <button
                onClick={enterEditMode}
                className="flex items-center gap-0.5 text-[8px] text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Script edit mode — edit labels/captions or delete clips"
              >
                <PenLine className="h-2.5 w-2.5" /> Edit
              </button>
            )}
            {editMode && (
              <button onClick={cancelEditMode} className="flex items-center gap-0.5 text-[8px] text-zinc-500 hover:text-zinc-300">
                <Eye className="h-2.5 w-2.5" /> View
              </button>
            )}
          </div>
        </div>
        {!editMode && (
          <div className="flex items-center gap-1.5">
            <button onClick={handleSelectAll} className="text-[8px] uppercase font-bold text-zinc-500 hover:text-zinc-300 transition-colors">All</button>
            <span className="text-zinc-700">·</span>
            <button onClick={handleSelectNone} className="text-[8px] uppercase font-bold text-zinc-500 hover:text-zinc-300 transition-colors">None</button>
            <span className="text-zinc-700">·</span>
            <button onClick={handleSelectHigh} className="text-[8px] uppercase font-bold text-rose-500 hover:text-rose-300 transition-colors">High emotion only</button>
          </div>
        )}
        {editMode && (
          <p className="text-[8px] text-zinc-500 leading-relaxed">
            Edit clip labels/captions. Click <Trash2 className="inline h-2.5 w-2.5 text-red-400" /> to delete a clip from the timeline.
          </p>
        )}
      </div>

      {/* Segment list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1.5">
          {sorted.map((seg, i) => {
            const emotion = EMOTION_LABEL(seg.confidence);
            const isApproved = approved.has(seg.id);
            const isExpanded = expanded.has(seg.id);
            const isDeleted = editDeleted.has(seg.id);
            const trimInfo = parseTrimInfo((seg as any).silenceTrimInfo);
            const wasTrimmed = trimInfo && (trimInfo.startTrimmedSec > 0.05 || trimInfo.endTrimmedSec > 0.05);
            const typeColor = TYPE_COLOR[seg.segmentType ?? "highlight"] ?? TYPE_COLOR.highlight;
            const typeIcon = TYPE_ICON[seg.segmentType ?? "highlight"] ?? TYPE_ICON.highlight;
            const dur = (seg.endTime - seg.startTime).toFixed(1);

            if (editMode) {
              return (
                <div
                  key={seg.id}
                  className={cn(
                    "rounded-lg border transition-all",
                    isDeleted
                      ? "border-red-500/30 bg-red-500/5 opacity-40"
                      : typeColor
                  )}
                >
                  <div className="flex items-start gap-2 p-2.5">
                    <div className="shrink-0 mt-1">{typeIcon}</div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[8px] font-bold text-zinc-600 font-mono">#{i + 1}</span>
                        <input
                          type="text"
                          value={editLabels[seg.id] ?? ""}
                          onChange={e => setEditLabels(prev => ({ ...prev, [seg.id]: e.target.value }))}
                          disabled={isDeleted}
                          className="flex-1 text-[10px] font-semibold bg-transparent border-b border-zinc-700 focus:border-primary outline-none text-zinc-200 py-0.5 disabled:opacity-30"
                          placeholder="Clip label..."
                        />
                        <span className="text-[8px] text-zinc-600 font-mono shrink-0">{dur}s</span>
                      </div>
                      <input
                        type="text"
                        value={editCaptions[seg.id] ?? ""}
                        onChange={e => setEditCaptions(prev => ({ ...prev, [seg.id]: e.target.value }))}
                        disabled={isDeleted}
                        className="w-full text-[9px] bg-transparent border-b border-zinc-800 focus:border-zinc-600 outline-none text-zinc-500 py-0.5 disabled:opacity-30"
                        placeholder="Caption text (optional)..."
                      />
                    </div>
                    <button
                      onClick={() => {
                        setEditDeleted(prev => {
                          const next = new Set(prev);
                          if (next.has(seg.id)) next.delete(seg.id);
                          else next.add(seg.id);
                          return next;
                        });
                      }}
                      className={cn(
                        "shrink-0 mt-0.5 transition-colors",
                        isDeleted ? "text-zinc-600 hover:text-zinc-400" : "text-zinc-700 hover:text-red-400"
                      )}
                      title={isDeleted ? "Restore clip" : "Remove from timeline"}
                    >
                      {isDeleted
                        ? <RotateCcw className="h-3.5 w-3.5" />
                        : <Trash2 className="h-3.5 w-3.5" />
                      }
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={seg.id}
                className={cn(
                  "rounded-lg border transition-all",
                  isApproved ? typeColor : "border-zinc-800/60 bg-zinc-900/20 opacity-50"
                )}
              >
                <div className="flex items-start gap-2 p-2.5">
                  {/* Approve toggle */}
                  <button
                    onClick={() => toggleApprove(seg.id)}
                    className="shrink-0 mt-0.5"
                    title={isApproved ? "Reject this clip" : "Approve this clip"}
                  >
                    {isApproved
                      ? <CheckCircle2 className="h-4 w-4 text-green-400" />
                      : <XCircle className="h-4 w-4 text-zinc-600" />
                    }
                  </button>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[8px] font-bold text-zinc-600 font-mono shrink-0">#{i + 1}</span>
                      {typeIcon}
                      <span className="text-[10px] font-semibold text-zinc-200 truncate flex-1">{seg.label ?? seg.segmentType}</span>
                      <span className={cn("text-[7px] font-bold px-1 py-0.5 rounded border shrink-0", emotion.bg, emotion.color)}>
                        {emotion.label}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-[8px] text-zinc-500 font-mono">
                      <span>{seg.startTime.toFixed(1)}s → {seg.endTime.toFixed(1)}s</span>
                      <span className="text-zinc-700">·</span>
                      <span>{dur}s</span>
                      {seg.confidence != null && (
                        <>
                          <span className="text-zinc-700">·</span>
                          <span className={cn("font-bold", (seg.confidence ?? 0) >= 0.85 ? "text-green-500" : (seg.confidence ?? 0) >= 0.65 ? "text-amber-500" : "text-zinc-500")}>
                            {Math.round((seg.confidence ?? 0) * 100)}%
                          </span>
                        </>
                      )}
                    </div>

                    {wasTrimmed && trimInfo && (
                      <div className="flex items-center gap-1 mt-0.5 text-[7.5px] text-amber-500/80 font-mono">
                        <Scissors className="h-2.5 w-2.5 shrink-0" />
                        <span>
                          Silence trimmed:{" "}
                          {trimInfo.startTrimmedSec > 0.05 && <span>start −{trimInfo.startTrimmedSec.toFixed(2)}s </span>}
                          {trimInfo.endTrimmedSec > 0.05 && <span>end −{trimInfo.endTrimmedSec.toFixed(2)}s </span>}
                          <span className="text-zinc-600">(was {trimInfo.originalStart.toFixed(1)}→{trimInfo.originalEnd.toFixed(1)}s)</span>
                        </span>
                      </div>
                    )}

                    {seg.captionText && (
                      <p className="mt-0.5 text-[8px] text-zinc-500 italic truncate">"{seg.captionText}"</p>
                    )}

                    {/* Reason / expanded details */}
                    {seg.aiReason && (
                      <button
                        onClick={() => toggleExpand(seg.id)}
                        className="flex items-center gap-0.5 mt-1 text-[8px] text-zinc-600 hover:text-zinc-400 transition-colors"
                      >
                        {isExpanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
                        {isExpanded ? "Hide" : "Why this clip?"}
                      </button>
                    )}
                    {isExpanded && seg.aiReason && (
                      <p className="mt-1.5 text-[9px] text-zinc-400 leading-relaxed bg-black/20 rounded p-1.5 border border-border/20">
                        {seg.aiReason}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer — Edit mode: Save/Cancel | View mode: Lock button */}
      <div className="shrink-0 p-3 border-t border-border/50 space-y-2">
        {editMode ? (
          <>
            <div className="flex items-center justify-between text-[9px] text-zinc-500">
              <span>{editDeleted.size > 0 ? `${editDeleted.size} clips to remove` : "No clips removed"}</span>
              <button onClick={cancelEditMode} className="text-zinc-600 hover:text-zinc-400">Cancel</button>
            </div>
            <Button
              size="sm"
              className="w-full gap-2 text-[10px] uppercase font-bold tracking-wider bg-amber-600 hover:bg-amber-500 text-white"
              disabled={isSaving}
              onClick={handleSaveEdits}
            >
              {isSaving
                ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>
                : <><Save className="h-3 w-3" /> Apply Script Edits</>
              }
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between text-[9px] text-zinc-500">
              <span>{approvedCount} clips approved · {totalDuration.toFixed(0)}s total</span>
              <button onClick={() => setApproved(new Set(sorted.filter(s => s.included).map(s => s.id)))} className="text-zinc-600 hover:text-zinc-400 flex items-center gap-0.5">
                <RotateCcw className="h-2.5 w-2.5" /> Reset
              </button>
            </div>
            <Button
              size="sm"
              className="w-full gap-2 text-[10px] uppercase font-bold tracking-wider"
              disabled={isLocking || approvedCount === 0}
              onClick={() => onLock(Array.from(approved))}
            >
              {isLocking
                ? <><Loader2 className="h-3 w-3 animate-spin" /> Applying...</>
                : <><LockKeyhole className="h-3 w-3" /> Lock {approvedCount} Clips to Timeline</>
              }
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
