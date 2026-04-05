import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import {
  BrainCircuit, TrendingUpDown, Zap, ChevronRight, RefreshCw,
  CheckCircle2, Clock, AlertCircle, Download, Play, X,
  BarChart3, Scissors, Activity, Database, Upload,
  ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

interface TrainingOverview {
  totalExamples: number;
  totalCorrections: number;
  totalPrefs: number;
  totalTrainingPairs: number;
  estimatedAccuracyGain: number;
  activeModel: string | null;
  finetuneJobId: string | null;
  formulaWeights: Record<string, number> | null;
  formulaWeightsVersion: number;
  formatBreakdown: Record<string, number>;
  recentExamples: Array<{
    id: string;
    projectName: string | null;
    format: string | null;
    totalClipsAvailable: number | null;
    totalClipsUsed: number | null;
    totalDuration: number | null;
    humanApproved: boolean | null;
    createdAt: string;
  }>;
}

interface FinetuneStatus {
  currentJob: {
    id: string;
    status: string;
    model: string;
    fineTunedModel: string | null;
    trainedTokens: number | null;
    createdAt: number;
    finishedAt: number | null;
  } | null;
  jobs: Array<{
    id: string;
    status: string;
    model: string;
    fineTunedModel: string | null;
    trainedTokens: number | null;
    createdAt: number;
    finishedAt: number | null;
  }>;
  activeModel: string | null;
  error?: string;
}

interface FieldDiff {
  field: string;
  aiValue: string | number | boolean | null;
  humanValue: string | number | boolean | null;
  editedAt: string;
}

interface Correction {
  id: string;
  segmentId: string;
  projectId: string;
  videoId: string | null;
  editType: string;
  field: string | null;
  aiValue: string | null;
  humanValue: string | null;
  editedAt: string;
  aiStartTime: number | null;
  humanStartTime: number | null;
  aiEndTime: number | null;
  humanEndTime: number | null;
  aiOrderIndex: number | null;
  humanOrderIndex: number | null;
  aiIncluded: boolean | null;
  humanIncluded: boolean | null;
  deltaStartSeconds: number | null;
  deltaEndSeconds: number | null;
  wasKept: boolean;
  fieldDiffs: FieldDiff[];
  createdAt: string;
}

interface LearnedPref {
  id: string;
  format: string;
  clipType: string | null;
  tag: string | null;
  dimension: string | null;
  selectionRate: number | null;
  usageCount: number | null;
  avgPosition: number | null;
  avgDuration: number | null;
  lastUpdated: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  succeeded: { label: "Succeeded", color: "text-green-500", icon: CheckCircle2 },
  running:   { label: "Training...", color: "text-blue-500", icon: Activity },
  queued:    { label: "Queued", color: "text-yellow-500", icon: Clock },
  validating_files: { label: "Validating", color: "text-blue-400", icon: Clock },
  failed:    { label: "Failed", color: "text-red-500", icon: AlertCircle },
  cancelled: { label: "Cancelled", color: "text-muted-foreground", icon: X },
};

function fmtDuration(sec: number | null | undefined) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function editTypeLabel(t: string) {
  const map: Record<string, string> = {
    trim_start: "Trim Start",
    trim_end: "Trim End",
    trim_both: "Trim Both",
    reorder: "Reorder",
    toggle_include: "Include/Exclude",
    speed_change: "Speed",
    color_grade: "Color Grade",
    split: "Split",
    delete: "Delete",
    other: "Other",
  };
  return map[t] ?? t;
}

function deltaSign(v: number | null | undefined) {
  if (v == null) return null;
  if (v > 0.05) return <ArrowUpRight className="h-3 w-3 text-red-400 inline" />;
  if (v < -0.05) return <ArrowDownRight className="h-3 w-3 text-green-400 inline" />;
  return <Minus className="h-3 w-3 text-muted-foreground inline" />;
}

export default function Intelligence() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<TrainingOverview | null>(null);
  const [finetuneStatus, setFinetuneStatus] = useState<FinetuneStatus | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [prefs, setPrefs] = useState<LearnedPref[]>([]);
  const [loading, setLoading] = useState(true);
  const [ftLoading, setFtLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ovRes, ftRes, corrRes, prefsRes] = await Promise.all([
        fetch(`${API_BASE}/training/overview`).then(r => r.ok ? r.json() : null),
        fetch(`${API_BASE}/training/finetune-status`).then(r => r.ok ? r.json() : null),
        fetch(`${API_BASE}/training/corrections?limit=50`).then(r => r.ok ? r.json() : []),
        fetch(`${API_BASE}/training/prefs`).then(r => r.ok ? r.json() : []),
      ]);
      if (ovRes) setOverview(ovRes);
      if (ftRes) setFinetuneStatus(ftRes);
      if (Array.isArray(corrRes)) setCorrections(corrRes);
      if (Array.isArray(prefsRes)) setPrefs(prefsRes);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleExportJsonl = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch(`${API_BASE}/training/export-finetune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submit: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cutai-finetune-${Date.now()}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "JSONL exported", description: "Training data downloaded successfully." });
    } catch (err: any) {
      toast({ title: "Export failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    }
    setExporting(false);
  }, [toast]);

  const handleSubmitFinetune = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/training/export-finetune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submit: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start fine-tuning");
      toast({
        title: "Fine-tuning started",
        description: `Job ${data.jobId} submitted with ${data.trainingExamples} examples. Training takes 15–60 minutes.`,
      });
      await loadAll();
    } catch (err: any) {
      toast({ title: "Fine-tuning failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    }
    setSubmitting(false);
  }, [toast, loadAll]);

  const handleActivateModel = useCallback(async (modelId: string) => {
    setActivating(modelId);
    try {
      const res = await fetch(`${API_BASE}/training/activate-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to activate");
      toast({ title: "Model activated", description: `${modelId} is now the active editing model.` });
      await loadAll();
    } catch (err: any) {
      toast({ title: "Activation failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    }
    setActivating(null);
  }, [toast, loadAll]);

  const handleDeactivate = useCallback(async () => {
    setDeactivating(true);
    try {
      const res = await fetch(`${API_BASE}/training/deactivate-model`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to deactivate");
      toast({ title: "Model deactivated", description: "Reverting to Claude Opus for edit generation." });
      await loadAll();
    } catch (err: any) {
      toast({ title: "Failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    }
    setDeactivating(false);
  }, [toast, loadAll]);

  const handleRefreshFt = useCallback(async () => {
    setFtLoading(true);
    try {
      const res = await fetch(`${API_BASE}/training/finetune-status`);
      if (res.ok) setFinetuneStatus(await res.json());
    } catch {}
    setFtLoading(false);
  }, []);

  const totalExamples = overview?.totalExamples ?? 0;
  const totalCorrections = overview?.totalCorrections ?? 0;
  const totalPrefs = overview?.totalPrefs ?? 0;
  const totalTrainingPairs = overview?.totalTrainingPairs ?? 0;
  const estimatedAccuracyGain = overview?.estimatedAccuracyGain ?? 0;
  const formulaWeights = overview?.formulaWeights ?? null;
  const formulaWeightsVersion = overview?.formulaWeightsVersion ?? 0;
  const activeModel = finetuneStatus?.activeModel ?? overview?.activeModel ?? null;

  return (
    <div className="flex-1 space-y-8 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <BrainCircuit className="h-8 w-8 text-primary" />
            Model Intelligence
          </h2>
          <p className="text-muted-foreground mt-1">
            Self-improving AI — every edit you make trains CutAI to get better.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAll}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* ── Stats row ── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title="Training Examples"
          value={loading ? null : totalExamples}
          icon={<Database className="h-4 w-4 text-muted-foreground" />}
          description="Completed projects learned from"
          accentColor={totalExamples > 0 ? "text-green-500" : "text-muted-foreground"}
        />
        <StatCard
          title="Human Corrections"
          value={loading ? null : totalCorrections}
          icon={<Scissors className="h-4 w-4 text-muted-foreground" />}
          description="Trim, reorder, delete & toggle edits"
          accentColor={totalCorrections > 0 ? "text-blue-500" : "text-muted-foreground"}
        />
        <StatCard
          title="Learned Preferences"
          value={loading ? null : totalPrefs}
          icon={<TrendingUpDown className="h-4 w-4 text-muted-foreground" />}
          description="Clip-type & tag selection signals"
          accentColor={totalPrefs > 0 ? "text-purple-500" : "text-muted-foreground"}
        />
        <StatCard
          title="ML Training Pairs"
          value={loading ? null : totalTrainingPairs}
          icon={<BrainCircuit className="h-4 w-4 text-muted-foreground" />}
          description={`Feature vectors × outcomes — formula weights v${formulaWeightsVersion}`}
          accentColor={totalTrainingPairs > 0 ? "text-lime-400" : "text-muted-foreground"}
        />
        {/* ── Estimated Accuracy Improvement ── */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Est. Accuracy Gain</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-6 w-20" />
            ) : (
              <div>
                <div className="text-2xl font-bold text-orange-400">+{estimatedAccuracyGain}%</div>
                <Progress value={estimatedAccuracyGain} max={100} className="mt-2 h-1.5" />
                <p className="text-xs text-muted-foreground mt-1">
                  {estimatedAccuracyGain === 0
                    ? "Run more projects to build signal"
                    : "Estimated lift from learned preferences"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Model</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-6 w-36" />
            ) : activeModel ? (
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-xs font-mono text-green-400 truncate max-w-[160px]">{activeModel.split(":")[0]}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Fine-tuned model active</p>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-blue-500" />
                  <span className="text-sm font-medium">Claude Opus</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Default AI model</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Learnable Formula Weights panel ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BrainCircuit className="h-4 w-4 text-lime-400" />
            Clip Score Formula — Learnable Weights
            {formulaWeightsVersion > 0 && (
              <Badge variant="secondary" className="text-[10px] h-4 py-0 bg-lime-500/10 text-lime-400 border-lime-500/20">
                v{formulaWeightsVersion} — trained
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {formulaWeightsVersion === 0
              ? "Weights are at defaults. Run \"Learn from Edit\" on a completed + rated project to start training."
              : `clip_score = hook × ${(formulaWeights?.hookWeight ?? 0.35).toFixed(3)} + emotion × ${(formulaWeights?.emotionWeight ?? 0.30).toFixed(3)} + clarity × ${(formulaWeights?.clarityWeight ?? 0.20).toFixed(3)} + motion × ${(formulaWeights?.motionWeight ?? 0.10).toFixed(3)} − repetition_penalty`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{[0,1,2,3].map(i => <Skeleton key={i} className="h-6 w-full" />)}</div>
          ) : (
            <div className="space-y-3">
              {[
                { label: "Hook Score", key: "hookWeight", def: 0.35, color: "bg-violet-500" },
                { label: "Emotion Score", key: "emotionWeight", def: 0.30, color: "bg-pink-500" },
                { label: "Clarity Score", key: "clarityWeight", def: 0.20, color: "bg-blue-500" },
                { label: "Motion Intensity", key: "motionWeight", def: 0.10, color: "bg-orange-500" },
                { label: "B-Roll Value", key: "bRollWeight", def: 0.05, color: "bg-green-500" },
              ].map(({ label, key, def, color }) => {
                const current = formulaWeights?.[key] ?? def;
                const pct = Math.round(current * 100);
                const defPct = Math.round(def * 100);
                const delta = pct - defPct;
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-muted-foreground">{label}</span>
                      <div className="flex items-center gap-2">
                        {delta !== 0 && (
                          <span className={cn("text-[10px]", delta > 0 ? "text-green-400" : "text-red-400")}>
                            {delta > 0 ? "+" : ""}{delta}%
                          </span>
                        )}
                        <span className="font-mono font-semibold">{pct}%</span>
                      </div>
                    </div>
                    <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
                      {/* Default marker */}
                      <div className="absolute top-0 h-full w-0.5 bg-white/30" style={{ left: `${defPct}%` }} />
                    </div>
                  </div>
                );
              })}
              {formulaWeightsVersion === 0 && (
                <p className="text-[11px] text-muted-foreground text-center pt-2 border-t border-border">
                  White markers show default positions. After "Learn from Edit" runs, bars will shift based on which features actually predicted good edits in your projects.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Fine-tuning jobs panel ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  Fine-tuning Jobs
                </CardTitle>
                <CardDescription className="mt-1">OpenAI gpt-4o-mini fine-tuning via your training data</CardDescription>
              </div>
              <Button variant="ghost" size="icon" onClick={handleRefreshFt} disabled={ftLoading}>
                <RefreshCw className={cn("h-4 w-4", ftLoading && "animate-spin")} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Active model badge */}
            {activeModel && (
              <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <div>
                    <p className="text-sm font-medium text-green-400">Active Fine-tuned Model</p>
                    <p className="text-xs font-mono text-green-500/80 truncate max-w-[240px]">{activeModel}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-red-400"
                  onClick={handleDeactivate}
                  disabled={deactivating}
                >
                  {deactivating ? <RefreshCw className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </Button>
              </div>
            )}

            {/* Jobs list */}
            {finetuneStatus?.error ? (
              <div className="rounded-md bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
                <AlertCircle className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                Could not reach OpenAI fine-tuning API.<br />
                <span className="text-xs">{finetuneStatus.error}</span>
              </div>
            ) : finetuneStatus?.jobs?.length === 0 || !finetuneStatus ? (
              <div className="rounded-md bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
                No fine-tuning jobs yet. Start one below.
              </div>
            ) : (
              <ScrollArea className="h-48">
                <div className="space-y-2">
                  {finetuneStatus.jobs.map((job) => {
                    const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.queued;
                    const Icon = cfg.icon;
                    const isSucceeded = job.status === "succeeded" && job.fineTunedModel;
                    const isActive = job.fineTunedModel === activeModel;
                    return (
                      <div
                        key={job.id}
                        className={cn(
                          "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
                          isActive ? "border-green-500/30 bg-green-500/5" : "border-border bg-muted/20"
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon className={cn("h-3.5 w-3.5 shrink-0", cfg.color, job.status === "running" && "animate-pulse")} />
                          <div className="min-w-0">
                            <p className="font-mono text-xs truncate text-muted-foreground">{job.id.slice(-12)}</p>
                            <p className={cn("text-xs font-medium", cfg.color)}>{cfg.label}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {job.trainedTokens && (
                            <span className="text-xs text-muted-foreground">{job.trainedTokens.toLocaleString()} tok</span>
                          )}
                          {isSucceeded && !isActive && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-xs border-green-500/40 text-green-400 hover:bg-green-500/10"
                              onClick={() => job.fineTunedModel && handleActivateModel(job.fineTunedModel)}
                              disabled={!!activating}
                            >
                              {activating === job.fineTunedModel ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Activate"}
                            </Button>
                          )}
                          {isActive && (
                            <Badge variant="outline" className="border-green-500/40 text-green-400 text-xs">Active</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}

            {/* Action buttons */}
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleExportJsonl}
                disabled={exporting || totalExamples === 0}
              >
                {exporting ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                Export JSONL
              </Button>
              <Button
                size="sm"
                className="flex-1 bg-primary"
                onClick={handleSubmitFinetune}
                disabled={submitting || totalExamples === 0}
              >
                {submitting ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                Start Fine-tuning
              </Button>
            </div>
            {totalExamples === 0 && (
              <p className="text-xs text-muted-foreground text-center">
                Complete projects and run "Learn from Edit" to generate training data first.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Learned preferences ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUpDown className="h-4 w-4 text-primary" />
              Learned Clip Preferences
            </CardTitle>
            <CardDescription>Selection rates learned from your editing decisions</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : prefs.length === 0 ? (
              <div className="rounded-md bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
                No preferences learned yet.<br />Run the AI pipeline and "Learn from Edit" on completed projects.
              </div>
            ) : (
              <ScrollArea className="h-72">
                <div className="space-y-1.5">
                  {prefs.slice(0, 30).map((pref) => {
                    const rate = pref.selectionRate ?? 0.5;
                    const label = pref.tag ? `tag: ${pref.tag}` : pref.clipType ?? "unknown";
                    const formatLabel = pref.format.replace(/_/g, " ");
                    return (
                      <div key={pref.id} className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs font-medium truncate">{label}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-xs text-muted-foreground">{formatLabel}</span>
                              <span className={cn("text-xs font-bold tabular-nums", rate >= 0.7 ? "text-green-400" : rate >= 0.4 ? "text-yellow-400" : "text-red-400")}>
                                {Math.round(rate * 100)}%
                              </span>
                            </div>
                          </div>
                          <Progress value={rate * 100} className="h-1.5" />
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 w-12 text-right">n={pref.usageCount}</span>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Recent corrections ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-primary" />
            Recent Human Corrections
          </CardTitle>
          <CardDescription>
            Every time you manually trim, reorder, or toggle a clip, CutAI records it for training.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : corrections.length === 0 ? (
            <div className="rounded-md bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No corrections recorded yet. Edit clips in your projects to train the AI.
            </div>
          ) : (
            <ScrollArea className="h-72">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left pb-2 font-medium w-28">Type</th>
                    <th className="text-left pb-2 font-medium">AI → Human</th>
                    <th className="text-left pb-2 font-medium">Delta</th>
                    <th className="text-left pb-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {corrections.map((c) => {
                    const hasTimingDelta = c.deltaStartSeconds != null || c.deltaEndSeconds != null;
                    const hasOrderDelta = c.aiOrderIndex != null && c.humanOrderIndex != null;
                    const hasIncludeDelta = c.aiIncluded != null && c.humanIncluded != null;
                    return (
                      <tr key={c.id} className="text-xs hover:bg-muted/20">
                        <td className="py-2 pr-4">
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {editTypeLabel(c.editType)}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 font-mono text-muted-foreground">
                          {hasTimingDelta && (
                            <>
                              {c.aiStartTime != null ? c.aiStartTime.toFixed(2) : "—"}s →{" "}
                              {c.humanStartTime != null ? c.humanStartTime.toFixed(2) : "—"}s
                            </>
                          )}
                          {hasOrderDelta && (
                            <>pos {c.aiOrderIndex} → {c.humanOrderIndex}</>
                          )}
                          {hasIncludeDelta && (
                            <>{String(c.aiIncluded)} → {String(c.humanIncluded)}</>
                          )}
                          {!hasTimingDelta && !hasOrderDelta && !hasIncludeDelta && "—"}
                        </td>
                        <td className="py-2 pr-4 font-mono">
                          {c.deltaStartSeconds != null && (
                            <span className={cn(Math.abs(c.deltaStartSeconds) > 0.5 ? "text-orange-400" : "text-muted-foreground")}>
                              {deltaSign(c.deltaStartSeconds)}{c.deltaStartSeconds > 0 ? "+" : ""}{c.deltaStartSeconds.toFixed(2)}s
                            </span>
                          )}
                          {c.deltaEndSeconds != null && c.deltaStartSeconds == null && (
                            <span className={cn(Math.abs(c.deltaEndSeconds) > 0.5 ? "text-orange-400" : "text-muted-foreground")}>
                              {deltaSign(c.deltaEndSeconds)}{c.deltaEndSeconds > 0 ? "+" : ""}{c.deltaEndSeconds.toFixed(2)}s
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ── Training examples ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Training Examples
          </CardTitle>
          <CardDescription>Completed projects used to fine-tune the AI model</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (overview?.recentExamples ?? []).length === 0 ? (
            <div className="rounded-md bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No training examples yet. Complete a project and run "Learn from Edit" from the project workspace.
            </div>
          ) : (
            <div className="space-y-2">
              {(overview?.recentExamples ?? []).map((ex) => (
                <div key={ex.id} className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <CheckCircle2 className={cn("h-4 w-4 shrink-0", ex.humanApproved ? "text-green-500" : "text-muted-foreground")} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{ex.projectName ?? "Unnamed project"}</p>
                      <p className="text-xs text-muted-foreground">
                        {ex.format?.replace(/_/g, " ")} · {ex.totalClipsUsed}/{ex.totalClipsAvailable} clips · {fmtDuration(ex.totalDuration)}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatDistanceToNow(new Date(ex.createdAt), { addSuffix: true })}
                  </span>
                </div>
              ))}
              {overview && overview.totalExamples > (overview.recentExamples?.length ?? 0) && (
                <p className="text-xs text-muted-foreground text-center pt-2">
                  Showing {overview.recentExamples?.length} of {overview.totalExamples} total examples
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Format breakdown ── */}
      {overview && Object.keys(overview.formatBreakdown ?? {}).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Training Data by Format
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(overview.formatBreakdown).map(([format, count]) => (
                <div key={format} className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <span className="text-sm capitalize">{format.replace(/_/g, " ")}</span>
                  <Badge variant="secondary">{count} example{count !== 1 ? "s" : ""}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({
  title, value, icon, description, accentColor,
}: {
  title: string;
  value: number | null;
  icon: React.ReactNode;
  description: string;
  accentColor?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {value === null ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className={cn("text-2xl font-bold", accentColor)}>{value.toLocaleString()}</div>
        )}
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}
