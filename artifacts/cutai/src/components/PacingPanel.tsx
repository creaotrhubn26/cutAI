import { useState } from "react";
import {
  Gauge, TrendingUp, AlertTriangle, CheckCircle2, Zap,
  Scissors, Clock, ChevronDown, ChevronUp, Sparkles, Loader2, Timer, Play
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

interface PacingIssue {
  clipIndex: number;
  label: string;
  issueType: "too_long" | "too_short" | "dead_air" | "repetitive" | "poor_transition" | "energy_drop";
  severity: "low" | "medium" | "high";
  currentDuration: number;
  suggestedDuration: number | null;
  action: string;
}

interface PacingData {
  overallScore: number;
  pacingStyle: "punchy" | "steady" | "building" | "wave" | "sluggish" | "erratic";
  verdict: string;
  recommendation: string;
  issues: PacingIssue[];
  strengths: string[];
  quickWins: string[];
  energyArc: number[];
}

interface PacingPanelProps {
  pacingSuggestions?: string | null;
  onRunJob: (type: string) => void;
  onApplyPacing: (issues: PacingIssue[]) => Promise<void>;
  isJobRunning: boolean;
  segmentCount: number;
}

const pacingStyleConfig: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  punchy:    { label: "Punchy",    color: "text-red-400",    bg: "bg-red-400/10 border-red-400/20",    icon: <Zap className="h-3 w-3" /> },
  steady:    { label: "Steady",    color: "text-green-400",  bg: "bg-green-400/10 border-green-400/20",  icon: <TrendingUp className="h-3 w-3" /> },
  building:  { label: "Building",  color: "text-blue-400",   bg: "bg-blue-400/10 border-blue-400/20",   icon: <TrendingUp className="h-3 w-3" /> },
  wave:      { label: "Wave",      color: "text-violet-400", bg: "bg-violet-400/10 border-violet-400/20", icon: <TrendingUp className="h-3 w-3" /> },
  sluggish:  { label: "Sluggish",  color: "text-amber-400",  bg: "bg-amber-400/10 border-amber-400/20",  icon: <Clock className="h-3 w-3" /> },
  erratic:   { label: "Erratic",   color: "text-orange-400", bg: "bg-orange-400/10 border-orange-400/20", icon: <AlertTriangle className="h-3 w-3" /> },
};

const issueTypeConfig: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  too_long:        { label: "Too long",       icon: <Scissors className="h-3 w-3" />,      color: "text-amber-400" },
  too_short:       { label: "Too short",      icon: <Timer className="h-3 w-3" />,          color: "text-blue-400" },
  dead_air:        { label: "Dead air",       icon: <Clock className="h-3 w-3" />,          color: "text-zinc-400" },
  repetitive:      { label: "Repetitive",     icon: <AlertTriangle className="h-3 w-3" />,  color: "text-orange-400" },
  poor_transition: { label: "Transition",     icon: <TrendingUp className="h-3 w-3" />,     color: "text-violet-400" },
  energy_drop:     { label: "Energy drop",    icon: <AlertTriangle className="h-3 w-3" />,  color: "text-red-400" },
};

const severityBg: Record<string, string> = {
  low:    "border-zinc-700/60 bg-zinc-900/30",
  medium: "border-amber-500/20 bg-amber-500/5",
  high:   "border-red-500/25 bg-red-500/5",
};

