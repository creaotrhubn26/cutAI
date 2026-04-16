/**
 * DualWorkflowPanel — one-click end-to-end video editing.
 *
 * Shows two "editing personalities" the user can pick after uploading footage.
 * Claude watches the video with Claude Vision AND reads the transcript, then
 * drives the full pipeline (transcribe → visual scan → edit plan → apply →
 * render) without any further input.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Zap, Sparkles, CheckCircle2, XCircle, Eye, Mic, Wand2, FilmIcon, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

type PresetId = "fast_social_cut" | "cinematic_story";

interface PresetInfo {
  id: PresetId;
  label: string;
  subtitle: string;
  targetFormat: string;
  renderFormat: "vertical" | "landscape";
  targetDurationSec: number;
  tone: string;
  pacing: string;
  editingConcept: string;
  whenToPick: string;
}

interface StageInfo {
  id: string;
  label: string;
  pct: number;
  status: "pending" | "running" | "completed" | "failed";
}

interface WorkflowStatus {
  hasRun: boolean;
  preset?: PresetId;
  presetInfo?: PresetInfo;
  job?: {
    id: string;
    status: "pending" | "running" | "completed" | "failed";
    progress: number;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    streamUrl: string;
  };
  stages?: StageInfo[];
  renderReady?: boolean;
  downloadUrl?: string | null;
}

const STAGE_ICONS: Record<string, typeof Mic> = {
  transcribe: Mic,
  visual_scan: Eye,
  generate_edit_plan: Wand2,
  apply_edit: Sparkles,
  render: FilmIcon,
};

export function DualWorkflowPanel({ projectId, videosCount }: { projectId: string; videosCount: number }) {
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [concept, setConcept] = useState<string>("");
  const [status, setStatus] = useState<WorkflowStatus>({ hasRun: false });
  const [starting, setStarting] = useState<PresetId | null>(null);
  const [expanded, setExpanded] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  // Load presets once
  useEffect(() => {
    fetch(`${API_BASE}/workflows/presets`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        setPresets(data.presets ?? []);
        setConcept(data.concept ?? "");
      })
      .catch(() => {});
  }, []);

  // Poll status — frequent while running, slow when idle
  const refreshStatus = async () => {
    try {
      const r = await fetch(`${API_BASE}/projects/${projectId}/workflows/status`);
      if (!r.ok) return;
      const data: WorkflowStatus = await r.json();
      setStatus(data);
      return data;
    } catch {
      return undefined;
    }
  };

  useEffect(() => {
    refreshStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const isActive = status.job?.status === "running" || status.job?.status === "pending";
    pollRef.current = setInterval(refreshStatus, isActive ? 1500 : 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.job?.status]);

  const startWorkflow = async (preset: PresetId) => {
    if (videosCount === 0) {
      toast({ title: "Upload a video first", description: "Drop a video into Media before running a workflow.", variant: "destructive" });
      return;
    }
    setStarting(preset);
    try {
      const r = await fetch(`${API_BASE}/projects/${projectId}/workflows/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Failed" }));
        toast({ title: "Could not start workflow", description: err.error ?? "Unknown error", variant: "destructive" });
      } else {
        const data = await r.json();
        toast({
          title: `Started ${data.presetInfo?.label}`,
          description: `Claude is now watching and editing your ${videosCount} clip${videosCount !== 1 ? "s" : ""}.`,
        });
        await refreshStatus();
      }
    } finally {
      setStarting(null);
    }
  };

  const running = status.job?.status === "running" || status.job?.status === "pending";
  const currentPreset = status.preset ? presets.find(p => p.id === status.preset) : undefined;
  const progress = status.job?.progress ?? 0;
  const stages = status.stages ?? [];

  const presetCardStyle = (_p: PresetInfo, accent: string) => ({
    background: `linear-gradient(135deg, ${accent}22 0%, #0f0f0f 85%)`,
    border: `1px solid ${accent}55`,
  });

  const accentFor = (id: string) =>
    id === "fast_social_cut" ? "#f472b6" : "#a78bfa";

  const activePresetCard = useMemo(() => {
    if (!running || !status.preset) return null;
    return presets.find(p => p.id === status.preset);
  }, [running, status.preset, presets]);

  return (
    <div className="mb-3 rounded-lg overflow-hidden" style={{ background: "#131313", border: "1px solid #2a2a2a" }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors"
        style={{ background: "linear-gradient(90deg, #1a1a2e 0%, #0f0f1a 100%)", borderBottom: "1px solid #2a2a2a" }}
      >
        <div className="h-5 w-5 rounded flex items-center justify-center" style={{ background: "linear-gradient(135deg,#f472b6,#a78bfa)" }}>
          <Zap className="h-3 w-3 text-white" />
        </div>
        <div className="flex-1 text-left">
          <div className="text-[11px] font-bold tracking-wide" style={{ color: "#e5e5e5" }}>
            Dual End-to-End Workflow
          </div>
          <div className="text-[8px]" style={{ color: "#888" }}>
            Upload → Claude Vision + Whisper → Edit → Render · one click
          </div>
        </div>
        {running && (
          <div className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: "#f472b6" }} />
            <span className="text-[9px] font-mono" style={{ color: "#f472b6" }}>{progress}%</span>
          </div>
        )}
        {!running && status.renderReady && (
          <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "#34d399" }} />
        )}
      </button>

      {expanded && (
        <div className="p-3 space-y-3">
          {/* Concept line */}
          {concept && (
            <p className="text-[9px] leading-relaxed" style={{ color: "#999" }}>{concept}</p>
          )}

          {/* Preset cards — side by side */}
          {!running && (
            <div className="grid grid-cols-1 gap-2">
              {presets.map(preset => {
                const accent = accentFor(preset.id);
                const Icon = preset.renderFormat === "vertical" ? Zap : FilmIcon;
                const isStarting = starting === preset.id;
                return (
                  <button
                    key={preset.id}
                    disabled={isStarting || starting !== null || videosCount === 0}
                    onClick={() => startWorkflow(preset.id)}
                    className="text-left p-2.5 rounded-lg transition-all hover:scale-[1.01] disabled:opacity-50 disabled:hover:scale-100"
                    style={presetCardStyle(preset, accent)}
                  >
                    <div className="flex items-start gap-2">
                      <div
                        className="h-7 w-7 rounded-md flex items-center justify-center shrink-0"
                        style={{ background: `${accent}33`, border: `1px solid ${accent}66` }}
                      >
                        {isStarting
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: accent }} />
                          : <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[10.5px] font-bold" style={{ color: "#f0f0f0" }}>{preset.label}</span>
                          <span
                            className="text-[7.5px] font-mono uppercase tracking-wider px-1 py-px rounded"
                            style={{ background: `${accent}22`, color: accent }}
                          >
                            {preset.renderFormat === "vertical" ? "9:16 · " : "16:9 · "}
                            {preset.targetDurationSec}s
                          </span>
                        </div>
                        <div className="text-[8.5px] mb-1" style={{ color: "#aaa" }}>{preset.subtitle}</div>
                        <p className="text-[8px] leading-snug" style={{ color: "#888" }}>{preset.editingConcept}</p>
                        <p className="text-[7.5px] mt-1 italic" style={{ color: "#666" }}>Best for: {preset.whenToPick}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Running: progress + stages */}
          {running && activePresetCard && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div
                  className="h-6 w-6 rounded flex items-center justify-center"
                  style={{ background: `${accentFor(activePresetCard.id)}33`, border: `1px solid ${accentFor(activePresetCard.id)}66` }}
                >
                  <Loader2 className="h-3 w-3 animate-spin" style={{ color: accentFor(activePresetCard.id) }} />
                </div>
                <div className="flex-1">
                  <div className="text-[10px] font-bold" style={{ color: "#eee" }}>{activePresetCard.label} — running</div>
                  <div className="text-[8px]" style={{ color: "#888" }}>{activePresetCard.subtitle}</div>
                </div>
                <span className="text-[10px] font-mono" style={{ color: accentFor(activePresetCard.id) }}>{progress}%</span>
              </div>
              <div className="h-1 rounded-full" style={{ background: "#222" }}>
                <div
                  className="h-1 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${accentFor(activePresetCard.id)} 0%, #4d9cf8 100%)` }}
                />
              </div>
              {/* Stages */}
              <div className="space-y-1">
                {stages.map(stage => {
                  const Icon = STAGE_ICONS[stage.id] ?? Sparkles;
                  const colour =
                    stage.status === "completed" ? "#34d399" :
                    stage.status === "running"   ? "#4d9cf8" :
                    stage.status === "failed"    ? "#f87171" :
                    "#555";
                  return (
                    <div key={stage.id} className="flex items-center gap-2 text-[9px]" style={{ color: colour }}>
                      {stage.status === "running"
                        ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        : stage.status === "completed"
                          ? <CheckCircle2 className="h-2.5 w-2.5" />
                          : stage.status === "failed"
                            ? <XCircle className="h-2.5 w-2.5" />
                            : <Icon className="h-2.5 w-2.5 opacity-50" />
                      }
                      <span className="flex-1">{stage.label}</span>
                      <span className="font-mono opacity-70">{stage.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Completed preview */}
          {!running && status.hasRun && status.job?.status === "completed" && status.renderReady && currentPreset && (
            <div className="rounded-md p-2 flex items-center gap-2" style={{ background: "#0f241a", border: "1px solid #1f5a3a" }}>
              <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: "#34d399" }} />
              <div className="flex-1">
                <div className="text-[10px] font-bold" style={{ color: "#c6f6d5" }}>
                  {currentPreset.label} done
                </div>
                <div className="text-[8px]" style={{ color: "#7aa88a" }}>
                  Final MP4 ready in project renders.
                </div>
              </div>
              {status.downloadUrl && (
                <a
                  href={status.downloadUrl}
                  download
                  className="h-6 px-2 rounded flex items-center gap-1 text-[9px] font-semibold"
                  style={{ background: "#14532d", color: "#c6f6d5", border: "1px solid #1f5a3a" }}
                >
                  <Download className="h-2.5 w-2.5" /> Download
                </a>
              )}
            </div>
          )}

          {/* Failed */}
          {!running && status.hasRun && status.job?.status === "failed" && (
            <div className="rounded-md p-2 flex items-center gap-2" style={{ background: "#2a0e0e", border: "1px solid #5a1f1f" }}>
              <XCircle className="h-4 w-4 shrink-0" style={{ color: "#f87171" }} />
              <div className="flex-1">
                <div className="text-[10px] font-bold" style={{ color: "#fecaca" }}>Workflow failed</div>
                <div className="text-[8px]" style={{ color: "#bb8a8a" }}>{status.job.errorMessage ?? "Unknown error"}</div>
              </div>
            </div>
          )}

          {/* Footer explanation */}
          {videosCount === 0 && (
            <p className="text-[8px] text-center italic" style={{ color: "#666" }}>
              Upload a video in the Media tab to unlock both workflows.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
