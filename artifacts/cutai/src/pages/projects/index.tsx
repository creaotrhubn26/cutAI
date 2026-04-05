import { useState } from "react";
import { useListProjects, getListProjectsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { Plus, Search, Folder, MoreVertical, Edit2, CheckCircle2, Clock, Zap, Brain, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

export default function Projects() {
  const { data: projects, isLoading } = useListProjects({
    query: { queryKey: getListProjectsQueryKey() }
  });
  const { toast } = useToast();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchAnalyzing, setBatchAnalyzing] = useState(false);
  const [batchDone, setBatchDone] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'draft': return 'bg-muted text-muted-foreground';
      case 'analyzing': return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
      case 'editing': return 'bg-purple-500/10 text-purple-500 border-purple-500/20';
      case 'review': return 'bg-orange-500/10 text-orange-500 border-orange-500/20';
      case 'exported': return 'bg-green-500/10 text-green-500 border-green-500/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const formatName = (format: string) => {
    return format.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const filtered = filteredProjects.map(p => p.id);
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered));
    }
  };

  const handleBatchAnalyze = async () => {
    if (selectedIds.size === 0) return;
    setBatchAnalyzing(true);
    setBatchDone(false);

    let queued = 0;
    for (const projectId of Array.from(selectedIds)) {
      try {
        await fetch(`${API_BASE}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "analyze_clips", projectId }),
        });
        queued++;
      } catch {}
    }

    setBatchAnalyzing(false);
    setBatchDone(true);
    setSelectedIds(new Set());
    toast({
      title: "Batch analysis queued",
      description: `Neural analysis queued for ${queued} project${queued !== 1 ? "s" : ""}. Jobs are running in the background.`,
    });
    setTimeout(() => setBatchDone(false), 3000);
  };

  const filteredProjects = (projects ?? []).filter(p =>
    !searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Projects</h2>
          <p className="text-muted-foreground">Manage your video editing projects.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/projects/batch">
            <Button variant="outline">
              <Zap className="mr-2 h-4 w-4 text-primary" />
              Batch Auto-Edit
            </Button>
          </Link>
          <Link href="/projects/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            className="pl-9"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedIds(new Set())}
              className="h-9 text-xs"
            >
              Clear
            </Button>
            <Button
              size="sm"
              onClick={handleBatchAnalyze}
              disabled={batchAnalyzing}
              className="h-9 text-xs bg-violet-600 hover:bg-violet-700 text-white"
            >
              {batchAnalyzing ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Queuing…</>
              ) : batchDone ? (
                <><Check className="h-3.5 w-3.5 mr-1.5 text-green-300" />Queued!</>
              ) : (
                <><Brain className="h-3.5 w-3.5 mr-1.5" />Batch Analyze ({selectedIds.size})</>
              )}
            </Button>
          </div>
        )}

        {!isLoading && filteredProjects.length > 0 && selectedIds.size === 0 && (
          <Button variant="ghost" size="sm" className="ml-auto h-9 text-xs text-muted-foreground" onClick={selectAll}>
            Select All for Batch Analysis
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array(8).fill(0).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <Skeleton className="h-32 w-full rounded-none" />
              <CardHeader className="space-y-2 p-4">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardFooter className="p-4 pt-0">
                <Skeleton className="h-8 w-full" />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="rounded-full bg-muted p-6 mb-4">
            <Folder className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-medium">No projects yet</h3>
          <p className="text-sm text-muted-foreground mt-2 mb-6 max-w-sm">
            Create your first project to start editing videos with AI.
          </p>
          <Link href="/projects/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Project
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredProjects.map((project) => {
            const isSelected = selectedIds.has(project.id);
            return (
              <Card key={project.id} className={`overflow-hidden flex flex-col group transition-all hover:border-primary/50 ${isSelected ? "border-violet-500/60 bg-violet-500/5" : ""}`}>
                <div className="aspect-video bg-muted relative">
                  {project.thumbnailUrl ? (
                    <img src={project.thumbnailUrl} alt={project.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                      <Folder className="h-12 w-12 opacity-20" />
                    </div>
                  )}
                  <div className="absolute top-2 right-2 flex gap-1.5 items-center">
                    <Badge variant="outline" className={`capitalize font-medium ${getStatusColor(project.status)}`}>
                      {project.status === 'analyzing' && <Clock className="mr-1 h-3 w-3 animate-spin" />}
                      {project.status === 'exported' && <CheckCircle2 className="mr-1 h-3 w-3" />}
                      {project.status}
                    </Badge>
                  </div>
                  <div className="absolute top-2 left-2">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(project.id)}
                      className="border-white/60 data-[state=checked]:bg-violet-600 data-[state=checked]:border-violet-600 bg-black/40"
                    />
                  </div>
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                    <Link href={`/projects/${project.id}`}>
                      <Button variant="secondary" size="sm" className="h-8">
                        <Edit2 className="h-4 w-4 mr-2" /> Open
                      </Button>
                    </Link>
                  </div>
                </div>
                <CardHeader className="p-4 flex-1">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <Link href={`/projects/${project.id}`} className="hover:underline">
                        <h3 className="font-semibold text-lg line-clamp-1">{project.name}</h3>
                      </Link>
                      <p className="text-sm text-muted-foreground line-clamp-1">{project.description || 'No description'}</p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2 -mt-2">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => toggleSelect(project.id)}>
                          {isSelected ? "Deselect" : "Select for batch"}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/projects/${project.id}`}>Open Editor</Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardHeader>
                <CardFooter className="p-4 pt-0 text-xs text-muted-foreground flex justify-between items-center border-t border-border mt-auto bg-muted/20">
                  <div className="flex gap-2">
                    <Badge variant="secondary" className="font-normal text-xs">{formatName(project.targetFormat)}</Badge>
                  </div>
                  <div>{formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}</div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
