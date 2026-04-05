import { useState, useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, Plus, Trash2, Edit3, Save, X, Palette, Zap, Music2, Target, FileCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const PACING_OPTIONS = ["slow", "medium", "fast", "frenetic"] as const;
const CUT_STYLE_OPTIONS = ["hard", "soft", "j-cut", "l-cut", "match-cut"] as const;
const TRANSITION_OPTIONS = ["cut", "dissolve", "fade", "wipe", "whip-pan"] as const;
const COLOR_GRADE_OPTIONS = ["none", "cinematic", "warm", "cool", "desaturated", "vibrant", "vintage"] as const;

type StyleProfile = {
  id: string;
  name: string;
  description: string | null;
  targetAudience: string | null;
  pacing: string;
  cutStyle: string;
  transitionStyle: string;
  colorGrade: string;
  musicMood: string | null;
  hookStrategy: string | null;
  formatPreferences: string | null;
  systemPromptOverride: string | null;
  createdAt: string;
};

const emptyDraft = (): Omit<StyleProfile, "id" | "createdAt"> => ({
  name: "",
  description: "",
  targetAudience: "",
  pacing: "medium",
  cutStyle: "hard",
  transitionStyle: "cut",
  colorGrade: "none",
  musicMood: "",
  hookStrategy: "",
  formatPreferences: "",
  systemPromptOverride: "",
});

export default function StyleProfilesPage() {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchProfiles = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/style-profiles`);
      const data = await res.json();
      setProfiles(data.profiles ?? []);
    } catch {
      toast({ title: "Failed to load style profiles", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProfiles(); }, []);

  const startCreate = () => {
    setDraft(emptyDraft());
    setCreating(true);
    setEditing(null);
    setShowAdvanced(false);
  };

  const startEdit = (profile: StyleProfile) => {
    setDraft({
      name: profile.name,
      description: profile.description ?? "",
      targetAudience: profile.targetAudience ?? "",
      pacing: profile.pacing,
      cutStyle: profile.cutStyle,
      transitionStyle: profile.transitionStyle,
      colorGrade: profile.colorGrade,
      musicMood: profile.musicMood ?? "",
      hookStrategy: profile.hookStrategy ?? "",
      formatPreferences: profile.formatPreferences ?? "",
      systemPromptOverride: profile.systemPromptOverride ?? "",
    });
    setEditing(profile.id);
    setCreating(false);
    setShowAdvanced(false);
  };

  const cancelEdit = () => {
    setCreating(false);
    setEditing(null);
    setDraft(emptyDraft());
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      toast({ title: "Profile name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...draft,
        description: draft.description || null,
        targetAudience: draft.targetAudience || null,
        musicMood: draft.musicMood || null,
        hookStrategy: draft.hookStrategy || null,
        formatPreferences: draft.formatPreferences || null,
        systemPromptOverride: draft.systemPromptOverride || null,
      };

      if (editing) {
        const res = await fetch(`${API_BASE}/api/style-profiles/${editing}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Failed to update");
        toast({ title: "Style profile updated" });
      } else {
        const res = await fetch(`${API_BASE}/api/style-profiles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Failed to create");
        toast({ title: "Style profile created" });
      }
      await fetchProfiles();
      cancelEdit();
    } catch (err: any) {
      toast({ title: err.message ?? "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete style profile "${name}"? This cannot be undone.`)) return;
    try {
      await fetch(`${API_BASE}/api/style-profiles/${id}`, { method: "DELETE" });
      setProfiles(prev => prev.filter(p => p.id !== id));
      toast({ title: `Deleted "${name}"` });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  const PillSelect = ({ label, value, options, onChange }: {
    label: string; value: string; options: readonly string[]; onChange: (v: string) => void;
  }) => (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => (
          <button key={opt} onClick={() => onChange(opt)} className={cn(
            "px-2.5 py-1 rounded-full text-xs font-medium border transition-all",
            value === opt
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
          )}>
            {opt}
          </button>
        ))}
      </div>
    </div>
  );

  const isFormOpen = creating || !!editing;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Palette className="h-5 w-5 text-primary" />
              Style Profiles
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Define reusable editorial styles — pacing, cut rhythm, color grade, hook strategy
            </p>
          </div>
          <Button onClick={startCreate} className="gap-2" disabled={isFormOpen}>
            <Plus className="h-4 w-4" />
            New Profile
          </Button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* Form panel */}
        {isFormOpen && (
          <div className="border border-primary/30 rounded-xl bg-card p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-base">{editing ? "Edit Style Profile" : "Create Style Profile"}</h2>
              <button onClick={cancelEdit} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Basic fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Profile Name *</label>
                <Input
                  placeholder="e.g. 'Punchy TikTok', 'Wedding Cinematic', 'B2B Ad'"
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <Input
                  placeholder="Brief description of this style"
                  value={draft.description ?? ""}
                  onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Target Audience</label>
                <Input
                  placeholder="e.g. Gen Z, B2B marketers, fitness enthusiasts"
                  value={draft.targetAudience ?? ""}
                  onChange={e => setDraft(d => ({ ...d, targetAudience: e.target.value }))}
                />
              </div>
            </div>

            {/* Pill selectors */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <PillSelect label="Pacing" value={draft.pacing} options={PACING_OPTIONS} onChange={v => setDraft(d => ({ ...d, pacing: v }))} />
              <PillSelect label="Cut Style" value={draft.cutStyle} options={CUT_STYLE_OPTIONS} onChange={v => setDraft(d => ({ ...d, cutStyle: v }))} />
              <PillSelect label="Transition Style" value={draft.transitionStyle} options={TRANSITION_OPTIONS} onChange={v => setDraft(d => ({ ...d, transitionStyle: v }))} />
              <PillSelect label="Color Grade" value={draft.colorGrade} options={COLOR_GRADE_OPTIONS} onChange={v => setDraft(d => ({ ...d, colorGrade: v }))} />
            </div>

            {/* Music + hook */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Music2 className="h-3.5 w-3.5" /> Music Mood
                </label>
                <Input
                  placeholder="e.g. upbeat hip-hop, cinematic orchestral"
                  value={draft.musicMood ?? ""}
                  onChange={e => setDraft(d => ({ ...d, musicMood: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5" /> Hook Strategy
                </label>
                <Input
                  placeholder="e.g. bold statement, question, action sequence"
                  value={draft.hookStrategy ?? ""}
                  onChange={e => setDraft(d => ({ ...d, hookStrategy: e.target.value }))}
                />
              </div>
            </div>

            {/* Advanced */}
            <div>
              <button
                onClick={() => setShowAdvanced(a => !a)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
              >
                <FileCode className="h-3.5 w-3.5" />
                {showAdvanced ? "Hide" : "Show"} advanced options
              </button>
              {showAdvanced && (
                <div className="mt-4 space-y-4 border-t border-border pt-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Target className="h-3.5 w-3.5" /> Format Preferences (JSON)
                    </label>
                    <Textarea
                      rows={3}
                      placeholder='{"ratio":"9:16","maxDuration":60,"captions":true}'
                      value={draft.formatPreferences ?? ""}
                      onChange={e => setDraft(d => ({ ...d, formatPreferences: e.target.value }))}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">System Prompt Override</label>
                    <Textarea
                      rows={4}
                      placeholder="Override the default Claude system prompt for generate_edit_plan when this profile is active..."
                      value={draft.systemPromptOverride ?? ""}
                      onChange={e => setDraft(d => ({ ...d, systemPromptOverride: e.target.value }))}
                      className="text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={cancelEdit} disabled={saving}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving ? "Saving…" : <><Save className="h-4 w-4" /> {editing ? "Save Changes" : "Create Profile"}</>}
              </Button>
            </div>
          </div>
        )}

        {/* Profile list */}
        {loading ? (
          <div className="text-center py-20 text-muted-foreground text-sm">Loading profiles…</div>
        ) : profiles.length === 0 ? (
          <div className="text-center py-20 border border-dashed border-border rounded-xl">
            <Palette className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">No style profiles yet</p>
            <p className="text-sm text-muted-foreground/60 mt-1">Create a profile to define reusable editorial styles for your projects</p>
            <Button className="mt-4 gap-2" onClick={startCreate}>
              <Plus className="h-4 w-4" /> Create First Profile
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {profiles.map(profile => (
              <div key={profile.id} className={cn(
                "border rounded-xl p-5 bg-card transition-all",
                editing === profile.id ? "border-primary/40 ring-1 ring-primary/20" : "border-border hover:border-border/80"
              )}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{profile.name}</h3>
                    {profile.description && (
                      <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">{profile.description}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(profile)}
                      className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(profile.id, profile.name)}
                      className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 mt-3">
                  <Badge variant="outline" className="text-xs font-normal capitalize">{profile.pacing}</Badge>
                  <Badge variant="outline" className="text-xs font-normal capitalize">{profile.cutStyle}</Badge>
                  <Badge variant="outline" className="text-xs font-normal capitalize">{profile.transitionStyle}</Badge>
                  {profile.colorGrade && profile.colorGrade !== "none" && (
                    <Badge variant="outline" className="text-xs font-normal capitalize">{profile.colorGrade}</Badge>
                  )}
                  {profile.musicMood && (
                    <Badge variant="outline" className="text-xs font-normal">
                      <Music2 className="h-2.5 w-2.5 mr-1" />{profile.musicMood}
                    </Badge>
                  )}
                  {profile.targetAudience && (
                    <Badge variant="secondary" className="text-xs font-normal">
                      <Target className="h-2.5 w-2.5 mr-1" />{profile.targetAudience}
                    </Badge>
                  )}
                </div>

                {profile.hookStrategy && (
                  <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
                    <Zap className="h-3 w-3 text-amber-400 shrink-0" />
                    Hook: {profile.hookStrategy}
                  </p>
                )}

                {profile.systemPromptOverride && (
                  <p className="text-xs text-muted-foreground/50 mt-2 flex items-center gap-1.5">
                    <FileCode className="h-3 w-3 shrink-0" />
                    Custom system prompt active
                  </p>
                )}

                <p className="text-xs text-muted-foreground/40 mt-3">
                  Created {new Date(profile.createdAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
