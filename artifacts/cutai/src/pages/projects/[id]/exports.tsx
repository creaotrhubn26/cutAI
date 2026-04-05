import { useListProjectExports, getListProjectExportsQueryKey, useGetProject, getGetProjectQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Download, FileVideo, Clock, CheckCircle2, AlertCircle, FileCode, FileJson, Music2, Clapperboard, FileText, Camera, Youtube, HardDriveUpload, ExternalLink, Loader2, Layers } from "lucide-react";
import { useState } from "react";

import { format } from "date-fns";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

type UploadState = { status: "idle" | "uploading" | "done" | "error"; message?: string; link?: string };

export default function ProjectExports() {
  const params = useParams();
  const id = params.id!;

  const [driveUpload, setDriveUpload] = useState<UploadState>({ status: "idle" });
  const [ytUpload, setYtUpload] = useState<UploadState>({ status: "idle" });

  async function uploadToDrive() {
    setDriveUpload({ status: "uploading" });
    try {
      const res = await fetch(`${API_BASE}/projects/${id}/upload-to-drive`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setDriveUpload({ status: "done", message: `${data.fileName} (${data.sizeMB}MB)`, link: data.webViewLink });
    } catch (err: any) {
      setDriveUpload({ status: "error", message: err.message });
    }
  }

  async function uploadToYouTube() {
    setYtUpload({ status: "uploading" });
    try {
      const res = await fetch(`${API_BASE}/projects/${id}/upload-to-youtube`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ privacyStatus: "unlisted" }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setYtUpload({ status: "done", message: data.title, link: data.videoUrl });
    } catch (err: any) {
      setYtUpload({ status: "error", message: err.message });
    }
  }

  const { data: project } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  const { data: exports, isLoading } = useListProjectExports(id, {
    query: { 
      enabled: !!id, 
      queryKey: getListProjectExportsQueryKey(id),
      refetchInterval: (query) => {
        const hasActive = query.state.data?.some(exp => exp.status === 'pending' || exp.status === 'rendering');
        return hasActive ? 3000 : false;
      }
    }
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending': return <Badge variant="outline" className="bg-muted text-muted-foreground">Queued</Badge>;
      case 'rendering': return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20"><Clock className="mr-1 h-3 w-3 animate-spin" /> Rendering</Badge>;
      case 'completed': return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20"><CheckCircle2 className="mr-1 h-3 w-3" /> Ready</Badge>;
      case 'failed': return <Badge variant="destructive">Failed</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getResolutionDisplay = (res: string) => {
    switch (res) {
      case '1080p': return '1920×1080 (HD)';
      case '720p': return '1280×720';
      case '4k': return '3840×2160 (4K)';
      case 'vertical_1080': return '1080×1920 (Vertical HD)';
      case 'vertical_720': return '720×1280 (Vertical)';
      default: return res;
    }
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="flex h-14 items-center gap-4 border-b border-border bg-card px-6 shrink-0">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="font-semibold text-sm">Exports</h1>
          {project && <p className="text-xs text-muted-foreground">{project.name}</p>}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">

          {/* NLE Exchange Formats */}
          <div>
            <div className="mb-4">
              <h2 className="text-2xl font-bold tracking-tight">NLE Exchange Formats</h2>
              <p className="text-muted-foreground">Import your CutAI edit directly into DaVinci Resolve, Premiere, or Final Cut Pro.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {/* DaVinci Resolve XML — top recommended */}
              <Card className="bg-card border-2 border-violet-500/40 group hover:border-violet-500/70 transition-colors relative overflow-hidden">
                <div className="absolute top-2 right-2">
                  <Badge className="text-[9px] bg-violet-500/20 text-violet-300 border-violet-500/40 px-1.5 h-4">Recommended</Badge>
                </div>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                      <Layers className="h-5 w-5 text-violet-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">DaVinci XML</CardTitle>
                      <CardDescription className="text-[11px]">.xml — xmeml v5</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    FCP7 XML — the most reliable format for DaVinci Resolve. Includes video + audio tracks, color grades, speed remaps, and clip notes. Use File → Import Timeline → XML in Resolve.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">DaVinci Resolve</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Adobe Premiere</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Avid</Badge>
                  </div>
                  <Button size="sm" className="w-full gap-2 text-xs bg-violet-600 hover:bg-violet-700" asChild>
                    <a href={`${API_BASE}/projects/${id}/export-resolve.xml`} download>
                      <Download className="h-3.5 w-3.5" />
                      Download for Resolve
                    </a>
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <Clapperboard className="h-5 w-5 text-blue-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">FCPXML</CardTitle>
                      <CardDescription className="text-[11px]">.fcpxml</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Full timeline with clip positions, beat markers, emotional section chapters, and AI metadata. Imports directly into Final Cut Pro X.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Final Cut Pro X</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Resolve (alt)</Badge>
                  </div>
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs" asChild>
                    <a href={`${API_BASE}/projects/${id}/export.fcpxml`} download>
                      <Download className="h-3.5 w-3.5" />
                      Download FCPXML
                    </a>
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
                      <FileCode className="h-5 w-5 text-orange-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">EDL</CardTitle>
                      <CardDescription className="text-[11px]">.edl — CMX3600</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Edit Decision List — the universal interchange format. Supported by every professional NLE including Resolve, Premiere, Avid, and Vegas.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">DaVinci Resolve</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Adobe Premiere</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Avid</Badge>
                  </div>
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs" asChild>
                    <a href={`/api/projects/${id}/export.edl`} download>
                      <Download className="h-3.5 w-3.5" />
                      Download EDL
                    </a>
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                      <FileJson className="h-5 w-5 text-emerald-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">JSON Data</CardTitle>
                      <CardDescription className="text-[11px]">.json — structured data</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Full edit plan with beat analysis, emotional arc, and all clip metadata. Use this to build custom integrations or import into other tools.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Custom tools</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Automation</Badge>
                  </div>
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs" asChild>
                    <a href={`/api/projects/${id}/export.json`} download>
                      <Download className="h-3.5 w-3.5" />
                      Download JSON
                    </a>
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* SRT + Thumbnail row */}
            <div className="grid gap-4 md:grid-cols-2 mt-4">
              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                      <FileText className="h-5 w-5 text-yellow-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">SRT Subtitles</CardTitle>
                      <CardDescription className="text-[11px]">.srt — SubRip format</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Subtitle file synced to your edit timeline. Generated from caption overlays, or chapter markers if no captions are set.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">YouTube</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Vimeo</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Any player</Badge>
                  </div>
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs" asChild>
                    <a href={`${API_BASE}/projects/${id}/export.srt`} download>
                      <Download className="h-3.5 w-3.5" />
                      Download SRT
                    </a>
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-pink-500/10 flex items-center justify-center">
                      <Camera className="h-5 w-5 text-pink-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">YouTube Thumbnail</CardTitle>
                      <CardDescription className="text-[11px]">.jpg — 1280px wide</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Auto-generated thumbnail extracted at the most visually interesting moment (30% into the video).
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">YouTube</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Instagram</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">1280px</Badge>
                  </div>
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs" asChild>
                    <a href={`${API_BASE}/projects/${id}/thumbnail.jpg`} target="_blank" rel="noreferrer">
                      <Camera className="h-3.5 w-3.5" />
                      Generate & Download
                    </a>
                  </Button>
                </CardContent>
              </Card>
            </div>

            <div className="mt-4 p-4 rounded-lg bg-muted/30 border border-border text-xs text-muted-foreground flex items-start gap-3">
              <Music2 className="h-4 w-4 shrink-0 mt-0.5 text-primary/60" />
              <span>
                FCPXML exports embed beat markers from your music analysis directly onto each clip, so cuts snap to beat grid automatically when you open the timeline in DaVinci Resolve.
                If you haven't run Music Analysis yet, go to the workspace and run it first for best results.
              </span>
            </div>
          </div>

          <Separator />

          {/* Publish to Cloud */}
          <div>
            <div className="mb-4">
              <h2 className="text-2xl font-bold tracking-tight">Publish to Cloud</h2>
              <p className="text-muted-foreground">Send your rendered video directly to Google Drive or YouTube.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">

              {/* Google Drive */}
              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <HardDriveUpload className="h-5 w-5 text-blue-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">Google Drive</CardTitle>
                      <CardDescription className="text-[11px]">Upload to your Drive folder</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Upload the rendered MP4 directly to your configured Google Drive folder. The file will be shared with view access automatically.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">MP4</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Public link</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">creatorhubn</Badge>
                  </div>
                  {driveUpload.status === "done" && driveUpload.link && (
                    <a href={driveUpload.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
                      <ExternalLink className="h-3 w-3" /> {driveUpload.message}
                    </a>
                  )}
                  {driveUpload.status === "error" && (
                    <p className="text-xs text-destructive">{driveUpload.message}</p>
                  )}
                  <Button
                    size="sm"
                    variant={driveUpload.status === "done" ? "outline" : "default"}
                    className="w-full gap-2 text-xs"
                    disabled={driveUpload.status === "uploading"}
                    onClick={uploadToDrive}
                  >
                    {driveUpload.status === "uploading"
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
                      : driveUpload.status === "done"
                        ? <><CheckCircle2 className="h-3.5 w-3.5" /> Upload Again</>
                        : <><HardDriveUpload className="h-3.5 w-3.5" /> Upload to Drive</>}
                  </Button>
                </CardContent>
              </Card>

              {/* YouTube */}
              <Card className="bg-card border-border group hover:border-primary/40 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="h-10 w-10 rounded-lg bg-red-500/10 flex items-center justify-center">
                      <Youtube className="h-5 w-5 text-red-400" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">YouTube</CardTitle>
                      <CardDescription className="text-[11px]">Publish as unlisted video</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Upload the rendered MP4 as an unlisted YouTube video. You can change the privacy setting and add a description in YouTube Studio afterwards.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">Unlisted</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">YouTube Data API</Badge>
                    <Badge variant="secondary" className="text-[9px] px-1.5 h-4">MP4</Badge>
                  </div>
                  {ytUpload.status === "done" && ytUpload.link && (
                    <a href={ytUpload.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-red-400 hover:underline">
                      <ExternalLink className="h-3 w-3" /> {ytUpload.message}
                    </a>
                  )}
                  {ytUpload.status === "error" && (
                    <p className="text-xs text-destructive">{ytUpload.message}</p>
                  )}
                  <Button
                    size="sm"
                    variant={ytUpload.status === "done" ? "outline" : "default"}
                    className="w-full gap-2 text-xs bg-red-600 hover:bg-red-700 text-white"
                    disabled={ytUpload.status === "uploading"}
                    onClick={uploadToYouTube}
                  >
                    {ytUpload.status === "uploading"
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
                      : ytUpload.status === "done"
                        ? <><CheckCircle2 className="h-3.5 w-3.5" /> Upload Again</>
                        : <><Youtube className="h-3.5 w-3.5" /> Publish to YouTube</>}
                  </Button>
                </CardContent>
              </Card>

            </div>
          </div>

          <Separator />

          <div className="flex justify-between items-end">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Final Render Exports</h2>
              <p className="text-muted-foreground">Download your finished videos.</p>
            </div>
            <Link href={`/projects/${id}`}>
              <Button>New Export</Button>
            </Link>
          </div>

          {isLoading ? (
            <div className="grid gap-4 md:grid-cols-2">
              {Array(4).fill(0).map((_, i) => (
                <Card key={i} className="overflow-hidden">
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      <Skeleton className="h-16 w-24 rounded-md" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-5 w-1/2" />
                        <Skeleton className="h-4 w-1/3" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : exports?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 border border-dashed rounded-lg bg-card/50">
              <Download className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium">No exports yet</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm text-center mb-6">
                You haven't exported any final videos from this project. Go to the workspace to render your edit.
              </p>
              <Link href={`/projects/${id}`}>
                <Button variant="outline">Go to Workspace</Button>
              </Link>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {exports?.map((exp) => (
                <Card key={exp.id} className="overflow-hidden group">
                  <CardContent className="p-0">
                    <div className="flex items-stretch">
                      {/* Thumbnail Placeholder based on format */}
                      <div className={`w-32 bg-muted flex items-center justify-center shrink-0 border-r border-border
                        ${exp.resolution.includes('vertical') ? 'aspect-[9/16]' : 'aspect-video w-40'}`}>
                        <FileVideo className="h-8 w-8 text-muted-foreground/30" />
                      </div>
                      
                      <div className="p-4 flex-1 flex flex-col justify-between">
                        <div>
                          <div className="flex justify-between items-start mb-1">
                            <h3 className="font-semibold text-sm truncate pr-2">
                              {project?.name}_{exp.resolution}.{exp.format}
                            </h3>
                            {getStatusBadge(exp.status)}
                          </div>
                          
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p>{getResolutionDisplay(exp.resolution)}</p>
                            <p>Started: {format(new Date(exp.createdAt), "MMM d, h:mm a")}</p>
                            {exp.fileSize && <p>Size: {(exp.fileSize / (1024 * 1024)).toFixed(2)} MB</p>}
                          </div>
                        </div>

                        <div className="mt-4">
                          {(exp.status === 'pending' || exp.status === 'rendering') ? (
                            <div className="space-y-1.5">
                              <div className="flex justify-between text-[10px] text-muted-foreground">
                                <span>Rendering...</span>
                                <span>{exp.progress}%</span>
                              </div>
                              <Progress value={exp.progress} className="h-1.5" />
                            </div>
                          ) : exp.status === 'completed' && exp.downloadUrl ? (
                            <Button size="sm" className="w-full gap-2" variant="secondary" asChild>
                              <a href={exp.downloadUrl} download>
                                <Download className="h-4 w-4" />
                                Download File
                              </a>
                            </Button>
                          ) : exp.status === 'failed' ? (
                            <div className="text-xs text-destructive bg-destructive/10 p-2 rounded flex items-start gap-1">
                              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                              <span className="line-clamp-2">{exp.errorMessage || "Rendering failed"}</span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
