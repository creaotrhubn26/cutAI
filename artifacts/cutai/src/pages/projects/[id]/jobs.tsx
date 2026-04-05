import { useListProjectJobs, getListProjectJobsQueryKey, useGetProject, getGetProjectQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Clock, Activity, AlertCircle, FileText, AudioWaveform, FileVideo, Wand2, Scissors, CheckCircle2, Video as VideoIcon, Sparkles } from "lucide-react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectJobs() {
  const params = useParams();
  const id = params.id!;

  const { data: project } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  const { data: jobs, isLoading } = useListProjectJobs(id, {
    query: { 
      enabled: !!id, 
      queryKey: getListProjectJobsQueryKey(id),
      refetchInterval: (query) => {
        // Poll if any jobs are pending or running
        const hasActiveJobs = query.state.data?.some(job => job.status === 'pending' || job.status === 'running');
        return hasActiveJobs ? 2000 : false;
      }
    }
  });

  const getJobIcon = (type: string) => {
    switch (type) {
      case 'transcribe': return <FileText className="h-5 w-5 text-blue-500" />;
      case 'detect_beats': return <AudioWaveform className="h-5 w-5 text-purple-500" />;
      case 'analyze_scenes': return <FileVideo className="h-5 w-5 text-orange-500" />;
      case 'generate_edit_plan': return <Wand2 className="h-5 w-5 text-primary" />;
      case 'apply_edit': return <Scissors className="h-5 w-5 text-green-500" />;
      case 'render': return <VideoIcon className="h-5 w-5 text-rose-500" />;
      case 'analyze_manuscript': return <FileText className="h-5 w-5 text-amber-500" />;
      case 'semantic_tag': return <Sparkles className="h-5 w-5 text-sky-300" />;
      default: return <Activity className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending': return <Badge variant="outline" className="bg-muted text-muted-foreground">Pending</Badge>;
      case 'running': return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20"><Clock className="mr-1 h-3 w-3 animate-spin" /> Running</Badge>;
      case 'completed': return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20"><CheckCircle2 className="mr-1 h-3 w-3" /> Completed</Badge>;
      case 'failed': return <Badge variant="destructive">Failed</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
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
          <h1 className="font-semibold text-sm">Job History</h1>
          {project && <p className="text-xs text-muted-foreground">{project.name}</p>}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">AI Analysis Jobs</h2>
            <p className="text-muted-foreground">Monitor the background processes running for your project.</p>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            {isLoading ? (
              <div className="divide-y divide-border">
                {Array(5).fill(0).map((_, i) => (
                  <div key={i} className="p-4 flex items-center gap-4">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-1/4" />
                      <Skeleton className="h-2 w-full" />
                    </div>
                    <Skeleton className="h-6 w-20" />
                  </div>
                ))}
              </div>
            ) : jobs?.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Activity className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-medium">No jobs run yet</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Run AI tools from the workspace to see them here.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {jobs?.map((job) => (
                  <div key={job.id} className="p-4 hover:bg-accent/50 transition-colors flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary shrink-0">
                      {getJobIcon(job.type)}
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-medium text-sm capitalize">{job.type.replace(/_/g, ' ')}</h4>
                        {getStatusBadge(job.status)}
                      </div>
                      
                      <div className="flex items-center text-xs text-muted-foreground gap-3">
                        <span className="truncate">{job.videoId ? `Video ID: ${job.videoId.substring(0,8)}...` : 'Project level job'}</span>
                        <span>•</span>
                        <span>{format(new Date(job.createdAt), "MMM d, h:mm a")}</span>
                        {job.status === 'completed' && job.completedAt && (
                          <>
                            <span>•</span>
                            <span>Done in {Math.round((new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) / 1000)}s</span>
                          </>
                        )}
                      </div>
                      
                      {(job.status === 'running' || job.status === 'pending') && (
                        <div className="mt-2 flex items-center gap-3">
                          <Progress value={job.progress} className="h-1.5 flex-1" />
                          <span className="text-xs font-medium w-8 text-right">{job.progress}%</span>
                        </div>
                      )}
                      
                      {job.status === 'failed' && job.errorMessage && (
                        <div className="mt-2 text-xs text-destructive flex items-start gap-1 bg-destructive/10 p-2 rounded">
                          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>{job.errorMessage}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
