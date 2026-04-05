import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { useLocation } from "wouter";
import { 
  Upload, Zap, Film, Clock, CheckCircle2, Loader2, 
  ArrowLeft, FileVideo, X, AlertCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FORMATS = [
  { id: "instagram_reel", label: "Instagram Reel", emoji: "📱", desc: "9:16 · 15–60s · high hook", color: "from-pink-600 to-purple-600" },
  { id: "tiktok", label: "TikTok", emoji: "🎵", desc: "9:16 · 15–60s · hook first", color: "from-zinc-800 to-zinc-700" },
  { id: "youtube_short", label: "YouTube Short", emoji: "▶️", desc: "9:16 · under 60s", color: "from-red-700 to-red-600" },
  { id: "youtube_long", label: "YouTube (Long)", emoji: "🎬", desc: "16:9 · 5–20 min", color: "from-red-800 to-red-700" },
  { id: "wedding_highlight", label: "Wedding Highlight", emoji: "💍", desc: "16:9 · 3–5 min · cinematic", color: "from-rose-700 to-pink-600" },
  { id: "ad_spot", label: "Ad Spot", emoji: "📢", desc: "16:9 · 15–30s · conversion", color: "from-blue-700 to-blue-600" },
  { id: "corporate_promo", label: "Corporate Promo", emoji: "🏢", desc: "16:9 · 1–3 min · professional", color: "from-slate-700 to-slate-600" },
] as const;

type FormatId = typeof FORMATS[number]["id"];

const PIPELINE_STEPS = [
  "Detect Beats",
  "Analyze Music",
  "Detect Speech",
  "Frame Quality Signals",
  "Analyze Clips (AI)",
  "AI Clip Ranking",
  "Generate Edit Plan",
  "Apply & Finalize",
  "Render to MP4",
  "Quality Check",
];

interface BatchFile {
  file: File;
  id: string;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
}

export default function BatchPage() {
  const [, navigate] = useLocation();
  const [format, setFormat] = useState<FormatId>("instagram_reel");
  const [projectName, setProjectName] = useState("");
  const [files, setFiles] = useState<BatchFile[]>([]);
  const [phase, setPhase] = useState<"setup" | "uploading" | "pipeline" | "done">("setup");
  const [pipelineStep, setPipelineStep] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback((accepted: File[]) => {
    const newFiles: BatchFile[] = accepted
      .filter(f => f.type.startsWith("video/") || f.type.startsWith("audio/"))
      .map(f => ({ file: f, id: crypto.randomUUID(), status: "pending", progress: 0 }));
    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "video/*": [".mp4", ".mov", ".avi", ".mkv", ".webm"], "audio/*": [".mp3", ".wav", ".m4a"] },
    multiple: true,
  });

  const removeFile = (id: string) => setFiles(prev => prev.filter(f => f.id !== id));

  const handleStart = async () => {
    if (files.length === 0) return;
    setError(null);
    setPhase("uploading");

    const name = projectName.trim() || `${FORMATS.find(f => f.id === format)?.label ?? "Batch"} — ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`;

    try {
      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, targetFormat: format }),
      });
      if (!createRes.ok) throw new Error("Failed to create project");
      const project = await createRes.json();
      setProjectId(project.id);

      for (let i = 0; i < files.length; i++) {
        const bf = files[i];
        setFiles(prev => prev.map(f => f.id === bf.id ? { ...f, status: "uploading", progress: 0 } : f));

        const form = new FormData();
        form.append("video", bf.file);

        try {
          const xhr = new XMLHttpRequest();
          await new Promise<void>((resolve, reject) => {
            xhr.upload.onprogress = (e) => {
              const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
              setFiles(prev => prev.map(f => f.id === bf.id ? { ...f, progress: pct } : f));
            };
            xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.statusText}`));
            xhr.onerror = () => reject(new Error("Upload network error"));
            xhr.open("POST", `/api/projects/${project.id}/videos`);
            xhr.send(form);
          });
          setFiles(prev => prev.map(f => f.id === bf.id ? { ...f, status: "done", progress: 100 } : f));
        } catch (e) {
          setFiles(prev => prev.map(f => f.id === bf.id ? { ...f, status: "error", error: String(e) } : f));
        }
      }

      setPhase("pipeline");
      await runFullPipeline(project.id);
    } catch (e) {
      setError(String(e));
      setPhase("setup");
    }
  };

  const runFullPipeline = async (pid: string) => {
    const steps: Array<{ type: string; requiresVideo?: boolean }> = [
      { type: "detect_beats", requiresVideo: true },
      { type: "analyze_music", requiresVideo: true },
      { type: "detect_speech" },
      { type: "detect_quality_signals" },
      { type: "analyze_clips" },
      { type: "rank_clips_ai" },
      { type: "generate_edit_plan" },
      { type: "apply_edit" },
      { type: "render" },
      { type: "quality_check" },
    ];

    const getVideos = async () => {
      const r = await fetch(`/api/projects/${pid}/videos`);
      return r.ok ? r.json() : [];
    };

    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      setPipelineStep(si + 1);

      const videos = await getVideos();
      const videoIds = videos.map((v: any) => v.id);

      const jobsToRun: Array<{ type: string; videoId?: string }> = [];
      if (step.requiresVideo && videoIds.length > 0) {
        for (const vid of videoIds) jobsToRun.push({ type: step.type, videoId: vid });
      } else {
        jobsToRun.push({ type: step.type });
      }

      const jobIds: string[] = [];
      for (const j of jobsToRun) {
        const r = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: pid, type: j.type, videoId: j.videoId }),
        });
        if (r.ok) {
          const job = await r.json();
          jobIds.push(job.id);
        }
      }

      await waitForJobs(jobIds);
    }

    setPhase("done");
  };

  const waitForJobs = async (jobIds: string[]) => {
    if (jobIds.length === 0) return;
    const maxWait = 300;
    let elapsed = 0;
    while (elapsed < maxWait) {
      await new Promise(r => setTimeout(r, 3000));
      elapsed += 3;
      const statuses = await Promise.all(jobIds.map(id =>
        fetch(`/api/jobs/${id}`).then(r => r.ok ? r.json() : { status: "unknown" })
      ));
      const allDone = statuses.every((s: any) => s.status === "completed" || s.status === "failed");
      if (allDone) return;
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => navigate("/projects")}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              Batch Auto-Edit
            </h1>
            <p className="text-sm text-muted-foreground">Upload clips → choose format → AI edits everything automatically</p>
          </div>
        </div>

        {phase === "setup" && (
          <div className="space-y-6">
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-2 block">Project name (optional)</label>
              <input
                type="text"
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                placeholder="e.g. Wedding Day Highlight"
                className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-muted-foreground mb-3 block">Target format</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {FORMATS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    className={cn(
                      "p-3 rounded-xl border text-left transition-all",
                      format === f.id
                        ? "border-primary bg-primary/10 ring-1 ring-primary"
                        : "border-border bg-card hover:border-primary/40"
                    )}
                  >
                    <div className="text-lg mb-1">{f.emoji}</div>
                    <div className="text-xs font-semibold">{f.label}</div>
                    <div className="text-[10px] text-muted-foreground">{f.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-muted-foreground mb-2 block">Upload clips</label>
              <div
                {...getRootProps()}
                className={cn(
                  "border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer",
                  isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                )}
              >
                <input {...getInputProps()} />
                <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm font-medium">Drop video files here</p>
                <p className="text-xs text-muted-foreground mt-1">MP4, MOV, MKV, WebM, MP3, WAV · Multiple files</p>
              </div>

              {files.length > 0 && (
                <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto">
                  {files.map(bf => (
                    <div key={bf.id} className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2">
                      <FileVideo className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs truncate flex-1">{bf.file.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{(bf.file.size / 1024 / 1024).toFixed(1)}MB</span>
                      <button onClick={() => removeFile(bf.id)} className="text-muted-foreground hover:text-red-400 transition-colors">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">What happens automatically:</div>
              <div className="grid grid-cols-2 gap-1.5">
                {PIPELINE_STEPS.map((step, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <div className="w-4 h-4 rounded-full bg-muted flex items-center justify-center text-[8px] font-bold text-muted-foreground shrink-0">{i + 1}</div>
                    {step}
                  </div>
                ))}
              </div>
            </div>

            <Button
              className="w-full h-11 text-sm font-semibold bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-700"
              disabled={files.length === 0}
              onClick={handleStart}
            >
              <Zap className="h-4 w-4 mr-2" />
              Start Auto-Edit ({files.length} clip{files.length !== 1 ? "s" : ""})
            </Button>
          </div>
        )}

        {phase === "uploading" && (
          <div className="space-y-4">
            <div className="text-center mb-6">
              <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-3" />
              <div className="font-semibold">Uploading files...</div>
            </div>
            {files.map(bf => (
              <div key={bf.id} className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm truncate max-w-[300px]">{bf.file.name}</span>
                  {bf.status === "done" && <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />}
                  {bf.status === "error" && <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />}
                  {bf.status === "uploading" && <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn("h-full rounded-full transition-all", bf.status === "error" ? "bg-red-500" : "bg-primary")}
                    style={{ width: `${bf.progress}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {(phase === "pipeline" || phase === "done") && (
          <div className="space-y-4">
            <div className="text-center mb-6">
              {phase === "done"
                ? <CheckCircle2 className="h-10 w-10 text-green-400 mx-auto mb-3" />
                : <Zap className="h-10 w-10 text-primary mx-auto mb-3 animate-pulse" />
              }
              <div className="text-lg font-bold">
                {phase === "done" ? "Edit ready!" : "AI is editing..."}
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {phase === "done"
                  ? "Your video has been automatically edited and rendered."
                  : `Step ${pipelineStep} of ${PIPELINE_STEPS.length}: ${PIPELINE_STEPS[pipelineStep - 1] ?? "Processing"}`
                }
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-4 space-y-2">
              {PIPELINE_STEPS.map((step, i) => {
                const done = i + 1 < pipelineStep || phase === "done";
                const running = i + 1 === pipelineStep && phase === "pipeline";
                return (
                  <div key={i} className={cn("flex items-center gap-2.5 py-1", done ? "text-green-400" : running ? "text-primary" : "text-muted-foreground/40")}>
                    <div className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0",
                      done ? "bg-green-500 text-white" : running ? "bg-primary text-white" : "bg-muted"
                    )}>
                      {done ? "✓" : running ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}
                    </div>
                    <span className={cn("text-sm", running && "font-semibold")}>{step}</span>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-3">
              {projectId && (
                <Button
                  className="flex-1"
                  variant={phase === "done" ? "default" : "outline"}
                  onClick={() => navigate(`/projects/${projectId}`)}
                >
                  <Film className="h-4 w-4 mr-2" />
                  {phase === "done" ? "Open in Editor" : "Open Project"}
                </Button>
              )}
              {phase !== "done" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-1 justify-center">
                  <Clock className="h-3.5 w-3.5" />
                  {Math.round((PIPELINE_STEPS.length - pipelineStep) * 30 / 60)} min remaining (est.)
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