function EnergyArc({ arc }: { arc: number[] }) {
  if (!arc.length) return null;
  const max = Math.max(...arc, 0.1);
  return (
    <div className="space-y-1">
      <p className="text-[8px] text-zinc-600 uppercase font-bold">Energy Arc</p>
      <div className="flex items-end gap-px h-6">
        {arc.map((v, i) => {
          const height = Math.round((v / max) * 100);
          const hue = v > 0.7 ? "bg-red-400" : v > 0.4 ? "bg-amber-400" : "bg-blue-400";
          return (
            <div
              key={i}
              className={`flex-1 rounded-sm ${hue} opacity-80 transition-all`}
              style={{ height: `${Math.max(8, height)}%` }}
              title={`Clip ${i + 1}: ${Math.round(v * 100)}% energy`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[7px] text-zinc-700">
        <span>Start</span>
        <span>End</span>
      </div>
    </div>
  );
}

export function PacingPanel({ pacingSuggestions, onRunJob, onApplyPacing, isJobRunning, segmentCount }: PacingPanelProps) {
  const [showAllIssues, setShowAllIssues] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedIds, setAppliedIds] = useState<Set<number>>(new Set());

  let data: PacingData | null = null;
  try {
    if (pacingSuggestions) data = JSON.parse(pacingSuggestions) as PacingData;
  } catch {}

  const scoreColor = !data ? "text-zinc-400" : data.overallScore >= 80 ? "text-green-400" : data.overallScore >= 60 ? "text-amber-400" : "text-red-400";
  const scoreBarColor = !data ? "" : data.overallScore >= 80 ? "[&>div]:bg-green-500" : data.overallScore >= 60 ? "[&>div]:bg-amber-500" : "[&>div]:bg-red-500";
  const styleConf = data ? (pacingStyleConfig[data.pacingStyle] ?? pacingStyleConfig["steady"]) : null;
  const visibleIssues = data?.issues ? (showAllIssues ? data.issues : data.issues.slice(0, 3)) : [];
  const applyableIssues = data?.issues?.filter(i => i.suggestedDuration != null) ?? [];

  const handleApplyAll = async () => {
    if (!data?.issues) return;
    setApplying(true);
    try {
      await onApplyPacing(applyableIssues);
      setAppliedIds(new Set(applyableIssues.map(i => i.clipIndex)));
    } finally {
      setApplying(false);
    }
  };

  const handleApplyOne = async (issue: PacingIssue) => {
    setApplying(true);
    try {
      await onApplyPacing([issue]);
      setAppliedIds(prev => new Set([...prev, issue.clipIndex]));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-3 py-1">
      {/* Header */}
      <div className="flex items-center gap-1.5">
        <Gauge className="h-3.5 w-3.5 text-cyan-400" />
        <span className="text-[11px] font-bold uppercase tracking-wider">Pacing Analysis</span>
      </div>

      {/* No data state */}
      {!data && (
        <div className="rounded-md border border-dashed border-zinc-800 p-3 space-y-2.5">
          <p className="text-[9px] text-zinc-500 leading-relaxed">
            AI analyzes your timeline rhythm — clip lengths, energy arc, cuts per minute — and gives specific suggestions for each clip that's too long, too short, or poorly timed.
          </p>
          {segmentCount === 0 && (
            <p className="text-[8px] text-amber-400/80 bg-amber-400/5 border border-amber-400/15 rounded px-2 py-1">
              Generate an edit plan first to create segments.
            </p>
          )}
          <Button
            size="sm"
            className="w-full text-[9px] h-7 bg-cyan-600/80 hover:bg-cyan-600 text-white border-0"
            disabled={isJobRunning || segmentCount === 0}
            onClick={() => onRunJob("suggest_pacing")}
          >
            {isJobRunning
              ? <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Analyzing…</>
              : <><Gauge className="h-3 w-3 mr-1.5" />Analyze Pacing</>
            }
          </Button>
        </div>
      )}

      {/* Results */}
      {data && (
        <>
          {/* Score + style */}
          <div className="flex items-center gap-3 bg-zinc-900/60 rounded-md border border-zinc-800 p-2.5">
            <div className="text-center shrink-0">
              <div className={`text-3xl font-black tabular-nums ${scoreColor}`}>{data.overallScore}</div>
              <div className="text-[7px] text-zinc-600 uppercase font-bold">/100</div>
            </div>
            <div className="flex-1 space-y-1.5">
              <div className="flex items-center gap-1.5">
                {styleConf && (
                  <span className={`flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${styleConf.bg} ${styleConf.color}`}>
                    {styleConf.icon}
                    {styleConf.label}
                  </span>
                )}
              </div>
              <Progress value={data.overallScore} className={`h-1.5 bg-zinc-800 ${scoreBarColor}`} />
              <p className="text-[8px] text-zinc-400 leading-snug">{data.verdict}</p>
            </div>
          </div>

          {/* Energy arc */}
          {data.energyArc?.length > 1 && (
            <div className="bg-zinc-900/40 rounded-md border border-zinc-800 p-2">
              <EnergyArc arc={data.energyArc} />
            </div>
          )}

          {/* Recommendation */}
          <div className="bg-cyan-950/30 rounded-md border border-cyan-500/15 p-2 space-y-1">
            <p className="text-[8px] text-cyan-400 uppercase font-bold">Recommendation</p>
            <p className="text-[9px] text-zinc-300 leading-relaxed">{data.recommendation}</p>
          </div>

          {/* Quick wins */}
          {data.quickWins?.length > 0 && (
            <div className="space-y-1">
              <p className="text-[8px] text-zinc-500 uppercase font-bold">Quick Wins</p>
              {data.quickWins.map((qw, i) => (
                <div key={i} className="flex items-start gap-1.5 bg-zinc-900/40 rounded px-2 py-1.5">
                  <Sparkles className="h-2.5 w-2.5 text-cyan-400 shrink-0 mt-0.5" />
                  <p className="text-[9px] text-zinc-300 leading-snug">{qw}</p>
                </div>
              ))}
            </div>
          )}

          {/* Issues */}
          {data.issues?.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[8px] text-zinc-500 uppercase font-bold">
                  Issues ({data.issues.length})
                </p>
                <div className="flex items-center gap-2">
                  {applyableIssues.length > 0 && (
                    <button
                      className="text-[8px] text-cyan-500 hover:text-cyan-300 font-bold flex items-center gap-0.5 disabled:opacity-40"
                      onClick={handleApplyAll}
                      disabled={applying}
                    >
                      {applying ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                      Apply All ({applyableIssues.length})
                    </button>
                  )}
                  {data.issues.length > 3 && (
                    <button
                      className="text-[8px] text-zinc-600 hover:text-zinc-400 flex items-center gap-0.5"
                      onClick={() => setShowAllIssues(v => !v)}
                    >
                      {showAllIssues ? <><ChevronUp className="h-2.5 w-2.5" />Less</> : <><ChevronDown className="h-2.5 w-2.5" />All</>}
                    </button>
                  )}
                </div>
              </div>
              {visibleIssues.map((issue, i) => {
                const iConf = issueTypeConfig[issue.issueType] ?? issueTypeConfig["too_long"];
                const isApplied = appliedIds.has(issue.clipIndex);
                return (
                  <div key={i} className={`rounded-md border px-2 py-1.5 space-y-0.5 ${isApplied ? "border-green-500/20 bg-green-500/5 opacity-60" : severityBg[issue.severity] ?? severityBg["low"]}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={`${iConf.color}`}>{iConf.icon}</span>
                      <span className="text-[9px] font-semibold text-zinc-200 truncate flex-1">
                        Clip #{issue.clipIndex}: {issue.label}
                      </span>
                      {isApplied ? (
                        <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                      ) : (
                        <>
                          <Badge
                            variant="outline"
                            className={`text-[7px] h-3.5 px-1 border-0 ${issue.severity === "high" ? "bg-red-500/20 text-red-400" : issue.severity === "medium" ? "bg-amber-500/20 text-amber-400" : "bg-zinc-700 text-zinc-400"}`}
                          >
                            {issue.severity}
                          </Badge>
                          {issue.suggestedDuration && (
                            <button
                              className="text-[7px] text-cyan-500 hover:text-cyan-300 font-bold px-1 py-0.5 rounded bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors disabled:opacity-40"
                              onClick={() => handleApplyOne(issue)}
                              disabled={applying}
                            >
                              Apply
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] text-zinc-500">{issue.currentDuration.toFixed(1)}s now</span>
                      {issue.suggestedDuration && !isApplied && (
                        <>
                          <span className="text-[8px] text-zinc-700">→</span>
                          <span className="text-[8px] text-cyan-400">{issue.suggestedDuration.toFixed(1)}s ideal</span>
                        </>
                      )}
                    </div>
                    {!isApplied && <p className="text-[8px] text-zinc-400">{issue.action}</p>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Strengths */}
          {data.strengths?.length > 0 && (
            <div className="space-y-1">
              <p className="text-[8px] text-zinc-500 uppercase font-bold">What's Working</p>
              {data.strengths.map((s, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <CheckCircle2 className="h-2.5 w-2.5 text-green-500 shrink-0 mt-0.5" />
                  <p className="text-[9px] text-zinc-400">{s}</p>
                </div>
              ))}
            </div>
          )}

          {/* Re-run */}
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-[9px] h-6 text-zinc-600 hover:text-zinc-400"
            disabled={isJobRunning}
            onClick={() => onRunJob("suggest_pacing")}
          >
            {isJobRunning
              ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Analyzing…</>
              : <><Gauge className="h-3 w-3 mr-1" />Re-analyze Pacing</>
            }
          </Button>
        </>
      )}
    </div>
  );
}
