import { 
  useGetProject, getGetProjectQueryKey, 
  useListProjectVideos, getListProjectVideosQueryKey, 
  useUploadVideo, 
  useListProjectSegments, getListProjectSegmentsQueryKey,
  useCreateJob,
  useUpdateSegment,
  useListProjectJobs, getListProjectJobsQueryKey,
  useGetProjectBeatMap, getGetProjectBeatMapQueryKey,
  useGetProjectMusicAnalysis, getGetProjectMusicAnalysisQueryKey,
  useGetProjectAudioEnhancement, getGetProjectAudioEnhancementQueryKey,
} from "@workspace/api-client-react";
import { useParams, Link, useLocation } from "wouter";
import { 
  FileVideo, Upload, Play, Wand2, AudioWaveform, FileText, 
  Loader2, ArrowLeft, Download, Video as VideoIcon, 
  AlertCircle, Clock, CheckCircle2, Eye, EyeOff,
  Activity, Music, BarChart3, BarChart2,
  Ear, Sparkles, Mic2, Wind, Radio, Music2,
  ListRestart, X, BookOpen, Zap, ChevronRight, Save,
  Shield, ShieldCheck, ShieldAlert, ShieldX, Gauge,
  GripVertical, Scissors, MessageSquare, Undo2, Redo2, Send, Keyboard,
  ScanEye, TrendingUpDown, BrainCircuit, Clapperboard, Users, Layers, Bot, ScrollText, Cpu, Star,
  MonitorPlay, Network, GitBranch, Type, Link2, Crop, Theater, Shuffle, Search,
  FastForward, SkipForward, Volume2,
  Palette, UserCheck, Film, Sun, Sliders, Copy, PanelLeft,
  MousePointer2, Move, Hand, Magnet, ZoomIn, ZoomOut, AlignCenter,
  SplitSquareHorizontal, ChevronDown, Settings2
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { useCallback, useState, useEffect, useRef, Fragment } from "react";
import { useDropzone } from "react-dropzone";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BeatTimeline } from "@/components/BeatTimeline";
import { TimelineEditor } from "@/components/TimelineEditor";
import { ClipPropertiesPanel } from "@/components/ClipPropertiesPanel";
import { StoryPrefsModal, type StoryPreferences } from "@/components/StoryPrefsModal";
import { StoryScriptPanel } from "@/components/StoryScriptPanel";
import { AudioMixPanel } from "@/components/AudioMixPanel";
import { PacingPanel } from "@/components/PacingPanel";
import { VideoPlayer } from "@/components/VideoPlayer";

export default function ProjectWorkspace() {
  const params = useParams();
  const id = params.id!;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState(() => {
    const hash = window.location.hash.replace("#", "");
    const valid = ["media","ai","clips","audio","script","styles","color","social"];
    return valid.includes(hash) ? hash : "media";
  });

  useEffect(() => {
    window.location.hash = activeTab;
  }, [activeTab]);

  // ── FCP edit tool selection ───────────────────────────────────────────────
  type EditTool = "select" | "trim" | "blade" | "position" | "hand";
  const [activeTool, setActiveTool] = useState<EditTool>("select");

  // ── iPad split-screen / narrow viewport adaptive layout ──────────────────
  const [isSplitMode, setIsSplitMode] = useState(() => window.innerWidth < 900);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const check = () => {
      const narrow = window.innerWidth < 900;
      setIsSplitMode(narrow);
      if (!narrow) setSidebarOpen(true);
    };
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [sequencePreview, setSequencePreview] = useState(false);
  const [seqIndex, setSeqIndex] = useState(0);
  const [seqBuffering, setSeqBuffering] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seqVideoRef = useRef<HTMLVideoElement>(null);
  // #23 Audio scrubbing preview
  const scrubAudioRef = useRef<HTMLAudioElement | null>(null);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrubTimeRef = useRef<number>(-1);
  const [manuscriptText, setManuscriptText] = useState("");
  const [manuscriptSaving, setManuscriptSaving] = useState(false);
  const [manuscriptSaved, setManuscriptSaved] = useState(false);
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(new Set());

  const toggleTranscript = (videoId: string) =>
    setExpandedTranscripts(prev => { const s = new Set(prev); s.has(videoId) ? s.delete(videoId) : s.add(videoId); return s; });

  // #2 Custom vocabulary
  const [vocabInput, setVocabInput]   = useState("");
  const [vocabSaving, setVocabSaving] = useState(false);

  // #4 Transcript diff toggle (per video id)
  const [showTxDiff, setShowTxDiff] = useState<Set<string>>(new Set());
  const toggleTxDiff = (vid: string) =>
    setShowTxDiff(prev => { const s = new Set(prev); s.has(vid) ? s.delete(vid) : s.add(vid); return s; });

  // #20 Transcript search (CMD+F)
  const [txSearchOpen,    setTxSearchOpen]    = useState(false);
  const [txSearchQuery,   setTxSearchQuery]   = useState("");
  const [txSearchMatchIdx, setTxSearchMatchIdx] = useState(0);
  const txSearchInputRef = useRef<HTMLInputElement>(null);

  // ── NLE features ──────────────────────────────────────────────────────────
  // #1/#5 Delete mode: ripple (extract) vs lift (leave gap)
  const [deleteMode, setDeleteMode] = useState<"ripple" | "lift">("ripple");
  // #8 Magnetic snapping
  const [snapEnabled, setSnapEnabled] = useState(true);
  // #9 Nested sequences — multi-select
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(new Set());
  const [showNestInput, setShowNestInput] = useState(false);
  const [nestName, setNestName] = useState("Compound Clip");
  // #4 Three-point editing
  const [threePointIn, setThreePointIn]   = useState<number | null>(null);
  const [threePointOut, setThreePointOut] = useState<number | null>(null);
  // #10 Markers
  type Marker = { id: string; timestamp: number; label: string; color: string; notes?: string | null };
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [showMarkers, setShowMarkers] = useState(true);
  const [markerDraft, setMarkerDraft] = useState<{ label: string; color: "red" | "yellow" | "green" | "blue" | "orange" } | null>(null);
  // #6/#7 Multi-track audio
  type AudioKeyframe = { id: string; timestamp: number; volume: number };
  type AudioTrack    = { id: string; name: string; trackType: string; volume: number; pan: number; mute: boolean; solo: boolean; color: string; orderIndex: number; keyframes: AudioKeyframe[] };
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [showAudioMixer, setShowAudioMixer] = useState(false);
  const [addTrackDraft, setAddTrackDraft] = useState<{ name: string; type: string } | null>(null);
  // #2 Slip edit popover
  const [slipTarget, setSlipTarget] = useState<string | null>(null);
  const [slipDelta, setSlipDelta] = useState("");

  // ── New NLE state (#11–#20) ────────────────────────────────────────────────
  // #11 Range selection
  const [rangeStart, setRangeStart]  = useState<number | null>(null);
  const [rangeEnd, setRangeEnd]      = useState<number | null>(null);
  const [rangeOp, setRangeOp]        = useState<"delete" | "speed" | "color">("delete");
  const [rangeSpeed, setRangeSpeed]  = useState(2.0);
  const [rangeColor, setRangeColor]  = useState("warm");
  const [showRangeTool, setShowRangeTool] = useState(false);

  // #41 Safe area guides / #42 Grid overlay
  const [showSafeAreas, setShowSafeAreas] = useState(false);
  const [showGrid, setShowGrid] = useState(false);

  // #43 Clip inspector — id of segment being hovered for inspector tooltip
  const [inspectorHoverId, setInspectorHoverId] = useState<string | null>(null);

  // #44 Batch trim silence dialog
  const [showBatchTrimDialog, setShowBatchTrimDialog] = useState(false);
  const [batchTrimBody, setBatchTrimBody] = useState({ silenceDuration: 0.4, headroom: 0.25, tailroom: 0.15, minDuration: 1.0 });
  const [batchTrimResult, setBatchTrimResult] = useState<null | { trimmedCount: number; totalTimeSavedSeconds: number; totalSegments: number; results: Array<{ segmentId: string; label: string | null; trimmedHead: number; trimmedTail: number; source: string }> }>(null);
  const [batchTrimLoading, setBatchTrimLoading] = useState(false);

  // #45 Smart insert B-roll — loading state per segment id
  const [brollLoading, setBrollLoading] = useState<Record<string, boolean>>({});

  // ── #46–#55 AI Intelligence ──────────────────────────────────────────────
  const [showIntelligence, setShowIntelligence] = useState(false);
  const [selectedGenre, setSelectedGenre] = useState<string>("");
  const [genreApplying, setGenreApplying] = useState(false);
  const [genreResult, setGenreResult] = useState<{ segmentsAdjusted: number } | null>(null);
  const [arcAssigning, setArcAssigning] = useState(false);
  const [arcResult, setArcResult] = useState<{ assigned: number; total: number } | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackResult, setFeedbackResult] = useState<{ adjustmentsApplied: number } | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string>("");
  const [platformPaceLoading, setPlatformPaceLoading] = useState(false);
  const [platformPaceResult, setPlatformPaceResult] = useState<{ modifiedCount: number; newAvgClipSec: number } | null>(null);
  const [dialogueBrollLoading, setDialogueBrollLoading] = useState(false);
  const [dialogueBrollResult, setDialogueBrollResult] = useState<{ matchesFound: number; insertedCount?: number } | null>(null);
  const [diversityReport, setDiversityReport] = useState<{ violationCount: number; isHealthy: boolean; summary: string } | null>(null);
  const [confidenceReport, setConfidenceReport] = useState<{ avgConfidence: number; distribution: { high: number; medium: number; low: number }; recommendation: string } | null>(null);
  const [editDiversityGuard, setEditDiversityGuard] = useState<boolean>(true);
  const [diversityGuardLoading, setDiversityGuardLoading] = useState(false);

  // ── Audio Tools Suite (#12–#20) ─────────────────────────────────────────
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftResult, setDriftResult] = useState<{ driftItems: { segmentId: string; label: string; driftMs: number; severity: string }[]; driftFound: number; corrected: number; message: string } | null>(null);
  const [deesserStrength, setDeesserStrength] = useState<"off"|"light"|"medium"|"heavy">("off");
  const [deesserSaving, setDeesserSaving] = useState(false);
  const [deesserSaved, setDeesserSaved] = useState(false);
  const [windLoading, setWindLoading] = useState(false);
  const [windResult, setWindResult] = useState<{ flaggedCount: number; flaggedClips: { label: string; reason: string }[]; applied: boolean; message: string } | null>(null);
  const [duckingEnabled, setDuckingEnabled] = useState(false);
  const [duckingLevel, setDuckingLevel] = useState(0.2);
  const [duckingLoading, setDuckingLoading] = useState(false);
  const [duckingResult, setDuckingResult] = useState<{ segmentsUpdated: number; message: string } | null>(null);
  const [voiceIsoStrength, setVoiceIsoStrength] = useState<"off"|"gentle"|"strong"|"max">("off");
  const [voiceIsoSaving, setVoiceIsoSaving] = useState(false);
  const [voiceIsoSaved, setVoiceIsoSaved] = useState(false);
  const [musicMoodLoading, setMusicMoodLoading] = useState(false);
  const [musicMoodResult, setMusicMoodResult] = useState<{ mood: string; energy: string; tracks: { id: string; name: string; artist: string; duration: number; audioUrl: string; shareUrl: string; imageUrl: string }[]; message: string } | null>(null);
  const [musicKeyLoading, setMusicKeyLoading] = useState(false);
  const [musicKeyResult, setMusicKeyResult] = useState<{ detectedKey: string; compatibleKeys: string[]; clashWarning: string; transitionTip: string } | null>(null);
  const [beatGridConfig, setBeatGridConfig] = useState<{ bpm: number; beats: number[]; downbeats: number[]; beatInterval: number; note: string; source: string } | null>(null);
  const [beatGridLoading, setBeatGridLoading] = useState(false);
  const [showBeatGridViz, setShowBeatGridViz] = useState(false);
  const [sfxMarkers, setSfxMarkers] = useState<{ ts: number; type: string; label: string; segmentId: string | null; volume: number }[]>([]);
  const [sfxLibrary, setSfxLibrary] = useState<{ id: string; label: string; description: string; icon: string; defaultVolume: number }[]>([]);
  const [sfxMarkersLoaded, setSfxMarkersLoaded] = useState(false);
  const [sfxPlacing, setSfxPlacing] = useState(false);
  const [sfxSelectedType, setSfxSelectedType] = useState("whoosh");

  // #22 Stem export
  const [stemExporting, setStemExporting] = useState(false);
  const [stemFiles, setStemFiles] = useState<Record<string, { status: string; downloadUrl?: string; filter: string }> | null>(null);
  // #24 Stem detection
  const [stemDetecting, setStemDetecting] = useState(false);
  const [stemCounts, setStemCounts] = useState<Record<string, number> | null>(null);

  // ── Color Pipeline ────────────────────────────────────────────────────────
  const [lutLibrary, setLutLibrary] = useState<{ id: string; name: string; sizeBytes: number; uploadedAt: string }[]>([]);
  const [lutLibraryLoaded, setLutLibraryLoaded] = useState(false);
  const [lutUploading, setLutUploading] = useState(false);
  const [lutApplying, setLutApplying] = useState(false);
  const [selectedLutId, setSelectedLutId] = useState<string>("__none__");
  const [autoWbLoading, setAutoWbLoading] = useState(false);
  const [autoWbResult, setAutoWbResult] = useState<{ message: string; results: { id: string; status: string }[] } | null>(null);
  const [expNormLoading, setExpNormLoading] = useState(false);
  const [expNormResult, setExpNormResult] = useState<{ message: string } | null>(null);
  const [skinProtectLoading, setSkinProtectLoading] = useState(false);
  const [shotMatchLoading, setShotMatchLoading] = useState(false);
  const [horizonLoading, setHorizonLoading] = useState(false);
  const [horizonResult, setHorizonResult] = useState<{ angle: number; message: string } | null>(null);
  const [frameInterpLoading, setFrameInterpLoading] = useState(false);
  const [frameInterpResult, setFrameInterpResult] = useState<{ message: string; ffmpegFilter: string } | null>(null);
  const [frameInterpFps, setFrameInterpFps] = useState(60);

  // ── Social Intelligence ───────────────────────────────────────────────────
  const [hookLoading, setHookLoading] = useState(false);
  const [hookResult, setHookResult] = useState<{ overallScore: number; grade: string; retentionPrediction: string; strengths: string[]; improvements: string[]; rewrittenHook: string } | null>(null);
  const [lengthLoading, setLengthLoading] = useState(false);
  const [lengthResult, setLengthResult] = useState<{ currentDuration: number; optimalDuration: number; assessment: string; deltaSeconds: number; recommendation: string } | null>(null);
  const [captionLoading, setCaptionLoading] = useState(false);
  const [captionResult, setCaptionResult] = useState<{ hooks: { id: number; strategy: string; english: string; norwegian: string; emojiSuggestion: string }[]; recommendedIndex: number } | null>(null);
  const [captionPlatform, setCaptionPlatform] = useState("instagram");
  const [postTimingResult, setPostTimingResult] = useState<{ platform: string; schedule: { best: string[]; good: string[] }; nextBestSlot: string; allPlatforms: { platform: string; bestSlots: string[] }[] } | null>(null);
  const [ytMetaLoading, setYtMetaLoading] = useState(false);
  const [ytMeta, setYtMeta] = useState<{ title: string; description: string; tags: string[] } | null>(null);
  const [batchExporting, setBatchExporting] = useState(false);
  const [tikTokUploading, setTikTokUploading] = useState(false);
  const [tikTokResult, setTikTokResult] = useState<{ publishId?: string; shareUrl?: string; error?: string } | null>(null);
  const [igUploading, setIgUploading] = useState(false);
  const [igResult, setIgResult] = useState<{ permalink?: string; mediaId?: string; error?: string } | null>(null);
  const [liUploading, setLiUploading] = useState(false);
  const [liResult, setLiResult] = useState<{ postUrl?: string; error?: string } | null>(null);
  const [batchResult, setBatchResult] = useState<{ outputs: { aspectRatio: string; label: string; status: string; downloadUrl?: string; sizeBytes?: number }[] } | null>(null);
  const [mezzExporting, setMezzExporting] = useState(false);
  const [mezzResult, setMezzResult] = useState<{ status: string; sizeMB: string; downloadUrl?: string; profile: string } | null>(null);

  // ── Intro / Outro Trimmer ────────────────────────────────────────────────
  const [introDetectLoading, setIntroDetectLoading] = useState(false);
  const [introDetectResult, setIntroDetectResult] = useState<{
    found: boolean; phrase?: string; introEndSec?: number;
    snippet?: string; segmentIds?: string[]; segmentCount?: number; message: string;
  } | null>(null);
  const [outroDetectLoading, setOutroDetectLoading] = useState(false);
  const [outroDetectResult, setOutroDetectResult] = useState<{
    found: boolean; phrase?: string; outroStartSec?: number;
    snippet?: string; segmentIds?: string[]; segmentCount?: number; message: string;
  } | null>(null);

  // #12 Paste attributes
  const [copiedGrade, setCopiedGrade] = useState<{ segId: string; grade: string } | null>(null);
  // #13 Speed ramp curve
  const [speedRampTarget, setSpeedRampTarget] = useState<string | null>(null);
  const [speedCurvePts, setSpeedCurvePts] = useState<{ t: number; v: number }[]>([{ t: 0, v: 1 }, { t: 0.5, v: 0.25 }, { t: 1, v: 1 }]);
  // #17 Multicam view
  const [multicamMode, setMulticamMode] = useState(false);
  // #18 JKL — track J hold for backward shuttle
  const jShuttleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // #20 Waveform zoom
  const [waveformZoom, setWaveformZoom] = useState(1);

  // ── New NLE state (#21–#30) ────────────────────────────────────────────────
  // #22 Clip stack view
  const [clipStackView, setClipStackView] = useState(false);
  // #31 Timeline lanes + zoom-to-selection
  const [showTimelineLanes, setShowTimelineLanes] = useState(false);
  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0);
  // #23 Lasso selection
  const [lassoActive, setLassoActive] = useState(false);
  const [lassoRect, setLassoRect] = useState<{ startY: number; endY: number } | null>(null);
  const clipsContainerRef = useRef<HTMLDivElement>(null);
  // #26 Edit decision log
  const [showEDL, setShowEDL] = useState(false);
  type EDLEntry = { id: string; segmentId: string; editType: string; field: string | null; aiValue: string | null; humanValue: string | null; editedAt: string; deltaStartSeconds?: number | null; deltaEndSeconds?: number | null };
  const [edlEntries, setEdlEntries] = useState<EDLEntry[]>([]);
  const fetchEDL = useCallback(async () => {
    const res = await fetch(`${API_BASE}/projects/${id}/edit-decision-log?limit=100`);
    if (res.ok) setEdlEntries(await res.json());
  }, [id]);
  // #27 Collaboration cursors
  type CollabCursor = { id: string; sessionId: string; displayName: string; color: string; playhead: number; activeSegmentId?: string | null; updatedAt: string };
  const [collabCursors, setCollabCursors] = useState<CollabCursor[]>([]);
  const mySessionId = useRef(`sess-${Math.random().toString(36).slice(2)}`);
  const myDisplayName = useRef("Me");
  // #28 Timeline comments
  type TimelineComment = { id: string; timecode: number; text: string; authorName: string; parentId: string | null; resolved: string; segmentId: string | null; createdAt: string };
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<TimelineComment[]>([]);
  const [commentDraft, setCommentDraft] = useState<{ timecode: number; text: string; parentId?: string } | null>(null);
  const fetchComments = useCallback(async () => {
    const res = await fetch(`${API_BASE}/projects/${id}/comments`);
    if (res.ok) setComments(await res.json());
  }, [id]);
  // #29 Clip version history
  const [versionHistoryTarget, setVersionHistoryTarget] = useState<string | null>(null);
  type VersionEntry = { id: string; editType: string; field: string | null; aiValue: string | null; humanValue: string | null; editedAt: string };
  const [versionHistory, setVersionHistory] = useState<VersionEntry[]>([]);
  // #30 Named checkpoints
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  // Export media root — the folder on the editor's workstation where original files live
  const [mediaRoot, setMediaRoot] = useState("");
  type Checkpoint = { id: string; name: string; description: string | null; createdAt: string; projectId: string };
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointNameInput, setCheckpointNameInput] = useState("");
  const [checkpointSaving, setCheckpointSaving] = useState(false);
  const fetchCheckpoints = useCallback(async () => {
    const res = await fetch(`${API_BASE}/projects/${id}/checkpoints`);
    if (res.ok) setCheckpoints(await res.json());
  }, [id]);

  const fmtTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Quality check state
  const [qcResult, setQcResult] = useState<{
    score: number; grade: string; passCount: number; totalChecks: number;
    sizeMB: number; duration: number; resolution: string; fps: number;
    videoCodec: string; audioCodec: string; bitrateMbps: number; lufs: number | null;
    checks: { id: string; label: string; pass: boolean; detail: string; severity: string }[];
    freezeEvents: { start: number; end: number; duration: number }[];
    blackEvents: { start: number; end: number; duration: number }[];
    silenceEvents: { start: number; end: number; duration: number }[];
  } | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<"music" | "qc" | "story" | "logs" | "pacing">("music");
  const [playerActiveSegId, setPlayerActiveSegId] = useState<string | null>(null);
  const [playerSegIndex, setPlayerSegIndex] = useState(0);
  const [playerSegProgress, setPlayerSegProgress] = useState(0);
  const [qualityRating, setQualityRating] = useState<number | null>(null);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);

  // Styles library state
  const [expandedNeuralVideoId, setExpandedNeuralVideoId] = useState<string | null>(null);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  // ── Media browser filter / sort / group ──────────────────────────────────
  const [mediaSearch, setMediaSearch]       = useState("");
  const [mediaSortBy, setMediaSortBy]       = useState<"score" | "duration" | "name" | "type">("score");
  const [mediaFilterType, setMediaFilterType] = useState<"all" | "talking_head" | "b_roll" | "mixed">("all");
  const [mediaGrouped, setMediaGrouped]     = useState(true);
  const [selectedStyleName, setSelectedStyleName] = useState<string | null>(null);
  const [styles, setStyles] = useState<any[]>([]);
  const [stylesCategory, setStylesCategory] = useState<string>("all");
  const [stylesSearch, setStylesSearch] = useState<string>("");
  const [stylesLoading, setStylesLoading] = useState(false);

  const { data: project, isLoading: projectLoading } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  const { data: videos, isLoading: videosLoading, refetch: refetchVideos } = useListProjectVideos(id, {
    query: {
      enabled: !!id,
      queryKey: getListProjectVideosQueryKey(id),
      refetchInterval: (query) => {
        const data = query.state.data as any[] | undefined;
        return data?.some((v: any) => v.status === "transcoding") ? 3000 : false;
      },
    }
  });

  const { data: jobs } = useListProjectJobs(id, {
    query: { 
      enabled: !!id, 
      queryKey: getListProjectJobsQueryKey(id),
      refetchInterval: 1500
    }
  });

  const hasRunningJob = (jobList: any[] | undefined) =>
    (jobList ?? []).some((j: any) => j.status === "running" || j.status === "pending");

  const { data: segments, isLoading: segmentsLoading, refetch: refetchSegments } = useListProjectSegments(id, {
    query: {
      enabled: !!id,
      queryKey: getListProjectSegmentsQueryKey(id),
      refetchInterval: hasRunningJob(jobs) ? 800 : false,
    }
  });

  // #24 Zoom-to-fit — must be declared AFTER `segments` to avoid TDZ
  const handleZoomToFit = useCallback(() => {
    const total = (segments ?? []).reduce((s, g) => Math.max(s, g.endTime), 0);
    if (total > 0) setWaveformZoom(Math.max(1, Math.min(8, Math.round(120 / total))));
    toast({ title: "Zoom to fit", description: `${total.toFixed(1)}s total`, duration: 1200 });
  }, [segments]);

  const { data: beatMap } = useGetProjectBeatMap(id, {
    query: { enabled: !!id, queryKey: getGetProjectBeatMapQueryKey(id) }
  });

  const { data: musicAnalysis } = useGetProjectMusicAnalysis(id, {
    query: { enabled: !!id, queryKey: getGetProjectMusicAnalysisQueryKey(id) }
  });

  const { data: audioEnhancementPlan, refetch: refetchAudioPlan } = useGetProjectAudioEnhancement(id, {
    query: { enabled: !!id, queryKey: getGetProjectAudioEnhancementQueryKey(id) }
  });

  const uploadVideo = useUploadVideo();
  const createJob = useCreateJob();
  const updateSegment = useUpdateSegment();

  const [learnedRulesEarly, setLearnedRulesEarly] = useState<Array<{ label: string; selectionRate: number; direction: "prefer" | "avoid" | "neutral"; delta: number }>>([]);
  const [topPreferencesEarly, setTopPreferencesEarly] = useState<Array<{ label: string; selectionRate: number; direction: string; usageCount: number }>>([]);
  const [lastAutoLearnAtEarly, setLastAutoLearnAtEarly] = useState<number>(0);

  const refetchTrainSignals = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects/${id}/training-signals`);
      if (res.ok) setTrainSignals(await res.json());
    } catch {}
  }, [id]);

  const runAutoLearn = useCallback(async (currentEdits: number) => {
    const thresholds = [3, 10, 25, 50, 100];
    const nextThreshold = thresholds.find(t => t > lastAutoLearnAtEarly && currentEdits >= t);
    if (!nextThreshold) return;
    try {
      const res = await fetch(`${API_BASE}/projects/${id}/auto-learn`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.changedRules?.length) setLearnedRulesEarly(data.changedRules);
        if (data.topPreferences?.length) setTopPreferencesEarly(data.topPreferences);
        setLastAutoLearnAtEarly(nextThreshold);
      }
    } catch {}
  }, [id, lastAutoLearnAtEarly]);

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string>("");
  const [uploadStats, setUploadStats] = useState<{ loadedMB: number; totalMB: number; speedMBs: number; etaSec: number } | null>(null);

  const [modelIntelligence, setModelIntelligence] = useState<any>(null);
  useEffect(() => {
    const format = (project as any)?.format ?? "instagram_reel";
    fetch(`/api/model-intelligence?format=${encodeURIComponent(format)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setModelIntelligence(d); })
      .catch(() => {});
  }, [project, jobs]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [jobs]);

  const prevSegCountRef = useRef(0);
  const [liveBuilding, setLiveBuilding] = useState(false);

  useEffect(() => {
    const sortedSegs = (segments ?? [])
      .filter((s: any) => s.videoId)
      .sort((a: any, b: any) => a.orderIndex - b.orderIndex);
    const count = sortedSegs.length;
    const isBuilding = hasRunningJob(jobs);

    if (isBuilding) {
      setLiveBuilding(true);
      if (count > prevSegCountRef.current && count > 0) {
        const newest = sortedSegs[count - 1];
        if (newest) setPlayerActiveSegId(newest.id);
      }
    } else {
      if (liveBuilding) setLiveBuilding(false);
    }
    prevSegCountRef.current = count;
  }, [segments, jobs]);

  const CHUNK_SIZE = 5 * 1024 * 1024;

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    const file = acceptedFiles[0];
    setUploadFileName(file.name);
    setUploadProgress(0);
    setUploadStats(null);

    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const totalMB = file.size / 1048576;
    const startTime = Date.now();
    let uploadedBytes = 0;

    const sendChunk = (chunkIndex: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        const form = new FormData();
        form.append("chunk", chunk, file.name);
        form.append("uploadId", uploadId);
        form.append("chunkIndex", String(chunkIndex));
        form.append("totalChunks", String(totalChunks));
        form.append("projectId", id);
        form.append("filename", file.name);
        form.append("mimeType", file.type || "video/mp4");
        form.append("fileSize", String(file.size));

        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/videos/chunk`);

        xhr.upload.onprogress = (e) => {
          const chunkSent = e.loaded;
          const totalSent = uploadedBytes + chunkSent;
          const pct = Math.round((totalSent / file.size) * 100);
          const dtSec = (Date.now() - startTime) / 1000;
          const speedMBs = dtSec > 0 ? (totalSent / 1048576) / dtSec : 0;
          const etaSec = speedMBs > 0 ? Math.round((file.size - totalSent) / 1048576 / speedMBs) : 0;
          setUploadProgress(pct);
          setUploadStats({ loadedMB: totalSent / 1048576, totalMB, speedMBs, etaSec });
        };

        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 201) resolve();
          else reject(new Error(`Chunk ${chunkIndex} failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("Network error on chunk " + chunkIndex));
        xhr.send(form);
      });

    try {
      for (let i = 0; i < totalChunks; i++) {
        await sendChunk(i);
        uploadedBytes = (i + 1) * CHUNK_SIZE;
      }
      setUploadProgress(100);
      setTimeout(() => {
        setUploadProgress(null);
        setUploadFileName("");
        setUploadStats(null);
        refetchVideos();
        toast({ title: "Video uploaded", description: `${file.name} is ready for processing.` });
      }, 800);
    } catch (err: any) {
      setUploadProgress(null);
      setUploadFileName("");
      setUploadStats(null);
      toast({ title: "Upload failed", description: err?.message ?? "Upload interrupted.", variant: "destructive" });
    }
  }, [id, refetchVideos, toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: { 'video/*': ['.mp4', '.mov', '.webm'] },
    maxFiles: 1
  });

  // Sync manuscript text from loaded project
  useEffect(() => {
    if (project?.manuscript && !manuscriptText) {
      setManuscriptText(project.manuscript);
    }
  }, [project?.manuscript]);

  // Sync quality rating from project
  useEffect(() => {
    if (project?.qualityRating != null && qualityRating === null) {
      setQualityRating(project.qualityRating);
    }
  }, [project?.qualityRating]);

  // #2 Sync custom vocabulary from project
  useEffect(() => {
    if (project && (project as any).customVocabulary != null) {
      setVocabInput((project as any).customVocabulary);
    }
  }, [(project as any)?.customVocabulary]);

  // Load markers, audio tracks, comments, checkpoints when project opens
  useEffect(() => {
    if (!id) return;
    fetchMarkers();
    fetchAudioTracks();
    fetchComments();
    fetchCheckpoints();
  }, [id]);

  // #27 Collaboration cursor — poll cursors every 3s, push my position every 5s
  useEffect(() => {
    if (!id) return;
    const pollCursors = async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/${id}/collaboration/cursors`);
        if (res.ok) {
          const all = (await res.json()) as CollabCursor[];
          setCollabCursors(all.filter(c => c.sessionId !== mySessionId.current));
        }
      } catch {}
    };
    const pushCursor = async () => {
      try {
        await fetch(`${API_BASE}/projects/${id}/collaboration/cursor`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: mySessionId.current, displayName: myDisplayName.current, playhead: currentTime }),
        });
      } catch {}
    };
    pollCursors();
    const pollTimer = setInterval(pollCursors, 3000);
    const pushTimer = setInterval(pushCursor, 5000);
    return () => { clearInterval(pollTimer); clearInterval(pushTimer); };
  }, [id, currentTime]);

  // #26 Load EDL when panel opens
  useEffect(() => { if (showEDL) fetchEDL(); }, [showEDL]);

  // #29 Load version history when target changes
  useEffect(() => {
    if (!versionHistoryTarget) { setVersionHistory([]); return; }
    (async () => {
      const res = await fetch(`${API_BASE}/segments/${versionHistoryTarget}/version-history`);
      if (res.ok) setVersionHistory(await res.json());
    })();
  }, [versionHistoryTarget]);

  // #5/#18 J/K/L transport + X/E delete keyboard shortcuts (clips tab active)
  // #18: J=backward shuttle (seek -0.1s per tick while held), K=pause, L=play forward
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeTab !== "clips") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        // DaVinci Resolve convention: J shuttles backward. HTML5 video doesn't support
        // negative playback rates, so we pause and seek backward on a hold interval.
        if (seqVideoRef.current) {
          seqVideoRef.current.pause();
          if (!jShuttleRef.current) {
            jShuttleRef.current = setInterval(() => {
              if (seqVideoRef.current) {
                seqVideoRef.current.currentTime = Math.max(0, seqVideoRef.current.currentTime - 0.1);
              }
            }, 80);
          }
        }
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        if (jShuttleRef.current) { clearInterval(jShuttleRef.current); jShuttleRef.current = null; }
        seqVideoRef.current?.pause();
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        if (jShuttleRef.current) { clearInterval(jShuttleRef.current); jShuttleRef.current = null; }
        if (seqVideoRef.current) { seqVideoRef.current.playbackRate = 1; seqVideoRef.current.play().catch(() => {}); }
      } else if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        if (selectedSegment) handleRippleDelete(selectedSegment);
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        if (selectedSegment) handleLiftDelete(selectedSegment);
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        setThreePointIn(parseFloat(currentTime.toFixed(3)));
        toast({ title: "Mark In", description: `${currentTime.toFixed(2)}s`, duration: 1500 });
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        setThreePointOut(parseFloat(currentTime.toFixed(3)));
        toast({ title: "Mark Out", description: `${currentTime.toFixed(2)}s`, duration: 1500 });
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setMarkerDraft({ label: "", color: "yellow" });
      } else if (e.key === "a" || e.key === "A") {
        // #11 A = mark range start
        e.preventDefault();
        setRangeStart(parseFloat(currentTime.toFixed(3)));
        setShowRangeTool(true);
        toast({ title: "Range start", description: `${currentTime.toFixed(2)}s`, duration: 1200 });
      } else if (e.key === "s" || e.key === "S") {
        // #11 S = mark range end
        e.preventDefault();
        setRangeEnd(parseFloat(currentTime.toFixed(3)));
        setShowRangeTool(true);
        toast({ title: "Range end", description: `${currentTime.toFixed(2)}s`, duration: 1200 });
      } else if (e.key === "z" || e.key === "Z") {
        // #24 Z = zoom to fit
        e.preventDefault();
        handleZoomToFit();
      } else if (e.key === "=" && (e.metaKey || e.ctrlKey)) {
        // #31 CMD+= zoom to selection
        e.preventDefault();
        if (selectedSegment) setZoomToFitTrigger(t => t + 1);
        else toast({ title: "Zoom to selection", description: "Select a clip first", duration: 1500 });
      } else if (e.key === "c" || e.key === "C") {
        // #28 C = add comment at current time (only when no grade copied)
        if (!copiedGrade) {
          e.preventDefault();
          setCommentDraft({ timecode: parseFloat(currentTime.toFixed(3)), text: "" });
          setShowComments(true);
        }
      }
    };
    const upHandler = (e: KeyboardEvent) => {
      // Stop J backward shuttle when J key released (#18)
      if ((e.key === "j" || e.key === "J") && jShuttleRef.current) {
        clearInterval(jShuttleRef.current);
        jShuttleRef.current = null;
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", upHandler);
    return () => { window.removeEventListener("keydown", handler); window.removeEventListener("keyup", upHandler); };
  }, [activeTab, selectedSegment, currentTime]);

  // #20 CMD+F opens transcript search when script/transcript tab is active
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeTab !== "script") return;
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setTxSearchOpen(true);
        setTimeout(() => txSearchInputRef.current?.focus(), 50);
      }
      if (e.key === "Escape" && txSearchOpen) setTxSearchOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, txSearchOpen]);

  // #23 Audio scrubbing preview — pitch-corrected audio on every playhead jump (while paused)
  useEffect(() => {
    if (!segments) return;
    const isPaused = !seqVideoRef.current || seqVideoRef.current.paused;
    if (!isPaused) return; // don't interrupt live playback

    const sorted = segments.filter(s => s.included).sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
    let elapsed = 0;
    let targetVideoId: string | null = null;
    let fileTime = 0;

    for (const seg of sorted) {
      const dur = (seg.outPoint ?? seg.endTime ?? 0) - (seg.inPoint ?? seg.startTime ?? 0);
      if (currentTime >= elapsed && currentTime < elapsed + Math.max(dur, 0.01)) {
        targetVideoId = (seg as { videoId?: string | null }).videoId ?? null;
        fileTime = (seg.inPoint ?? seg.startTime ?? 0) + (currentTime - elapsed);
        break;
      }
      elapsed += dur;
    }

    if (!targetVideoId) return;
    if (Math.abs(fileTime - lastScrubTimeRef.current) < 0.04) return;
    lastScrubTimeRef.current = fileTime;

    if (!scrubAudioRef.current) {
      scrubAudioRef.current = new Audio();
      scrubAudioRef.current.volume = 0.55;
      scrubAudioRef.current.preload = "auto";
    }
    const audio = scrubAudioRef.current;
    const wantSrc = `${API_BASE}/videos/${targetVideoId}/stream`;
    if (!audio.src.endsWith(`/videos/${targetVideoId}/stream`)) audio.src = wantSrc;

    if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
    audio.currentTime = fileTime;
    audio.playbackRate = 1.0;
    audio.play().catch(() => {});
    scrubTimerRef.current = setTimeout(() => audio.pause(), 130);

    return () => { if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current); };
  }, [currentTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveVocabulary = async () => {
    setVocabSaving(true);
    try {
      await fetch(`${API_BASE}/projects/${id}/vocabulary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customVocabulary: vocabInput }),
      });
      toast({ title: "Vocabulary saved", description: "Terms will be used on next transcription.", duration: 3000 });
    } catch {
      toast({ title: "Failed to save vocabulary", variant: "destructive" });
    } finally {
      setVocabSaving(false);
    }
  };

  // ── NLE API helpers ────────────────────────────────────────────────────────
  const fetchMarkers = useCallback(async () => {
    const res = await fetch(`${API_BASE}/projects/${id}/markers`);
    if (res.ok) setMarkers(await res.json());
  }, [id]);

  const addMarker = async (timestamp: number, label: string, color: string) => {
    await fetch(`${API_BASE}/projects/${id}/markers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp, label, color }),
    });
    fetchMarkers();
  };

  const patchMarker = async (markerId: string, patch: Record<string, unknown>) => {
    await fetch(`${API_BASE}/markers/${markerId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    fetchMarkers();
  };

  const deleteMarker = async (markerId: string) => {
    await fetch(`${API_BASE}/markers/${markerId}`, { method: "DELETE" });
    setMarkers(prev => prev.filter(m => m.id !== markerId));
  };

  const fetchAudioTracks = useCallback(async () => {
    const res = await fetch(`${API_BASE}/projects/${id}/audio-tracks`);
    if (res.ok) setAudioTracks(await res.json());
  }, [id]);

  const updateAudioTrack = async (trackId: string, patch: object) => {
    await fetch(`${API_BASE}/audio-tracks/${trackId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    fetchAudioTracks();
  };

  const deleteAudioTrack = async (trackId: string) => {
    await fetch(`${API_BASE}/audio-tracks/${trackId}`, { method: "DELETE" });
    fetchAudioTracks();
  };

  const addAudioKeyframe = async (trackId: string, timestamp: number, volume: number) => {
    await fetch(`${API_BASE}/audio-tracks/${trackId}/keyframes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp, volume }),
    });
    fetchAudioTracks();
  };

  const deleteKeyframe = async (kfId: string) => {
    await fetch(`${API_BASE}/keyframes/${kfId}`, { method: "DELETE" });
    fetchAudioTracks();
  };

  // #1 Ripple delete
  const handleRippleDelete = async (segId: string) => {
    pushUndo();
    await fetch(`${API_BASE}/segments/${segId}/ripple`, { method: "DELETE" });
    refetchSegments();
    toast({ title: "Ripple delete", description: "Downstream clips shifted left.", duration: 2000 });
  };

  // #5 Lift delete (leave gap)
  const handleLiftDelete = async (segId: string) => {
    pushUndo();
    await fetch(`${API_BASE}/segments/${segId}/lift`, { method: "POST" });
    refetchSegments();
    toast({ title: "Lift delete", description: "Gap left in timeline.", duration: 2000 });
  };

  // #2 Slip edit
  const handleSlipEdit = async (segId: string, delta: number) => {
    if (isNaN(delta) || delta === 0) return;
    await fetch(`${API_BASE}/segments/${segId}/slip`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta }),
    });
    refetchSegments();
    setSlipTarget(null); setSlipDelta("");
    toast({ title: "Slip applied", description: `In/out shifted ${delta > 0 ? "+" : ""}${delta.toFixed(2)}s`, duration: 2000 });
  };

  // #3 Roll edit (#8 — snaps delta to nearest beat when snapEnabled)
  const handleRollEdit = async (leftId: string, rightId: string, rawDelta: number) => {
    pushUndo();
    let delta = rawDelta;
    if (snapEnabled && beatMap?.beats?.length) {
      // Find the left clip's current endTime and apply raw delta to get candidate boundary
      const leftSeg = (segments ?? []).find(s => s.id === leftId);
      if (leftSeg) {
        const candidateBoundary = leftSeg.endTime + rawDelta;
        // Find nearest beat within 0.3s snap radius
        const nearest = beatMap.beats.reduce<number | null>((best, b) => {
          if (best === null || Math.abs(b - candidateBoundary) < Math.abs(best - candidateBoundary)) return b;
          return best;
        }, null);
        if (nearest !== null && Math.abs(nearest - candidateBoundary) < 0.3) {
          delta = nearest - leftSeg.endTime;
        }
        // Also snap to marker timestamps
        for (const m of markers) {
          if (Math.abs(m.timestamp - candidateBoundary) < 0.15) {
            delta = m.timestamp - leftSeg.endTime;
            break;
          }
        }
      }
    }
    await fetch(`${API_BASE}/projects/${id}/roll-edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leftId, rightId, delta }),
    });
    refetchSegments();
    toast({ title: `Roll edit applied${snapEnabled && delta !== rawDelta ? " (snapped)" : ""}`, duration: 2000 });
  };

  // #4 Three-point insert
  const handleThreePointInsert = async () => {
    if (threePointIn == null || threePointOut == null || !previewVideoId) return;
    const sorted = [...(segments ?? [])].sort((a, b) => a.orderIndex - b.orderIndex);
    const atOrderIndex = sorted.length;
    pushUndo();
    await fetch(`${API_BASE}/projects/${id}/three-point-insert`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: previewVideoId, sourceIn: threePointIn, sourceOut: threePointOut, atOrderIndex }),
    });
    refetchSegments();
    setThreePointIn(null); setThreePointOut(null);
    toast({ title: "3-point insert done", description: `${(threePointOut - threePointIn).toFixed(1)}s clip inserted.`, duration: 2500 });
  };

  // #9 Nest segments
  const handleNestSegments = async () => {
    if (selectedSegmentIds.size < 2) return;
    pushUndo();
    const res = await fetch(`${API_BASE}/projects/${id}/nest-segments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segmentIds: [...selectedSegmentIds], name: nestName }),
    });
    if (res.ok) {
      refetchSegments();
      setSelectedSegmentIds(new Set());
      setShowNestInput(false);
      toast({ title: "Nested", description: `${selectedSegmentIds.size} clips grouped as "${nestName}".`, duration: 2500 });
    }
  };

  // #9 Unnest compound clip
  const handleUnnest = async (compoundId: string) => {
    pushUndo();
    await fetch(`${API_BASE}/segments/${compoundId}/unnest`, { method: "DELETE" });
    refetchSegments();
    toast({ title: "Unnested", description: "Compound clip flattened.", duration: 2000 });
  };

  // EDL export with markers
  const exportEDLWithMarkers = () => {
    window.open(`${API_BASE}/projects/${id}/export.edl`, "_blank");
  };

  // ── API helpers #21–#30 ───────────────────────────────────────────────────

  // #28 Add comment
  const addComment = async (timecode: number, text: string, parentId?: string) => {
    if (!text.trim()) return;
    await fetch(`${API_BASE}/projects/${id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timecode, text, authorName: "Me", parentId }),
    });
    fetchComments();
    setCommentDraft(null);
  };

  const resolveComment = async (commentId: string) => {
    await fetch(`${API_BASE}/comments/${commentId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: "true" }),
    });
    fetchComments();
  };

  const deleteComment = async (commentId: string) => {
    await fetch(`${API_BASE}/comments/${commentId}`, { method: "DELETE" });
    setComments(prev => prev.filter(c => c.id !== commentId));
  };

  // #30 Create checkpoint
  const saveCheckpoint = async () => {
    const name = checkpointNameInput.trim();
    if (!name) return;
    setCheckpointSaving(true);
    const res = await fetch(`${API_BASE}/projects/${id}/checkpoints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    setCheckpointSaving(false);
    setCheckpointNameInput("");
    fetchCheckpoints();
    toast({ title: `Checkpoint saved: "${name}"`, description: `${data.segmentCount} clips captured`, duration: 2500 });
  };

  const restoreCheckpoint = async (checkId: string, checkName: string) => {
    pushUndo();
    const res = await fetch(`${API_BASE}/projects/${id}/checkpoints/${checkId}/restore`, { method: "POST" });
    const data = await res.json();
    refetchSegments();
    toast({ title: `Restored: "${checkName}"`, description: `${data.restored} clips restored`, duration: 2500 });
  };

  const deleteCheckpoint = async (checkId: string) => {
    await fetch(`${API_BASE}/checkpoints/${checkId}`, { method: "DELETE" });
    setCheckpoints(prev => prev.filter(c => c.id !== checkId));
  };

  // #29 Revert clip to historical state
  const revertToEdit = async (segId: string, editId: string, editType: string) => {
    const res = await fetch(`${API_BASE}/segments/${segId}/revert-to/${editId}`, { method: "POST" });
    if (res.ok) {
      refetchSegments();
      toast({ title: `Reverted ${editType} edit`, duration: 2000 });
    } else {
      const e = await res.json().catch(() => ({}));
      toast({ title: "Revert failed", description: e.error, variant: "destructive" });
    }
  };

  // ── New NLE API helpers (#11–#16) ──────────────────────────────────────────

  // #15 Freeze frame toggle
  const handleFreezeFrame = async (segId: string, duration = 2.0) => {
    const res = await fetch(`${API_BASE}/segments/${segId}/freeze-frame`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration }),
    });
    const updated = await res.json();
    refetchSegments();
    toast({ title: updated.freeze ? `Freeze frame on (${updated.freezeDuration}s)` : "Freeze frame off", duration: 2000 });
  };

  // #14 Optical-flow slow-mo toggle
  const handleOpticalFlow = async (segId: string) => {
    const res = await fetch(`${API_BASE}/segments/${segId}/optical-flow`, { method: "POST" });
    const updated = await res.json();
    refetchSegments();
    toast({ title: updated.opticalFlow ? "Optical-flow slo-mo ON (0.25×)" : "Optical-flow slo-mo OFF", duration: 2000 });
  };

  // #16 Reverse clip toggle
  const handleReverse = async (segId: string) => {
    const res = await fetch(`${API_BASE}/segments/${segId}/reverse`, { method: "POST" });
    const updated = await res.json();
    refetchSegments();
    toast({ title: updated.reverse ? "Clip reversed ◀" : "Clip reversed off", duration: 2000 });
  };

  // #12 Paste attributes to selected clips
  const handlePasteAttributes = async () => {
    if (!copiedGrade) return;
    const targets = selectedSegmentIds.size > 0
      ? [...selectedSegmentIds].filter(s => s !== copiedGrade.segId)
      : (segments ?? []).filter(s => s.id !== copiedGrade.segId).map(s => s.id);
    for (const t of targets) {
      await fetch(`${API_BASE}/segments/${t}/paste-attributes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSegmentId: copiedGrade.segId }),
      });
    }
    refetchSegments();
    toast({ title: `Color grade pasted to ${targets.length} clip${targets.length !== 1 ? "s" : ""}`, duration: 2000 });
  };

  // #13 Save speed ramp curve
  const handleSaveSpeedCurve = async (segId: string, points: { t: number; v: number }[]) => {
    const avgSpeed = points.reduce((s, p) => s + p.v, 0) / points.length;
    await fetch(`${API_BASE}/segments/${segId}/speed-curve`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points, speedFactor: avgSpeed }),
    });
    refetchSegments();
    setSpeedRampTarget(null);
    toast({ title: "Speed ramp applied", description: `${points.length} control points`, duration: 2000 });
  };

  // #11 Range operations
  const handleRangeApply = async () => {
    if (rangeStart == null || rangeEnd == null || rangeEnd <= rangeStart) {
      toast({ title: "Invalid range", description: "Set start < end", variant: "destructive" }); return;
    }
    pushUndo();
    let endpoint = rangeOp === "delete" ? `range-delete` : rangeOp === "speed" ? `range-speed` : `range-color`;
    const body: Record<string, unknown> = { start: rangeStart, end: rangeEnd };
    if (rangeOp === "speed") body.speedFactor = rangeSpeed;
    if (rangeOp === "color") body.colorGrade = rangeColor;
    const res = await fetch(`${API_BASE}/projects/${id}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    refetchSegments();
    const n = data.deleted ?? data.updated ?? 0;
    toast({ title: `Range ${rangeOp}: ${n} clip${n !== 1 ? "s" : ""} affected`, description: `${rangeStart.toFixed(1)}s → ${rangeEnd.toFixed(1)}s`, duration: 2500 });
  };

  const handleSubmitRating = async (rating: number) => {
    setQualityRating(rating);
    setRatingSubmitting(true);
    try {
      await fetch(`${API_BASE}/projects/${id}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      toast({ title: "Rating saved", description: `Edit rated ${rating}/5 — RL loop will use this weight when you run "Learn from Edit"`, duration: 3000 });
    } catch {
      toast({ title: "Could not save rating", variant: "destructive" });
    } finally {
      setRatingSubmitting(false);
    }
  };

  const handleSaveManuscript = async () => {
    setManuscriptSaving(true);
    try {
      await fetch(`${API_BASE}/projects/${id}/manuscript`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manuscript: manuscriptText }),
      });
      setManuscriptSaved(true);
      toast({ title: "Script saved", description: "Your manuscript is ready for AI analysis." });
      setTimeout(() => setManuscriptSaved(false), 3000);
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    }
    setManuscriptSaving(false);
  };

  const [renderStatus, setRenderStatus] = useState<{ ready: boolean; status: string; sizeMB?: number; downloadUrl?: string | null } | null>(null);
  const [showRenderPreview, setShowRenderPreview] = useState(false);
  const [renderFormat, setRenderFormat] = useState<"horizontal" | "vertical">("horizontal");
  const [captionStyle, setCaptionStyle] = useState<"subtitle" | "title" | "lower_third" | "kinetic">("subtitle");
  const [previewMode, setPreviewMode] = useState<"source" | "rendered">("source");
  const [trainSignals, setTrainSignals] = useState<{ totalEdits: number; byType: Record<string, number>; learningActive: boolean } | null>(null);

  // Undo / Redo
  type SegmentSnapshot = Array<{ id: string; orderIndex: number; included: boolean; startTime: number; endTime: number }>;
  const [undoStack, setUndoStack] = useState<SegmentSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<SegmentSnapshot[]>([]);

  const pushUndo = useCallback(() => {
    if (!segments?.length) return;
    const snap = segments.map(s => ({ id: s.id, orderIndex: s.orderIndex, included: s.included, startTime: s.startTime, endTime: s.endTime }));
    setUndoStack(prev => [...prev.slice(-14), snap]);
    setRedoStack([]);
  }, [segments]);

  const applySnapshot = useCallback(async (snap: SegmentSnapshot) => {
    for (const s of snap) {
      await fetch(`${API_BASE}/segments/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIndex: s.orderIndex, included: s.included, startTime: s.startTime, endTime: s.endTime }),
      });
    }
    refetchSegments();
  }, [refetchSegments]);

  const handleUndo = useCallback(async () => {
    if (!undoStack.length || !segments?.length) return;
    const currentSnap = segments.map(s => ({ id: s.id, orderIndex: s.orderIndex, included: s.included, startTime: s.startTime, endTime: s.endTime }));
    setRedoStack(prev => [...prev, currentSnap]);
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(stack => stack.slice(0, -1));
    await applySnapshot(prev);
  }, [undoStack, segments, applySnapshot]);

  const handleRedo = useCallback(async () => {
    if (!redoStack.length || !segments?.length) return;
    const currentSnap = segments.map(s => ({ id: s.id, orderIndex: s.orderIndex, included: s.included, startTime: s.startTime, endTime: s.endTime }));
    setUndoStack(prev => [...prev, currentSnap]);
    const next = redoStack[redoStack.length - 1];
    setRedoStack(stack => stack.slice(0, -1));
    await applySnapshot(next);
  }, [redoStack, segments, applySnapshot]);

  // Drag-to-reorder
  const [dragOver, setDragOver] = useState<string | null>(null);
  const dragSegId = useRef<string | null>(null);

  const handleDragStart = (segId: string) => { dragSegId.current = segId; };
  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault(); setDragOver(targetId);
  };
  const handleDrop = useCallback(async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOver(null);
    const sourceId = dragSegId.current;
    if (!sourceId || sourceId === targetId || !segments) return;
    pushUndo();
    const sorted = [...segments].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIdx = sorted.findIndex(s => s.id === sourceId);
    const toIdx = sorted.findIndex(s => s.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...sorted];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    await Promise.all(reordered.map((s, i) =>
      fetch(`${API_BASE}/segments/${s.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIndex: i }),
      })
    ));
    refetchSegments();
    dragSegId.current = null;
  }, [segments, pushUndo, refetchSegments]);

  // Split clip
  const handleSplit = useCallback(async (segmentId: string, at: number) => {
    pushUndo();
    const res = await fetch(`${API_BASE}/segments/${segmentId}/split`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at }),
    });
    if (res.ok) {
      toast({ title: "Clip split", description: `Split at ${at.toFixed(2)}s` });
      refetchSegments();
    } else {
      const err = await res.json().catch(() => ({}));
      toast({ title: "Split failed", description: err.error ?? "Unknown error", variant: "destructive" });
    }
  }, [pushUndo, refetchSegments, toast]);

  // AI Refine Edit
  const [refineInstruction, setRefineInstruction] = useState("");
  const [showRefineInput, setShowRefineInput] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [drivePickerParent, setDrivePickerParent] = useState<Array<{ id: string; name: string }>>([]);
  const [driveFolders, setDriveFolders] = useState<Array<{ id: string; name: string; hasChildren: boolean }>>([]);
  const [driveFoldersLoading, setDriveFoldersLoading] = useState(false);
  const [selectedDriveFolder, setSelectedDriveFolder] = useState<{ id: string; name: string } | null>(null);

  // Story Preferences Modal
  const [showStoryPrefs, setShowStoryPrefs] = useState(false);
  const [isLockingScript, setIsLockingScript] = useState(false);

  const handleStoryPrefsApply = useCallback((prefs: StoryPreferences) => {
    handleRunJob("generate_edit_plan", undefined, JSON.stringify({ styleId: selectedStyleId ?? null, storyPrefs: prefs }));
  }, [selectedStyleId]);

  const handleApplyPacing = useCallback(async (issues: Array<{ clipIndex: number; suggestedDuration: number | null }>) => {
    const res = await fetch(`${API_BASE}/projects/${id}/apply-pacing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issues }),
    });
    if (!res.ok) throw new Error(`apply-pacing failed: ${res.status}`);
    const data = await res.json();
    await refetchSegments();
    toast({ title: `Pacing applied`, description: `${data.applied} of ${data.total} clips trimmed` });
  }, [id, refetchSegments, toast]);

  const handleBulkSegmentUpdate = useCallback(async (updates: Array<{ id: string; label?: string; captionText?: string; included?: boolean }>) => {
    const res = await fetch(`${API_BASE}/projects/${id}/segments/bulk`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    if (!res.ok) throw new Error(`bulk update failed: ${res.status}`);
    const data = await res.json();
    await refetchSegments();
    toast({ title: "Script updated", description: `${data.applied} clips updated` });
  }, [id, refetchSegments, toast]);

  const handleLockScript = useCallback(async (approvedIds: string[]) => {
    if (!segments?.length) return;
    setIsLockingScript(true);
    try {
      const approvedSet = new Set(approvedIds);
      await Promise.all(segments.map(seg =>
        fetch(`${API_BASE}/segments/${seg.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ included: approvedSet.has(seg.id) }),
        })
      ));
      await refetchSegments();
      toast({ title: `Timeline locked`, description: `${approvedIds.length} clips approved, ${segments.length - approvedIds.length} excluded` });
      setRightPanelTab("music");
    } finally {
      setIsLockingScript(false);
    }
  }, [segments, refetchSegments, toast]);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/${id}/render-status`);
        if (res.ok) {
          const data = await res.json();
          const wasReady = renderStatus?.ready;
          setRenderStatus(data);
          // Auto-switch to rendered preview when render just completed
          if (!wasReady && data.ready) {
            setPreviewMode("rendered");
          }
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [id]);

  // Poll training signals for this project
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/${id}/training-signals`);
        if (res.ok) setTrainSignals(await res.json());
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [id]);

  // Fetch styles library when styles tab is active
  useEffect(() => {
    if (activeTab !== "styles") return;
    const fetchStyles = async () => {
      setStylesLoading(true);
      try {
        const params = new URLSearchParams({ limit: "80" });
        if (stylesCategory !== "all") params.set("category", stylesCategory);
        if (stylesSearch.trim()) params.set("search", stylesSearch.trim());
        const res = await fetch(`${API_BASE}/styles?${params}`);
        if (res.ok) {
          const data = await res.json();
          setStyles(data.styles ?? []);
        }
      } catch {}
      setStylesLoading(false);
    };
    fetchStyles();
  }, [activeTab, stylesCategory, stylesSearch]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const ctrlCmd = isMac ? e.metaKey : e.ctrlKey;

      if (ctrlCmd && e.key === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); return; }
      if (ctrlCmd && (e.key === "z" && e.shiftKey || e.key === "y")) { e.preventDefault(); handleRedo(); return; }

      if (!segments?.length) return;
      const sorted = [...segments].filter(s => s.included).sort((a, b) => a.orderIndex - b.orderIndex);

      switch (e.key) {
        case " ":
          e.preventDefault();
          if (sequencePreview) {
            seqVideoRef.current?.paused ? seqVideoRef.current?.play() : seqVideoRef.current?.pause();
          } else if (sorted.length > 0) {
            setSeqIndex(0); setSequencePreview(true);
          }
          break;
        case "Escape":
          if (sequencePreview) { setSequencePreview(false); }
          else { setSelectedSegment(null); }
          break;
        case "Delete":
        case "Backspace":
          if (selectedSegment && !sequencePreview) {
            e.preventDefault();
            const seg = segments?.find(s => s.id === selectedSegment);
            if (seg) {
              pushUndo();
              updateSegment.mutate({ id: seg.id, data: { included: !seg.included } }, { onSuccess: () => { refetchSegments(); refetchTrainSignals(); runAutoLearn((trainSignals?.totalEdits ?? 0) + 1); } });
            }
          }
          break;
        case "ArrowRight":
          if (!sequencePreview && selectedSegment) {
            e.preventDefault();
            const allSorted = [...segments].sort((a, b) => a.orderIndex - b.orderIndex);
            const idx = allSorted.findIndex(s => s.id === selectedSegment);
            if (idx < allSorted.length - 1) setSelectedSegment(allSorted[idx + 1].id);
          } else if (sequencePreview) {
            e.preventDefault();
            setSeqIndex(i => Math.min(sorted.length - 1, i + 1));
          }
          break;
        case "ArrowLeft":
          if (!sequencePreview && selectedSegment) {
            e.preventDefault();
            const allSorted = [...segments].sort((a, b) => a.orderIndex - b.orderIndex);
            const idx = allSorted.findIndex(s => s.id === selectedSegment);
            if (idx > 0) setSelectedSegment(allSorted[idx - 1].id);
          } else if (sequencePreview) {
            e.preventDefault();
            setSeqIndex(i => Math.max(0, i - 1));
          }
          break;
        case "j":
          e.preventDefault();
          setCurrentTime(t => Math.max(0, t - 5));
          break;
        case "l":
          e.preventDefault();
          setCurrentTime(t => t + 5);
          break;
        case "k":
          e.preventDefault();
          if (sequencePreview) seqVideoRef.current?.pause();
          break;
        case "i":
          if (selectedSegment) {
            e.preventDefault();
            const seg = segments?.find(s => s.id === selectedSegment);
            if (seg && currentTime < seg.endTime) {
              pushUndo();
              updateSegment.mutate({ id: selectedSegment, data: { startTime: parseFloat(currentTime.toFixed(2)) } }, { onSuccess: () => refetchSegments() });
              toast({ title: `In point set to ${currentTime.toFixed(2)}s` });
            }
          }
          break;
        case "o":
          if (selectedSegment) {
            e.preventDefault();
            const seg = segments?.find(s => s.id === selectedSegment);
            if (seg && currentTime > seg.startTime) {
              pushUndo();
              updateSegment.mutate({ id: selectedSegment, data: { endTime: parseFloat(currentTime.toFixed(2)) } }, { onSuccess: () => refetchSegments() });
              toast({ title: `Out point set to ${currentTime.toFixed(2)}s` });
            }
          }
          break;
        case "s":
          if (ctrlCmd && selectedSegment) {
            e.preventDefault();
            const seg = segments?.find(s => s.id === selectedSegment);
            if (seg && currentTime > seg.startTime && currentTime < seg.endTime) {
              handleSplit(selectedSegment, currentTime);
            }
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [segments, selectedSegment, sequencePreview, currentTime, handleUndo, handleRedo, handleSplit, pushUndo, updateSegment, refetchSegments, toast]);

  const loadDriveFolders = async (parentId?: string) => {
    setDriveFoldersLoading(true);
    try {
      const url = parentId
        ? `${API_BASE}/drive-folders?parent=${encodeURIComponent(parentId)}`
        : `${API_BASE}/drive-folders`;
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setDriveFolders(data);
    } catch (e: any) {
      toast({ title: "Drive error", description: e.message ?? "Could not list folders", variant: "destructive" });
    } finally {
      setDriveFoldersLoading(false);
    }
  };

  const handleRunJob = (type: "transcribe" | "analyze_scenes" | "detect_beats" | "analyze_music" | "enhance_audio" | "generate_edit_plan" | "apply_edit" | "render" | "analyze_manuscript" | "quality_check" | "refine_edit" | "detect_speech" | "analyze_clips" | "detect_quality_signals" | "learn_from_edit" | "rank_clips_ai" | "detect_scenes_visual" | "detect_speakers" | "auto_assemble" | "generate_manuscript" | "extract_features" | "semantic_tag" | "generate_proxy" | "embed_clips" | "score_cut_points" | "match_broll" | "match_broll_v2" | "generate_captions" | "trim_silence" | "suggest_broll" | "smart_reframe" | "suggest_graphics" | "suggest_music" | "suggest_pacing" | "scan_drive_broll" | "analyze_faces" | "detect_reactions" | "enforce_shot_diversity" | "diarize_speakers_v2" | "detect_action_boundaries" | "check_av_correspondence" | "check_consistency", videoId?: string, options?: string) => {
    createJob.mutate({
      data: {
        projectId: id,
        type,
        videoId,
        options,
        // Pass selected style DNA when generating edit plan
        ...(type === "generate_edit_plan" && selectedStyleId ? { styleId: selectedStyleId } : {})
      }
    }, {
      onSuccess: () => {
        toast({
          title: "Job started",
          description: `Started ${type.replace(/_/g, ' ')}...`
        });
        if (type === 'enhance_audio') {
          const interval = setInterval(() => { refetchAudioPlan(); }, 3000);
          setTimeout(() => clearInterval(interval), 30000);
        }
        if (type === 'generate_edit_plan' || type === 'apply_edit') {
          const interval = setInterval(() => { refetchSegments(); }, 3000);
          setTimeout(() => clearInterval(interval), 60000);
        }
        if (type === 'render') {
          const poll = async () => {
            const res = await fetch(`${API_BASE}/projects/${id}/render-status`);
            if (res.ok) setRenderStatus(await res.json());
          };
          const interval = setInterval(poll, 3000);
          setTimeout(() => clearInterval(interval), 600000);
        }
        if (type === 'quality_check') {
          setRightPanelTab("qc");
        }
      }
    });
  };

  // Load QC result from the latest completed quality_check job
  useEffect(() => {
    const qcJob = (jobs ?? []).slice().reverse().find((j: any) => j.type === 'quality_check' && j.status === 'completed' && j.result);
    if (qcJob?.result) {
      try { setQcResult(JSON.parse(qcJob.result)); } catch {}
    }
  }, [jobs]);

  // Pre-buffer ref for next segment
  const seqPrebufferRef = useRef<HTMLVideoElement | null>(null);

  // Sequence preview: imperatively control single video element to avoid re-buffering
  const seqCurrentSrcRef = useRef<string>("");
  useEffect(() => {
    if (!sequencePreview) return;
    const video = seqVideoRef.current;
    if (!video) return;
    const includedSegs = (segments ?? []).filter(s => s.included).sort((a, b) => a.orderIndex - b.orderIndex);
    const seg = includedSegs[seqIndex];
    if (!seg) return;
    const segVideo = videos?.find(v => v.id === seg.videoId);
    if (!segVideo) return;
    const newSrc = `${API_BASE}/videos/${segVideo.id}/stream`;
    setSeqBuffering(true);
    if (seqCurrentSrcRef.current !== newSrc) {
      // Different clip — change src and seek after metadata loads
      seqCurrentSrcRef.current = newSrc;
      video.src = newSrc;
      video.preload = "auto";
      const onMeta = () => {
        video.currentTime = seg.startTime ?? 0;
        video.play().catch(() => {});
        setSeqBuffering(false);
        video.removeEventListener("loadedmetadata", onMeta);
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.load();
    } else {
      // Same clip, just seek — no re-buffer needed
      video.currentTime = seg.startTime ?? 0;
      video.play().catch(() => {});
      setSeqBuffering(false);
    }

    // Pre-buffer the NEXT clip in a hidden video element
    const nextSeg = includedSegs[seqIndex + 1];
    if (nextSeg) {
      const nextVideo = videos?.find(v => v.id === nextSeg.videoId);
      if (nextVideo) {
        const nextSrc = `${API_BASE}/videos/${nextVideo.id}/stream`;
        if (!seqPrebufferRef.current) {
          seqPrebufferRef.current = document.createElement("video");
          seqPrebufferRef.current.preload = "auto";
          seqPrebufferRef.current.style.display = "none";
          document.body.appendChild(seqPrebufferRef.current);
        }
        if (seqPrebufferRef.current.src !== nextSrc) {
          seqPrebufferRef.current.src = nextSrc;
          seqPrebufferRef.current.load();
        }
      }
    }

    return () => {
      // Cleanup pre-buffer element when closing preview
      if (!sequencePreview && seqPrebufferRef.current) {
        seqPrebufferRef.current.remove();
        seqPrebufferRef.current = null;
      }
    };
  }, [seqIndex, sequencePreview]);

  const handleToggleSegment = (segmentId: string, currentIncluded: boolean) => {
    updateSegment.mutate({
      id: segmentId,
      data: { included: !currentIncluded }
    }, {
      onSuccess: () => {
        refetchSegments();
      }
    });
  };

  if (projectLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold">Project not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => setLocation('/projects')}>
          Back to Projects
        </Button>
      </div>
    );
  }

  const activeJobs = jobs?.filter(j => j.status === 'running' || j.status === 'pending') || [];
  const sortedJobs = [...(jobs ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const lastJob = activeJobs.length > 0 ? activeJobs[0] : sortedJobs[0];
  const logLines: string[] = lastJob?.logLines ? (() => { try { return JSON.parse(lastJob.logLines).slice(-20); } catch { return []; } })() : [];

  const isJobRunning = (type: string) => activeJobs.some(j => j.type === type);
  const isAnyJobRunning = activeJobs.length > 0;

  const timelineDuration = Math.max(
    segments?.reduce((max, seg) => Math.max(max, seg.endTime), 0) || 0,
    project.durationSeconds || 60,
    beatMap?.totalDuration || 0
  );

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden font-sans">
      {/* Workspace Header */}
      <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLocation('/projects')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {/* Split-screen sidebar toggle — visible when viewport is narrow (iPad multitasking) */}
          {isSplitMode && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSidebarOpen(o => !o)}
              title="Toggle tools panel"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
          <div className="flex flex-col">
            <h1 className="font-semibold text-sm flex items-center gap-2">
              {project.name}
              <Badge variant="outline" className="text-[10px] h-5 py-0 px-1.5 uppercase bg-muted/50">{project.status}</Badge>
              {isSplitMode && (
                <Badge variant="outline" className="text-[9px] h-4 py-0 px-1 bg-indigo-500/10 text-indigo-400 border-indigo-500/30 hidden sm:flex">Split</Badge>
              )}
            </h1>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {activeJobs.length > 0 && (
            <Badge variant="secondary" className="mr-2 animate-pulse">
              <Clock className="h-3 w-3 mr-1" />
              {activeJobs.length} active jobs
            </Badge>
          )}
          <Link href={`/projects/${id}/jobs`}>
            <Button variant="ghost" size="sm" className="h-8 text-xs">
              <Clock className="h-3.5 w-3.5 mr-1.5" /> Jobs
            </Button>
          </Link>
          {renderStatus?.ready && renderStatus.downloadUrl && (
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-8 text-xs border-green-600/50 text-green-400 hover:bg-green-600/10" onClick={() => setShowRenderPreview(true)}>
                <Play className="h-3.5 w-3.5 mr-1.5 fill-green-400" /> Preview Export
              </Button>
              <a href={renderStatus.downloadUrl} download>
                <Button size="sm" className="h-8 bg-green-600 hover:bg-green-700 text-xs">
                  <Download className="h-3.5 w-3.5 mr-1.5" /> Download MP4 ({renderStatus.sizeMB}MB)
                </Button>
              </a>
              <Button size="sm" variant="outline" className="h-8 text-xs border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={() => {
                  const url = window.location.origin + (renderStatus.downloadUrl ?? "");
                  navigator.clipboard.writeText(url).then(() => {
                    const btn = document.getElementById("copy-link-btn");
                    if (btn) { btn.textContent = "Copied!"; setTimeout(() => { if (btn) btn.textContent = "Copy Link"; }, 2000); }
                  });
                }}
              >
                <Link2 className="h-3.5 w-3.5 mr-1.5" /><span id="copy-link-btn">Copy Link</span>
              </Button>
            </div>
          )}
          <div className="flex items-center gap-1 border-l border-border/50 pl-2">
            <button
              disabled={!undoStack.length}
              onClick={handleUndo}
              title="Undo (Cmd+Z)"
              className="h-8 w-8 flex items-center justify-center rounded hover:bg-accent/70 disabled:opacity-30 transition-colors"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              disabled={!redoStack.length}
              onClick={handleRedo}
              title="Redo (Cmd+Shift+Z)"
              className="h-8 w-8 flex items-center justify-center rounded hover:bg-accent/70 disabled:opacity-30 transition-colors"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            title="Keyboard Shortcuts: Space=play, Delete=exclude, ←/→=prev/next clip, I/O=set in/out, J/K/L=seek, Cmd+S=split, Cmd+Z=undo"
            className="h-8 w-8 flex items-center justify-center rounded hover:bg-accent/70 transition-colors text-zinc-500 hover:text-zinc-300"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-8 bg-primary hover:bg-primary/90 text-xs gap-1.5">
                <Download className="h-3.5 w-3.5" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              {/* ── Media Root for filename relinking ─────────────── */}
              <div className="px-2 py-2 border-b border-border/40" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Media root (for DaVinci Resolve)</p>
                <input
                  type="text"
                  value={mediaRoot}
                  onChange={e => setMediaRoot(e.target.value)}
                  placeholder="/Volumes/Drive/Footage  or  C:\Footage"
                  className="w-full text-[9px] bg-zinc-900 border border-border/60 rounded px-1.5 py-1 text-zinc-200 placeholder-zinc-600 font-mono"
                  title="The folder on your editing machine where the original source files live. DaVinci Resolve uses this path to relink media when you import the XML."
                  onKeyDown={e => e.stopPropagation()}
                />
                {mediaRoot && (
                  <p className="text-[8px] text-emerald-400 mt-0.5">✓ XML will reference files in this folder</p>
                )}
                {!mediaRoot && (
                  <p className="text-[8px] text-zinc-600 mt-0.5">Leave blank → Resolve asks to relink on import</p>
                )}
              </div>

              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Download for NLE</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <a href={`${API_BASE}/projects/${id}/export-resolve.xml${mediaRoot ? `?mediaRoot=${encodeURIComponent(mediaRoot)}` : ""}`} download className="flex items-center gap-2 cursor-pointer">
                    <div className="h-4 w-4 rounded bg-violet-500/20 flex items-center justify-center shrink-0">
                      <Download className="h-2.5 w-2.5 text-violet-400" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-medium">DaVinci Resolve XML</span>
                      <span className="text-[10px] text-muted-foreground truncate">File → Import Timeline → XML</span>
                    </div>
                    <Badge className="ml-auto text-[8px] px-1 h-3.5 bg-violet-500/20 text-violet-300 border-violet-500/30">Best</Badge>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={`${API_BASE}/projects/${id}/export.fcpxml${mediaRoot ? `?mediaRoot=${encodeURIComponent(mediaRoot)}` : ""}`} download className="flex items-center gap-2 cursor-pointer">
                    <div className="h-4 w-4 rounded bg-blue-500/20 flex items-center justify-center shrink-0">
                      <Download className="h-2.5 w-2.5 text-blue-400" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-medium">FCPXML 1.11</span>
                      <span className="text-[10px] text-muted-foreground truncate">Final Cut Pro X / Resolve</span>
                    </div>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={`${API_BASE}/projects/${id}/export.edl`} download className="flex items-center gap-2 cursor-pointer">
                    <div className="h-4 w-4 rounded bg-orange-500/20 flex items-center justify-center shrink-0">
                      <Download className="h-2.5 w-2.5 text-orange-400" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-medium">EDL (CMX 3600)</span>
                      <span className="text-[10px] text-muted-foreground truncate">Resolve / Premiere / Avid</span>
                    </div>
                  </a>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <a href={`${API_BASE}/projects/${id}/export.srt`} download className="flex items-center gap-2 cursor-pointer">
                    <div className="h-4 w-4 rounded bg-yellow-500/20 flex items-center justify-center shrink-0">
                      <Download className="h-2.5 w-2.5 text-yellow-400" />
                    </div>
                    <span className="text-xs">SRT Subtitles</span>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={`${API_BASE}/projects/${id}/export.json`} download className="flex items-center gap-2 cursor-pointer">
                    <div className="h-4 w-4 rounded bg-emerald-500/20 flex items-center justify-center shrink-0">
                      <Download className="h-2.5 w-2.5 text-emerald-400" />
                    </div>
                    <span className="text-xs">JSON Edit Data</span>
                  </a>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setLocation(`/projects/${id}/exports`)} className="text-xs text-muted-foreground">
                View all exports & cloud upload →
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Main Workspace Area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Overlay backdrop for split-screen drawer (iPad multitasking) */}
        {isSplitMode && sidebarOpen && (
          <div
            className="absolute inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {/* Left Sidebar - Media & AI Tools */}
        <div className={`border-r border-border bg-card flex flex-col shrink-0 transition-transform duration-200 ${
          isSplitMode
            ? `absolute inset-y-0 left-0 z-50 w-72 ${sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"}`
            : "w-72"
        }`}>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col w-full">
            {/* ── FCP-style icon tab bar ── */}
            <div className="flex-shrink-0 flex items-stretch overflow-x-auto scrollbar-none" style={{ background: "#1e1e1e", borderBottom: "1px solid #333" }}>
              {([
                { value: "media",  Icon: Film,        label: "Media",   accent: "#4d9cf8" },
                { value: "ai",     Icon: Sparkles,    label: "AI",      accent: "#4d9cf8" },
                { value: "clips",  Icon: Scissors,    label: "Klipp",   accent: "#22d3ee" },
                { value: "audio",  Icon: Volume2,     label: "Lyd",     accent: "#4d9cf8" },
                { value: "script", Icon: FileText,    label: "Script",  accent: "#fbbf24" },
                { value: "styles", Icon: Wand2,       label: "Stiler",  accent: "#a78bfa" },
                { value: "color",  Icon: Palette,     label: "Farge",   accent: "#34d399" },
                { value: "social", Icon: MonitorPlay, label: "Eksport", accent: "#f472b6" },
              ] as const).map(({ value, Icon, label, accent }) => {
                const isActive = activeTab === value;
                return (
                  <button
                    key={value}
                    onClick={() => setActiveTab(value)}
                    className="relative flex flex-col items-center justify-center gap-0.5 px-2.5 py-1.5 flex-shrink-0 transition-colors"
                    style={{
                      background: isActive ? "#2a2a2a" : "transparent",
                      borderBottom: isActive ? `2px solid ${accent}` : "2px solid transparent",
                      minWidth: 44,
                    }}
                  >
                    <Icon className="h-3.5 w-3.5" style={{ color: isActive ? accent : "#666" }} />
                    <span className="text-[7px] font-medium tracking-wide whitespace-nowrap"
                      style={{ color: isActive ? "#ccc" : "#555" }}>
                      {label}
                      {value === "styles" && selectedStyleId && (
                        <span className="inline-block w-1 h-1 rounded-full ml-0.5 align-middle" style={{ background: "#a78bfa" }} />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Hidden Shadcn TabsList for accessibility / state management */}
            <TabsList className="hidden">
              <TabsTrigger value="media">Media</TabsTrigger>
              <TabsTrigger value="ai">AI</TabsTrigger>
              <TabsTrigger value="clips">Klipp</TabsTrigger>
              <TabsTrigger value="audio">Lyd</TabsTrigger>
              <TabsTrigger value="script">Script</TabsTrigger>
              <TabsTrigger value="styles">Stiler</TabsTrigger>
              <TabsTrigger value="color">Farge</TabsTrigger>
              <TabsTrigger value="social">Eksport</TabsTrigger>
            </TabsList>
            
            <TabsContent value="media" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              {/* ── FCP-style filter bar ── */}
              <div className="flex-shrink-0 flex flex-col gap-0" style={{ background: "#252525", borderBottom: "1px solid #333" }}>
                {/* Search row */}
                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
                  <div className="flex-1 relative">
                    <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5" style={{ color: "#555" }} />
                    <input
                      value={mediaSearch}
                      onChange={e => setMediaSearch(e.target.value)}
                      placeholder="Søk klipp…"
                      className="w-full pl-5 pr-2 py-0.5 text-[10px] rounded outline-none"
                      style={{ background: "#1c1c1c", border: "1px solid #3a3a3a", color: "#ccc" }}
                    />
                  </div>
                  {/* Sort dropdown */}
                  <div className="relative">
                    <select
                      value={mediaSortBy}
                      onChange={e => setMediaSortBy(e.target.value as any)}
                      className="appearance-none text-[9px] pl-1.5 pr-4 py-0.5 rounded outline-none cursor-pointer"
                      style={{ background: "#1c1c1c", border: "1px solid #3a3a3a", color: "#888" }}
                    >
                      <option value="score">Score ↓</option>
                      <option value="duration">Varighet ↓</option>
                      <option value="name">Navn A–Z</option>
                      <option value="type">Type</option>
                    </select>
                    <ChevronDown className="absolute right-0.5 top-1/2 -translate-y-1/2 h-2 w-2 pointer-events-none" style={{ color: "#555" }} />
                  </div>
                  {/* Group toggle */}
                  <button
                    onClick={() => setMediaGrouped(g => !g)}
                    title="Grupper etter type"
                    className="rounded p-0.5 transition-colors"
                    style={{ background: mediaGrouped ? "#3a4a6a" : "#2a2a2a", border: "1px solid #3a3a3a" }}
                  >
                    <Layers className="h-2.5 w-2.5" style={{ color: mediaGrouped ? "#4d9cf8" : "#555" }} />
                  </button>
                </div>
                {/* Shot-type filter pills */}
                <div className="flex items-center gap-1 px-2 pb-1.5">
                  {([ ["all","Alle"], ["talking_head","TALK"], ["b_roll","B-ROLL"], ["mixed","MIX"] ] as const).map(([key, lbl]) => (
                    <button
                      key={key}
                      onClick={() => setMediaFilterType(key as any)}
                      className="text-[7px] font-bold uppercase px-1.5 py-0.5 rounded transition-all"
                      style={{
                        background: mediaFilterType === key ? "#1d3a5e" : "#1c1c1c",
                        border: `1px solid ${mediaFilterType === key ? "#4d9cf8" : "#333"}`,
                        color: mediaFilterType === key ? "#4d9cf8" : "#555",
                      }}
                    >{lbl}</button>
                  ))}
                  {(mediaSearch || mediaFilterType !== "all") && (
                    <button
                      onClick={() => { setMediaSearch(""); setMediaFilterType("all"); }}
                      className="ml-auto text-[7px] rounded px-1 py-0.5 transition-colors"
                      style={{ color: "#f87171", border: "1px solid #3a2a2a", background: "#1c1c1c" }}
                    >Tøm</button>
                  )}
                </div>
              </div>
              <ScrollArea className="flex-1 p-3">
                {uploadProgress !== null ? (
                  <div className="border-2 border-dashed border-blue-500/50 rounded-lg p-3 flex flex-col mb-4 bg-blue-500/5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-semibold text-blue-300 truncate max-w-[75%]">{uploadFileName}</span>
                      <span className="text-[10px] font-bold text-blue-200 tabular-nums">{uploadProgress}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden mb-2">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    {uploadStats && (
                      <div className="grid grid-cols-3 gap-1 text-center">
                        <div>
                          <div className="text-[9px] text-zinc-500 uppercase tracking-wider">Sent</div>
                          <div className="text-[10px] font-mono text-blue-300">
                            {uploadStats.loadedMB.toFixed(0)} <span className="text-zinc-500">/ {uploadStats.totalMB.toFixed(0)} MB</span>
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] text-zinc-500 uppercase tracking-wider">Speed</div>
                          <div className="text-[10px] font-mono text-green-400">
                            {uploadStats.speedMBs > 0 ? `${uploadStats.speedMBs.toFixed(1)} MB/s` : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] text-zinc-500 uppercase tracking-wider">ETA</div>
                          <div className="text-[10px] font-mono text-amber-400">
                            {uploadStats.etaSec > 0
                              ? uploadStats.etaSec >= 60
                                ? `${Math.floor(uploadStats.etaSec / 60)}m ${uploadStats.etaSec % 60}s`
                                : `${uploadStats.etaSec}s`
                              : "—"}
                          </div>
                        </div>
                      </div>
                    )}
                    <p className="text-[9px] text-blue-400/50 mt-2 text-center">
                      {uploadProgress < 100 ? "Server is receiving — keep this tab open…" : "Upload complete, processing…"}
                    </p>
                  </div>
                ) : (
                  <div 
                    {...getRootProps()} 
                    className={`border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center text-center cursor-pointer transition-colors mb-4
                      ${isDragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/50'}`}
                  >
                    <input {...getInputProps()} />
                    <Upload className={`h-6 w-6 mb-2 ${isDragActive ? 'text-primary' : 'text-muted-foreground'}`} />
                    <p className="text-xs font-medium">Add Video</p>
                  </div>
                )}

                {/* Drive B-roll scan card with folder picker */}
                {(() => {
                  const driveJob = (jobs ?? []).find((j: any) => j.type === "scan_drive_broll");
                  const scanning = driveJob?.status === "running" || driveJob?.status === "pending";
                  const done = driveJob?.status === "completed";
                  const lastLog = (driveJob as any)?.logs?.split("\n").filter(Boolean).pop();
                  return (
                    <div className="mb-3 rounded-md border border-border bg-accent/20 p-2.5 space-y-2">
                      <div className="flex items-center gap-2.5">
                        <div className="h-7 w-7 rounded bg-emerald-500/10 flex items-center justify-center shrink-0">
                          <svg className="h-3.5 w-3.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-medium">Google Drive B-roll</span>
                            {done && <Badge className="text-[8px] px-1 h-3 bg-emerald-500/20 text-emerald-300 border-emerald-500/30">Scanned</Badge>}
                          </div>
                          <p className="text-[9px] text-muted-foreground leading-snug truncate">
                            {scanning
                              ? (lastLog ?? "Scanning Drive folder…")
                              : selectedDriveFolder
                                ? <span className="text-emerald-400/80">📁 {selectedDriveFolder.name}</span>
                                : "Choose a Drive folder to import B-roll from"}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-2 flex-1"
                          disabled={scanning}
                          onClick={() => {
                            setShowDrivePicker(true);
                            setDrivePickerParent([]);
                            setDriveFolders([]);
                            loadDriveFolders();
                          }}
                        >
                          <svg className="h-3 w-3 mr-1" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l.64.641H13.5A1.5 1.5 0 0115 4.5v8a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/></svg>
                          {selectedDriveFolder ? "Change folder" : "Choose folder"}
                        </Button>
                        <Button
                          size="sm"
                          className="h-6 text-[10px] px-2 flex-1 bg-emerald-600 hover:bg-emerald-500"
                          disabled={scanning || createJob.isPending || !selectedDriveFolder}
                          onClick={() => handleRunJob("scan_drive_broll", undefined, JSON.stringify({ folderId: selectedDriveFolder?.id, folderName: selectedDriveFolder?.name }))}
                        >
                          {scanning ? (
                            <><span className="inline-block h-2 w-2 rounded-full bg-white animate-pulse mr-1" />Scanning…</>
                          ) : done ? "Re-scan" : "Scan Drive"}
                        </Button>
                      </div>
                    </div>
                  );
                })()}

                {(() => {
                  type ShotKey = "talking_head" | "b_roll" | "mixed" | "unknown";
                  const ORDER: ShotKey[] = ["talking_head", "b_roll", "mixed", "unknown"];
                  const getShotType = (v: any): ShotKey => {
                    let sa: any = null;
                    try { sa = JSON.parse((v as any).sceneAnalysis ?? "{}"); } catch {}
                    const t = sa?.faceAnalysis?.shotType;
                    return (ORDER.includes(t) ? t : "unknown") as ShotKey;
                  };
                  const getScore = (v: any) => {
                    let ca: any = null;
                    try { ca = (v as any).clipAnalysis ? JSON.parse((v as any).clipAnalysis) : null; } catch {}
                    return ca?.compositeScore ?? 0;
                  };
                  const vids = videos ?? [];
                  let filtered: typeof vids = mediaSearch
                    ? vids.filter(v => v.originalName.toLowerCase().includes(mediaSearch.toLowerCase()))
                    : vids;
                  if (mediaFilterType !== "all")
                    filtered = filtered.filter(v => getShotType(v) === mediaFilterType);
                  const sorted = [...filtered].sort((a, b) => {
                    if (mediaSortBy === "duration") return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
                    if (mediaSortBy === "name") return a.originalName.localeCompare(b.originalName);
                    if (mediaSortBy === "type") return ORDER.indexOf(getShotType(a)) - ORDER.indexOf(getShotType(b));
                    return getScore(b) - getScore(a);
                  });
                  const GROUP_LABELS: Record<ShotKey, string> = {
                    talking_head: "TALK HEAD", b_roll: "B-ROLL", mixed: "MIXED", unknown: "ANDRE",
                  };
                  let lastGroup: ShotKey | null = null;
                  return (
                  <div className="space-y-1.5">
                    {sorted.length === 0 && (
                      <div className="py-8 text-center text-[10px] italic" style={{ color: "#555" }}>
                        {mediaSearch || mediaFilterType !== "all" ? "Ingen klipp matcher filteret" : "Ingen klipp lastet opp"}
                      </div>
                    )}
                    {sorted.map(video => {
                    let ca: any = null;
                    try { ca = (video as any).clipAnalysis ? JSON.parse((video as any).clipAnalysis) : null; } catch {}
                    const neural = ca?.neural ?? null;
                    const isNeuralExpanded = expandedNeuralVideoId === video.id;
                    const sType = mediaGrouped ? getShotType(video) : null;
                    const showGrpHeader = mediaGrouped && sType !== null && sType !== lastGroup;
                    if (mediaGrouped && sType !== null) lastGroup = sType;
                    return (
                    <Fragment key={video.id}>
                      {showGrpHeader && sType && (
                        <div className="flex items-center gap-1.5 px-1 pt-2 pb-0.5">
                          <div className="h-px flex-1" style={{ background: "#333" }} />
                          <span className="text-[7px] font-bold uppercase tracking-widest" style={{ color: "#505050" }}>
                            {GROUP_LABELS[sType]}
                          </span>
                          <div className="h-px flex-1" style={{ background: "#333" }} />
                        </div>
                      )}
                    <div className="rounded-md overflow-hidden transition-all group/card hover:ring-1 hover:ring-primary/40 cursor-grab active:cursor-grabbing"
                      style={{ background: "#232323", border: "1px solid #3a3a3a" }}
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData("cutai/videoId", video.id);
                        e.dataTransfer.setData("cutai/videoName", video.originalName ?? "");
                        e.dataTransfer.effectAllowed = "copy";
                      }}>
                      {/* ── Filmstrip thumbnail ── */}
                      <div
                        className="relative cursor-pointer group overflow-hidden"
                        style={{ aspectRatio: "16/9", background: "#111" }}
                        onClick={() => setPreviewVideoId(video.id)}
                      >
                        <img
                          src={`${API_BASE}/videos/${video.id}/thumbnail.jpg`}
                          alt={video.originalName}
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                        {/* Filmstrip sprocket holes top and bottom */}
                        <div className="absolute top-0 left-0 right-0 h-3 filmstrip-holes bg-black pointer-events-none opacity-80" />
                        <div className="absolute bottom-0 left-0 right-0 h-3 filmstrip-holes bg-black pointer-events-none opacity-80" />
                        {/* Hover play overlay */}
                        <div className="absolute inset-3 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity rounded-sm">
                          <div className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                            <Play className="h-4 w-4 text-white fill-white ml-0.5" />
                          </div>
                        </div>
                        {/* Duration badge */}
                        {video.durationSeconds != null && (
                          <div className="absolute bottom-3.5 right-1.5 text-[8px] bg-black/80 text-white px-1 py-0.5 rounded font-mono tabular-nums pointer-events-none">
                            {Math.floor(video.durationSeconds / 60)}:{String(Math.round(video.durationSeconds % 60)).padStart(2,"0")}
                          </div>
                        )}
                        {/* Shot type badge top-right */}
                        {(() => {
                          let sa: any = null;
                          try { sa = JSON.parse((video as any).sceneAnalysis ?? "{}"); } catch {}
                          const fa = sa?.faceAnalysis;
                          if (!fa) return null;
                          const colors: Record<string, string> = {
                            talking_head: "#1d4ed8cc",
                            b_roll:       "#15803dcc",
                            mixed:        "#b45309cc",
                          };
                          const labels: Record<string, string> = {
                            talking_head: "TALK",
                            b_roll:       "B-ROLL",
                            mixed:        "MIX",
                          };
                          return (
                            <div className="absolute top-3 left-1.5 text-[7px] font-bold text-white px-1 py-0.5 rounded pointer-events-none"
                              style={{ background: colors[fa.shotType] ?? "#52525bcc", letterSpacing: "0.05em" }}>
                              {labels[fa.shotType] ?? fa.shotType?.toUpperCase()}
                            </div>
                          );
                        })()}
                        {/* Status badge for transcoding */}
                        {video.status === "transcoding" && (
                          <div className="absolute inset-3 flex items-center justify-center bg-black/60">
                            <div className="flex items-center gap-1.5 text-[9px] text-amber-400 font-medium">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                              Downscaling 4K→1080p
                            </div>
                          </div>
                        )}
                      </div>
                      {/* ── Metadata row below thumbnail ── */}
                      <div className="px-2 pt-1.5 pb-0.5">
                        <p className="text-[11px] font-medium truncate text-zinc-200">{video.originalName}</p>
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          {video.status !== "transcoding" && (
                            <Badge variant="secondary" className="text-[7px] px-1 h-3">{video.status}</Badge>
                          )}
                          {video.height != null && video.height > 1080 && video.status !== "transcoding" && (
                            <span className="text-[7px] text-orange-400 font-semibold">4K</span>
                          )}
                        </div>
                      </div>
                      {/* ── Analysis badges + neural toggle ── */}
                      <div className="px-2 pb-1.5">
                          <div className="flex items-center gap-1 mt-0 flex-wrap">
                            {/* Face analysis badges */}
                            {(() => {
                              let sa: any = null;
                              try { sa = JSON.parse((video as any).sceneAnalysis ?? "{}"); } catch {}
                              const fa = sa?.faceAnalysis;
                              if (!fa) return null;
                              const shotColors: Record<string, string> = {
                                talking_head: "text-blue-400",
                                b_roll:       "text-emerald-400",
                                mixed:        "text-amber-400",
                              };
                              const continuityGaps = (fa.subjectSegments ?? []).filter((s: any) => !s.subjectPresent).length;
                              return (
                                <>
                                  <span className={`text-[7px] font-bold uppercase ${shotColors[fa.shotType] ?? "text-zinc-400"}`}>
                                    {fa.shotType?.replace("_", "-")}
                                  </span>
                                  <span className="text-[7px] text-zinc-500">{fa.framing}</span>
                                  <span className="text-[7px] text-zinc-500">face {Math.round((fa.facePresencePct ?? 0) * 100)}%</span>
                                  {continuityGaps > 0 && (
                                    <span className="text-[7px] text-rose-400">{continuityGaps} exit{continuityGaps !== 1 ? "s" : ""}</span>
                                  )}
                                </>
                              );
                            })()}
                            {/* Reaction detection badges */}
                            {(() => {
                              let sa: any = null;
                              try { sa = JSON.parse((video as any).sceneAnalysis ?? "{}"); } catch {}
                              const ra = sa?.reactionAnalysis;
                              if (!ra || ra.totalReactions === 0) return null;
                              const reactionColors: Record<string, string> = {
                                laughing:  "text-yellow-400",
                                shocked:   "text-cyan-400",
                                angry:     "text-red-400",
                                disgusted: "text-orange-400",
                                fearful:   "text-purple-400",
                                nodding:   "text-green-400",
                              };
                              const byType: Record<string, number> = {};
                              for (const m of ra.moments ?? []) byType[m.type] = (byType[m.type] ?? 0) + 1;
                              return (
                                <>
                                  {Object.entries(byType).slice(0, 3).map(([type, count]) => (
                                    <span key={type} className={`text-[7px] font-medium ${reactionColors[type] ?? "text-zinc-400"}`}>
                                      {type.slice(0, 4)}×{count}
                                    </span>
                                  ))}
                                </>
                              );
                            })()}
                            {ca && (() => {
                              const score = Math.round((ca.compositeScore ?? 0.5) * 100);
                              const scoreColor = score >= 75 ? "text-green-400" : score >= 50 ? "text-yellow-400" : "text-red-400";
                              const tags = (ca.tags ?? []).slice(0, 2) as string[];
                              return (
                                <>
                                  <span className={`text-[8px] font-bold ${scoreColor}`}>{score}/100</span>
                                  {ca.clipType && <span className="text-[7px] text-violet-400 uppercase font-medium">{ca.clipType}</span>}
                                  {tags.map((tag: string) => (
                                    <span key={tag} className="text-[7px] bg-violet-500/10 text-violet-300 px-0.5 rounded">{tag.replace(/_/g, " ")}</span>
                                  ))}
                                  {ca.isUsable === false && <span className="text-[7px] text-red-400 font-bold">UNUSABLE</span>}
                                </>
                              );
                            })()}
                          </div>
                        {neural && (
                          <button
                            className={`shrink-0 text-[7px] font-bold px-1.5 py-0.5 rounded border transition-colors ${isNeuralExpanded ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'bg-violet-500/5 border-violet-500/20 text-violet-400 hover:bg-violet-500/15'}`}
                            onClick={e => { e.stopPropagation(); setExpandedNeuralVideoId(isNeuralExpanded ? null : video.id); }}
                          >
                            NEURAL
                          </button>
                        )}
                      </div>
                      {neural && isNeuralExpanded && (
                        <div className="px-2 pb-2 border-t border-border/50 pt-2">
                          <p className="text-[8px] font-bold text-violet-400 uppercase tracking-wider mb-1.5">Neural Analysis Scores</p>
                          {([
                            { label: "Visual Quality", value: neural.visual_quality,  color: "bg-blue-500" },
                            { label: "Hook Score",     value: neural.hook_score,      color: "bg-amber-500" },
                            { label: "Emotion Score",  value: neural.emotion_score,   color: "bg-rose-500" },
                            { label: "Diversity",      value: neural.diversity_score, color: "bg-emerald-500" },
                            { label: "Audio Valence",  value: neural.audio_valence,   color: "bg-violet-500" },
                            { label: "Audio Arousal",  value: neural.audio_arousal,   color: "bg-pink-500" },
                          ].filter(m => m.value != null)).map(metric => (
                            <div key={metric.label} className="flex items-center gap-1.5 mb-1">
                              <span className="text-[8px] text-muted-foreground w-24 shrink-0">{metric.label}</span>
                              <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                                <div className={`h-full ${metric.color} rounded-full transition-all`} style={{ width: `${Math.round((metric.value ?? 0) * 100)}%` }} />
                              </div>
                              <span className="text-[8px] font-mono text-muted-foreground w-6 text-right">{Math.round((metric.value ?? 0) * 100)}</span>
                            </div>
                          ))}
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {neural.detected_shot_count != null && (
                              <span className="text-[7px] bg-slate-500/15 text-slate-300 px-1 rounded">{neural.detected_shot_count} shots</span>
                            )}
                            {neural.scene_count != null && (
                              <span className="text-[7px] bg-slate-500/10 text-slate-400 px-1 rounded">~{neural.scene_count} scenes</span>
                            )}
                            {neural.has_faces && (
                              <span className="text-[7px] bg-sky-500/15 text-sky-300 px-1 rounded">faces detected</span>
                            )}
                            {neural.has_speech && (
                              <span className="text-[7px] bg-green-500/15 text-green-300 px-1 rounded">speech</span>
                            )}
                            {neural.dominant_emotion && (
                              <span className="text-[7px] bg-rose-500/10 text-rose-300 px-1 rounded capitalize">{neural.dominant_emotion}</span>
                            )}
                            {neural.face_valence != null && (
                              <span className={`text-[7px] px-1 rounded ${neural.face_valence > 0.5 ? 'bg-green-500/15 text-green-300' : neural.face_valence < 0.2 ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}>
                                face valence {Math.round(neural.face_valence * 100)}%
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    </Fragment>
                    );
                  })}
                  </div>
                  );
                })()}
              </ScrollArea>
            </TabsContent>
            
            <TabsContent value="ai" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-3">
                <div className="space-y-1.5">
                  {/* ── FCP-style Pipeline ─────────────────────────────────── */}
                  {(() => {
                    // Script-mode badge
                    const scriptDriven = project?.manuscriptAnalysis && (() => { try { const m = JSON.parse(project.manuscriptAnalysis); return m.totalScenes > 0; } catch { return false; } })();

                    const TOOLS = [
                      { step: 1,  id: 'generate_proxy',          icon: MonitorPlay,    label: 'Generate Proxy',           color: '#94a3b8', phase: 'FORBERED',  done: (videos ?? []).some((v: any) => v.proxyPath),                                                        desc: 'FFmpeg 720p web-ready proxy — enables fast playback' },
                      { step: 2,  id: 'transcribe',               icon: FileText,       label: 'Transcribe (Whisper)',      color: '#60a5fa', phase: 'FORBERED',  done: (jobs ?? []).some((j: any) => j.type === 'transcribe' && j.status === 'completed'),                 desc: 'Speech-to-text with word-level timestamps' },
                      { step: 3,  id: 'generate_manuscript',      icon: ScrollText,     label: 'Generate Manuscript',      color: '#fbbf24', phase: 'FORBERED',  done: (jobs ?? []).some((j: any) => j.type === 'generate_manuscript' && j.status === 'completed') || !!project?.manuscript, desc: 'AI writes narrative script from transcript' },
                      { step: 4,  id: 'detect_speakers',          icon: Users,          label: 'Speaker Detection',        color: '#38bdf8', phase: 'FORBERED',  done: (jobs ?? []).some((j: any) => j.type === 'detect_speakers' && j.status === 'completed'),            desc: 'Audio-based speaker diarization' },
                      { step: 5,  id: 'diarize_speakers_v2',      icon: Users,          label: 'Speaker Diarize v2',       color: '#fda4af', phase: 'FORBERED',  done: (jobs ?? []).some((j: any) => j.type === 'diarize_speakers_v2' && j.status === 'completed'),        desc: 'Offline MFCC clustering — no API needed' },
                      { step: 6,  id: 'detect_scenes_visual',     icon: Clapperboard,   label: 'Scene Detection (CNN)',    color: '#fb923c', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'detect_scenes_visual' && j.status === 'completed'),       desc: 'MobileNetV2 semantic cosine dissimilarity' },
                      { step: 7,  id: 'analyze_faces',            icon: ScanEye,        label: 'Face & Shot Type',         color: '#fb7185', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'analyze_faces' && j.status === 'completed'),               desc: 'Haar cascade → talking_head / b_roll / mixed' },
                      { step: 8,  id: 'detect_reactions',         icon: Theater,        label: 'Reaction Detection',       color: '#f472b6', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'detect_reactions' && j.status === 'completed'),            desc: 'HSEmotion ONNX — laughing, shocked, nodding' },
                      { step: 9,  id: 'analyze_scenes',           icon: FileVideo,      label: 'Scene Understanding',      color: '#f97316', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'analyze_scenes' && j.status === 'completed'),             desc: 'GPT-4o visual content tagging per scene' },
                      { step: 10, id: 'detect_beats',             icon: AudioWaveform,  label: 'Beat Detection',           color: '#a78bfa', phase: 'ANALYSER',  done: (beatMap?.beats?.length ?? 0) > 0,                                                                  desc: 'BPM + beat grid for music sync' },
                      { step: 11, id: 'analyze_music',            icon: Music,          label: 'Music Analysis',           color: '#ec4899', phase: 'ANALYSER',  done: !!musicAnalysis,                                                                                    desc: 'Mood, energy, emotional arc' },
                      { step: 12, id: 'detect_speech',            icon: Mic2,           label: 'Speech & Balance',         color: '#60a5fa', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'detect_speech' && j.status === 'completed'),              desc: 'FFmpeg speech detection — duck levels' },
                      { step: 13, id: 'detect_quality_signals',   icon: ScanEye,        label: 'Frame Quality',            color: '#eab308', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'detect_quality_signals' && j.status === 'completed'),     desc: 'Blur, shake, overexposure (FFmpeg)' },
                      { step: 14, id: 'detect_action_boundaries', icon: Activity,       label: 'Action Boundaries',        color: '#fbbf24', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'detect_action_boundaries' && j.status === 'completed'),  desc: 'Farneback optical flow settling points' },
                      { step: 15, id: 'check_av_correspondence',  icon: Link2,          label: 'AV Correspondence',        color: '#a78bfa', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'check_av_correspondence' && j.status === 'completed'),   desc: 'Flags audio/visual semantic mismatches' },
                      { step: 16, id: 'check_consistency',        icon: Layers,         label: 'Consistency Check',        color: '#a3e635', phase: 'ANALYSER',  done: (jobs ?? []).some((j: any) => j.type === 'check_consistency' && j.status === 'completed'),         desc: 'Color, audio, caption consistency 0–100' },
                      { step: 17, id: 'analyze_clips',            icon: BarChart2,      label: 'Highlight Scoring',        color: '#c084fc', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'analyze_clips' && j.status === 'completed'),              desc: 'Hook / emotion / quality scoring' },
                      { step: 18, id: 'extract_features',         icon: Cpu,            label: 'Feature Extraction (ML)',  color: '#86efac', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'extract_features' && j.status === 'completed'),           desc: 'clip_score = hook + emotion + clarity' },
                      { step: 19, id: 'semantic_tag',             icon: Sparkles,       label: 'Gemini Semantic Tags',     color: '#7dd3fc', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'semantic_tag' && j.status === 'completed'),               desc: 'Gemini 2.5 Flash — 3 keyframes per clip' },
                      { step: 20, id: 'embed_clips',              icon: Network,        label: 'Clip Embeddings',          color: '#818cf8', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'embed_clips' && j.status === 'completed'),                desc: '1536-dim embeddings — diversity penalty' },
                      { step: 21, id: 'score_cut_points',         icon: GitBranch,      label: 'Cut Rhythm Scoring',       color: '#fde68a', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'score_cut_points' && j.status === 'completed'),          desc: 'Beat-grid × speech boundary scoring' },
                      { step: 22, id: 'rank_clips_ai',            icon: TrendingUpDown, label: 'AI Clip Ranking',          color: '#e879f9', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'rank_clips_ai' && j.status === 'completed'),             desc: 'Applies learned preferences' },
                      { step: 23, id: 'auto_assemble',            icon: Layers,         label: 'Auto-Assemble',            color: '#4d9cf8', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'auto_assemble' && j.status === 'completed'),             desc: 'Transcript-driven timeline build' },
                      { step: 24, id: 'generate_edit_plan',       icon: Wand2,          label: 'Generate Edit Plan',       color: '#4d9cf8', phase: 'MONTER',    done: (segments?.length ?? 0) > 0,                                                                        desc: 'Claude AI creates timeline — uses manuscript' },
                      { step: 25, id: 'match_broll',              icon: Layers,         label: 'Match B-Roll',             color: '#38bdf8', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'match_broll' && j.status === 'completed'),               desc: 'Auto-insert B-roll between A-roll speech' },
                      { step: 26, id: 'match_broll_v2',           icon: Network,        label: 'B-Roll Semantic v2',       color: '#818cf8', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'match_broll_v2' && j.status === 'completed'),            desc: 'CLIP-style embedding cosine match' },
                      { step: 27, id: 'enforce_shot_diversity',   icon: Shuffle,        label: 'Shot Diversity',           color: '#2dd4bf', phase: 'MONTER',    done: (jobs ?? []).some((j: any) => j.type === 'enforce_shot_diversity' && j.status === 'completed'),    desc: 'Prevents 3+ consecutive same-angle cuts' },
                      { step: 28, id: 'enhance_audio',            icon: Ear,            label: 'AI Enhance Audio',         color: '#22d3ee', phase: 'FORBEDRE',  done: !!audioEnhancementPlan,                                                                             desc: 'Loudness, noise, voice EQ' },
                      { step: 29, id: 'generate_captions',        icon: Type,           label: 'Auto-Captions',            color: '#facc15', phase: 'FORBEDRE',  done: (jobs ?? []).some((j: any) => j.type === 'generate_captions' && j.status === 'completed'),         desc: 'Transcript → captions on all segments' },
                      { step: 30, id: 'trim_silence',             icon: Scissors,       label: 'Trim Silence',             color: '#a1a1aa', phase: 'FORBEDRE',  done: (jobs ?? []).some((j: any) => j.type === 'trim_silence' && j.status === 'completed'),              desc: 'ffmpeg silencedetect leading/trailing trim' },
                      { step: 31, id: 'suggest_broll',            icon: Layers,         label: 'B-Roll Suggestions',       color: '#38bdf8', phase: 'FORBEDRE',  done: (jobs ?? []).some((j: any) => j.type === 'suggest_broll' && j.status === 'completed'),             desc: 'Claude tags best B-roll candidates' },
                      { step: 32, id: 'smart_reframe',            icon: Crop,           label: 'Smart Reframe 9:16',       color: '#2dd4bf', phase: 'FORBEDRE',  done: (jobs ?? []).some((j: any) => j.type === 'smart_reframe' && j.status === 'completed'),            desc: 'Face-centered portrait crop per segment' },
                      { step: 33, id: 'suggest_graphics',         icon: Sparkles,       label: 'Graphic Overlays',         color: '#c084fc', phase: 'FORBEDRE',  done: (jobs ?? []).some((j: any) => j.type === 'suggest_graphics' && j.status === 'completed'),         desc: 'Claude Vision — headlines, lower thirds, CTA' },
                      { step: 34, id: 'suggest_music',            icon: Music2,         label: 'Music Suggestions',        color: '#f472b6', phase: 'FORBEDRE',  done: (jobs ?? []).some((j: any) => j.type === 'suggest_music' && j.status === 'completed'),            desc: 'Genre, BPM, royalty-free search keywords' },
                      { step: 35, id: 'suggest_pacing',           icon: Gauge,          label: 'Pacing Analysis',          color: '#22d3ee', phase: 'FORBEDRE',  done: !!(project?.pacingSuggestions),                                                                     desc: 'Rhythm, CPM, energy arc recommendations' },
                      { step: 36, id: 'render',                   icon: VideoIcon,      label: 'Render (FFmpeg)',           color: '#f87171', phase: 'FULLFØR',   done: renderStatus?.ready === true,                                                                        desc: 'Final MP4 with music ducking' },
                      { step: 37, id: 'quality_check',            icon: Gauge,          label: 'Quality Check',            color: '#34d399', phase: 'FULLFØR',   done: !!qcResult,                                                                                          desc: 'Playback, audio, codec & loudness QC' },
                      { step: 38, id: 'apply_edit',               icon: CheckCircle2,   label: 'Apply & Finalize',         color: '#22c55e', phase: 'FULLFØR',   done: project?.status === 'review' || project?.status === 'exported',                                    desc: 'Lock timeline, ready for export' },
                      { step: 39, id: 'learn_from_edit',          icon: BrainCircuit,   label: 'Learn from Edit',          color: '#2dd4bf', phase: 'FULLFØR',   done: (jobs ?? []).some((j: any) => j.type === 'learn_from_edit' && j.status === 'completed'),           desc: 'AI trains on this edit for future projects' },
                    ] as const;

                    const PHASE_META: Record<string, { accent: string; emoji: string }> = {
                      FORBERED:  { accent: '#4d9cf8', emoji: '▶' },
                      ANALYSER:  { accent: '#fb923c', emoji: '◈' },
                      MONTER:    { accent: '#a78bfa', emoji: '◆' },
                      FORBEDRE:  { accent: '#34d399', emoji: '◉' },
                      FULLFØR:   { accent: '#f87171', emoji: '◀' },
                    };

                    const totalDone = TOOLS.filter(t => t.done).length;
                    const pct = Math.round((totalDone / TOOLS.length) * 100);

                    let lastPhase: string | null = null;

                    return (
                      <>
                        {/* ── Progress header ─────────────────────────── */}
                        <div className="mb-2 px-0.5">
                          {scriptDriven && (
                            <div className="flex items-center gap-1.5 mb-2 px-2 py-1 rounded" style={{ background: "#2a220a", border: "1px solid #6b4e00" }}>
                              <BookOpen className="h-2.5 w-2.5" style={{ color: "#fbbf24" }} />
                              <span className="text-[8px] font-medium" style={{ color: "#fbbf24" }}>Script-driven — Edit Plan følger manuskriptet</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#555" }}>AI Pipeline</span>
                            <span className="text-[8px] font-mono" style={{ color: totalDone === TOOLS.length ? "#34d399" : "#4d9cf8" }}>
                              {totalDone}/{TOOLS.length} · {pct}%
                            </span>
                          </div>
                          <div className="h-1 rounded-full mb-2" style={{ background: "#222" }}>
                            <div className="h-1 rounded-full transition-all duration-500"
                              style={{ width: `${pct}%`, background: "linear-gradient(90deg, #4d9cf8 0%, #a78bfa 50%, #34d399 100%)" }} />
                          </div>
                          {/* Auto-Assemble CTA */}
                          <button
                            className="w-full h-8 rounded flex items-center justify-center gap-2 text-[10px] font-semibold transition-all disabled:opacity-40"
                            style={{ background: "linear-gradient(135deg, #1a3a5c 0%, #1e1048 100%)", border: "1px solid #2a4a7a" }}
                            disabled={(jobs ?? []).some((j: any) => j.status === 'running') || (videos?.length ?? 0) === 0}
                            onClick={() => handleRunJob('auto_assemble')}
                          >
                            {(jobs ?? []).some((j: any) => j.type === 'auto_assemble' && j.status === 'running')
                              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "#4d9cf8" }} /><span style={{ color: "#4d9cf8" }}>Setter sammen…</span></>
                              : <><Zap className="h-3.5 w-3.5" style={{ color: "#4d9cf8" }} /><span style={{ color: "#4d9cf8" }}>Auto-Assemble nå</span><Bot className="h-3 w-3 ml-1" style={{ color: "#4d9cf8", opacity: 0.5 }} /></>
                            }
                          </button>
                        </div>

                        {/* ── Phase-grouped tool rows ──────────────────── */}
                        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid #2a2a2a" }}>
                          {TOOLS.map((tool) => {
                            const pm = PHASE_META[tool.phase] ?? { accent: "#666", emoji: "·" };
                            const showPhaseHdr = tool.phase !== lastPhase;
                            lastPhase = tool.phase;
                            const running = isJobRunning(tool.id);
                            const phaseDoneCount = TOOLS.filter(t => t.phase === tool.phase && t.done).length;
                            const phaseTotal = TOOLS.filter(t => t.phase === tool.phase).length;

                            return (
                              <Fragment key={tool.id}>
                                {showPhaseHdr && (
                                  <div className="flex items-center gap-2 px-2 py-1" style={{ background: "#1a1a1a", borderBottom: "1px solid #252525", borderTop: lastPhase !== tool.phase ? "1px solid #252525" : undefined }}>
                                    <div className="h-3 w-0.5 rounded-full shrink-0" style={{ background: pm.accent }} />
                                    <span className="text-[7px] font-black uppercase tracking-[0.15em] flex-1" style={{ color: pm.accent }}>{tool.phase}</span>
                                    <span className="text-[7px] font-mono" style={{ color: phaseDoneCount === phaseTotal ? pm.accent : "#444" }}>{phaseDoneCount}/{phaseTotal}</span>
                                  </div>
                                )}
                                {/* Compact tool row */}
                                <div
                                  className="flex items-center gap-2 px-2.5 transition-colors group"
                                  style={{
                                    background: running ? "#0f1f33" : tool.done ? "#101a12" : "transparent",
                                    borderBottom: "1px solid #1c1c1c",
                                    minHeight: 30,
                                  }}
                                >
                                  {/* Status circle */}
                                  {running ? (
                                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" style={{ color: "#4d9cf8" }} />
                                  ) : tool.done ? (
                                    <CheckCircle2 className="h-3 w-3 shrink-0" style={{ color: "#4ade80" }} />
                                  ) : (
                                    <div className="h-3 w-3 rounded-full shrink-0 flex items-center justify-center text-[5px] font-bold" style={{ background: "#252525", color: "#555" }}>
                                      {tool.step}
                                    </div>
                                  )}
                                  {/* Tool icon */}
                                  <tool.icon className="h-2.5 w-2.5 shrink-0" style={{ color: tool.done ? "#4ade80" : tool.color, opacity: tool.done ? 0.8 : 1 }} />
                                  {/* Label */}
                                  <span className="flex-1 text-[10px] truncate" style={{ color: tool.done ? "#4ade80" : running ? "#7dd3fc" : "#aaa" }}
                                    title={tool.desc}>
                                    {tool.label}
                                    {tool.id === 'generate_edit_plan' && selectedStyleId && (
                                      <span className="ml-1 text-[7px] px-1 rounded" style={{ background: "#2d1b69", color: "#a78bfa" }}>
                                        {selectedStyleName?.slice(0, 10)}
                                      </span>
                                    )}
                                  </span>
                                  {/* Run / Re-run button */}
                                  <button
                                    className="shrink-0 text-[8px] px-1.5 h-5 rounded font-medium transition-all disabled:opacity-30"
                                    style={{
                                      background: running ? "transparent"
                                        : tool.id === 'generate_edit_plan' ? (selectedStyleId ? "#4a1d96" : "#1e3a5f")
                                        : tool.id === 'render' ? "#3b0d0d"
                                        : tool.id === 'apply_edit' ? "#14291a"
                                        : tool.done ? "#1a1a1a"
                                        : "#252525",
                                      border: `1px solid ${running ? "#1d4ed8" : tool.done ? "#333" : tool.id === 'generate_edit_plan' ? "#7c3aed" : tool.id === 'render' ? "#9f1239" : "#3a3a3a"}`,
                                      color: running ? "#4d9cf8" : tool.done ? "#555" : tool.id === 'generate_edit_plan' ? "#c4b5fd" : tool.id === 'render' ? "#fca5a5" : "#aaa",
                                    }}
                                    disabled={running || (videos?.length ?? 0) === 0}
                                    onClick={() => {
                                      if (tool.id === 'generate_edit_plan') setShowStoryPrefs(true);
                                      else if (tool.id === 'generate_captions') handleRunJob(tool.id as any, undefined, JSON.stringify({ captionStyle }));
                                      else handleRunJob(tool.id as any, undefined, tool.id === 'render' ? JSON.stringify({ format: renderFormat }) : undefined);
                                    }}
                                  >
                                    {running ? '…'
                                      : tool.done
                                        ? (tool.id === 'render' ? `${renderStatus?.sizeMB ?? 0}MB ↻` : tool.id === 'quality_check' ? `${qcResult?.score ?? 0}/100` : '↻')
                                        : tool.id === 'apply_edit' ? 'Lock'
                                        : tool.id === 'render' ? 'Render'
                                        : tool.id === 'quality_check' ? 'Check'
                                        : tool.id === 'generate_edit_plan' ? '✦ Plan'
                                        : 'Run'
                                    }
                                  </button>
                                </div>
                                {/* Inline extras for specific tools */}
                                {tool.id === 'generate_captions' && (
                                  <div className="flex gap-1 px-8 pb-1.5" style={{ background: "#101010", borderBottom: "1px solid #1c1c1c" }}>
                                    {(['subtitle', 'title', 'lower_third', 'kinetic'] as const).map(s => (
                                      <button key={s} onClick={() => setCaptionStyle(s)}
                                        className="text-[7px] px-1 py-0.5 rounded transition-colors"
                                        style={{ background: captionStyle === s ? "#332a00" : "#1a1a1a", border: `1px solid ${captionStyle === s ? "#854d0e" : "#2a2a2a"}`, color: captionStyle === s ? "#fbbf24" : "#555" }}>
                                        {s.replace(/_/g, " ")}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {tool.id === 'render' && (
                                  <div className="flex gap-1 px-8 pb-1.5" style={{ background: "#101010", borderBottom: "1px solid #1c1c1c" }}>
                                    <button onClick={() => setRenderFormat('horizontal')}
                                      className="flex-1 text-[7px] py-0.5 rounded transition-colors"
                                      style={{ background: renderFormat === 'horizontal' ? "#1e3a5f" : "#1a1a1a", border: `1px solid ${renderFormat === 'horizontal' ? "#1d4ed8" : "#2a2a2a"}`, color: renderFormat === 'horizontal' ? "#60a5fa" : "#555" }}>
                                      ⬛ 16:9 HD
                                    </button>
                                    <button onClick={() => setRenderFormat('vertical')}
                                      className="flex-1 text-[7px] py-0.5 rounded transition-colors"
                                      style={{ background: renderFormat === 'vertical' ? "#0e2a2a" : "#1a1a1a", border: `1px solid ${renderFormat === 'vertical' ? "#0e7490" : "#2a2a2a"}`, color: renderFormat === 'vertical' ? "#22d3ee" : "#555" }}>
                                      ▬ 9:16 Reel
                                    </button>
                                    {segments && segments.filter(s => s.included).length > 0 && (() => {
                                      const totalSec = segments.filter(s => s.included).reduce((acc, s) => acc + (s.endTime - s.startTime), 0);
                                      return <span className="text-[7px] self-center ml-1" style={{ color: "#444" }}>~{totalSec.toFixed(0)}s</span>;
                                    })()}
                                  </div>
                                )}
                              </Fragment>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}

                  {/* Self-learning Feedback Loop Panel */}
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <div className="flex items-center gap-1.5 mb-2">
                      <BrainCircuit className="h-3 w-3 text-teal-400" />
                      <span className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider">Self-Learning Loop</span>
                      {trainSignals?.learningActive ? (
                        <span className="ml-auto flex items-center gap-1 text-[8px] bg-teal-500/10 text-teal-400 border border-teal-500/20 rounded px-1.5 py-0.5">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-teal-400" />
                          </span>
                          Learning
                        </span>
                      ) : (
                        <span className="ml-auto text-[8px] text-zinc-600">Inactive</span>
                      )}
                    </div>

                    {/* Per-project signals + auto-learn counter */}
                    <div className="bg-zinc-900/60 border border-white/5 rounded-md p-2 mb-2">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-[8px] text-zinc-500">Session signals</p>
                        {lastAutoLearnAtEarly > 0 && (
                          <span className="text-[7px] bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-400 rounded px-1 py-0.5">
                            Updated at {lastAutoLearnAtEarly} edits
                          </span>
                        )}
                      </div>
                      <div className="flex items-end gap-2">
                        <div>
                          <div className="text-[17px] font-bold text-teal-400 leading-none">{trainSignals?.totalEdits ?? 0}</div>
                          <div className="text-[8px] text-zinc-600 mt-0.5">edits captured</div>
                        </div>
                        {trainSignals?.totalEdits ? (
                          <div className="flex flex-wrap gap-1 pb-0.5">
                            {Object.entries(trainSignals.byType).map(([type, count]) => (
                              <span key={type} className="text-[7px] bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded px-1 py-0.5">
                                {type.replace(/_/g, " ")}: {count}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[8px] text-zinc-600 italic pb-0.5">Edit or trim clips to start training</p>
                        )}
                      </div>
                      {/* Next auto-learn threshold hint */}
                      {(() => {
                        const current = trainSignals?.totalEdits ?? 0;
                        const next = [3,10,25,50,100].find(t => t > current);
                        return next ? (
                          <div className="mt-2">
                            <div className="flex justify-between text-[7px] text-zinc-600 mb-0.5">
                              <span>Auto-learn at {next} edits</span>
                              <span>{current}/{next}</span>
                            </div>
                            <div className="h-0.5 rounded-full bg-white/5">
                              <div className="h-0.5 rounded-full bg-teal-500 transition-all" style={{ width: `${Math.min(100, (current / next) * 100)}%` }} />
                            </div>
                          </div>
                        ) : null;
                      })()}
                    </div>

                    {/* What the AI just learned — shown after auto-learn fires */}
                    {learnedRulesEarly.length > 0 && (
                      <div className="bg-fuchsia-500/5 border border-fuchsia-500/15 rounded-md p-2 mb-2">
                        <p className="text-[8px] font-semibold text-fuchsia-400 mb-1.5">✦ Model just updated</p>
                        <div className="space-y-1">
                          {learnedRulesEarly.map((rule, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                              <span className={`text-[8px] font-bold ${rule.direction === "prefer" ? "text-teal-400" : rule.direction === "avoid" ? "text-red-400" : "text-zinc-400"}`}>
                                {rule.direction === "prefer" ? "↑" : rule.direction === "avoid" ? "↓" : "~"}
                              </span>
                              <span className="text-[8px] text-zinc-300 flex-1 truncate">{rule.label}</span>
                              <span className={`text-[7px] shrink-0 ${rule.delta > 0 ? "text-teal-400" : "text-red-400"}`}>
                                {rule.delta > 0 ? "+" : ""}{Math.round(rule.delta * 100)}%
                              </span>
                            </div>
                          ))}
                        </div>
                        <p className="text-[7px] text-zinc-600 mt-1.5 italic">Applied to all future edit plans for this format</p>
                      </div>
                    )}

                    <p className="text-[8px] text-zinc-600 leading-relaxed mb-2">
                      Every clip you keep, trim, or remove is recorded. At 3, 10, and 25 edits the model auto-updates — no manual step needed.
                    </p>

                    {/* Live learned preferences — from auto-learn or model-intelligence */}
                    {(topPreferencesEarly.length > 0 || (modelIntelligence?.topPreferences?.length ?? 0) > 0) && (
                      <div className="space-y-1 mb-2">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[8px] text-zinc-500">Learned clip preferences</p>
                          {topPreferencesEarly.length > 0 && (
                            <span className="text-[7px] bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded px-1 py-0.5">injected into next plan ✓</span>
                          )}
                        </div>
                        {(topPreferencesEarly.length > 0 ? topPreferencesEarly : modelIntelligence?.topPreferences ?? []).slice(0, 6).map((pref: any, i: number) => {
                          const rate = pref.selectionRate ?? 0.5;
                          const isPrefer = rate >= 0.70;
                          const isAvoid = rate <= 0.35;
                          return (
                            <div key={i} className="flex items-center gap-1.5">
                              <span className={`text-[8px] w-3 shrink-0 ${isPrefer ? "text-teal-400" : isAvoid ? "text-red-400" : "text-zinc-500"}`}>
                                {isPrefer ? "✓" : isAvoid ? "✗" : "·"}
                              </span>
                              <div className="h-1 rounded-full bg-white/5 flex-1 max-w-[70px]">
                                <div className={`h-1 rounded-full ${isPrefer ? "bg-teal-500" : isAvoid ? "bg-red-500" : "bg-zinc-600"}`}
                                  style={{ width: `${Math.round(rate * 100)}%` }} />
                              </div>
                              <span className="text-[8px] text-zinc-400 truncate max-w-[90px]">{pref.label ?? pref.key}</span>
                              <span className="text-[7px] text-zinc-600 ml-auto shrink-0">{Math.round(rate * 100)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Global model stats */}
                    <div className="grid grid-cols-3 gap-1.5 mb-2">
                      <div className="bg-card/50 border border-border rounded p-1.5 text-center">
                        <div className="text-[12px] font-bold text-teal-400">{modelIntelligence?.totalTrainingExamples ?? 0}</div>
                        <div className="text-[7px] text-muted-foreground">Total Edits</div>
                      </div>
                      <div className="bg-card/50 border border-border rounded p-1.5 text-center">
                        <div className="text-[12px] font-bold text-fuchsia-400">{modelIntelligence?.totalLearnedPrefs ?? 0}</div>
                        <div className="text-[7px] text-muted-foreground">Learned Prefs</div>
                      </div>
                      <div className="bg-card/50 border border-border rounded p-1.5 text-center">
                        <div className="text-[12px] font-bold text-yellow-400">{modelIntelligence?.totalTrainingPairs ?? 0}</div>
                        <div className="text-[7px] text-muted-foreground">Training Pairs</div>
                      </div>
                    </div>
                  </div>

                  {/* ── #46–#55 AI Edit Intelligence Panel ────────────────────── */}
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <button
                      className="w-full flex items-center justify-between text-[9px] uppercase font-bold text-muted-foreground tracking-wider mb-2 hover:text-violet-400 transition-colors"
                      onClick={() => setShowIntelligence(v => !v)}
                    >
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="h-3 w-3 text-violet-400" />
                        AI Edit Intelligence
                        <span className="text-[7px] bg-violet-500/10 border border-violet-500/20 text-violet-400 rounded px-1">10 features</span>
                      </span>
                      <span>{showIntelligence ? "▲" : "▼"}</span>
                    </button>

                    {showIntelligence && (
                      <div className="space-y-3 animate-in fade-in duration-200">

                        {/* #48 Genre preset */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Clapperboard className="h-2.5 w-2.5 text-orange-400" />
                            <span className="text-[9px] font-semibold text-orange-400">#48 Genre Preset</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground">Apply genre-specific pacing rules to clips. Active genre shapes the next Edit Plan.</p>
                          <div className="flex gap-1 flex-wrap">
                            {(["documentary","tutorial","vlog","ad","short_film","social_media","music_video"] as const).map(g => (
                              <button key={g}
                                className={cn("text-[7px] px-1 py-0.5 rounded border transition-colors", selectedGenre === g ? "border-orange-500/60 bg-orange-500/10 text-orange-400" : "border-border/40 text-zinc-500 hover:border-orange-500/30")}
                                onClick={() => setSelectedGenre(g === selectedGenre ? "" : g)}
                              >{g.replace(/_/g, " ")}</button>
                            ))}
                          </div>
                          <div className="flex gap-1">
                            <button
                              disabled={!selectedGenre || genreApplying}
                              className="flex-1 text-[9px] h-6 rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                              onClick={async () => {
                                if (!selectedGenre) return;
                                setGenreApplying(true); setGenreResult(null);
                                try {
                                  await fetch(`${API_BASE}/projects/${projectId}/genre-preset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ genre: selectedGenre, applyPacing: false }) });
                                  setGenreResult({ segmentsAdjusted: 0 });
                                  toast({ title: `Genre: ${selectedGenre.replace(/_/g," ")}`, description: "Saved — shapes next Edit Plan", duration: 2000 });
                                } finally { setGenreApplying(false); }
                              }}
                            >{genreApplying ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Saving…</> : "Save Genre"}</button>
                            <button
                              disabled={!selectedGenre || genreApplying}
                              className="flex-1 text-[9px] h-6 rounded border border-orange-500/60 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                              onClick={async () => {
                                if (!selectedGenre) return;
                                setGenreApplying(true); setGenreResult(null);
                                try {
                                  const r = await fetch(`${API_BASE}/projects/${projectId}/genre-preset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ genre: selectedGenre, applyPacing: true }) });
                                  const d = await r.json();
                                  setGenreResult({ segmentsAdjusted: d.segmentsAdjusted ?? 0 });
                                  refetchSegments?.();
                                  toast({ title: "Genre applied", description: `${d.segmentsAdjusted} clips adjusted to ${selectedGenre.replace(/_/g," ")} pacing`, duration: 2500 });
                                } finally { setGenreApplying(false); }
                              }}
                            >{genreApplying ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Applying…</> : "Apply Pacing"}</button>
                          </div>
                          {genreResult && genreResult.segmentsAdjusted > 0 && <p className="text-[8px] text-orange-400">{genreResult.segmentsAdjusted} clips adjusted</p>}
                        </div>

                        {/* #49 Story arc enforcement */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Activity className="h-2.5 w-2.5 text-fuchsia-400" />
                            <span className="text-[9px] font-semibold text-fuchsia-400">#49 Story Arc Enforcement</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground">AI labels each clip as hook / buildup / conflict / climax / resolution / cta. Badges appear on clip cards.</p>
                          <button
                            disabled={arcAssigning || (segments?.filter(s => s.included)?.length ?? 0) === 0}
                            className="w-full text-[9px] h-6 rounded border border-fuchsia-500/40 text-fuchsia-400 hover:bg-fuchsia-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setArcAssigning(true); setArcResult(null);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/assign-story-arc`, { method: "POST" });
                                const d = await r.json();
                                setArcResult({ assigned: d.assigned, total: d.total });
                                refetchSegments?.();
                                toast({ title: "Story arc assigned", description: `${d.assigned}/${d.total} clips labelled`, duration: 2500 });
                              } catch { toast({ title: "Error", description: "Could not assign story arc", variant: "destructive" }); }
                              finally { setArcAssigning(false); }
                            }}
                          >{arcAssigning ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Assigning…</> : <><Sparkles className="h-2.5 w-2.5" />Assign Story Arc</>}</button>
                          {arcResult && <p className="text-[8px] text-fuchsia-400">{arcResult.assigned}/{arcResult.total} clips labelled with arc roles</p>}
                        </div>

                        {/* #50 Re-edit from feedback */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <MessageSquare className="h-2.5 w-2.5 text-cyan-400" />
                            <span className="text-[9px] font-semibold text-cyan-400">#50 Re-edit from Feedback</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground">Describe what's wrong. AI adjusts the affected section of your timeline.</p>
                          <div className="flex gap-1 flex-wrap mb-1">
                            {["Too slow in the middle","Weak ending","Too many similar cuts","Start is too long","Remove the boring parts"].map(ex => (
                              <button key={ex} onClick={() => setFeedbackText(ex)} className="text-[7px] text-zinc-500 hover:text-cyan-300 border border-border/30 rounded px-1 py-0.5 hover:border-cyan-500/30 transition-colors">{ex}</button>
                            ))}
                          </div>
                          <textarea
                            value={feedbackText}
                            onChange={e => setFeedbackText(e.target.value)}
                            placeholder="e.g. The middle section drags — tighten it up..."
                            rows={2}
                            className="w-full bg-zinc-900/80 border border-border/60 rounded px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-500/50 focus:outline-none resize-none"
                          />
                          <button
                            disabled={!feedbackText.trim() || feedbackLoading}
                            className="w-full text-[9px] h-6 rounded border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              if (!feedbackText.trim()) return;
                              setFeedbackLoading(true); setFeedbackResult(null);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/redit-from-feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback: feedbackText }) });
                                const d = await r.json();
                                setFeedbackResult({ adjustmentsApplied: d.adjustmentsApplied });
                                refetchSegments?.();
                                toast({ title: "Feedback applied", description: `${d.adjustmentsApplied} adjustments made`, duration: 2500 });
                              } catch { toast({ title: "Error", description: "AI feedback failed", variant: "destructive" }); }
                              finally { setFeedbackLoading(false); }
                            }}
                          >{feedbackLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Adjusting…</> : <><Send className="h-2.5 w-2.5" />Apply Feedback</>}</button>
                          {feedbackResult && <p className="text-[8px] text-cyan-400">{feedbackResult.adjustmentsApplied} clip adjustments applied</p>}
                        </div>

                        {/* #51 Cut point heat map */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <GitBranch className="h-2.5 w-2.5 text-amber-400" />
                            <span className="text-[9px] font-semibold text-amber-400">#51 Cut Point Heat Map</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground">Visualize AI confidence and cut decisions across your entire timeline at a glance.</p>
                          {(() => {
                            const accepted = (segments ?? []).filter(s => s.included);
                            const excl = (segments ?? []).length - accepted.length;
                            return (
                              <div className="space-y-1">
                                <div className="flex gap-1 text-[8px]">
                                  <span className="text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1">{accepted.length} accepted</span>
                                  <span className="text-zinc-500 bg-zinc-800/40 border border-zinc-700/30 rounded px-1">{excl} excluded</span>
                                </div>
                                <div className="h-3 rounded bg-white/5 overflow-hidden flex gap-px p-px">
                                  {(segments ?? []).slice(0, 40).map(s => (
                                    <div
                                      key={s.id}
                                      className={cn("flex-1 h-full rounded-sm", s.included
                                        ? (s.confidence ?? 0) >= 0.85 ? "bg-emerald-500" : (s.confidence ?? 0) >= 0.65 ? "bg-amber-400" : "bg-yellow-600/70"
                                        : "bg-zinc-700/60"
                                      )}
                                      title={`${s.label ?? s.segmentType} [${s.included ? "ON" : "OFF"}] conf=${Math.round((s.confidence ?? 0) * 100)}%`}
                                    />
                                  ))}
                                </div>
                                <div className="flex gap-2 text-[7px] text-zinc-600">
                                  <span className="flex items-center gap-0.5"><span className="inline-block w-1.5 h-1.5 rounded-sm bg-emerald-500" />≥85%</span>
                                  <span className="flex items-center gap-0.5"><span className="inline-block w-1.5 h-1.5 rounded-sm bg-amber-400" />65–85%</span>
                                  <span className="flex items-center gap-0.5"><span className="inline-block w-1.5 h-1.5 rounded-sm bg-zinc-700/60" />excluded</span>
                                </div>
                              </div>
                            );
                          })()}
                        </div>

                        {/* #52 Confidence report */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <BarChart2 className="h-2.5 w-2.5 text-emerald-400" />
                            <span className="text-[9px] font-semibold text-emerald-400">#52 Confidence Report</span>
                          </div>
                          {!confidenceReport ? (
                            <button
                              className="w-full text-[9px] h-6 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 flex items-center justify-center gap-1"
                              onClick={async () => {
                                try {
                                  const r = await fetch(`${API_BASE}/projects/${projectId}/confidence-report`);
                                  const d = await r.json();
                                  setConfidenceReport({ avgConfidence: d.avgConfidence, distribution: d.distribution, recommendation: d.recommendation });
                                } catch {}
                              }}
                            ><Gauge className="h-2.5 w-2.5" />Load Confidence Report</button>
                          ) : (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 flex-1 rounded-full bg-white/5 overflow-hidden">
                                  <div className={cn("h-full rounded-full", confidenceReport.avgConfidence >= 0.75 ? "bg-emerald-500" : confidenceReport.avgConfidence >= 0.60 ? "bg-amber-400" : "bg-red-500")} style={{ width: `${Math.round(confidenceReport.avgConfidence * 100)}%` }} />
                                </div>
                                <span className="text-[9px] font-bold text-emerald-400 shrink-0">{Math.round(confidenceReport.avgConfidence * 100)}% avg</span>
                              </div>
                              <div className="flex gap-1 text-[7px]">
                                <span className="text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1">High: {confidenceReport.distribution.high}</span>
                                <span className="text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1">Mid: {confidenceReport.distribution.medium}</span>
                                <span className="text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1">Low: {confidenceReport.distribution.low}</span>
                              </div>
                              <p className="text-[8px] text-zinc-500 leading-relaxed">{confidenceReport.recommendation}</p>
                            </div>
                          )}
                        </div>

                        {/* #53 Edit diversity guard */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <Shuffle className="h-2.5 w-2.5 text-teal-400" />
                              <span className="text-[9px] font-semibold text-teal-400">#53 Edit Diversity Guard</span>
                            </div>
                            <button
                              disabled={diversityGuardLoading}
                              onClick={async () => {
                                const newVal = !editDiversityGuard;
                                setDiversityGuardLoading(true);
                                try {
                                  await fetch(`${API_BASE}/projects/${projectId}/diversity-guard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: newVal }) });
                                  setEditDiversityGuard(newVal);
                                  toast({ title: newVal ? "Diversity guard ON" : "Diversity guard OFF", duration: 1500 });
                                } finally { setDiversityGuardLoading(false); }
                              }}
                              className={cn("text-[8px] h-5 px-2 rounded border transition-colors", editDiversityGuard ? "border-teal-500/40 bg-teal-500/10 text-teal-400" : "border-zinc-700/40 text-zinc-500 hover:border-teal-500/20")}
                            >{diversityGuardLoading ? "…" : editDiversityGuard ? "ON" : "OFF"}</button>
                          </div>
                          <p className="text-[8px] text-muted-foreground">Prevents 3+ consecutive identical-type cuts in the Edit Plan. Forces variety.</p>
                          {!diversityReport ? (
                            <button
                              className="w-full text-[9px] h-6 rounded border border-teal-500/30 text-teal-400 hover:bg-teal-500/10 flex items-center justify-center gap-1"
                              onClick={async () => {
                                try {
                                  const r = await fetch(`${API_BASE}/projects/${projectId}/diversity-check`);
                                  const d = await r.json();
                                  setDiversityReport({ violationCount: d.violationCount, isHealthy: d.isHealthy, summary: d.summary });
                                } catch {}
                              }}
                            ><ScanEye className="h-2.5 w-2.5" />Check Current Diversity</button>
                          ) : (
                            <div className={cn("text-[8px] rounded p-1.5 border", diversityReport.isHealthy ? "text-teal-400 bg-teal-500/10 border-teal-500/20" : "text-amber-400 bg-amber-500/10 border-amber-500/20")}>
                              {diversityReport.isHealthy ? "✓ Healthy" : `⚠ ${diversityReport.violationCount} violations`} — {diversityReport.summary.slice(0, 90)}
                            </div>
                          )}
                        </div>

                        {/* #54 Platform-optimized pacing */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Gauge className="h-2.5 w-2.5 text-sky-400" />
                            <span className="text-[9px] font-semibold text-sky-400">#54 Platform Pacing</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground">Auto-adjust all clip lengths to platform best-practices.</p>
                          <div className="flex gap-1 flex-wrap">
                            {([
                              { id: "tiktok",    label: "TikTok",     cut: "2.3s" },
                              { id: "youtube",   label: "YouTube",    cut: "8s"   },
                              { id: "linkedin",  label: "LinkedIn",   cut: "12s"  },
                              { id: "instagram", label: "Instagram",  cut: "3.5s" },
                            ] as const).map(p => (
                              <button key={p.id}
                                className={cn("text-[7px] px-1.5 py-0.5 rounded border transition-colors", selectedPlatform === p.id ? "border-sky-500/60 bg-sky-500/10 text-sky-400" : "border-border/40 text-zinc-500 hover:border-sky-500/30")}
                                onClick={() => setSelectedPlatform(p.id === selectedPlatform ? "" : p.id)}
                              >{p.label} ~{p.cut}</button>
                            ))}
                          </div>
                          <div className="flex gap-1">
                            <button
                              disabled={!selectedPlatform || platformPaceLoading}
                              className="flex-1 text-[9px] h-6 rounded border border-sky-500/30 text-sky-400 hover:bg-sky-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                              onClick={async () => {
                                if (!selectedPlatform) return;
                                setPlatformPaceLoading(true); setPlatformPaceResult(null);
                                try {
                                  const r = await fetch(`${API_BASE}/projects/${projectId}/platform-pace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: selectedPlatform, dryRun: true }) });
                                  const d = await r.json();
                                  setPlatformPaceResult({ modifiedCount: d.modifiedCount, newAvgClipSec: d.newAvgClipSec });
                                } finally { setPlatformPaceLoading(false); }
                              }}
                            >{platformPaceLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />…</> : "Preview"}</button>
                            <button
                              disabled={!selectedPlatform || platformPaceLoading}
                              className="flex-1 text-[9px] h-6 rounded border border-sky-500/60 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 disabled:opacity-40 flex items-center justify-center gap-1"
                              onClick={async () => {
                                if (!selectedPlatform) return;
                                setPlatformPaceLoading(true); setPlatformPaceResult(null);
                                try {
                                  const r = await fetch(`${API_BASE}/projects/${projectId}/platform-pace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: selectedPlatform, dryRun: false }) });
                                  const d = await r.json();
                                  setPlatformPaceResult({ modifiedCount: d.modifiedCount, newAvgClipSec: d.newAvgClipSec });
                                  refetchSegments?.();
                                  toast({ title: `${selectedPlatform} pacing applied`, description: `${d.modifiedCount} clips adjusted. Avg: ${d.newAvgClipSec?.toFixed(1)}s/clip`, duration: 2500 });
                                } finally { setPlatformPaceLoading(false); }
                              }}
                            >Apply</button>
                          </div>
                          {platformPaceResult && (
                            <p className="text-[8px] text-sky-400">{platformPaceResult.modifiedCount} clips → avg {platformPaceResult.newAvgClipSec?.toFixed(1)}s/clip</p>
                          )}
                        </div>

                        {/* #55 Dialogue-driven B-roll timing */}
                        <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Layers className="h-2.5 w-2.5 text-indigo-400" />
                            <span className="text-[9px] font-semibold text-indigo-400">#55 Dialogue B-Roll Timing</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground">AI detects keyword timestamps in your transcript and marks perfect B-roll insertion points.</p>
                          <button
                            disabled={dialogueBrollLoading || (videos?.length ?? 0) === 0}
                            className="w-full text-[9px] h-6 rounded border border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setDialogueBrollLoading(true); setDialogueBrollResult(null);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/dialogue-broll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
                                const d = await r.json();
                                setDialogueBrollResult({ matchesFound: d.matchesFound ?? 0 });
                                if (d.matchesFound > 0) {
                                  toast({ title: `${d.matchesFound} B-roll points found`, description: d.message, duration: 3000 });
                                } else {
                                  toast({ title: "No matches found", description: d.message ?? "Run Transcribe first", variant: "destructive" });
                                }
                              } catch (e: any) { toast({ title: "Error", description: e?.message ?? "Failed", variant: "destructive" }); }
                              finally { setDialogueBrollLoading(false); }
                            }}
                          >{dialogueBrollLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Scanning transcript…</> : <><Network className="h-2.5 w-2.5" />Find B-Roll Points</>}</button>
                          {dialogueBrollResult && (
                            <p className="text-[8px] text-indigo-400">{dialogueBrollResult.matchesFound} keyword match{dialogueBrollResult.matchesFound !== 1 ? "es" : ""} found{dialogueBrollResult.insertedCount != null ? ` · ${dialogueBrollResult.insertedCount} inserted` : " (dry run — no changes yet)"}</p>
                          )}
                        </div>

                      </div>
                    )}
                  </div>

                  {/* ── Intro / Outro Trimmer ──────────────────────────────── */}
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider mb-2 flex items-center gap-1.5">
                      <Scissors className="h-3 w-3 text-rose-400" />
                      <span className="text-rose-400">Intro / Outro Trimmer</span>
                    </div>
                    <p className="text-[8px] text-muted-foreground mb-2 leading-relaxed">
                      Auto-detects cliché intros ("hey guys welcome back") and outros ("thanks for watching, subscribe") in your transcript and lets you instantly cut them.
                    </p>

                    <div className="space-y-2">
                      {/* ── #14 Intro Trimmer ── */}
                      <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <FastForward className="h-2.5 w-2.5 text-amber-400" />
                            <span className="text-[9px] font-semibold text-amber-400">Intro Detector</span>
                          </div>
                          {introDetectResult?.found && (
                            <span className="text-[7px] bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-1 py-0.5">
                              ≤{introDetectResult.introEndSec?.toFixed(1)}s
                            </span>
                          )}
                        </div>
                        <p className="text-[8px] text-zinc-600">Scans the opening section for greeting phrases. Found clips will be in the intro window.</p>

                        {!introDetectResult ? (
                          <button
                            disabled={introDetectLoading}
                            className="w-full text-[9px] h-6 rounded border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setIntroDetectLoading(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/detect-intro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scan" }) });
                                const d = await r.json();
                                setIntroDetectResult(d);
                              } catch { toast({ title: "Scan failed", variant: "destructive" }); }
                              finally { setIntroDetectLoading(false); }
                            }}
                          >{introDetectLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Scanning…</> : <><Search className="h-2.5 w-2.5" />Scan for Intro</>}</button>
                        ) : introDetectResult.found ? (
                          <div className="space-y-1.5">
                            <div className="rounded bg-amber-500/5 border border-amber-500/20 px-2 py-1 space-y-0.5">
                              <div className="text-[8px] text-amber-300 font-medium">Detected: "{introDetectResult.phrase}"</div>
                              <div className="text-[7px] text-zinc-500 italic leading-snug truncate">"…{introDetectResult.snippet?.slice(0, 80)}…"</div>
                              <div className="text-[7px] text-zinc-600">{introDetectResult.segmentCount} clip{introDetectResult.segmentCount !== 1 ? "s" : ""} in intro window (0s–{introDetectResult.introEndSec?.toFixed(1)}s)</div>
                            </div>
                            <div className="flex gap-1">
                              <button
                                className="flex-1 text-[9px] h-6 rounded border border-rose-500/50 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 flex items-center justify-center gap-1"
                                onClick={async () => {
                                  setIntroDetectLoading(true);
                                  try {
                                    const r = await fetch(`${API_BASE}/projects/${projectId}/detect-intro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cut" }) });
                                    const d = await r.json();
                                    setIntroDetectResult(d);
                                    refetchSegments?.();
                                    toast({ title: "Intro cut", description: d.message, duration: 2500 });
                                  } finally { setIntroDetectLoading(false); }
                                }}
                              ><Scissors className="h-2.5 w-2.5" />Cut Intro</button>
                              <button
                                className="flex-1 text-[9px] h-6 rounded border border-border/40 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 flex items-center justify-center gap-1"
                                onClick={() => { setIntroDetectResult(null); }}
                              >Keep It</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <span className="text-[8px] text-zinc-600">{introDetectResult.message}</span>
                            <button className="text-[7px] text-zinc-600 hover:text-zinc-400" onClick={() => setIntroDetectResult(null)}>Reset</button>
                          </div>
                        )}
                      </div>

                      {/* ── #13 Outro Trimmer ── */}
                      <div className="p-2 rounded-lg border border-border/40 bg-card/30 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <SkipForward className="h-2.5 w-2.5 text-purple-400" />
                            <span className="text-[9px] font-semibold text-purple-400">Outro Detector</span>
                          </div>
                          {outroDetectResult?.found && (
                            <span className="text-[7px] bg-purple-500/10 border border-purple-500/20 text-purple-400 rounded px-1 py-0.5">
                              ≥{outroDetectResult.outroStartSec?.toFixed(1)}s
                            </span>
                          )}
                        </div>
                        <p className="text-[8px] text-zinc-600">Scans the closing section for subscribe / sign-off phrases.</p>

                        {!outroDetectResult ? (
                          <button
                            disabled={outroDetectLoading}
                            className="w-full text-[9px] h-6 rounded border border-purple-500/30 text-purple-400 hover:bg-purple-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setOutroDetectLoading(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/detect-outro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "scan" }) });
                                const d = await r.json();
                                setOutroDetectResult(d);
                              } catch { toast({ title: "Scan failed", variant: "destructive" }); }
                              finally { setOutroDetectLoading(false); }
                            }}
                          >{outroDetectLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Scanning…</> : <><Search className="h-2.5 w-2.5" />Scan for Outro</>}</button>
                        ) : outroDetectResult.found ? (
                          <div className="space-y-1.5">
                            <div className="rounded bg-purple-500/5 border border-purple-500/20 px-2 py-1 space-y-0.5">
                              <div className="text-[8px] text-purple-300 font-medium">Detected: "{outroDetectResult.phrase}"</div>
                              <div className="text-[7px] text-zinc-500 italic leading-snug truncate">"…{outroDetectResult.snippet?.slice(-80)}…"</div>
                              <div className="text-[7px] text-zinc-600">{outroDetectResult.segmentCount} clip{outroDetectResult.segmentCount !== 1 ? "s" : ""} in outro window (≥{outroDetectResult.outroStartSec?.toFixed(1)}s)</div>
                            </div>
                            <div className="flex gap-1">
                              <button
                                className="flex-1 text-[9px] h-6 rounded border border-rose-500/50 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 flex items-center justify-center gap-1"
                                onClick={async () => {
                                  setOutroDetectLoading(true);
                                  try {
                                    const r = await fetch(`${API_BASE}/projects/${projectId}/detect-outro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cut" }) });
                                    const d = await r.json();
                                    setOutroDetectResult(d);
                                    refetchSegments?.();
                                    toast({ title: "Outro cut", description: d.message, duration: 2500 });
                                  } finally { setOutroDetectLoading(false); }
                                }}
                              ><Scissors className="h-2.5 w-2.5" />Cut Outro</button>
                              <button
                                className="flex-1 text-[9px] h-6 rounded border border-border/40 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 flex items-center justify-center gap-1"
                                onClick={() => { setOutroDetectResult(null); }}
                              >Keep It</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <span className="text-[8px] text-zinc-600">{outroDetectResult.message}</span>
                            <button className="text-[7px] text-zinc-600 hover:text-zinc-400" onClick={() => setOutroDetectResult(null)}>Reset</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* AI Refine Edit — instruction-based editing */}
                  {(segments?.length ?? 0) > 0 && (
                    <div className="mt-4 pt-3 border-t border-border/50">
                      <button
                        className="w-full flex items-center justify-between text-[9px] uppercase font-bold text-muted-foreground tracking-wider mb-2 hover:text-primary transition-colors"
                        onClick={() => setShowRefineInput(v => !v)}
                      >
                        <span className="flex items-center gap-1.5"><MessageSquare className="h-3 w-3" /> AI Edit by Instruction</span>
                        <span>{showRefineInput ? "▲" : "▼"}</span>
                      </button>
                      {showRefineInput && (
                        <div className="space-y-2 animate-in fade-in duration-200">
                          <p className="text-[9px] text-muted-foreground leading-relaxed">Describe what to change. AI will adjust the existing timeline.</p>
                          <div className="flex flex-col gap-1.5">
                            {["Remove all silences", "Start with the best moment", "Make it faster — shorter clips", "Add more variety in shots", "Emphasize emotional peaks"].map(ex => (
                              <button key={ex} onClick={() => setRefineInstruction(ex)} className="text-left text-[8px] text-zinc-500 hover:text-zinc-300 transition-colors px-1.5 py-0.5 rounded hover:bg-zinc-800">
                                → {ex}
                              </button>
                            ))}
                          </div>
                          <textarea
                            value={refineInstruction}
                            onChange={e => setRefineInstruction(e.target.value)}
                            placeholder="e.g. Remove boring middle section and start with the kiss..."
                            rows={3}
                            className="w-full bg-zinc-900/80 border border-border/60 rounded px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-primary/50 focus:outline-none resize-none"
                          />
                          <Button
                            size="sm"
                            className="w-full h-7 text-[10px] gap-1.5"
                            disabled={!refineInstruction.trim() || isJobRunning('refine_edit')}
                            onClick={() => {
                              if (!refineInstruction.trim()) return;
                              handleRunJob('refine_edit', undefined, JSON.stringify({ instruction: refineInstruction.trim() }));
                              setRefineInstruction("");
                            }}
                          >
                            {isJobRunning('refine_edit') ? <><Loader2 className="h-2.5 w-2.5 animate-spin" /> Refining...</> : <><Send className="h-2.5 w-2.5" /> Apply Instruction</>}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* Clips tab — NLE timeline panel */}
            <TabsContent value="clips" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">

              {/* ── NLE Toolbar ─────────────────────────────────────────────── */}
              <div className="shrink-0 px-2 py-1 border-b border-border/50 bg-card/60 space-y-1">
                {/* Row 1: Transport + Undo/Redo */}
                <div className="flex items-center gap-1 flex-wrap">
                  {/* J/K/L transport */}
                  <div className="flex items-center gap-0.5 border border-border/40 rounded p-0.5">
                    <button onClick={() => { if (seqVideoRef.current) { seqVideoRef.current.playbackRate = 0.5; seqVideoRef.current.play().catch(()=>{}); }}} className="px-1.5 py-0.5 text-[9px] font-mono font-bold text-zinc-400 hover:text-zinc-100 hover:bg-accent/30 rounded" title="J — Play ×0.5 backward">J</button>
                    <button onClick={() => seqVideoRef.current?.pause()} className="px-1.5 py-0.5 text-[9px] font-mono font-bold text-zinc-400 hover:text-zinc-100 hover:bg-accent/30 rounded" title="K — Pause">K</button>
                    <button onClick={() => { if (seqVideoRef.current) { seqVideoRef.current.playbackRate = 1; seqVideoRef.current.play().catch(()=>{}); }}} className="px-1.5 py-0.5 text-[9px] font-mono font-bold text-zinc-400 hover:text-zinc-100 hover:bg-accent/30 rounded" title="L — Play ×1">L</button>
                  </div>

                  <div className="h-4 w-px bg-border/40" />

                  {/* Delete mode toggle */}
                  <div className="flex items-center gap-0.5 border border-border/40 rounded p-0.5">
                    <button
                      onClick={() => setDeleteMode("ripple")}
                      className={cn("px-1.5 py-0.5 text-[8px] font-bold rounded transition-colors", deleteMode === "ripple" ? "bg-rose-500/20 text-rose-300" : "text-zinc-500 hover:text-zinc-300")}
                      title="X — Extract/Ripple delete: removes clip and shifts downstream"
                    >Ripple</button>
                    <button
                      onClick={() => setDeleteMode("lift")}
                      className={cn("px-1.5 py-0.5 text-[8px] font-bold rounded transition-colors", deleteMode === "lift" ? "bg-amber-500/20 text-amber-300" : "text-zinc-500 hover:text-zinc-300")}
                      title="E — Lift delete: removes clip content but leaves a gap"
                    >Lift</button>
                  </div>

                  <div className="h-4 w-px bg-border/40" />

                  {/* Magnetic snap */}
                  <button
                    onClick={() => setSnapEnabled(p => !p)}
                    className={cn("flex items-center gap-1 px-1.5 py-0.5 text-[8px] rounded border transition-colors", snapEnabled ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")}
                    title="#8 Magnetic snapping — snap clips to beat/chapter markers and clip edges"
                  >
                    <span className="text-[10px]">⟨⟩</span> Snap
                  </button>

                  <div className="h-4 w-px bg-border/40" />

                  {/* Undo/Redo */}
                  <button disabled={!undoStack.length} onClick={handleUndo} className="p-1 rounded hover:bg-accent/50 disabled:opacity-30" title="Undo (Cmd+Z)"><Undo2 className="h-3 w-3" /></button>
                  <button disabled={!redoStack.length} onClick={handleRedo} className="p-1 rounded hover:bg-accent/50 disabled:opacity-30" title="Redo (Cmd+Shift+Z)"><Redo2 className="h-3 w-3" /></button>

                  <div className="h-4 w-px bg-border/40" />

                  {/* Markers + Audio Mixer toggles */}
                  <button onClick={() => setShowMarkers(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showMarkers ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#10 Markers">Markers</button>
                  <button onClick={() => setShowAudioMixer(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showAudioMixer ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#6 Audio Mixer">Mixer</button>

                  <div className="h-4 w-px bg-border/40" />

                  {/* #11 Range selection tool */}
                  <button onClick={() => setShowRangeTool(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showRangeTool ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#11 Range selection — A/S to mark, then delete/speed/color">Range</button>

                  {/* #12 Paste attributes */}
                  {copiedGrade && (
                    <button onClick={handlePasteAttributes} className="px-1.5 py-0.5 text-[8px] rounded border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20" title={`Paste color grade "${copiedGrade.grade}" to ${selectedSegmentIds.size > 0 ? selectedSegmentIds.size + " selected" : "all"} clips`}>
                      Paste Grade
                    </button>
                  )}

                  {/* #17 Multicam view */}
                  <button onClick={() => setMulticamMode(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", multicamMode ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#17 Multicam — up to 4 angles side by side, click to cut">CAM</button>

                  <div className="h-4 w-px bg-border/40" />

                  {/* #22 Clip stack view */}
                  <button onClick={() => setClipStackView(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", clipStackView ? "border-teal-500/40 bg-teal-500/10 text-teal-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#22 Clip stack view — see all takes of the same moment">Stack</button>

                  {/* #23 Lasso selection */}
                  <button onClick={() => setLassoActive(p => !p)} className={cn("flex items-center gap-0.5 px-1.5 py-0.5 text-[8px] rounded border transition-colors", lassoActive ? "border-pink-500/40 bg-pink-500/10 text-pink-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#23 Lasso — drag to select multiple clips">
                    <span className="text-[10px]">⬚</span> Lasso
                  </button>

                  {/* #24 Zoom-to-fit */}
                  <button onClick={handleZoomToFit} className="px-1.5 py-0.5 text-[8px] rounded border border-border/40 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500/40 transition-colors font-mono" title="#24 Zoom to fit — fit entire edit in view (Z)">Z-fit</button>

                  {/* #31 Zoom-to-selection */}
                  <button
                    onClick={() => { if (selectedSegment) setZoomToFitTrigger(t => t + 1); else toast({ title: "Select a clip first", duration: 1500 }); }}
                    className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors font-mono", selectedSegment ? "border-blue-500/40 text-blue-400 hover:text-blue-200" : "border-border/40 text-zinc-600")}
                    title="#31 Zoom to selection — center timeline on selected clip (⌘+=)"
                  >
                    Z-sel
                  </button>

                  {/* #31 Timeline lanes */}
                  <button
                    onClick={() => setShowTimelineLanes(p => !p)}
                    className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showTimelineLanes ? "border-violet-500/40 bg-violet-500/10 text-violet-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")}
                    title="#31 Color-coded lanes — separate dialogue / B-roll / music / graphics"
                  >
                    Lanes
                  </button>

                  <div className="h-4 w-px bg-border/40" />

                  {/* #28 Comments */}
                  <button onClick={() => setShowComments(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors relative", showComments ? "border-blue-500/40 bg-blue-500/10 text-blue-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#28 Timeline comment threads (C)">
                    💬{comments.filter(c => c.resolved !== "true").length > 0 && <span className="absolute -top-0.5 -right-0.5 bg-blue-500 text-[6px] text-white rounded-full w-2.5 h-2.5 flex items-center justify-center">{comments.filter(c => c.resolved !== "true").length}</span>}
                  </button>

                  {/* #26 EDL */}
                  <button onClick={() => setShowEDL(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showEDL ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-200" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#26 Edit decision log — full audit trail of every cut, trim, and move">EDL</button>

                  {/* #30 Checkpoints */}
                  <button onClick={() => setShowCheckpoints(p => !p)} className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showCheckpoints ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")} title="#30 Named checkpoints — auto-save named versions">
                    ⛳{checkpoints.length > 0 ? ` ${checkpoints.length}` : ""}
                  </button>

                  {/* #44 Batch trim silence */}
                  <button
                    onClick={() => { setShowBatchTrimDialog(p => !p); setBatchTrimResult(null); }}
                    className={cn("px-1.5 py-0.5 text-[8px] rounded border transition-colors", showBatchTrimDialog ? "border-teal-500/40 bg-teal-500/10 text-teal-300" : "border-border/40 text-zinc-500 hover:text-zinc-300")}
                    title="#44 Batch trim silence — remove silence from start/end of every clip"
                  >Trim✂</button>
                </div>

                {/* Row 2: Three-point editing */}
                {(threePointIn != null || threePointOut != null || previewVideoId) && (
                  <div className="flex items-center gap-1.5 text-[8px]">
                    <span className="text-zinc-500 font-bold uppercase tracking-wider">3-Point:</span>
                    <button onClick={() => setThreePointIn(parseFloat(currentTime.toFixed(3)))} className={cn("px-1.5 py-0.5 rounded border font-mono", threePointIn != null ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border/40 text-zinc-500 hover:text-sky-300")}>
                      I {threePointIn != null ? fmtTime(threePointIn) : "--:--"}
                    </button>
                    <button onClick={() => setThreePointOut(parseFloat(currentTime.toFixed(3)))} className={cn("px-1.5 py-0.5 rounded border font-mono", threePointOut != null ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border/40 text-zinc-500 hover:text-sky-300")}>
                      O {threePointOut != null ? fmtTime(threePointOut) : "--:--"}
                    </button>
                    {threePointIn != null && threePointOut != null && threePointOut > threePointIn && (
                      <>
                        <span className="text-zinc-600 font-mono">{(threePointOut - threePointIn).toFixed(1)}s</span>
                        <Button size="sm" className="h-5 text-[8px] px-2 bg-sky-600 hover:bg-sky-500" onClick={handleThreePointInsert}>Insert</Button>
                        <button onClick={() => { setThreePointIn(null); setThreePointOut(null); }} className="text-zinc-600 hover:text-zinc-300">✕</button>
                      </>
                    )}
                  </div>
                )}

                {/* Row 3: Multi-select nest controls */}
                {selectedSegmentIds.size > 0 && (
                  <div className="flex items-center gap-1.5 text-[8px] py-0.5 border-t border-border/30">
                    <span className="text-violet-300 font-bold">{selectedSegmentIds.size} selected</span>
                    {!showNestInput ? (
                      <button onClick={() => setShowNestInput(true)} className="px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20">Group as Compound</button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <input type="text" value={nestName} onChange={e => setNestName(e.target.value)} placeholder="Compound Clip" className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[8px] text-zinc-200 outline-none w-28" />
                        <Button size="sm" className="h-5 text-[8px] px-2 bg-violet-600 hover:bg-violet-500" onClick={handleNestSegments}>Nest</Button>
                        <button onClick={() => setShowNestInput(false)} className="text-zinc-600 hover:text-zinc-300">✕</button>
                      </div>
                    )}
                    <button onClick={() => setSelectedSegmentIds(new Set())} className="text-zinc-600 hover:text-zinc-300 ml-auto">Clear</button>
                  </div>
                )}

                {/* Row 4: Add marker form */}
                {markerDraft && (
                  <div className="flex items-center gap-1.5 text-[8px] py-0.5 border-t border-border/30">
                    <span className="text-yellow-400 font-bold">M</span>
                    <span className="text-zinc-500 font-mono shrink-0">@{currentTime.toFixed(2)}s</span>
                    <input type="text" value={markerDraft.label} onChange={e => setMarkerDraft(d => d ? { ...d, label: e.target.value } : d)} placeholder="Marker label…" className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[8px] text-zinc-200 outline-none" onKeyDown={e => { if (e.key === "Enter") { addMarker(currentTime, markerDraft.label, markerDraft.color); setMarkerDraft(null); } if (e.key === "Escape") setMarkerDraft(null); }} autoFocus />
                    {(["red","yellow","green","blue","orange"] as const).map(c => (
                      <button key={c} onClick={() => setMarkerDraft(d => d ? { ...d, color: c } : d)} className={cn("w-3.5 h-3.5 rounded-full border-2 transition-all", markerDraft.color === c ? "border-white scale-125" : "border-transparent opacity-60")} style={{ backgroundColor: c === "yellow" ? "#eab308" : c === "red" ? "#ef4444" : c === "green" ? "#22c55e" : c === "blue" ? "#3b82f6" : "#f97316" }} />
                    ))}
                    <Button size="sm" className="h-5 text-[8px] px-2" onClick={() => { addMarker(currentTime, markerDraft.label, markerDraft.color); setMarkerDraft(null); }}>Add</Button>
                    <button onClick={() => setMarkerDraft(null)} className="text-zinc-600 hover:text-zinc-300">✕</button>
                  </div>
                )}

                {/* Row 5: Slip edit form */}
                {slipTarget && (
                  <div className="flex items-center gap-1.5 text-[8px] py-0.5 border-t border-border/30">
                    <span className="text-orange-300 font-bold">Slip</span>
                    <input
                      type="number" step="0.1"
                      value={slipDelta} onChange={e => setSlipDelta(e.target.value)}
                      placeholder="±seconds"
                      className="w-20 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[8px] text-zinc-200 outline-none font-mono"
                      onKeyDown={e => { if (e.key === "Enter") handleSlipEdit(slipTarget, parseFloat(slipDelta)); if (e.key === "Escape") { setSlipTarget(null); setSlipDelta(""); } }}
                      autoFocus
                    />
                    <Button size="sm" className="h-5 text-[8px] px-2 bg-orange-600 hover:bg-orange-500" onClick={() => handleSlipEdit(slipTarget, parseFloat(slipDelta))}>Apply</Button>
                    <button onClick={() => { setSlipTarget(null); setSlipDelta(""); }} className="text-zinc-600 hover:text-zinc-300">✕</button>
                  </div>
                )}

                {/* Row 6: #11 Range selection tool */}
                {showRangeTool && (
                  <div className="flex items-center gap-1.5 text-[8px] py-0.5 border-t border-border/30 flex-wrap">
                    <span className="text-sky-400 font-bold">Range</span>
                    <span className="text-zinc-600 text-[7px]">A/S keys or:</span>
                    <input type="number" step="0.1" value={rangeStart ?? ""} onChange={e => setRangeStart(parseFloat(e.target.value))} placeholder="Start (s)" className="w-16 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[8px] text-zinc-200 outline-none font-mono" />
                    <span className="text-zinc-600">→</span>
                    <input type="number" step="0.1" value={rangeEnd ?? ""} onChange={e => setRangeEnd(parseFloat(e.target.value))} placeholder="End (s)" className="w-16 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[8px] text-zinc-200 outline-none font-mono" />
                    {rangeStart != null && rangeEnd != null && rangeEnd > rangeStart && (
                      <span className="text-zinc-500 font-mono">{(rangeEnd - rangeStart).toFixed(1)}s</span>
                    )}
                    <select value={rangeOp} onChange={e => setRangeOp(e.target.value as "delete" | "speed" | "color")} className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[8px] text-zinc-200 outline-none">
                      <option value="delete">Delete</option>
                      <option value="speed">Speed</option>
                      <option value="color">Color</option>
                    </select>
                    {rangeOp === "speed" && (
                      <input type="number" step="0.25" min="0.05" max="10" value={rangeSpeed} onChange={e => setRangeSpeed(parseFloat(e.target.value))} className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[8px] text-zinc-200 outline-none font-mono" />
                    )}
                    {rangeOp === "color" && (
                      <select value={rangeColor} onChange={e => setRangeColor(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[8px] text-zinc-200 outline-none">
                        <option value="warm">Warm</option>
                        <option value="cool">Cool</option>
                        <option value="cinema">Cinema</option>
                        <option value="bw">B&W</option>
                        <option value="vibrant">Vibrant</option>
                        <option value="none">None</option>
                      </select>
                    )}
                    <Button size="sm" className="h-5 text-[8px] px-2 bg-sky-600 hover:bg-sky-500" onClick={handleRangeApply}>Apply</Button>
                    <button onClick={() => { setShowRangeTool(false); setRangeStart(null); setRangeEnd(null); }} className="text-zinc-600 hover:text-zinc-300 ml-auto">✕</button>
                  </div>
                )}

                {/* Row 7: #13 Speed ramp curve editor */}
                {speedRampTarget && (
                  <div className="flex flex-col gap-1 py-0.5 border-t border-border/30 text-[8px]">
                    <div className="flex items-center gap-1.5">
                      <span className="text-amber-400 font-bold">Speed Ramp</span>
                      <span className="text-zinc-500">{speedCurvePts.length} pts</span>
                      <button onClick={() => setSpeedCurvePts(p => [...p, { t: 0.75, v: 2.0 }].sort((a, b) => a.t - b.t))} className="text-zinc-600 hover:text-amber-300">+ pt</button>
                      <Button size="sm" className="h-5 text-[8px] px-2 bg-amber-600 hover:bg-amber-500 ml-auto" onClick={() => handleSaveSpeedCurve(speedRampTarget, speedCurvePts)}>Save Ramp</Button>
                      <button onClick={() => setSpeedRampTarget(null)} className="text-zinc-600 hover:text-zinc-300">✕</button>
                    </div>
                    {/* Mini SVG curve preview */}
                    <div className="relative h-16 bg-zinc-900 rounded border border-zinc-700 overflow-hidden">
                      <svg width="100%" height="100%" viewBox="0 0 100 50" preserveAspectRatio="none" className="absolute inset-0">
                        {/* Grid lines */}
                        <line x1="0" y1="25" x2="100" y2="25" stroke="#3f3f46" strokeWidth="0.5" strokeDasharray="2,2" />
                        <line x1="0" y1="12.5" x2="100" y2="12.5" stroke="#3f3f46" strokeWidth="0.3" strokeDasharray="1,3" />
                        <line x1="0" y1="37.5" x2="100" y2="37.5" stroke="#3f3f46" strokeWidth="0.3" strokeDasharray="1,3" />
                        {/* Speed curve */}
                        <polyline
                          points={speedCurvePts.map(p => `${p.t * 100},${50 - Math.min(p.v / 4, 1) * 50}`).join(" ")}
                          fill="none" stroke="#f59e0b" strokeWidth="1.5"
                        />
                        {/* Control points */}
                        {speedCurvePts.map((p, i) => (
                          <circle key={i} cx={p.t * 100} cy={50 - Math.min(p.v / 4, 1) * 50} r="2.5" fill="#f59e0b" stroke="#fff" strokeWidth="0.5" className="cursor-move" />
                        ))}
                      </svg>
                      {/* Speed labels */}
                      <div className="absolute top-0.5 left-0.5 text-[6px] text-zinc-600 font-mono">4×</div>
                      <div className="absolute bottom-0.5 left-0.5 text-[6px] text-zinc-600 font-mono">0×</div>
                    </div>
                    {/* Control point editors */}
                    <div className="flex gap-1 flex-wrap">
                      {speedCurvePts.map((p, i) => (
                        <div key={i} className="flex items-center gap-0.5 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5">
                          <span className="text-zinc-600 font-mono text-[7px]">t:</span>
                          <input type="number" min="0" max="1" step="0.05" value={p.t} onChange={e => setSpeedCurvePts(pts => pts.map((pt, j) => j === i ? { ...pt, t: parseFloat(e.target.value) } : pt).sort((a, b) => a.t - b.t))} className="w-8 bg-transparent text-zinc-200 outline-none text-[7px] font-mono" />
                          <span className="text-zinc-600 font-mono text-[7px]">v:</span>
                          <input type="number" min="0.05" max="10" step="0.25" value={p.v} onChange={e => setSpeedCurvePts(pts => pts.map((pt, j) => j === i ? { ...pt, v: parseFloat(e.target.value) } : pt))} className="w-8 bg-transparent text-zinc-200 outline-none text-[7px] font-mono" />
                          {speedCurvePts.length > 2 && (
                            <button onClick={() => setSpeedCurvePts(pts => pts.filter((_, j) => j !== i))} className="text-zinc-700 hover:text-red-400 text-[7px]">✕</button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <ScrollArea className="flex-1 p-2">
                <div className="space-y-1">

                  {/* ── #44 Batch Trim Silence panel ─────────────────────── */}
                  {showBatchTrimDialog && (
                    <div className="mb-2 p-2 rounded-lg border border-teal-500/30 bg-teal-500/5 space-y-2 text-[8px]">
                      <div className="flex items-center justify-between">
                        <span className="text-teal-300 font-bold tracking-wide uppercase">Batch Trim Silence</span>
                        <button onClick={() => setShowBatchTrimDialog(false)} className="text-zinc-600 hover:text-zinc-300">✕</button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                        <label className="text-zinc-500">Min silence (s)</label>
                        <input type="number" step="0.1" min="0.1" max="5" value={batchTrimBody.silenceDuration}
                          onChange={e => setBatchTrimBody(b => ({ ...b, silenceDuration: parseFloat(e.target.value) || 0.4 }))}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200 outline-none font-mono w-full" />
                        <label className="text-zinc-500">Head trim (s)</label>
                        <input type="number" step="0.05" min="0" max="2" value={batchTrimBody.headroom}
                          onChange={e => setBatchTrimBody(b => ({ ...b, headroom: parseFloat(e.target.value) || 0 }))}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200 outline-none font-mono w-full" />
                        <label className="text-zinc-500">Tail trim (s)</label>
                        <input type="number" step="0.05" min="0" max="2" value={batchTrimBody.tailroom}
                          onChange={e => setBatchTrimBody(b => ({ ...b, tailroom: parseFloat(e.target.value) || 0 }))}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200 outline-none font-mono w-full" />
                        <label className="text-zinc-500">Min clip dur (s)</label>
                        <input type="number" step="0.1" min="0.1" max="30" value={batchTrimBody.minDuration}
                          onChange={e => setBatchTrimBody(b => ({ ...b, minDuration: parseFloat(e.target.value) || 1 }))}
                          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200 outline-none font-mono w-full" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={async () => {
                            setBatchTrimLoading(true);
                            setBatchTrimResult(null);
                            try {
                              const res = await fetch(`${API_BASE}/projects/${id}/batch-trim-silence`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ ...batchTrimBody, dryRun: true }),
                              });
                              setBatchTrimResult(await res.json());
                            } catch { toast({ title: "Preview failed", variant: "destructive" }); }
                            finally { setBatchTrimLoading(false); }
                          }}
                          disabled={batchTrimLoading}
                          className="px-2 py-0.5 rounded border border-zinc-600 text-zinc-400 hover:text-zinc-200 hover:border-zinc-400 transition-colors"
                        >{batchTrimLoading ? "…" : "Preview"}</button>
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Apply silence trim to all clips? This modifies ${(segments ?? []).filter(s => s.included).length} clips.`)) return;
                            setBatchTrimLoading(true);
                            try {
                              const res = await fetch(`${API_BASE}/projects/${id}/batch-trim-silence`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ ...batchTrimBody, dryRun: false }),
                              });
                              const data = await res.json();
                              setBatchTrimResult(data);
                              await refetchSegments();
                              toast({ title: `Trimmed ${data.trimmedCount} clips — saved ${data.totalTimeSavedSeconds?.toFixed(2)}s`, duration: 3000 });
                            } catch { toast({ title: "Batch trim failed", variant: "destructive" }); }
                            finally { setBatchTrimLoading(false); }
                          }}
                          disabled={batchTrimLoading}
                          className="px-2 py-0.5 rounded bg-teal-600/80 hover:bg-teal-500/80 text-white transition-colors"
                        >{batchTrimLoading ? "…" : "Apply All"}</button>
                      </div>
                      {batchTrimResult && (
                        <div className="mt-1 space-y-0.5">
                          <div className="text-teal-300 font-mono">
                            {batchTrimResult.trimmedCount}/{batchTrimResult.totalSegments} clips · saves <span className="font-bold">{batchTrimResult.totalTimeSavedSeconds?.toFixed(2)}s</span>
                          </div>
                          <div className="max-h-20 overflow-y-auto space-y-0.5 pr-0.5">
                            {batchTrimResult.results.filter(r => r.source !== "skipped").map(r => (
                              <div key={r.segmentId} className="flex items-center gap-1 text-[7px] font-mono text-zinc-400">
                                <span className="text-zinc-300 truncate max-w-[80px]">{r.label ?? r.segmentId.slice(0, 8)}</span>
                                <span className="text-teal-500">-{(r.trimmedHead + r.trimmedTail).toFixed(2)}s</span>
                                <span className="text-zinc-600">{r.source === "silence_trim_info" ? "AI" : "heuristic"}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Clip list ──────────────────────────────────────────── */}
                  {(!segments || segments.length === 0) ? (
                    <div className="flex flex-col items-center justify-center h-20 text-center text-zinc-600 text-[10px] gap-1">
                      <Scissors className="h-5 w-5" />
                      <p>No clips yet — generate an edit plan first</p>
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {[...segments].sort((a, b) => a.orderIndex - b.orderIndex).map((seg, i, arr) => {
                        const srcVideo = videos?.find(v => v.id === seg.videoId);
                        const isSelected = selectedSegmentIds.has(seg.id);
                        const isCompound = (seg as any).segmentType === "compound";
                        const isGap = (seg as any).isGap === true;
                        const segMarkers = markers.filter(m => m.timestamp >= seg.startTime && m.timestamp <= seg.endTime);
                        const markerColorMap: Record<string, string> = { red: "bg-red-500", yellow: "bg-yellow-400", green: "bg-green-500", blue: "bg-blue-500", orange: "bg-orange-500" };
                        const nextSeg = arr[i + 1];

                        // #21 Color-coded clip type — border left + label dot
                        const typeColorBorder: Record<string, string> = {
                          primary: "border-l-2 border-l-orange-500/70",
                          action: "border-l-2 border-l-orange-500/70",
                          "b-roll": "border-l-2 border-l-sky-500/70",
                          broll: "border-l-2 border-l-sky-500/70",
                          motion_graphic: "border-l-2 border-l-green-500/70",
                          graphic: "border-l-2 border-l-green-500/70",
                          music: "border-l-2 border-l-purple-500/70",
                          compound: "border-l-2 border-l-violet-500/70",
                          interview: "border-l-2 border-l-amber-500/70",
                          transition: "border-l-2 border-l-zinc-500/50",
                        };
                        const typeDotColor: Record<string, string> = {
                          primary: "bg-orange-500", action: "bg-orange-500",
                          "b-roll": "bg-sky-500", broll: "bg-sky-500",
                          motion_graphic: "bg-green-500", graphic: "bg-green-500",
                          music: "bg-purple-500", compound: "bg-violet-500",
                          interview: "bg-amber-500", transition: "bg-zinc-500",
                        };
                        const typeBorderClass = typeColorBorder[seg.segmentType?.toLowerCase() ?? ""] ?? "border-l-2 border-l-zinc-700/30";
                        const typeDotClass = typeDotColor[seg.segmentType?.toLowerCase() ?? ""] ?? "bg-zinc-600";

                        // #25 Segment's clip comments
                        const segComments = comments.filter(c => c.timecode >= seg.startTime && c.timecode <= seg.endTime && c.resolved !== "true");

                        return (
                          <div key={seg.id}>
                            {/* Gap placeholder */}
                            {isGap ? (
                              <div className="flex items-center gap-1.5 px-1.5 py-1 rounded border border-dashed border-zinc-700/50 bg-zinc-900/20 opacity-60">
                                <div className="flex-1 text-[8px] text-zinc-600 font-mono italic">
                                  gap — {(seg.endTime - seg.startTime).toFixed(1)}s [{fmtTime(seg.startTime)}–{fmtTime(seg.endTime)}]
                                </div>
                                <button onClick={() => handleRippleDelete(seg.id)} className="text-[7px] text-zinc-700 hover:text-zinc-400">remove</button>
                              </div>
                            ) : (
                              <div
                                draggable={!isSelected}
                                onDragStart={() => handleDragStart(seg.id)}
                                onDragOver={e => handleDragOver(e, seg.id)}
                                onDrop={e => handleDrop(e, seg.id)}
                                onDragLeave={() => setDragOver(null)}
                                onClick={() => { setSelectedSegment(seg.id); }}
                                className={cn(
                                  "flex items-center gap-1 px-1 py-1 rounded border cursor-pointer transition-all group relative",
                                  typeBorderClass,
                                  selectedSegment === seg.id ? "border-primary/60 bg-primary/5" : "border-border/40 hover:border-primary/30",
                                  isSelected && "border-violet-500/60 bg-violet-500/5",
                                  !seg.included && !isGap && "opacity-50",
                                  dragOver === seg.id && "border-cyan-400 bg-cyan-400/5",
                                  isCompound && "border-violet-500/30 bg-violet-500/5",
                                  lassoActive && "cursor-crosshair"
                                )}
                              >
                                {/* Multi-select checkbox */}
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={e => { e.stopPropagation(); setSelectedSegmentIds(prev => { const s = new Set(prev); e.target.checked ? s.add(seg.id) : s.delete(seg.id); return s; }); }}
                                  onClick={e => e.stopPropagation()}
                                  className="w-2.5 h-2.5 shrink-0 accent-violet-500"
                                />

                                <GripVertical className="h-3 w-3 text-zinc-600 shrink-0 cursor-grab" />

                                {/* #43 Thumbnail + clip inspector tooltip */}
                                <div
                                  className="h-6 w-9 shrink-0 rounded overflow-visible bg-zinc-900 relative"
                                  onMouseEnter={() => setInspectorHoverId(seg.id)}
                                  onMouseLeave={() => setInspectorHoverId(null)}
                                >
                                  <div className="h-6 w-9 rounded overflow-hidden">
                                  {srcVideo && !isCompound && (
                                    <img src={`${API_BASE}/videos/${srcVideo.id}/thumbnail.jpg`} alt="" className="h-full w-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  )}
                                  {isCompound && <div className="h-full w-full flex items-center justify-center bg-violet-900/40"><Layers className="h-3 w-3 text-violet-400" /></div>}
                                  </div>
                                  {/* Inspector tooltip */}
                                  {inspectorHoverId === seg.id && srcVideo && (
                                    <div className="absolute left-10 top-0 z-50 w-52 bg-zinc-950 border border-zinc-700/60 rounded-lg p-2 text-[8px] font-mono shadow-2xl pointer-events-none">
                                      <div className="text-zinc-200 font-bold truncate mb-1 text-[9px]">{srcVideo.originalName}</div>
                                      <div className="grid grid-cols-2 gap-x-1.5 gap-y-0.5 text-zinc-400">
                                        <span className="text-zinc-600">Resolution</span>
                                        <span>{(srcVideo as any).width && (srcVideo as any).height ? `${(srcVideo as any).width}×${(srcVideo as any).height}` : "—"}</span>
                                        <span className="text-zinc-600">FPS</span>
                                        <span>{(srcVideo as any).fps ? `${(srcVideo as any).fps} fps` : "—"}</span>
                                        <span className="text-zinc-600">Duration</span>
                                        <span>{srcVideo.durationSeconds ? `${srcVideo.durationSeconds.toFixed(1)}s` : "—"}</span>
                                        <span className="text-zinc-600">Clip range</span>
                                        <span>{seg.startTime.toFixed(1)}→{seg.endTime.toFixed(1)}s</span>
                                        <span className="text-zinc-600">Clip dur</span>
                                        <span className="text-teal-400 font-bold">{(seg.endTime - seg.startTime).toFixed(2)}s</span>
                                        <span className="text-zinc-600">File size</span>
                                        <span>{(srcVideo as any).sizeBytes ? `${((srcVideo as any).sizeBytes / 1024 / 1024).toFixed(1)} MB` : "—"}</span>
                                        <span className="text-zinc-600">Type</span>
                                        <span>{srcVideo.mimeType?.replace("video/", "") ?? "—"}</span>
                                        {(srcVideo as any).codec && (
                                          <>
                                            <span className="text-zinc-600">Codec</span>
                                            <span>{(srcVideo as any).codec}</span>
                                          </>
                                        )}
                                        {(srcVideo as any).bitrate && (
                                          <>
                                            <span className="text-zinc-600">Bitrate</span>
                                            <span>{Math.round((srcVideo as any).bitrate / 1000)} kbps</span>
                                          </>
                                        )}
                                      </div>
                                      <div className="mt-1.5 pt-1 border-t border-zinc-800 text-zinc-600">segment: {seg.id.slice(0, 12)}…</div>
                                    </div>
                                  )}
                                </div>

                                {/* Label + timecode */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1">
                                    {/* #21 Type color dot */}
                                    <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", typeDotClass)} title={seg.segmentType} />
                                    <p className="text-[9px] font-medium truncate">{seg.label ?? seg.segmentType}</p>
                                    {isCompound && <span className="text-[7px] font-bold text-violet-400 bg-violet-500/10 px-0.5 rounded">COMPOUND</span>}
                                    {(seg as any).inPoint != null && <span className="text-[7px] text-orange-400 font-mono">slip</span>}
                                    {(seg as any).reverse && <span className="text-[7px] text-pink-400 font-mono">◀</span>}
                                    {(seg as any).freeze && <span className="text-[7px] text-blue-400 font-mono">❚❚</span>}
                                    {(seg as any).opticalFlow && <span className="text-[7px] text-sky-400 font-mono">OF</span>}
                                    {/* #28 Comment thread indicator */}
                                    {segComments.length > 0 && <span className="text-[7px] text-blue-300">💬{segComments.length}</span>}
                                    {/* #49 Story arc bucket badge */}
                                    {(seg as any).storyArcBucket && (() => {
                                      const arcColors: Record<string, string> = {
                                        hook: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
                                        buildup: "text-blue-400 bg-blue-500/10 border-blue-500/30",
                                        conflict: "text-orange-400 bg-orange-500/10 border-orange-500/30",
                                        climax: "text-red-400 bg-red-500/10 border-red-500/30",
                                        resolution: "text-green-400 bg-green-500/10 border-green-500/30",
                                        cta: "text-violet-400 bg-violet-500/10 border-violet-500/30",
                                      };
                                      const col = arcColors[(seg as any).storyArcBucket] ?? "text-zinc-400 bg-zinc-500/10 border-zinc-500/30";
                                      return <span className={`text-[6px] font-bold uppercase border rounded px-0.5 ${col}`}>{(seg as any).storyArcBucket}</span>;
                                    })()}
                                    {/* #24 Stem type badge */}
                                    {(seg as any).stemType && (() => {
                                      const stemIcons: Record<string, string> = { dialogue: "🎙", music: "🎵", sfx: "⚡", ambience: "🌊", mixed: "⊕" };
                                      const stemCols: Record<string, string> = {
                                        dialogue: "text-sky-400 bg-sky-500/10 border-sky-500/30",
                                        music: "text-pink-400 bg-pink-500/10 border-pink-500/30",
                                        sfx: "text-amber-400 bg-amber-500/10 border-amber-500/30",
                                        ambience: "text-teal-400 bg-teal-500/10 border-teal-500/30",
                                        mixed: "text-violet-400 bg-violet-500/10 border-violet-500/30",
                                      };
                                      const t = (seg as any).stemType as string;
                                      return <span className={`text-[6px] font-bold border rounded px-0.5 ${stemCols[t] ?? "text-zinc-400 bg-zinc-500/10 border-zinc-500/30"}`}>{stemIcons[t] ?? ""}{t}</span>;
                                    })()}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <p className="text-[7px] text-muted-foreground font-mono">{seg.startTime.toFixed(1)}→{seg.endTime.toFixed(1)}s · {(seg.endTime - seg.startTime).toFixed(1)}s</p>
                                    {(seg as any).inPoint != null && <p className="text-[7px] text-orange-400/60 font-mono">in:{((seg as any).inPoint ?? seg.startTime).toFixed(1)}</p>}
                                  </div>
                                  {/* Marker pips */}
                                  {segMarkers.length > 0 && (
                                    <div className="flex gap-0.5 mt-0.5">
                                      {segMarkers.map(m => <div key={m.id} className={cn("w-1.5 h-1.5 rounded-full", markerColorMap[m.color] ?? "bg-yellow-400")} title={m.label || `@${m.timestamp.toFixed(1)}s`} />)}
                                    </div>
                                  )}
                                  {/* #52 Confidence visualization bar */}
                                  {seg.confidence != null && (
                                    <div className="mt-0.5 h-0.5 rounded-full bg-white/5 overflow-hidden" title={`AI confidence: ${Math.round((seg.confidence ?? 0) * 100)}%`}>
                                      <div
                                        className={cn("h-full rounded-full transition-all", (seg.confidence ?? 0) >= 0.85 ? "bg-emerald-500" : (seg.confidence ?? 0) >= 0.65 ? "bg-amber-400" : "bg-red-500/60")}
                                        style={{ width: `${Math.round((seg.confidence ?? 0) * 100)}%` }}
                                      />
                                    </div>
                                  )}
                                </div>

                                {/* Status badges */}
                                <div className="flex flex-col items-end gap-0.5 shrink-0">
                                  <span className={cn("text-[7px] font-bold rounded px-0.5", seg.included ? "text-green-400" : "text-zinc-500")}>{seg.included ? "ON" : "OFF"}</span>
                                  {seg.confidence != null && (() => {
                                    const c = seg.confidence ?? 0;
                                    const cl = c >= 0.85 ? "text-rose-400" : c >= 0.65 ? "text-amber-400" : "text-zinc-600";
                                    return <span className={cn("text-[7px] font-mono", cl)}>{c >= 0.85 ? "HI" : c >= 0.65 ? "MD" : "LO"}</span>;
                                  })()}
                                </div>

                                {/* Action buttons (shown on hover) */}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                  {/* Slip edit */}
                                  {!isCompound && (
                                    <button
                                      onClick={e => { e.stopPropagation(); setSlipTarget(seg.id); setSlipDelta(""); }}
                                      className="p-0.5 rounded hover:bg-orange-500/20 text-zinc-500 hover:text-orange-300 transition-colors"
                                      title="#2 Slip edit — shift in/out without moving timeline position"
                                    >
                                      <Scissors className="h-2.5 w-2.5" />
                                    </button>
                                  )}
                                  {/* #16 Reverse clip */}
                                  {!isCompound && (
                                    <button
                                      onClick={e => { e.stopPropagation(); handleReverse(seg.id); }}
                                      className={cn("p-0.5 rounded transition-colors", (seg as any).reverse ? "text-pink-400 bg-pink-500/10" : "text-zinc-500 hover:text-pink-300 hover:bg-pink-500/10")}
                                      title="#16 Reverse — flip playback direction non-destructively"
                                    >
                                      <span className="text-[7px] font-mono font-bold">◀▶</span>
                                    </button>
                                  )}
                                  {/* #14 Optical flow slo-mo */}
                                  {!isCompound && (
                                    <button
                                      onClick={e => { e.stopPropagation(); handleOpticalFlow(seg.id); }}
                                      className={cn("p-0.5 rounded transition-colors text-[7px] font-mono font-bold", (seg as any).opticalFlow ? "text-sky-300 bg-sky-500/10" : "text-zinc-600 hover:text-sky-300 hover:bg-sky-500/10")}
                                      title="#14 Optical-flow slo-mo — 0.25× with frame interpolation (minterpolate)"
                                    >OF</button>
                                  )}
                                  {/* #15 Freeze frame */}
                                  {!isCompound && (
                                    <button
                                      onClick={e => {
                                        e.stopPropagation();
                                        if ((seg as any).freeze) { handleFreezeFrame(seg.id); return; }
                                        const d = parseFloat(prompt("Freeze duration (seconds):", "2.0") ?? "2");
                                        if (!isNaN(d) && d > 0) handleFreezeFrame(seg.id, d);
                                      }}
                                      className={cn("p-0.5 rounded transition-colors text-[7px] font-mono font-bold", (seg as any).freeze ? "text-blue-300 bg-blue-500/10" : "text-zinc-600 hover:text-blue-300 hover:bg-blue-500/10")}
                                      title="#15 Freeze frame — hold last frame for N seconds"
                                    >❚❚</button>
                                  )}
                                  {/* #13 Speed ramp */}
                                  {!isCompound && (
                                    <button
                                      onClick={e => { e.stopPropagation(); setSpeedRampTarget(seg.id); if ((seg as any).speedCurvePoints) { try { setSpeedCurvePts(JSON.parse((seg as any).speedCurvePoints)); } catch {} } }}
                                      className={cn("p-0.5 rounded transition-colors text-[7px] font-mono font-bold", (seg as any).speedCurvePoints ? "text-amber-300 bg-amber-500/10" : "text-zinc-600 hover:text-amber-300 hover:bg-amber-500/10")}
                                      title="#13 Speed ramp — drag bezier curve handles"
                                    >⏩</button>
                                  )}
                                  {/* #12 Copy color grade */}
                                  <button
                                    onClick={e => { e.stopPropagation(); setCopiedGrade({ segId: seg.id, grade: (seg as any).colorGrade ?? "none" }); toast({ title: `Grade "${(seg as any).colorGrade ?? "none"}" copied`, description: "Click 'Paste Grade' to apply", duration: 2000 }); }}
                                    className={cn("p-0.5 rounded transition-colors text-[7px] font-mono font-bold", copiedGrade?.segId === seg.id ? "text-purple-300 bg-purple-500/10" : "text-zinc-600 hover:text-purple-300 hover:bg-purple-500/10")}
                                    title="#12 Copy color grade from this clip"
                                  >C</button>
                                  {/* Unnest compound */}
                                  {isCompound && (
                                    <button
                                      onClick={e => { e.stopPropagation(); handleUnnest(seg.id); }}
                                      className="p-0.5 rounded hover:bg-violet-500/20 text-zinc-500 hover:text-violet-300 transition-colors"
                                      title="#9 Unnest — flatten compound clip"
                                    >
                                      <Network className="h-2.5 w-2.5" />
                                    </button>
                                  )}
                                  {/* #45 Smart B-roll insert */}
                                  {!isCompound && !isGap && (
                                    <button
                                      onClick={async e => {
                                        e.stopPropagation();
                                        const isBroll = seg.segmentType?.toLowerCase() === "b-roll";
                                        setBrollLoading(p => ({ ...p, [seg.id]: true }));
                                        try {
                                          await fetch(`${API_BASE}/segments/${seg.id}/set-broll`, {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ duckLevel: 0.3, undo: isBroll }),
                                          });
                                          await refetchSegments();
                                          toast({ title: isBroll ? "Restored to primary track" : "Set as B-roll — audio muted, adjacent clips ducked", duration: 2500 });
                                        } catch { toast({ title: "B-roll update failed", variant: "destructive" }); }
                                        finally { setBrollLoading(p => ({ ...p, [seg.id]: false })); }
                                      }}
                                      disabled={brollLoading[seg.id]}
                                      className={cn(
                                        "p-0.5 rounded transition-colors text-[7px] font-mono font-bold",
                                        seg.segmentType?.toLowerCase() === "b-roll"
                                          ? "text-sky-300 bg-sky-500/10 hover:bg-sky-500/20"
                                          : "text-zinc-600 hover:text-sky-300 hover:bg-sky-500/10"
                                      )}
                                      title={seg.segmentType?.toLowerCase() === "b-roll" ? "#45 Restore to primary track (undo B-roll)" : "#45 Smart insert: set as B-roll — mutes audio, ducks adjacent clips"}
                                    >
                                      {brollLoading[seg.id] ? "…" : "B"}
                                    </button>
                                  )}
                                  {/* Add marker at seg start */}
                                  <button
                                    onClick={e => { e.stopPropagation(); addMarker(seg.startTime, seg.label ?? "", "yellow"); }}
                                    className="p-0.5 rounded hover:bg-yellow-500/20 text-zinc-600 hover:text-yellow-300 transition-colors"
                                    title="#10 Add marker at clip start"
                                  >
                                    <span className="text-[8px] font-bold">M</span>
                                  </button>
                                  {/* #29 Clip version history */}
                                  <button
                                    onClick={e => { e.stopPropagation(); setVersionHistoryTarget(versionHistoryTarget === seg.id ? null : seg.id); }}
                                    className={cn("p-0.5 rounded transition-colors text-[7px] font-mono", versionHistoryTarget === seg.id ? "text-emerald-300 bg-emerald-500/10" : "text-zinc-600 hover:text-emerald-300 hover:bg-emerald-500/10")}
                                    title="#29 Clip version history — view and revert to previous states"
                                  >VH</button>
                                  {/* #28 Add comment at this clip */}
                                  <button
                                    onClick={e => { e.stopPropagation(); setCommentDraft({ timecode: seg.startTime, text: "" }); setShowComments(true); }}
                                    className="p-0.5 rounded text-zinc-600 hover:text-blue-300 hover:bg-blue-500/10 transition-colors text-[7px]"
                                    title="#28 Add comment thread at this clip's timecode"
                                  >💬</button>
                                  {/* Delete button (mode-aware) */}
                                  <button
                                    onClick={e => { e.stopPropagation(); deleteMode === "ripple" ? handleRippleDelete(seg.id) : handleLiftDelete(seg.id); }}
                                    className={cn("p-0.5 rounded transition-colors", deleteMode === "ripple" ? "hover:bg-rose-500/20 text-zinc-600 hover:text-rose-400" : "hover:bg-amber-500/20 text-zinc-600 hover:text-amber-400")}
                                    title={deleteMode === "ripple" ? "X — Ripple delete (shift downstream)" : "E — Lift delete (leave gap)"}
                                  >
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* ── #3 Roll edit handle between adjacent included clips ── */}
                            {nextSeg && seg.included && nextSeg.included && !isGap && !(nextSeg as any).isGap && (
                              <div className="flex items-center justify-center h-2 group cursor-col-resize"
                                title={`#3 Roll edit between ${seg.label ?? seg.id} and ${nextSeg.label ?? nextSeg.id}`}
                                onDoubleClick={() => {
                                  const delta = parseFloat(prompt(`Roll edit delta (seconds, negative=trim left clip):`, "0") ?? "0");
                                  if (!isNaN(delta) && delta !== 0) handleRollEdit(seg.id, nextSeg.id, delta);
                                }}
                              >
                                <div className="h-0.5 w-6 rounded-full bg-zinc-700 group-hover:bg-cyan-500/60 transition-colors" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ── #10 Markers panel ──────────────────────────────────── */}
                  {showMarkers && (
                    <div className="mt-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-yellow-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-yellow-400">Markers</span>
                        <span className="text-[8px] text-zinc-500">{markers.length} total</span>
                        <button onClick={() => setMarkerDraft({ label: "", color: "yellow" })} className="ml-auto text-[8px] text-zinc-500 hover:text-yellow-300 font-mono">+ Add (M)</button>
                        <button onClick={() => exportEDLWithMarkers()} className="text-[8px] text-zinc-600 hover:text-zinc-300">EDL ↓</button>
                      </div>
                      {markers.length === 0 ? (
                        <p className="text-[8px] text-zinc-600 px-2.5 py-2 italic">No markers yet — press M to add at current time</p>
                      ) : (
                        <div className="max-h-36 overflow-y-auto">
                          {[...markers].sort((a, b) => a.timestamp - b.timestamp).map(m => {
                            const colorMap: Record<string, string> = { red: "bg-red-500/20 text-red-300 border-red-500/30", yellow: "bg-yellow-500/10 text-yellow-300 border-yellow-500/20", green: "bg-green-500/10 text-green-300 border-green-500/20", blue: "bg-blue-500/10 text-blue-300 border-blue-500/20", orange: "bg-orange-500/10 text-orange-300 border-orange-500/20" };
                            return (
                              <div key={m.id} className={cn("flex items-center gap-2 px-2.5 py-1 border-b border-yellow-500/5 last:border-b-0 group", colorMap[m.color] ?? colorMap.yellow)}>
                                <div className="w-1.5 h-4 rounded-full shrink-0" style={{ backgroundColor: m.color === "yellow" ? "#eab308" : m.color === "red" ? "#ef4444" : m.color === "green" ? "#22c55e" : m.color === "blue" ? "#3b82f6" : "#f97316" }} />
                                <button
                                  className="text-[8px] font-mono shrink-0 hover:underline"
                                  onClick={() => { if (videoRef.current) videoRef.current.currentTime = m.timestamp; }}
                                  title={`Jump to ${fmtTime(m.timestamp)}`}
                                >
                                  {fmtTime(m.timestamp)}
                                </button>
                                <span className="text-[8px] flex-1 truncate">{m.label || <span className="italic text-zinc-600">untitled</span>}</span>
                                {/* Color dots */}
                                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  {(["red","yellow","green","blue","orange"] as const).map(c => (
                                    <button key={c} onClick={() => patchMarker(m.id, { color: c })} className={cn("w-2 h-2 rounded-full border", m.color === c ? "border-white" : "border-transparent opacity-50")} style={{ backgroundColor: c === "yellow" ? "#eab308" : c === "red" ? "#ef4444" : c === "green" ? "#22c55e" : c === "blue" ? "#3b82f6" : "#f97316" }} />
                                  ))}
                                  <button onClick={() => deleteMarker(m.id)} className="text-[7px] text-zinc-600 hover:text-red-400 ml-1">✕</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── #6/#7 Multi-track audio mixer ──────────────────────── */}
                  {showAudioMixer && (
                    <div className="mt-2 rounded-lg border border-green-500/20 bg-green-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-green-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-green-400">Audio Mixer</span>
                        <span className="text-[8px] text-zinc-500">{audioTracks.length} tracks</span>
                        <button
                          onClick={() => setAddTrackDraft({ name: "New Track", type: "dialogue" })}
                          className="ml-auto text-[8px] text-zinc-500 hover:text-green-300 font-mono"
                        >+ Add Track</button>
                      </div>

                      {/* Add track form */}
                      {addTrackDraft && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-green-500/10 text-[8px]">
                          <input type="text" value={addTrackDraft.name} onChange={e => setAddTrackDraft(d => d ? { ...d, name: e.target.value } : d)} className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 outline-none" placeholder="Track name" />
                          <select value={addTrackDraft.type} onChange={e => setAddTrackDraft(d => d ? { ...d, type: e.target.value } : d)} className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200 outline-none text-[8px]">
                            <option value="dialogue">Dialogue</option>
                            <option value="music">Music</option>
                            <option value="sfx">SFX</option>
                            <option value="ambient">Ambient</option>
                          </select>
                          <Button size="sm" className="h-5 text-[8px] px-2 bg-green-600 hover:bg-green-500" onClick={async () => {
                            await fetch(`${API_BASE}/projects/${id}/audio-tracks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: addTrackDraft.name, trackType: addTrackDraft.type, orderIndex: audioTracks.length }) });
                            setAddTrackDraft(null);
                            fetchAudioTracks();
                          }}>Add</Button>
                          <button onClick={() => setAddTrackDraft(null)} className="text-zinc-600 hover:text-zinc-300">✕</button>
                        </div>
                      )}

                      {audioTracks.length === 0 && !addTrackDraft ? (
                        <p className="text-[8px] text-zinc-600 px-2.5 py-2 italic">No audio tracks — add Dialogue, Music, or SFX tracks</p>
                      ) : (
                        <div className="space-y-0 max-h-48 overflow-y-auto">
                          {audioTracks.map(track => {
                            const trackColorMap: Record<string, string> = { dialogue: "text-sky-400", music: "text-violet-400", sfx: "text-amber-400", ambient: "text-emerald-400" };
                            const tColor = trackColorMap[track.trackType] ?? "text-zinc-400";
                            return (
                              <div key={track.id} className="border-b border-green-500/5 last:border-b-0">
                                {/* Track header row */}
                                <div className="flex items-center gap-1.5 px-2.5 py-1 group">
                                  <span className={cn("text-[8px] font-bold uppercase shrink-0 w-12 truncate", tColor)}>{track.trackType.slice(0, 3).toUpperCase()}</span>
                                  <span className="text-[8px] text-zinc-300 flex-1 truncate">{track.name}</span>
                                  {/* Volume fader */}
                                  <input
                                    type="range" min="0" max="2" step="0.01" value={track.volume}
                                    onChange={e => updateAudioTrack(track.id, { volume: parseFloat(e.target.value) })}
                                    className="w-16 h-1 accent-green-400"
                                    title={`Volume: ${Math.round(track.volume * 100)}%`}
                                  />
                                  <span className="text-[7px] text-zinc-500 font-mono w-7 text-right">{Math.round(track.volume * 100)}%</span>
                                  {/* Pan */}
                                  <input
                                    type="range" min="-1" max="1" step="0.05" value={track.pan}
                                    onChange={e => updateAudioTrack(track.id, { pan: parseFloat(e.target.value) })}
                                    className="w-10 h-1 accent-green-400"
                                    title={`Pan: ${track.pan > 0 ? "R" : track.pan < 0 ? "L" : "C"}${Math.abs(Math.round(track.pan * 100))}`}
                                  />
                                  {/* Mute/Solo */}
                                  <button onClick={() => updateAudioTrack(track.id, { mute: !track.mute })} className={cn("text-[7px] font-bold px-0.5 rounded border", track.mute ? "border-red-500/40 bg-red-500/10 text-red-400" : "border-border/40 text-zinc-600 hover:text-zinc-300")}>M</button>
                                  <button onClick={() => updateAudioTrack(track.id, { solo: !track.solo })} className={cn("text-[7px] font-bold px-0.5 rounded border", track.solo ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-400" : "border-border/40 text-zinc-600 hover:text-zinc-300")}>S</button>
                                  <button onClick={() => deleteAudioTrack(track.id)} className="opacity-0 group-hover:opacity-100 text-[7px] text-zinc-600 hover:text-red-400 transition-opacity">✕</button>
                                </div>

                                {/* #7 Rubber-band keyframes */}
                                {track.keyframes.length > 0 && (
                                  <div className="px-2.5 pb-1 flex items-center gap-1 flex-wrap">
                                    {[...track.keyframes].sort((a, b) => a.timestamp - b.timestamp).map(kf => (
                                      <div key={kf.id} className="flex items-center gap-0.5 bg-zinc-800/60 rounded px-1 py-0.5">
                                        <span className="text-[7px] font-mono text-zinc-400">{fmtTime(kf.timestamp)}</span>
                                        <span className="text-[7px] font-mono text-green-400">{Math.round(kf.volume * 100)}%</span>
                                        <button onClick={() => deleteKeyframe(kf.id)} className="text-[6px] text-zinc-600 hover:text-red-400">✕</button>
                                      </div>
                                    ))}
                                    <button
                                      onClick={() => { const ts = parseFloat(prompt("Add keyframe at timestamp (s):", currentTime.toFixed(2)) ?? "0"); const vol = parseFloat(prompt("Volume (0–200%):", "100") ?? "100") / 100; if (!isNaN(ts) && !isNaN(vol)) addAudioKeyframe(track.id, ts, vol); }}
                                      className="text-[7px] text-zinc-600 hover:text-green-300"
                                    >+ kf</button>
                                  </div>
                                )}
                                {track.keyframes.length === 0 && (
                                  <div className="px-2.5 pb-1">
                                    <button
                                      onClick={() => { const ts = parseFloat(prompt("Add keyframe at timestamp (s):", currentTime.toFixed(2)) ?? "0"); const vol = parseFloat(prompt("Volume (0–200%):", "100") ?? "100") / 100; if (!isNaN(ts) && !isNaN(vol)) addAudioKeyframe(track.id, ts, vol); }}
                                      className="text-[7px] text-zinc-600 hover:text-green-300 italic"
                                    >+ Add volume keyframe</button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── #17 Multicam view ──────────────────────────────────── */}
                  {multicamMode && (videos?.length ?? 0) > 0 && (
                    <div className="mt-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-indigo-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-400">Multicam</span>
                        <span className="text-[8px] text-zinc-500">{Math.min((videos?.length ?? 0), 4)} angles</span>
                        <span className="text-[7px] text-zinc-600 ml-auto">Click angle to cut to it</span>
                      </div>
                      <div className={cn("grid gap-1 p-1.5", (videos?.length ?? 0) > 2 ? "grid-cols-2" : "grid-cols-2")}>
                        {(videos ?? []).slice(0, 4).map((v, vi) => (
                          <div key={v.id}
                            className={cn("relative rounded overflow-hidden bg-zinc-900 cursor-pointer border-2 transition-all", selectedSegment && (segments ?? []).find(s => s.id === selectedSegment)?.videoId === v.id ? "border-indigo-400" : "border-transparent hover:border-indigo-500/50")}
                            onClick={() => {
                              // #17 Cut to this angle: update selected segment to use this video
                              if (selectedSegment) {
                                fetch(`${API_BASE}/segments/${selectedSegment}`, {
                                  method: "PATCH", headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ videoId: v.id }),
                                }).then(() => refetchSegments());
                                toast({ title: `Cut to Cam ${vi + 1}`, description: v.filename, duration: 1500 });
                              } else {
                                toast({ title: "Select a clip first", description: "Click a clip in the list, then click an angle to cut to it", duration: 2000 });
                              }
                            }}
                            title={`Cam ${vi + 1}: ${v.filename} — Click to cut selected clip to this angle`}
                          >
                            <div className="aspect-video">
                              <img src={`${API_BASE}/videos/${v.id}/thumbnail.jpg`} alt={v.filename} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 flex items-center gap-1">
                              <span className="text-[7px] font-bold text-indigo-300">CAM {vi + 1}</span>
                              <span className="text-[6px] text-zinc-400 truncate">{v.filename.replace(/\.[^.]+$/, "")}</span>
                            </div>
                            {selectedSegment && (segments ?? []).find(s => s.id === selectedSegment)?.videoId === v.id && (
                              <div className="absolute top-0.5 right-0.5 text-[6px] bg-indigo-500 text-white rounded px-0.5 font-bold">ACTIVE</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── #20 Waveform zoom control ──────────────────────────── */}
                  {showAudioMixer && (
                    <div className="mt-1 flex items-center gap-2 px-0.5 text-[8px]">
                      <span className="text-zinc-500 shrink-0">Waveform Zoom:</span>
                      <input
                        type="range" min="1" max="8" step="0.5" value={waveformZoom}
                        onChange={e => setWaveformZoom(parseFloat(e.target.value))}
                        className="flex-1 h-1 accent-green-400"
                        title="#20 Zoom audio waveform lane independently of video timeline"
                      />
                      <span className="font-mono text-green-400 w-6 text-right">{waveformZoom}×</span>
                      <button onClick={() => setWaveformZoom(1)} className="text-zinc-600 hover:text-zinc-300 text-[7px]">↺</button>
                    </div>
                  )}

                  {/* ──────────────────────────────────────────────────────────
                      #22 CLIP STACK VIEW — takes grouped by source video/time
                  ────────────────────────────────────────────────────────── */}
                  {clipStackView && (videos?.length ?? 0) > 0 && (
                    <div className="mt-2 rounded-lg border border-teal-500/20 bg-teal-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-teal-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-teal-400">Clip Stack View</span>
                        <span className="text-[8px] text-zinc-500">All takes grouped by source</span>
                        <button onClick={() => setClipStackView(false)} className="ml-auto text-zinc-600 hover:text-zinc-300 text-[9px]">✕</button>
                      </div>
                      <div className="p-1.5 space-y-1.5">
                        {(videos ?? []).map(v => {
                          const vSegs = (segments ?? []).filter(s => s.videoId === v.id).sort((a, b) => a.startTime - b.startTime);
                          if (vSegs.length === 0) return null;
                          return (
                            <div key={v.id} className="space-y-0.5">
                              <p className="text-[7px] font-bold text-teal-300 truncate px-0.5">{v.filename.replace(/\.[^.]+$/, "")}</p>
                              {vSegs.map(seg => (
                                <div key={seg.id} onClick={() => setSelectedSegment(seg.id)} className={cn("flex items-center gap-1 px-1 py-0.5 rounded border text-[7px] cursor-pointer transition-colors", selectedSegment === seg.id ? "border-teal-400 bg-teal-500/10 text-teal-300" : "border-border/30 hover:border-teal-500/30 text-zinc-400")}>
                                  <div className="w-6 h-4 rounded overflow-hidden shrink-0 bg-zinc-900">
                                    <img src={`${API_BASE}/videos/${v.id}/thumbnail.jpg`} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                                  </div>
                                  <span className="font-mono">{seg.startTime.toFixed(1)}→{seg.endTime.toFixed(1)}s</span>
                                  <span className="truncate text-zinc-500">{seg.label ?? seg.segmentType}</span>
                                  <span className={cn("ml-auto w-1.5 h-1.5 rounded-full shrink-0", seg.included ? "bg-green-500" : "bg-red-500")} title={seg.included ? "included" : "excluded"} />
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ──────────────────────────────────────────────────────────
                      #27 COLLABORATION CURSORS — floating session badges
                  ────────────────────────────────────────────────────────── */}
                  {collabCursors.filter(c => c.sessionId !== mySessionId.current).length > 0 && (
                    <div className="mt-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-cyan-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-400">Live Collaborators</span>
                        <span className="text-[8px] text-zinc-500">{collabCursors.filter(c => c.sessionId !== mySessionId.current).length} online</span>
                      </div>
                      <div className="flex flex-wrap gap-1 p-1.5">
                        {collabCursors.filter(c => c.sessionId !== mySessionId.current).map(c => {
                          const colors = ["bg-rose-500", "bg-orange-500", "bg-amber-500", "bg-lime-500", "bg-cyan-500", "bg-blue-500", "bg-violet-500", "bg-pink-500"];
                          const colorIdx = c.sessionId.charCodeAt(0) % colors.length;
                          return (
                            <div key={c.sessionId} className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[7px] text-white font-bold", colors[colorIdx])} title={`Editing at ${fmtTime(parseFloat(c.clipIndex ?? "0"))}`}>
                              <div className="w-1.5 h-1.5 rounded-full bg-white/80 animate-pulse" />
                              {c.sessionId.slice(0, 6)}
                              {c.clipIndex && <span className="font-mono font-normal opacity-80">@{fmtTime(parseFloat(c.clipIndex ?? "0"))}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ──────────────────────────────────────────────────────────
                      #28 COMMENT THREADS PANEL
                  ────────────────────────────────────────────────────────── */}
                  {showComments && (
                    <div className="mt-2 rounded-lg border border-blue-500/20 bg-blue-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-blue-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-blue-400">Comment Threads</span>
                        <span className="text-[8px] text-zinc-500">{comments.length} total · {comments.filter(c => c.resolved !== "true").length} open</span>
                        <button onClick={() => setShowComments(false)} className="ml-auto text-zinc-600 hover:text-zinc-300 text-[9px]">✕</button>
                      </div>

                      {/* Add comment input */}
                      <div className="p-1.5 border-b border-blue-500/10">
                        {commentDraft ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1 text-[7px] text-zinc-500 font-mono">
                              <span>@{commentDraft.timecode.toFixed(2)}s</span>
                              <button onClick={() => setCommentDraft(d => d ? { ...d, timecode: parseFloat(currentTime.toFixed(3)) } : d)} className="text-blue-400 hover:text-blue-300">↻ use current time</button>
                            </div>
                            <textarea
                              value={commentDraft.text}
                              onChange={e => setCommentDraft(d => d ? { ...d, text: e.target.value } : d)}
                              placeholder="Write a comment…"
                              className="w-full text-[8px] bg-zinc-900/60 border border-blue-500/20 rounded px-1.5 py-1 text-zinc-300 placeholder-zinc-600 resize-none"
                              rows={2}
                            />
                            <div className="flex items-center gap-1">
                              <button
                                onClick={async () => {
                                  if (commentDraft.text.trim()) {
                                    await addComment(commentDraft.timecode, commentDraft.text.trim());
                                    setCommentDraft(null);
                                  }
                                }}
                                disabled={!commentDraft.text.trim()}
                                className="text-[8px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
                              >Post</button>
                              <button onClick={() => setCommentDraft(null)} className="text-[8px] px-2 py-0.5 rounded border border-border/40 text-zinc-500 hover:text-zinc-300">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setCommentDraft({ timecode: parseFloat(currentTime.toFixed(3)), text: "" })}
                            className="w-full text-left text-[8px] text-zinc-500 hover:text-zinc-300 font-mono italic border border-dashed border-blue-500/20 rounded px-2 py-1 hover:border-blue-500/40 transition-colors"
                          >+ Add comment at current time ({fmtTime(currentTime)})…</button>
                        )}
                      </div>

                      {/* Comment list */}
                      <div className="max-h-48 overflow-y-auto">
                        {comments.length === 0 && <p className="text-[8px] text-zinc-600 text-center py-3">No comments yet. Press C or click + above.</p>}
                        {[...comments].sort((a, b) => parseFloat(a.timecode) - parseFloat(b.timecode)).map(c => (
                          <div key={c.id} className={cn("flex items-start gap-1.5 px-2 py-1.5 border-b border-blue-500/5 last:border-0 transition-colors", c.resolved === "true" ? "opacity-40" : "")}>
                            <div className="flex flex-col items-center gap-0.5 shrink-0">
                              <span className="text-[6px] font-mono text-blue-400 font-bold">{fmtTime(parseFloat(c.timecode))}</span>
                              <div className="w-px h-3 bg-blue-500/20" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[8px] text-zinc-300 break-words">{c.text}</p>
                              <div className="flex items-center gap-1 mt-0.5">
                                <span className="text-[6px] text-zinc-600">{c.author ?? "anon"}</span>
                                {c.resolved !== "true" && (
                                  <button onClick={() => resolveComment(c.id)} className="text-[6px] text-green-500/70 hover:text-green-400 ml-auto">✓ Resolve</button>
                                )}
                                {c.resolved === "true" && <span className="text-[6px] text-zinc-600 ml-auto">✓ resolved</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ──────────────────────────────────────────────────────────
                      #29 VERSION HISTORY PANEL — per-clip edit history
                  ────────────────────────────────────────────────────────── */}
                  {versionHistoryTarget && (
                    <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-emerald-500/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-400">Version History</span>
                        <span className="text-[8px] text-zinc-500 truncate">{(segments ?? []).find(s => s.id === versionHistoryTarget)?.label ?? versionHistoryTarget.slice(0, 8)}</span>
                        <button onClick={() => setVersionHistoryTarget(null)} className="ml-auto text-zinc-600 hover:text-zinc-300 text-[9px]">✕</button>
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {versionHistory.length === 0 && (
                          <p className="text-[8px] text-zinc-600 text-center py-3">No edit history for this clip yet.</p>
                        )}
                        {versionHistory.map((v, vi) => (
                          <div key={v.id ?? vi} className="flex items-center gap-2 px-2 py-1.5 border-b border-emerald-500/5 last:border-0 hover:bg-emerald-500/5 transition-colors">
                            <div className="flex-1 min-w-0">
                              <p className="text-[8px] font-medium text-zinc-300">{v.action ?? `Edit ${vi + 1}`}</p>
                              <div className="flex gap-1 text-[6px] font-mono text-zinc-600">
                                {v.oldStartTime != null && <span>in: {parseFloat(v.oldStartTime).toFixed(2)}→{parseFloat(v.newStartTime ?? v.oldStartTime).toFixed(2)}</span>}
                                {v.oldEndTime != null && <span>out: {parseFloat(v.oldEndTime).toFixed(2)}→{parseFloat(v.newEndTime ?? v.oldEndTime).toFixed(2)}</span>}
                                {v.createdAt && <span className="ml-auto">{new Date(v.createdAt).toLocaleTimeString()}</span>}
                              </div>
                            </div>
                            <button
                              onClick={() => revertToEdit(v.id)}
                              className="shrink-0 text-[7px] px-1.5 py-0.5 rounded border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                              title="Revert this clip to this version"
                            >Revert</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ──────────────────────────────────────────────────────────
                      #30 NAMED CHECKPOINTS PANEL
                  ────────────────────────────────────────────────────────── */}
                  {showCheckpoints && (
                    <div className="mt-2 rounded-lg border border-emerald-600/20 bg-emerald-600/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-emerald-600/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-300">Named Checkpoints</span>
                        <span className="text-[8px] text-zinc-500">{checkpoints.length} saved</span>
                        <button onClick={() => setShowCheckpoints(false)} className="ml-auto text-zinc-600 hover:text-zinc-300 text-[9px]">✕</button>
                      </div>
                      <div className="p-1.5 border-b border-emerald-600/10">
                        <div className="flex gap-1">
                          <input
                            id="ckpt-name-input"
                            type="text"
                            placeholder="Checkpoint name…"
                            className="flex-1 text-[8px] bg-zinc-900/60 border border-emerald-600/20 rounded px-1.5 py-0.5 text-zinc-300 placeholder-zinc-600"
                            defaultValue=""
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                const val = (document.getElementById("ckpt-name-input") as HTMLInputElement)?.value?.trim();
                                if (val) { saveCheckpoint(val); (document.getElementById("ckpt-name-input") as HTMLInputElement).value = ""; }
                              }
                            }}
                          />
                          <button
                            onClick={() => {
                              const val = (document.getElementById("ckpt-name-input") as HTMLInputElement)?.value?.trim();
                              if (val) { saveCheckpoint(val); (document.getElementById("ckpt-name-input") as HTMLInputElement).value = ""; }
                            }}
                            className="shrink-0 text-[8px] px-2 py-0.5 rounded bg-emerald-700 text-white hover:bg-emerald-600"
                          >⛳ Save</button>
                        </div>
                      </div>
                      <div className="max-h-40 overflow-y-auto">
                        {checkpoints.length === 0 && <p className="text-[8px] text-zinc-600 text-center py-3">No checkpoints yet. Type a name + Save.</p>}
                        {[...checkpoints].reverse().map((ck, cki) => (
                          <div key={ck.id ?? cki} className="flex items-center gap-2 px-2 py-1.5 border-b border-emerald-600/5 last:border-0 hover:bg-emerald-600/5 transition-colors">
                            <div className="flex-1 min-w-0">
                              <p className="text-[8px] font-medium text-zinc-300 truncate">{ck.name}</p>
                              <p className="text-[6px] font-mono text-zinc-600">{ck.createdAt ? new Date(ck.createdAt).toLocaleString() : ""} · {ck.segmentCount ?? "?"} clips</p>
                            </div>
                            <button
                              onClick={() => restoreCheckpoint(ck.id)}
                              className="shrink-0 text-[7px] px-1.5 py-0.5 rounded border border-emerald-600/30 text-emerald-400 hover:bg-emerald-600/10 transition-colors"
                              title="Restore this checkpoint"
                            >↩ Restore</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ──────────────────────────────────────────────────────────
                      #26 EDL AUDIT LOG PANEL
                  ────────────────────────────────────────────────────────── */}
                  {showEDL && (
                    <div className="mt-2 rounded-lg border border-zinc-600/20 bg-zinc-900/40 overflow-hidden">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-600/10">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-300">Edit Decision Log</span>
                        <span className="text-[8px] text-zinc-500">{edlEntries.length} entries</span>
                        <button onClick={() => setShowEDL(false)} className="ml-auto text-zinc-600 hover:text-zinc-300 text-[9px]">✕</button>
                      </div>
                      <div className="max-h-52 overflow-y-auto">
                        {edlEntries.length === 0 && <p className="text-[8px] text-zinc-600 text-center py-3">No edits logged yet. Make cuts, trims, or moves to populate the EDL.</p>}
                        {[...edlEntries].reverse().map((entry, ei) => (
                          <div key={entry.id ?? ei} className="flex items-start gap-1.5 px-2 py-1.5 border-b border-zinc-700/20 last:border-0 hover:bg-zinc-800/20 transition-colors">
                            <div className="flex flex-col items-center shrink-0">
                              <span className="text-[6px] font-bold text-zinc-500 font-mono">{String(edlEntries.length - ei).padStart(3, "0")}</span>
                              <div className={cn("mt-0.5 px-1 py-0 rounded text-[5px] font-bold uppercase", {
                                cut: "bg-rose-500/20 text-rose-300",
                                trim: "bg-amber-500/20 text-amber-300",
                                move: "bg-sky-500/20 text-sky-300",
                                delete: "bg-red-500/20 text-red-400",
                                insert: "bg-green-500/20 text-green-300",
                                paste: "bg-violet-500/20 text-violet-300",
                              }[entry.action?.toLowerCase() ?? ""] ?? "bg-zinc-500/20 text-zinc-400")}>{entry.action}</div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[7px] text-zinc-300">{entry.description ?? `${entry.action} on segment ${(entry.segmentId ?? "").slice(0, 8)}`}</p>
                              <div className="flex gap-1 text-[6px] font-mono text-zinc-600">
                                {entry.oldValue && <span className="text-rose-400/60">{entry.oldValue}</span>}
                                {entry.oldValue && entry.newValue && <span>→</span>}
                                {entry.newValue && <span className="text-green-400/60">{entry.newValue}</span>}
                                {entry.createdAt && <span className="ml-auto">{new Date(entry.createdAt).toLocaleTimeString()}</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Keyboard shortcut legend ───────────────────────────── */}
                  <div className="text-[7px] text-zinc-700 font-mono space-y-0.5 px-0.5 pt-1 border-t border-border/20">
                    <p>J←·K pause·L→  ·  X ripple-del·E lift-del  ·  A range-start·S range-end</p>
                    <p>I mark-in·O mark-out  ·  M add-marker  ·  Z zoom-to-fit  ·  C add-comment</p>
                    <p>Hover clip → ◀▶ reverse · OF optical-flow · ❚❚ freeze · C copy-grade · ⏩ speed-ramp</p>
                  </div>

                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="audio" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-3">
                <div className="space-y-4">
                  <Card className="border-border bg-card shadow-sm overflow-hidden">
                    <CardHeader className="p-3 bg-accent/30 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Ear className="h-4 w-4 text-cyan-500" />
                        <CardTitle className="text-xs">AI Audio Enhancement</CardTitle>
                      </div>
                      <CardDescription className="text-[10px]">Generate deep enhancement recipes</CardDescription>
                    </CardHeader>
                    <CardContent className="p-3 space-y-4">
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { id: 'cinematic', icon: Sparkles, label: 'Cinematic' },
                          { id: 'podcast', icon: Mic2, label: 'Podcast' },
                          { id: 'wedding', icon: Music2, label: 'Wedding' },
                          { id: 'social', icon: Radio, label: 'Social' },
                          { id: 'raw', icon: Wind, label: 'Raw' },
                        ].map(preset => (
                          <Button 
                            key={preset.id}
                            variant="outline" 
                            size="sm" 
                            className="h-10 flex flex-col gap-0.5 items-center justify-center text-[9px] font-bold uppercase"
                            disabled={isJobRunning('enhance_audio')}
                            onClick={() => handleRunJob('enhance_audio', undefined, preset.id)}
                          >
                            <preset.icon className="h-3 w-3" />
                            {preset.label}
                          </Button>
                        ))}
                      </div>

                      {isJobRunning('enhance_audio') && (
                        <div className="flex flex-col items-center justify-center p-4 gap-3 bg-accent/10 rounded-lg animate-pulse">
                          <Loader2 className="h-6 w-6 animate-spin text-cyan-500" />
                          <p className="text-[10px] text-center text-muted-foreground uppercase font-bold tracking-wider">AI is analyzing audio...</p>
                        </div>
                      )}

                      {audioEnhancementPlan && !isJobRunning('enhance_audio') && (
                        <div className="space-y-4 pt-2 border-t border-border animate-in fade-in duration-500">
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant="secondary" className="text-[8px] uppercase bg-cyan-500/10 text-cyan-600 border-cyan-500/20">
                              Noise: {audioEnhancementPlan.noiseReduction}
                            </Badge>
                            <Badge variant="secondary" className="text-[8px] uppercase">
                              Loudness: {audioEnhancementPlan.loudnessTarget}
                            </Badge>
                            <Badge variant="secondary" className="text-[8px] uppercase">
                              Voice: {audioEnhancementPlan.voiceEnhancement}
                            </Badge>
                            <Badge variant="secondary" className="text-[8px] uppercase">
                              Reverb: {audioEnhancementPlan.deReverb}
                            </Badge>
                            <Badge variant="secondary" className="text-[8px] uppercase">
                              EQ: {audioEnhancementPlan.eqProfile}
                            </Badge>
                            <Badge variant="secondary" className="text-[8px] uppercase">
                              Stems: {audioEnhancementPlan.stemSeparation}
                            </Badge>
                          </div>
                          
                          <div className="p-2 rounded bg-accent/30 border border-border">
                            <h4 className="text-[9px] uppercase font-bold text-muted-foreground mb-1">AI Reasoning</h4>
                            <p className="text-[10px] italic leading-relaxed text-zinc-400">"{audioEnhancementPlan.aiReasoning}"</p>
                          </div>

                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="w-full text-[9px] h-7 uppercase font-bold"
                            onClick={() => handleRunJob('enhance_audio')}
                          >
                            <ListRestart className="h-3 w-3 mr-1.5" /> Re-analyze Audio
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* ── #12–#16 Audio Processing Tools ─────────────────── */}
                  <Card className="border-border bg-card shadow-sm overflow-hidden">
                    <CardHeader className="p-3 bg-accent/30 border-b border-border">
                      <div className="flex items-center gap-2">
                        <AudioWaveform className="h-4 w-4 text-violet-400" />
                        <CardTitle className="text-xs">Audio Processing Tools</CardTitle>
                      </div>
                      <CardDescription className="text-[10px]">Drift fix, de-esser, wind noise, music ducking, voice isolation</CardDescription>
                    </CardHeader>
                    <CardContent className="p-3 space-y-3">

                      {/* #12 Drift Correction */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-violet-400">
                          <Activity className="h-2.5 w-2.5" /> #12 A/V Drift Correction
                        </div>
                        <p className="text-[8px] text-muted-foreground">Detects timing gaps &gt;200ms between consecutive clips — artifacts of re-encoded long recordings.</p>
                        <div className="flex gap-1">
                          <button
                            disabled={driftLoading}
                            className="flex-1 text-[9px] h-6 rounded border border-violet-500/30 text-violet-400 hover:bg-violet-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setDriftLoading(true); setDriftResult(null);
                              try { const r = await fetch(`${API_BASE}/projects/${projectId}/detect-drift`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixDrift: false }) }); setDriftResult(await r.json()); }
                              finally { setDriftLoading(false); }
                            }}
                          >{driftLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Scanning…</> : "Scan for Drift"}</button>
                          <button
                            disabled={driftLoading || !driftResult?.driftFound}
                            className="flex-1 text-[9px] h-6 rounded border border-violet-500/50 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setDriftLoading(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/detect-drift`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixDrift: true }) });
                                const d = await r.json(); setDriftResult(d);
                                refetchSegments?.();
                                toast({ title: "Drift corrected", description: d.message, duration: 2500 });
                              } finally { setDriftLoading(false); }
                            }}
                          >Fix Drift</button>
                        </div>
                        {driftResult && (
                          <div className={cn("text-[8px] rounded px-2 py-1 border", driftResult.driftFound === 0 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : "text-amber-400 bg-amber-500/10 border-amber-500/20")}>
                            {driftResult.message}
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border/30" />

                      {/* #13 De-esser */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-pink-400">
                          <Mic2 className="h-2.5 w-2.5" /> #13 De-esser
                        </div>
                        <p className="text-[8px] text-muted-foreground">Reduces harsh sibilance (S/SH sounds) via a 5–7kHz frequency sidechain compressor on render.</p>
                        <div className="flex gap-1">
                          {(["off","light","medium","heavy"] as const).map(s => (
                            <button key={s}
                              className={cn("flex-1 text-[7px] h-5 rounded border transition-colors capitalize",
                                deesserStrength === s ? "border-pink-500/60 bg-pink-500/10 text-pink-400" : "border-border/40 text-zinc-500 hover:border-pink-500/30")}
                              onClick={() => { setDeesserStrength(s); setDeesserSaved(false); }}
                            >{s}</button>
                          ))}
                        </div>
                        <button
                          disabled={deesserSaving}
                          className="w-full text-[9px] h-6 rounded border border-pink-500/40 text-pink-400 hover:bg-pink-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                          onClick={async () => {
                            setDeesserSaving(true); setDeesserSaved(false);
                            try {
                              await fetch(`${API_BASE}/projects/${projectId}/deesser`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strength: deesserStrength }) });
                              setDeesserSaved(true);
                              toast({ title: `De-esser: ${deesserStrength}`, description: deesserStrength === "off" ? "Disabled" : "Saved — applied on next render", duration: 2000 });
                            } finally { setDeesserSaving(false); }
                          }}
                        >{deesserSaving ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Saving…</> : deesserSaved ? "✓ Saved" : "Save De-esser Setting"}</button>
                      </div>

                      <div className="border-t border-border/30" />

                      {/* #14 Wind Noise */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-sky-400">
                          <Wind className="h-2.5 w-2.5" /> #14 Wind Noise Detection
                        </div>
                        <p className="text-[8px] text-muted-foreground">Flags outdoor clips with wind rumble. Applies highpass+afftdn filter on render.</p>
                        <div className="flex gap-1">
                          <button disabled={windLoading} className="flex-1 text-[9px] h-6 rounded border border-sky-500/30 text-sky-400 hover:bg-sky-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setWindLoading(true); setWindResult(null);
                              try { const r = await fetch(`${API_BASE}/projects/${projectId}/detect-wind-noise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applyFix: false }) }); setWindResult(await r.json()); }
                              finally { setWindLoading(false); }
                            }}
                          >{windLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />…</> : "Detect"}</button>
                          <button disabled={windLoading || !windResult?.flaggedCount} className="flex-1 text-[9px] h-6 rounded border border-sky-500/50 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setWindLoading(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/detect-wind-noise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applyFix: true }) });
                                const d = await r.json(); setWindResult(d);
                                toast({ title: "Wind filter saved", description: d.message, duration: 2500 });
                              } finally { setWindLoading(false); }
                            }}
                          >Apply Fix</button>
                        </div>
                        {windResult && (
                          <div className={cn("text-[8px] rounded px-2 py-1 border", windResult.flaggedCount === 0 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : "text-sky-400 bg-sky-500/10 border-sky-500/20")}>
                            {windResult.message}
                            {windResult.flaggedClips.length > 0 && (
                              <ul className="mt-1 space-y-0.5">{windResult.flaggedClips.slice(0, 3).map((c, i) => <li key={i} className="text-[7px] text-zinc-500">• {c.label}</li>)}</ul>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border/30" />

                      {/* #15 Audio Ducking */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-[9px] font-semibold text-amber-400">
                            <Volume2 className="h-2.5 w-2.5" /> #15 Music Ducking on Transitions
                          </div>
                          <button
                            onClick={() => setDuckingEnabled(v => !v)}
                            className={cn("text-[8px] h-5 px-2 rounded border transition-colors", duckingEnabled ? "border-amber-500/40 bg-amber-500/10 text-amber-400" : "border-zinc-700/40 text-zinc-500 hover:border-amber-500/20")}
                          >{duckingEnabled ? "ON" : "OFF"}</button>
                        </div>
                        <p className="text-[8px] text-muted-foreground">Gradually ducks background music volume 2s before each cut, restores 1s after — avoids jarring audio jumps.</p>
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-zinc-500 w-14">Duck to:</span>
                          <input type="range" min={0} max={0.8} step={0.05} value={duckingLevel}
                            onChange={e => { setDuckingLevel(parseFloat(e.target.value)); setDuckingResult(null); }}
                            className="flex-1 h-1.5 accent-amber-400"
                          />
                          <span className="text-[8px] text-amber-400 w-10">{Math.round(duckingLevel * 100)}%</span>
                        </div>
                        <button
                          disabled={duckingLoading}
                          className="w-full text-[9px] h-6 rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                          onClick={async () => {
                            setDuckingLoading(true); setDuckingResult(null);
                            try {
                              const r = await fetch(`${API_BASE}/projects/${projectId}/apply-ducking`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duckLevel: duckingLevel, enabled: duckingEnabled, duckLeadSec: 2, restoreDelaySec: 1 }) });
                              const d = await r.json(); setDuckingResult(d);
                              toast({ title: duckingEnabled ? "Ducking applied" : "Ducking disabled", description: d.message, duration: 2500 });
                            } finally { setDuckingLoading(false); }
                          }}
                        >{duckingLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Applying…</> : "Apply Ducking"}</button>
                        {duckingResult && <p className="text-[8px] text-amber-400">{duckingResult.message}</p>}
                      </div>

                      <div className="border-t border-border/30" />

                      {/* #16 Voice Isolation */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-emerald-400">
                          <Mic2 className="h-2.5 w-2.5" /> #16 Voice Isolation
                        </div>
                        <p className="text-[8px] text-muted-foreground">AI-powered noise reduction + voice frequency band isolation. Applies via FFmpeg afftdn + EQ chain on render.</p>
                        <div className="flex gap-1">
                          {(["off","gentle","strong","max"] as const).map(s => (
                            <button key={s}
                              className={cn("flex-1 text-[7px] h-5 rounded border transition-colors capitalize",
                                voiceIsoStrength === s ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-400" : "border-border/40 text-zinc-500 hover:border-emerald-500/30")}
                              onClick={() => { setVoiceIsoStrength(s); setVoiceIsoSaved(false); }}
                            >{s}</button>
                          ))}
                        </div>
                        <button
                          disabled={voiceIsoSaving}
                          className="w-full text-[9px] h-6 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                          onClick={async () => {
                            setVoiceIsoSaving(true); setVoiceIsoSaved(false);
                            try {
                              await fetch(`${API_BASE}/projects/${projectId}/voice-isolation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strength: voiceIsoStrength }) });
                              setVoiceIsoSaved(true);
                              toast({ title: `Voice isolation: ${voiceIsoStrength}`, description: voiceIsoStrength === "off" ? "Disabled" : "Filter saved for render", duration: 2000 });
                            } finally { setVoiceIsoSaving(false); }
                          }}
                        >{voiceIsoSaving ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Saving…</> : voiceIsoSaved ? "✓ Saved" : "Save Voice Isolation"}</button>
                      </div>

                    </CardContent>
                  </Card>

                  {/* ── #17–#18 Music Intelligence ─────────────────────── */}
                  <Card className="border-border bg-card shadow-sm overflow-hidden">
                    <CardHeader className="p-3 bg-accent/30 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Music2 className="h-4 w-4 text-pink-400" />
                        <CardTitle className="text-xs">Music Intelligence</CardTitle>
                      </div>
                      <CardDescription className="text-[10px]">Mood-matched music from Jamendo · Key detection · Clash prevention</CardDescription>
                    </CardHeader>
                    <CardContent className="p-3 space-y-3">

                      {/* #17 Jamendo Music Suggestions */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-pink-400">
                          <Radio className="h-2.5 w-2.5" /> #17 Background Music Suggestions
                        </div>
                        <p className="text-[8px] text-muted-foreground">Claude analyzes your video mood, queries Jamendo's royalty-free library, returns matching tracks with preview links.</p>
                        <button
                          disabled={musicMoodLoading}
                          className="w-full text-[9px] h-6 rounded border border-pink-500/40 text-pink-400 hover:bg-pink-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                          onClick={async () => {
                            setMusicMoodLoading(true); setMusicMoodResult(null);
                            try {
                              const r = await fetch(`${API_BASE}/projects/${projectId}/suggest-music-jamendo`, { method: "POST" });
                              const d = await r.json(); setMusicMoodResult(d);
                            } catch { toast({ title: "Music suggestion failed", variant: "destructive" }); }
                            finally { setMusicMoodLoading(false); }
                          }}
                        >{musicMoodLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Analyzing mood…</> : <><Sparkles className="h-2.5 w-2.5" />Suggest Music</>}</button>

                        {musicMoodResult && (
                          <div className="space-y-1.5">
                            <div className="flex gap-1 flex-wrap">
                              <span className="text-[7px] bg-pink-500/10 border border-pink-500/20 text-pink-400 rounded px-1.5 py-0.5">🎭 {musicMoodResult.mood}</span>
                              <span className="text-[7px] bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-1.5 py-0.5">⚡ {musicMoodResult.energy} energy</span>
                              {musicMoodResult.tracks.length > 0 && <span className="text-[7px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded px-1.5 py-0.5">🎵 {musicMoodResult.tracks.length} tracks</span>}
                            </div>
                            {musicMoodResult.tracks.length > 0 ? (
                              <div className="space-y-1 max-h-48 overflow-y-auto">
                                {musicMoodResult.tracks.map(track => (
                                  <div key={track.id} className="flex items-center gap-2 p-1.5 rounded border border-border/40 bg-card/30 hover:border-pink-500/20 transition-colors">
                                    {track.imageUrl && <img src={track.imageUrl} alt={track.name} className="w-7 h-7 rounded object-cover shrink-0" />}
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[9px] font-medium text-zinc-200 truncate">{track.name}</div>
                                      <div className="text-[7px] text-zinc-500 truncate">{track.artist} · {Math.floor(track.duration / 60)}:{String(Math.round(track.duration % 60)).padStart(2,'0')}</div>
                                    </div>
                                    <div className="flex gap-1 shrink-0">
                                      {track.audioUrl && <a href={track.audioUrl} target="_blank" rel="noreferrer" className="text-[7px] text-pink-400 hover:text-pink-300 border border-pink-500/30 rounded px-1 py-0.5">▶</a>}
                                      {track.shareUrl && <a href={track.shareUrl} target="_blank" rel="noreferrer" className="text-[7px] text-zinc-500 hover:text-zinc-300 border border-border/40 rounded px-1 py-0.5">↗</a>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[8px] text-zinc-500">{musicMoodResult.message}</p>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border/30" />

                      {/* #18 Music Key Detection */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-cyan-400">
                          <Music className="h-2.5 w-2.5" /> #18 Music Key Detection
                        </div>
                        <p className="text-[8px] text-muted-foreground">AI infers the probable musical key from your project's mood and genre, suggests compatible transition keys to avoid harmonic clashes.</p>
                        <button
                          disabled={musicKeyLoading}
                          className="w-full text-[9px] h-6 rounded border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                          onClick={async () => {
                            setMusicKeyLoading(true); setMusicKeyResult(null);
                            try { const r = await fetch(`${API_BASE}/projects/${projectId}/detect-music-key`, { method: "POST" }); setMusicKeyResult(await r.json()); }
                            catch { toast({ title: "Key detection failed", variant: "destructive" }); }
                            finally { setMusicKeyLoading(false); }
                          }}
                        >{musicKeyLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Analyzing…</> : "Detect Music Key"}</button>
                        {musicKeyResult && (
                          <div className="space-y-1 p-2 rounded border border-cyan-500/20 bg-cyan-500/5">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-cyan-300">{musicKeyResult.detectedKey}</span>
                              <span className="text-[7px] text-zinc-500">Compatible: {musicKeyResult.compatibleKeys.slice(0,4).join(", ")}</span>
                            </div>
                            <p className="text-[7px] text-zinc-500 leading-snug">{musicKeyResult.transitionTip}</p>
                          </div>
                        )}
                      </div>

                    </CardContent>
                  </Card>

                  {/* ── #19–#20 Beat Grid & SFX ─────────────────────────── */}
                  <Card className="border-border bg-card shadow-sm overflow-hidden">
                    <CardHeader className="p-3 bg-accent/30 border-b border-border">
                      <div className="flex items-center gap-2">
                        <AudioWaveform className="h-4 w-4 text-purple-400" />
                        <CardTitle className="text-xs">Beat Grid & SFX Library</CardTitle>
                      </div>
                      <CardDescription className="text-[10px]">Musical beat grid overlay · One-click sound effects at cut points</CardDescription>
                    </CardHeader>
                    <CardContent className="p-3 space-y-3">

                      {/* #19 Beat Grid */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-[9px] font-semibold text-purple-400">
                            <Activity className="h-2.5 w-2.5" /> #19 Beat Grid Visualization
                          </div>
                          {beatGridConfig && (
                            <span className="text-[7px] bg-purple-500/10 border border-purple-500/20 text-purple-400 rounded px-1.5 py-0.5">
                              {beatGridConfig.bpm} BPM · {beatGridConfig.source}
                            </span>
                          )}
                        </div>
                        <p className="text-[8px] text-muted-foreground">Shows musical beat grid overlaid on the timeline. Helps snap cuts to rhythmic beats for music-driven editing.</p>
                        <div className="flex gap-1">
                          <button
                            disabled={beatGridLoading}
                            className="flex-1 text-[9px] h-6 rounded border border-purple-500/30 text-purple-400 hover:bg-purple-500/10 disabled:opacity-40 flex items-center justify-center gap-1"
                            onClick={async () => {
                              setBeatGridLoading(true);
                              try { const r = await fetch(`${API_BASE}/projects/${projectId}/beat-grid-config`); setBeatGridConfig(await r.json()); setShowBeatGridViz(true); }
                              finally { setBeatGridLoading(false); }
                            }}
                          >{beatGridLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Loading…</> : "Load Beat Grid"}</button>
                          {beatGridConfig && (
                            <button className="flex-1 text-[9px] h-6 rounded border border-purple-500/40 bg-purple-500/10 text-purple-400 flex items-center justify-center gap-1" onClick={() => setShowBeatGridViz(v => !v)}>
                              {showBeatGridViz ? "Hide" : "Show"} Grid
                            </button>
                          )}
                        </div>
                        {beatGridConfig && showBeatGridViz && (
                          <div className="space-y-1">
                            <div className="h-6 rounded bg-black/30 border border-purple-500/20 overflow-hidden relative">
                              <div className="h-full flex items-end px-0.5 gap-px">
                                {beatGridConfig.beats.slice(0, 60).map((b, i) => {
                                  const isDownbeat = i % 4 === 0;
                                  return (
                                    <div
                                      key={i}
                                      className={cn("shrink-0 rounded-t-sm", isDownbeat ? "w-px bg-purple-400" : "w-px bg-purple-700/60")}
                                      style={{ height: isDownbeat ? "85%" : "40%" }}
                                      title={`Beat ${i + 1} @ ${b.toFixed(2)}s`}
                                    />
                                  );
                                })}
                              </div>
                              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="text-[7px] text-purple-400/60 font-mono">{beatGridConfig.beats.length} beats shown</span>
                              </div>
                            </div>
                            <div className="flex gap-2 text-[7px] text-zinc-600">
                              <span className="flex items-center gap-0.5"><span className="inline-block w-px h-3 bg-purple-400 rounded" />Downbeat (bar 1)</span>
                              <span className="flex items-center gap-0.5"><span className="inline-block w-px h-2 bg-purple-700/60 rounded" />Beat</span>
                              <span className="ml-auto">{beatGridConfig.note}</span>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border/30" />

                      {/* #20 SFX Library */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-orange-400">
                          <Layers className="h-2.5 w-2.5" /> #20 SFX Library
                        </div>
                        <p className="text-[8px] text-muted-foreground">One-click sound effect markers at cut points. Auto-place mode puts selected SFX at every cut simultaneously.</p>

                        {/* Load SFX library */}
                        {!sfxMarkersLoaded && (
                          <button
                            className="w-full text-[9px] h-6 rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 flex items-center justify-center gap-1"
                            onClick={async () => {
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/sfx-markers`);
                                const d = await r.json();
                                setSfxMarkers(d.markers ?? []);
                                setSfxLibrary(d.library ?? []);
                                setSfxMarkersLoaded(true);
                              } catch { toast({ title: "Failed to load SFX library", variant: "destructive" }); }
                            }}
                          >Load SFX Library</button>
                        )}

                        {sfxMarkersLoaded && (
                          <div className="space-y-2">
                            <div className="grid grid-cols-4 gap-1">
                              {sfxLibrary.map(sfx => (
                                <button
                                  key={sfx.id}
                                  title={sfx.description}
                                  className={cn("text-[7px] h-8 rounded border flex flex-col items-center justify-center gap-0.5 transition-colors",
                                    sfxSelectedType === sfx.id ? "border-orange-500/60 bg-orange-500/10 text-orange-400" : "border-border/40 text-zinc-500 hover:border-orange-500/20")}
                                  onClick={() => setSfxSelectedType(sfx.id)}
                                >
                                  <span>{sfx.icon}</span>
                                  <span>{sfx.label}</span>
                                </button>
                              ))}
                            </div>

                            <div className="flex gap-1">
                              <button
                                disabled={sfxPlacing}
                                className="flex-1 text-[9px] h-6 rounded border border-orange-500/40 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 disabled:opacity-40 flex items-center justify-center gap-1"
                                onClick={async () => {
                                  setSfxPlacing(true);
                                  try {
                                    const r = await fetch(`${API_BASE}/projects/${projectId}/sfx-markers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ts: currentTime, type: sfxSelectedType, autoPlace: false, volume: 0.7 }) });
                                    const d = await r.json();
                                    setSfxMarkers(d.markers ?? []);
                                    toast({ title: `SFX: ${sfxSelectedType} placed`, description: `At ${currentTime.toFixed(2)}s`, duration: 1500 });
                                  } finally { setSfxPlacing(false); }
                                }}
                              >{sfxPlacing ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />…</> : <><Zap className="h-2.5 w-2.5" />Place at Cursor</>}</button>
                              <button
                                disabled={sfxPlacing}
                                className="flex-1 text-[9px] h-6 rounded border border-orange-500/60 bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 disabled:opacity-40 flex items-center justify-center gap-1"
                                onClick={async () => {
                                  setSfxPlacing(true);
                                  try {
                                    const r = await fetch(`${API_BASE}/projects/${projectId}/sfx-markers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ts: 0, type: sfxSelectedType, autoPlace: true, volume: 0.7 }) });
                                    const d = await r.json();
                                    setSfxMarkers(d.markers ?? []);
                                    toast({ title: `Auto-placed ${sfxSelectedType}`, description: `${d.added} SFX markers at cut points`, duration: 2500 });
                                  } finally { setSfxPlacing(false); }
                                }}
                              >{sfxPlacing ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />…</> : "Auto-place All Cuts"}</button>
                            </div>

                            {sfxMarkers.length > 0 && (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[8px] text-zinc-500">{sfxMarkers.length} SFX marker{sfxMarkers.length !== 1 ? "s" : ""}</span>
                                  <button
                                    className="text-[7px] text-zinc-600 hover:text-red-400"
                                    onClick={async () => {
                                      await fetch(`${API_BASE}/projects/${projectId}/sfx-markers`, { method: "DELETE" });
                                      setSfxMarkers([]);
                                      toast({ title: "All SFX markers cleared", duration: 1500 });
                                    }}
                                  >Clear all</button>
                                </div>
                                <div className="h-6 rounded bg-black/20 border border-border/40 overflow-hidden relative">
                                  {sfxMarkers.slice(0, 40).map((m, i) => {
                                    const totalDur = (segments ?? []).reduce((acc, s) => acc + ((s.outPoint ?? 0) - (s.inPoint ?? 0)), 0) || 60;
                                    const pct = Math.min(100, (m.ts / totalDur) * 100);
                                    return (
                                      <div key={i} className="absolute top-0 bottom-0 w-0.5 bg-orange-400/70" style={{ left: `${pct}%` }} title={`${m.type} @ ${m.ts.toFixed(1)}s`} />
                                    );
                                  })}
                                </div>
                                <div className="flex flex-wrap gap-1 max-h-12 overflow-y-auto">
                                  {sfxMarkers.slice(0, 8).map((m, i) => (
                                    <span key={i} className="text-[7px] bg-orange-500/10 border border-orange-500/20 text-orange-400 rounded px-1 py-0.5 flex items-center gap-0.5">
                                      {m.label} @{m.ts.toFixed(1)}s
                                      <button className="ml-0.5 text-zinc-600 hover:text-red-400" onClick={async () => {
                                        await fetch(`${API_BASE}/projects/${projectId}/sfx-markers/${m.ts}`, { method: "DELETE" });
                                        setSfxMarkers(p => p.filter((_, j) => j !== i));
                                      }}>✕</button>
                                    </span>
                                  ))}
                                  {sfxMarkers.length > 8 && <span className="text-[7px] text-zinc-600">+{sfxMarkers.length - 8} more</span>}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                    </CardContent>
                  </Card>

                  {/* ── #22 + #24 Stem Analysis & Multitrack Export ──────── */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3">
                      <CardTitle className="text-xs flex items-center gap-1.5">
                        <Layers className="h-3 w-3 text-cyan-400" />
                        Stem Analysis &amp; Multitrack Export
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-3 pb-3 space-y-3">

                      {/* #24 Detect stems */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1 text-[8px] text-zinc-400 uppercase tracking-wide font-semibold">
                          <Activity className="h-2.5 w-2.5 text-cyan-400" /> #24 Auto-Detect Stems per Clip
                        </div>
                        <p className="text-[9px] text-zinc-500">Classifies each clip as dialogue, music, SFX, ambience, or mixed. Results appear as badges on clip cards.</p>
                        <div className="flex items-center gap-2">
                          <button
                            disabled={stemDetecting}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-cyan-600/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-600/30 disabled:opacity-50"
                            onClick={async () => {
                              setStemDetecting(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${projectId}/detect-stems`, { method: "POST" });
                                const d = await r.json();
                                setStemCounts(d.counts);
                                refetchSegments();
                                toast({ title: "Stems classified", description: d.message, duration: 3000 });
                              } catch { toast({ title: "Stem detection failed", variant: "destructive", duration: 2500 }); }
                              finally { setStemDetecting(false); }
                            }}
                          >{stemDetecting ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Detecting…</> : <><Activity className="h-2.5 w-2.5" />Detect All Stems</>}</button>
                        </div>
                        {stemCounts && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {Object.entries(stemCounts).map(([type, count]) => {
                              const icons: Record<string, string> = { dialogue: "🎙", music: "🎵", sfx: "⚡", ambience: "🌊", mixed: "⊕" };
                              return (
                                <span key={type} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
                                  {icons[type] ?? ""} {type} <span className="text-zinc-500">×{count}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="h-px bg-border/30" />

                      {/* #22 Export stems */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1 text-[8px] text-zinc-400 uppercase tracking-wide font-semibold">
                          <Music className="h-2.5 w-2.5 text-fuchsia-400" /> #22 Multitrack Stem Export
                        </div>
                        <p className="text-[9px] text-zinc-500">Export dialogue, music, SFX, and full mix as separate 48kHz stereo WAV stems. Requires a rendered MP4 first.</p>
                        <button
                          disabled={stemExporting}
                          className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-fuchsia-600/20 border border-fuchsia-500/30 text-fuchsia-300 hover:bg-fuchsia-600/30 disabled:opacity-50"
                          onClick={async () => {
                            setStemExporting(true);
                            setStemFiles(null);
                            try {
                              const r = await fetch(`${API_BASE}/projects/${projectId}/export-stems`, { method: "POST" });
                              const d = await r.json();
                              if (d.renderRequired) {
                                toast({ title: "Render first", description: "Please render your project before exporting stems.", variant: "destructive", duration: 4000 });
                              } else {
                                setStemFiles(d.stems);
                                toast({ title: "Stems exported", description: d.message, duration: 3000 });
                              }
                            } catch { toast({ title: "Export failed", variant: "destructive", duration: 2500 }); }
                            finally { setStemExporting(false); }
                          }}
                        >{stemExporting ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Exporting…</> : <><Layers className="h-2.5 w-2.5" />Export All Stems</>}</button>

                        {stemFiles && (
                          <div className="grid grid-cols-2 gap-1 mt-1.5">
                            {Object.entries(stemFiles).map(([stem, info]) => {
                              const stemLabels: Record<string, string> = { dialogue: "🎙 Dialogue", music: "🎵 Music", sfx: "⚡ SFX", fullmix: "🔊 Full Mix" };
                              return (
                                <div key={stem} className="flex items-center justify-between px-2 py-1 rounded bg-zinc-900 border border-zinc-800">
                                  <span className="text-[8px] text-zinc-300">{stemLabels[stem] ?? stem}</span>
                                  {info.status === "ready" && info.downloadUrl ? (
                                    <a
                                      href={`${API_BASE}${info.downloadUrl}`}
                                      download={`${stem}.wav`}
                                      className="text-[8px] font-semibold text-fuchsia-400 hover:text-fuchsia-300 underline"
                                    >↓ WAV</a>
                                  ) : (
                                    <span className="text-[8px] text-red-400">{info.status}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* #23 Audio scrubbing info */}
                      <div className="h-px bg-border/30" />
                      <div className="flex items-start gap-2 p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
                        <Activity className="h-3 w-3 text-emerald-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[9px] font-semibold text-emerald-300">#23 Audio Scrubbing Active</p>
                          <p className="text-[8px] text-zinc-500 mt-0.5">Arrow key or keyboard seek plays 130ms of pitch-corrected audio at the playhead position (while paused). Uses the source clip's stream directly.</p>
                        </div>
                      </div>

                    </CardContent>
                  </Card>

                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="script" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              {/* ── #20 CMD+F search bar ─────────────────────────────────── */}
              {txSearchOpen && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-blue-500/30 bg-blue-500/5 shrink-0">
                  <Search className="h-3 w-3 text-blue-400 shrink-0" />
                  <input
                    ref={txSearchInputRef}
                    type="text"
                    value={txSearchQuery}
                    onChange={e => { setTxSearchQuery(e.target.value); setTxSearchMatchIdx(0); }}
                    placeholder="Search transcripts…"
                    className="flex-1 bg-transparent text-[10px] text-zinc-200 placeholder:text-zinc-600 outline-none"
                  />
                  {txSearchQuery && (
                    <span className="text-[8px] text-zinc-500 font-mono shrink-0">
                      {(() => {
                        const q = txSearchQuery.toLowerCase();
                        const allSegs = (videos ?? []).flatMap(v => { try { return JSON.parse(v.transcript!).segments ?? []; } catch { return []; } });
                        const count = allSegs.filter((s: any) => s.text.toLowerCase().includes(q)).length;
                        return `${count} match${count !== 1 ? "es" : ""}`;
                      })()}
                    </span>
                  )}
                  <button onClick={() => { setTxSearchOpen(false); setTxSearchQuery(""); }} className="text-zinc-600 hover:text-zinc-300 text-[8px]">✕</button>
                </div>
              )}
              <ScrollArea className="flex-1 p-3">
                <div className="space-y-3">

                  {/* ── #2 Custom vocabulary ───────────────────────────────── */}
                  <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <BookOpen className="h-3 w-3 text-violet-400" />
                      <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400">Custom Vocabulary</p>
                      <span className="text-[8px] text-zinc-500">Terms to hint Whisper transcription</span>
                    </div>
                    <textarea
                      className="w-full text-[9px] text-zinc-300 bg-zinc-900/60 border border-zinc-700/50 rounded px-2 py-1 outline-none resize-none font-mono placeholder:text-zinc-600 focus:border-violet-500/50"
                      rows={2}
                      placeholder="e.g. Kubernetes, GPT-4o, TensorFlow (comma or newline separated)"
                      value={vocabInput}
                      onChange={e => setVocabInput(e.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" className="h-5 text-[8px] px-2 border-violet-500/30 text-violet-300 hover:bg-violet-500/10" onClick={saveVocabulary} disabled={vocabSaving}>
                        {vocabSaving ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </div>

                  {/* ── Source Transcripts (Whisper output) ───────────────── */}
                  {(() => {
                    const q = txSearchOpen ? txSearchQuery.toLowerCase() : "";
                    const transcribedVideos = (videos ?? []).filter(v => {
                      if (!v.transcript) return false;
                      try { const p = JSON.parse(v.transcript); return p.transcript && p.transcript.length > 0; } catch { return false; }
                    });
                    if (transcribedVideos.length === 0) return null;
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Mic2 className="h-3.5 w-3.5 text-blue-400" />
                          <p className="text-[10px] font-bold uppercase tracking-wider text-blue-400">Source Transcripts</p>
                          <span className="text-[8px] text-zinc-500 font-mono">{transcribedVideos.length} video{transcribedVideos.length !== 1 ? "s" : ""}</span>
                          {!txSearchOpen && (
                            <button onClick={() => { setTxSearchOpen(true); setTimeout(() => txSearchInputRef.current?.focus(), 50); }}
                              className="ml-auto text-[8px] text-zinc-600 hover:text-zinc-300 flex items-center gap-1">
                              <Search className="h-2.5 w-2.5" /> Search
                            </button>
                          )}
                        </div>
                        <div className="space-y-2">
                          {transcribedVideos.map(video => {
                            let txData: { transcript: string; segments?: Array<{ start: number; end: number; text: string; speaker?: string }>; wordCount?: number; language?: string; duration?: number } = { transcript: "" };
                            try { txData = JSON.parse(video.transcript!); } catch {}
                            const segs = txData.segments ?? [];
                            const isExpanded = expandedTranscripts.has(video.id);

                            // Find the latest completed transcribe job for this video (for diff)
                            const latestTxJob = (jobs ?? [])
                              .filter((j: any) => j.type === "transcribe" && j.videoId === video.id && j.status === "completed")
                              .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))[0] as any;
                            const txJobResult = latestTxJob?.result ? (() => { try { return JSON.parse(latestTxJob.result); } catch { return null; } })() : null;
                            const wordDiff: Array<{ op: string; text: string }> | null = txJobResult?.wordDiff ?? null;
                            const isDiffShown = showTxDiff.has(video.id);

                            // Find the latest completed diarize_speakers_v2 job for this video
                            const latestDiarizeJob = (jobs ?? [])
                              .filter((j: any) => j.type === "diarize_speakers_v2" && j.videoId === video.id && j.status === "completed")
                              .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))[0] as any;
                            const diarizeResult = latestDiarizeJob?.result ? (() => { try { return JSON.parse(latestDiarizeJob.result); } catch { return null; } })() : null;
                            const diarizeSegs: Array<{ start: number; end: number; speaker: string }> = diarizeResult?.segments ?? [];
                            const speakerColors: Record<string, string> = {};
                            const palette = ["text-rose-400", "text-sky-400", "text-amber-400", "text-emerald-400", "text-violet-400", "text-orange-400"];
                            diarizeSegs.forEach(s => { if (!speakerColors[s.speaker]) speakerColors[s.speaker] = palette[Object.keys(speakerColors).length % palette.length]; });

                            // Helper: highlight search match
                            const highlight = (text: string) => {
                              if (!q || !text.toLowerCase().includes(q)) return <span>{text}</span>;
                              const idx = text.toLowerCase().indexOf(q);
                              return <span>{text.slice(0, idx)}<mark className="bg-yellow-400/30 text-yellow-200 rounded-sm px-0.5">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</span>;
                            };

                            // Auto-expand if search has a match in this video
                            const hasSearchMatch = q && segs.some(s => s.text.toLowerCase().includes(q));
                            const effectiveExpanded = isExpanded || !!hasSearchMatch;

                            return (
                              <div key={video.id} className="rounded-lg border border-blue-500/20 bg-blue-500/5 overflow-hidden">
                                {/* Video header row */}
                                <button
                                  className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-blue-500/10 transition-colors text-left"
                                  onClick={() => toggleTranscript(video.id)}
                                >
                                  <Mic2 className="h-3 w-3 text-blue-400 shrink-0" />
                                  <span className="text-[10px] font-semibold text-zinc-200 flex-1 truncate">{video.originalName}</span>
                                  {diarizeSegs.length > 0 && (
                                    <span className="text-[8px] text-rose-300 font-mono shrink-0 mr-1">{Object.keys(speakerColors).length} speaker{Object.keys(speakerColors).length !== 1 ? "s" : ""}</span>
                                  )}
                                  <span className="text-[8px] text-zinc-500 font-mono shrink-0">
                                    {txData.wordCount ?? txData.transcript.split(" ").filter(Boolean).length} words
                                    {txData.language && txData.language !== "unknown" && ` · ${txData.language}`}
                                    {segs.length > 0 && ` · ${segs.length} segs`}
                                  </span>
                                  <ChevronRight className={cn("h-3 w-3 text-zinc-500 shrink-0 transition-transform", effectiveExpanded && "rotate-90")} />
                                </button>
                                {/* Transcript content */}
                                {effectiveExpanded && (
                                  <div className="px-2.5 pb-2.5 space-y-1 max-h-[400px] overflow-y-auto">
                                    {/* #3 Speaker legend */}
                                    {diarizeSegs.length > 0 && (
                                      <div className="flex flex-wrap gap-1.5 py-1 border-b border-rose-500/10 mb-1">
                                        {Object.entries(speakerColors).map(([spk, cls]) => (
                                          <span key={spk} className={cn("text-[8px] font-mono px-1.5 py-0.5 rounded-full border border-current/20", cls)}>{spk}</span>
                                        ))}
                                      </div>
                                    )}
                                    {segs.length > 0 ? (
                                      segs
                                        .filter(seg => !q || seg.text.toLowerCase().includes(q))
                                        .map((seg, i) => {
                                          // Match speaker from diarize result by overlapping time
                                          const _segEnd = (seg as any).end ?? (seg.start + 1);
                                          const matchedSpk = diarizeSegs.find(d => d.start <= (seg.start + _segEnd) / 2 && d.end >= seg.start)?.speaker;
                                          return (
                                            <div key={i} className="flex gap-2 group">
                                              <button
                                                className="shrink-0 font-mono text-[8px] text-blue-400/70 hover:text-blue-300 transition-colors pt-0.5 tabular-nums"
                                                title={`Seek video to ${fmtTime(seg.start)}`}
                                                onClick={() => {
                                                  setPreviewVideoId(video.id);
                                                  if (videoRef.current) videoRef.current.currentTime = seg.start;
                                                }}
                                              >
                                                [{fmtTime(seg.start)}]
                                              </button>
                                              {matchedSpk && (
                                                <span className={cn("shrink-0 text-[7px] font-mono mt-0.5 px-1 rounded-sm border border-current/20", speakerColors[matchedSpk])}>{matchedSpk}</span>
                                              )}
                                              <p className="text-[10px] text-zinc-300 leading-relaxed flex-1">{highlight(seg.text.trim())}</p>
                                            </div>
                                          );
                                        })
                                    ) : (
                                      /* No segments — show plain text (fallback for older transcripts) */
                                      <p className="text-[10px] text-zinc-300 leading-relaxed whitespace-pre-wrap">{txData.transcript}</p>
                                    )}
                                    {/* #4 Word diff view */}
                                    {wordDiff && wordDiff.length > 0 && (
                                      <div className="mt-1 pt-1 border-t border-blue-500/10">
                                        <button
                                          className={cn("text-[8px] transition-colors", isDiffShown ? "text-emerald-400 hover:text-zinc-300" : "text-zinc-500 hover:text-emerald-400")}
                                          onClick={() => toggleTxDiff(video.id)}
                                        >
                                          {isDiffShown ? "▼ Hide vocabulary diff" : "▶ Show vocabulary diff"}
                                        </button>
                                        {isDiffShown && (
                                          <div className="mt-1 p-1.5 rounded bg-zinc-900/60 border border-zinc-700/30 text-[9px] leading-relaxed font-mono break-all">
                                            {wordDiff.map((tok, k) => (
                                              <span key={k} className={tok.op === "+" ? "text-emerald-400 bg-emerald-500/10" : tok.op === "-" ? "text-red-400 line-through bg-red-500/10" : "text-zinc-400"}>
                                                {tok.text}{" "}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {/* Copy full text button */}
                                    <div className="pt-1 border-t border-blue-500/10">
                                      <button
                                        className="text-[8px] text-zinc-500 hover:text-zinc-300 transition-colors"
                                        onClick={() => { navigator.clipboard.writeText(txData.transcript); toast({ title: "Copied", description: "Transcript text copied to clipboard." }); }}
                                      >
                                        Copy full text
                                      </button>
                                      <span className="mx-2 text-zinc-700">·</span>
                                      <button
                                        className="text-[8px] text-amber-400/70 hover:text-amber-300 transition-colors"
                                        onClick={() => { setManuscriptText(prev => prev ? prev + "\n\n" + txData.transcript : txData.transcript); toast({ title: "Added to manuscript", description: "Transcript appended to your script." }); }}
                                      >
                                        Use as manuscript
                                      </button>
                                      {diarizeSegs.length === 0 && (
                                        <>
                                          <span className="mx-2 text-zinc-700">·</span>
                                          <button
                                            className="text-[8px] text-rose-400/70 hover:text-rose-300 transition-colors"
                                            onClick={() => handleRunJob("diarize_speakers_v2", video.id)}
                                          >
                                            Diarize speakers
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="h-px bg-border/50" />
                      </div>
                    );
                  })()}

                  {/* Header */}
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-3.5 w-3.5 text-amber-400" />
                    <p className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Manuscript / Script</p>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">Paste your full script here. Claude will read it and map each scene to your footage with captions, color grades, and transitions.</p>

                  {/* Textarea */}
                  <Textarea
                    className="min-h-[200px] text-[11px] font-mono resize-none bg-black/30 border-white/10 focus:border-amber-400/50 placeholder:text-zinc-600"
                    placeholder={`Paste your manuscript here...\n\nExample:\nScene 1: The skyline at dawn — a city waking up.\n\nScene 2: Inside a coffee shop, hands wrap around a warm mug...`}
                    value={manuscriptText}
                    onChange={(e) => setManuscriptText(e.target.value)}
                  />

                  {/* Word count + Save */}
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">
                      {manuscriptText.trim().split(/\s+/).filter(Boolean).length} words
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-amber-400/30 text-amber-400 hover:bg-amber-400/10"
                      onClick={handleSaveManuscript}
                      disabled={manuscriptSaving || !manuscriptText.trim()}
                    >
                      {manuscriptSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : manuscriptSaved ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                      {manuscriptSaved ? "Saved!" : "Save Script"}
                    </Button>
                  </div>

                  {/* Analyze button */}
                  <Button
                    className="w-full h-8 text-[11px] bg-amber-500 hover:bg-amber-600 text-black font-bold"
                    onClick={() => {
                      if (!manuscriptText.trim()) {
                        toast({ title: "Script is empty", description: "Paste your manuscript first.", variant: "destructive" });
                        return;
                      }
                      handleSaveManuscript().then(() => handleRunJob('analyze_manuscript'));
                    }}
                    disabled={!manuscriptText.trim()}
                  >
                    <Zap className="h-3.5 w-3.5 mr-1.5" />
                    Analyze Script with AI
                  </Button>

                  {/* Manuscript Analysis Results */}
                  {project?.manuscriptAnalysis && (() => {
                    try {
                      const msa = JSON.parse(project.manuscriptAnalysis);
                      return (
                        <div className="space-y-2 mt-2">
                          <div className="flex items-center gap-1.5 pt-1">
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                            <span className="text-[10px] font-bold text-green-400">Script Analysis Ready</span>
                          </div>
                          <div className="bg-black/40 rounded-lg p-2.5 border border-white/5 space-y-1.5">
                            <div className="flex justify-between">
                              <span className="text-[9px] text-muted-foreground">Scenes</span>
                              <span className="text-[9px] font-bold">{msa.totalScenes ?? msa.scenes?.length ?? 0}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-[9px] text-muted-foreground">Duration</span>
                              <span className="text-[9px] font-bold">~{msa.totalEstimatedDuration ?? 0}s</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-[9px] text-muted-foreground">Pacing</span>
                              <Badge variant="outline" className="text-[8px] h-3 capitalize">{msa.pacing ?? "medium"}</Badge>
                            </div>
                            {msa.narrativeArc && (
                              <p className="text-[9px] text-muted-foreground pt-1 border-t border-white/5 italic leading-relaxed">{msa.narrativeArc}</p>
                            )}
                          </div>

                          {/* Scene list */}
                          <p className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider">Scenes</p>
                          <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
                            {(msa.scenes ?? []).map((scene: any, i: number) => (
                              <div key={i} className="bg-black/30 rounded p-2 border border-white/5 text-[9px] space-y-0.5">
                                <div className="flex items-center gap-1 font-bold text-[10px]">
                                  <span className="text-amber-400 shrink-0">#{scene.sceneNumber}</span>
                                  <span className="truncate">{scene.title}</span>
                                  <span className="ml-auto text-muted-foreground shrink-0">{scene.suggestedDuration}s</span>
                                </div>
                                {scene.captionText && (
                                  <p className="text-sky-300/80 italic">"{scene.captionText}"</p>
                                )}
                                <div className="flex flex-wrap gap-1 pt-0.5">
                                  {scene.colorGrade && scene.colorGrade !== "none" && <Badge variant="outline" className="text-[7px] h-3 px-1 border-purple-500/30 text-purple-300">{scene.colorGrade}</Badge>}
                                  {scene.emotionalTone && <Badge variant="outline" className="text-[7px] h-3 px-1 border-blue-500/30 text-blue-300">{scene.emotionalTone}</Badge>}
                                  {scene.transitionIn && scene.transitionIn !== "cut" && <Badge variant="outline" className="text-[7px] h-3 px-1 border-zinc-500/30 text-zinc-400">{scene.transitionIn}</Badge>}
                                </div>
                              </div>
                            ))}
                          </div>

                          <Button
                            className="w-full h-7 text-[10px] mt-1"
                            variant="outline"
                            onClick={() => { setActiveTab("ai"); toast({ title: "Go to AI Tools", description: 'Run "Generate Edit Plan" to build the script-driven timeline.' }); }}
                          >
                            <ChevronRight className="h-3 w-3 mr-1" /> Generate Script-Driven Edit Plan
                          </Button>
                        </div>
                      );
                    } catch { return null; }
                  })()}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ── Styles Library Tab ────────────────────────────────────── */}
            <TabsContent value="styles" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-3">
                <div className="space-y-3">
                  {/* Header */}
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                    <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400">XML Style Library</p>
                  </div>

                  {/* Selected style badge */}
                  {selectedStyleId && (
                    <div className="flex items-center justify-between bg-violet-500/10 border border-violet-500/30 rounded-md px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3 w-3 text-violet-400" />
                        <span className="text-[10px] text-violet-300 font-medium truncate max-w-[140px]">{selectedStyleName}</span>
                      </div>
                      <button onClick={() => { setSelectedStyleId(null); setSelectedStyleName(null); }} className="text-muted-foreground hover:text-white">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {/* Category filter chips */}
                  <div className="flex flex-wrap gap-1">
                    {["all","wedding","corporate","documentary","sports","music_video","commercial","travel","social"].map(cat => (
                      <button
                        key={cat}
                        onClick={() => setStylesCategory(cat)}
                        className={`text-[9px] px-2 py-0.5 rounded-full border transition-colors ${stylesCategory === cat ? "bg-violet-600 border-violet-500 text-white" : "border-white/10 text-muted-foreground hover:border-violet-400/50"}`}
                      >
                        {cat.replace(/_/g, " ")}
                      </button>
                    ))}
                  </div>

                  {/* Search */}
                  <input
                    type="text"
                    placeholder="Search styles..."
                    value={stylesSearch}
                    onChange={e => setStylesSearch(e.target.value)}
                    className="w-full text-[11px] bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-foreground placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/50"
                  />

                  {/* Upload FCPXML card */}
                  <Card className="bg-black/30 border-violet-500/20 border-dashed cursor-pointer hover:border-violet-400/50 transition-colors"
                    onClick={() => {
                      const xml = prompt("Paste your FCPXML content:");
                      if (!xml) return;
                      const name = prompt("Style name:", "My Custom Style") || "My Custom Style";
                      fetch(`${API_BASE}/styles/learn`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ fcpxml: xml, name })
                      }).then(r => r.json()).then(data => {
                        toast({ title: "FCPXML Uploaded", description: `Learning style "${name}"... This may take a moment.` });
                        setStylesCategory("all");
                        setStylesSearch("");
                      }).catch(() => toast({ title: "Upload Failed", variant: "destructive" }));
                    }}
                  >
                    <CardContent className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <Upload className="h-3.5 w-3.5 text-violet-400" />
                        <span className="text-[10px] text-violet-300">Upload FCPXML to learn style</span>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Styles grid */}
                  {stylesLoading ? (
                    <div className="space-y-1.5">
                      {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-16 w-full rounded-md" />)}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {styles.map((style: any) => {
                        const isSelected = selectedStyleId === style.id;
                        const colorClass = ({
                          wedding: "text-pink-400", corporate: "text-blue-400",
                          documentary: "text-amber-400", sports: "text-green-400",
                          music_video: "text-purple-400", commercial: "text-orange-400",
                          travel: "text-cyan-400", social: "text-rose-400", custom: "text-zinc-400"
                        } as Record<string, string>)[style.category] ?? "text-zinc-400";
                        return (
                          <div
                            key={style.id}
                            onClick={() => { setSelectedStyleId(style.id); setSelectedStyleName(style.name); }}
                            className={`rounded-md border p-2 cursor-pointer transition-all ${isSelected ? "border-violet-500/60 bg-violet-500/10" : "border-white/5 bg-black/20 hover:border-violet-400/30 hover:bg-black/40"}`}
                          >
                            <div className="flex items-start justify-between gap-1">
                              <div className="flex-1 min-w-0">
                                <p className="text-[10px] font-semibold truncate">{style.name}</p>
                                <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                  <span className={`text-[9px] font-bold uppercase ${colorClass}`}>{style.category?.replace(/_/g, " ")}</span>
                                  {style.subcategory && <span className="text-[8px] text-muted-foreground">· {style.subcategory}</span>}
                                </div>
                              </div>
                              {isSelected && <CheckCircle2 className="h-3 w-3 text-violet-400 shrink-0 mt-0.5" />}
                            </div>
                            <div className="grid grid-cols-3 gap-x-2 mt-1.5">
                              <div>
                                <p className="text-[8px] text-muted-foreground">Pace</p>
                                <p className="text-[9px] font-mono">{style.cutsPerMinute?.toFixed(1) ?? "—"}/min</p>
                              </div>
                              <div>
                                <p className="text-[8px] text-muted-foreground">Clip</p>
                                <p className="text-[9px] font-mono">{style.avgClipDuration?.toFixed(1) ?? "—"}s</p>
                              </div>
                              <div>
                                <p className="text-[8px] text-muted-foreground">Grade</p>
                                <p className="text-[9px] font-mono truncate">{style.primaryColorGrade ?? "—"}</p>
                              </div>
                            </div>
                            {style.description && (
                              <p className="text-[8px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{style.description}</p>
                            )}
                          </div>
                        );
                      })}
                      {styles.length === 0 && (
                        <p className="text-[10px] text-muted-foreground text-center py-4">No styles found. Try a different filter.</p>
                      )}
                    </div>
                  )}

                  {selectedStyleId && (
                    <Button
                      className="w-full bg-violet-600 hover:bg-violet-700 text-white mt-2"
                      size="sm"
                      onClick={() => { setActiveTab("ai"); toast({ title: `Style "${selectedStyleName}" active`, description: 'Now run "Generate Edit Plan" in AI Tools to apply this style.' }); }}
                    >
                      <Wand2 className="h-3.5 w-3.5 mr-1.5" /> Apply Style to Edit Plan
                    </Button>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ── Color Pipeline Tab ─────────────────────────────────────── */}
            <TabsContent value="color" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-3">
                <div className="space-y-3">

                  {/* Color #1 — LUT Import */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Palette className="h-3 w-3 text-emerald-400" />LUT Import &amp; Apply</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#1 Upload .cube or .3dl LUT files and apply to all clips or selected clips.</p>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="file" accept=".cube,.3dl" className="hidden" disabled={lutUploading}
                          onChange={async e => {
                            const file = e.target.files?.[0]; if (!file) return;
                            setLutUploading(true);
                            try {
                              const fd = new FormData(); fd.append("lut", file);
                              const r = await fetch(`${API_BASE}/projects/${id}/upload-lut`, { method: "POST", body: fd });
                              const d = await r.json();
                              setLutLibrary(d.library ?? []);
                              setLutLibraryLoaded(true);
                              toast({ title: `LUT uploaded: ${file.name}`, duration: 2000 });
                            } catch { toast({ title: "Upload failed", variant: "destructive", duration: 2000 }); }
                            finally { setLutUploading(false); e.target.value = ""; }
                          }}
                        />
                        <span className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30 cursor-pointer">
                          {lutUploading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Uploading…</> : <><Upload className="h-2.5 w-2.5" />Upload LUT (.cube / .3dl)</>}
                        </span>
                      </label>
                      {!lutLibraryLoaded && (
                        <button className="text-[9px] text-emerald-400 underline" onClick={async () => {
                          const r = await fetch(`${API_BASE}/projects/${id}/lut-library`);
                          const d = await r.json();
                          setLutLibrary(d.library ?? []); setLutLibraryLoaded(true);
                        }}>Load LUT library</button>
                      )}
                      {lutLibraryLoaded && lutLibrary.length === 0 && <p className="text-[8px] text-zinc-600">No LUTs uploaded yet.</p>}
                      {lutLibrary.length > 0 && (
                        <div className="space-y-1">
                          <div className="flex gap-1">
                            <select value={selectedLutId} onChange={e => setSelectedLutId(e.target.value)}
                              className="flex-1 text-[8px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300">
                              <option value="__none__">— None (remove LUT) —</option>
                              {lutLibrary.map(l => <option key={l.id} value={l.id}>{l.name} ({(l.sizeBytes/1024).toFixed(0)} KB)</option>)}
                            </select>
                            <button disabled={lutApplying} className="px-2 py-0.5 rounded text-[8px] font-semibold bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 disabled:opacity-50"
                              onClick={async () => {
                                setLutApplying(true);
                                try {
                                  const r = await fetch(`${API_BASE}/projects/${id}/apply-lut`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lutId: selectedLutId }) });
                                  const d = await r.json();
                                  toast({ title: d.message ?? "LUT applied", duration: 2500 });
                                  refetchSegments();
                                } catch { toast({ title: "Apply failed", variant: "destructive", duration: 2000 }); }
                                finally { setLutApplying(false); }
                              }}>{lutApplying ? <Loader2 className="h-2.5 w-2.5 animate-spin inline" /> : "Apply to all clips"}</button>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Color #2 — Auto White Balance */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Sun className="h-3 w-3 text-yellow-400" />Auto White Balance</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#2 Detect color temperature from neutral regions and generate a colorbalance correction for each clip.</p>
                      <button disabled={autoWbLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-yellow-600/20 border border-yellow-500/30 text-yellow-300 hover:bg-yellow-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setAutoWbLoading(true);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/auto-white-balance`, { method: "POST", headers: { "Content-Type": "application/json" } });
                            const d = await r.json();
                            setAutoWbResult(d);
                            toast({ title: "White balance applied", description: d.message, duration: 3000 });
                          } catch { toast({ title: "WB failed", variant: "destructive", duration: 2000 }); }
                          finally { setAutoWbLoading(false); }
                        }}
                      >{autoWbLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Analyzing…</> : <><Sun className="h-2.5 w-2.5" />Auto-Correct All Clips</>}</button>
                      {autoWbResult && <p className="text-[8px] text-yellow-300/80">{autoWbResult.message}</p>}
                    </CardContent>
                  </Card>

                  {/* Color #3 — Exposure Normalization */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Sliders className="h-3 w-3 text-orange-400" />Exposure Normalization</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#3 Match exposure between clips filmed at different times of day. Measures luma and applies eq filter to normalize.</p>
                      <button disabled={expNormLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-orange-600/20 border border-orange-500/30 text-orange-300 hover:bg-orange-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setExpNormLoading(true);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/normalize-exposure`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetLuma: 128 }) });
                            const d = await r.json();
                            setExpNormResult(d);
                            toast({ title: "Exposure normalized", description: d.message, duration: 3000 });
                          } catch { toast({ title: "Normalization failed", variant: "destructive", duration: 2000 }); }
                          finally { setExpNormLoading(false); }
                        }}
                      >{expNormLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Measuring…</> : <><Sliders className="h-2.5 w-2.5" />Normalize All Clips (target luma 128)</>}</button>
                      {expNormResult && <p className="text-[8px] text-orange-300/80">{expNormResult.message}</p>}
                    </CardContent>
                  </Card>

                  {/* Color #4 — Skin Tone Protection */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><UserCheck className="h-3 w-3 text-rose-400" />Skin Tone Protection</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#4 Apply color correction while protecting skin tones (hue 0°–50°). Corrections apply to non-skin regions only.</p>
                      <button disabled={skinProtectLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-rose-600/20 border border-rose-500/30 text-rose-300 hover:bg-rose-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setSkinProtectLoading(true);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/skin-tone-protect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ correction: { saturation: 1.1, brightness: 0, contrast: 1.05 } }) });
                            const d = await r.json();
                            toast({ title: "Skin protection enabled", description: d.message, duration: 3000 });
                          } catch { toast({ title: "Failed", variant: "destructive", duration: 2000 }); }
                          finally { setSkinProtectLoading(false); }
                        }}
                      >{skinProtectLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Applying…</> : <><UserCheck className="h-2.5 w-2.5" />Enable Skin Tone Protection</>}</button>
                    </CardContent>
                  </Card>

                  {/* Color #5 — Shot Matching */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Copy className="h-3 w-3 text-teal-400" />Shot Matching</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#5 Analyze a reference clip and automatically match all other clips' look (RGB levels + luma) to it.</p>
                      {selectedSegment ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-teal-300">Ref: clip {selectedSegment.slice(0, 8)}</span>
                          <button disabled={shotMatchLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-teal-600/20 border border-teal-500/30 text-teal-300 disabled:opacity-50"
                            onClick={async () => {
                              setShotMatchLoading(true);
                              const others = (segments ?? []).filter(s => s.id !== selectedSegment && s.included).map(s => s.id);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${id}/shot-match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referenceSegmentId: selectedSegment, targetSegmentIds: others }) });
                                const d = await r.json();
                                toast({ title: "Shot match complete", description: d.message, duration: 3000 });
                                refetchSegments();
                              } catch { toast({ title: "Shot match failed", variant: "destructive", duration: 2000 }); }
                              finally { setShotMatchLoading(false); }
                            }}
                          >{shotMatchLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Matching…</> : <><Copy className="h-2.5 w-2.5" />Match all clips to selected</>}</button>
                        </div>
                      ) : <p className="text-[8px] text-zinc-600">Select a reference clip in the Clips tab first.</p>}
                    </CardContent>
                  </Card>

                  {/* Color #10 — Horizon Leveling */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Crop className="h-3 w-3 text-sky-400" />Horizon Leveling</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#10 Auto-detect tilted horizons and correct with FFmpeg rotate filter. Select a clip, then detect or set angle manually.</p>
                      {selectedSegment ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[8px] text-sky-300">Clip: {selectedSegment.slice(0, 8)}</span>
                          <button disabled={horizonLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-sky-600/20 border border-sky-500/30 text-sky-300 disabled:opacity-50"
                            onClick={async () => {
                              setHorizonLoading(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${id}/level-horizon`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segmentId: selectedSegment }) });
                                const d = await r.json();
                                setHorizonResult({ angle: d.angle, message: d.message });
                                toast({ title: "Horizon leveled", description: d.message, duration: 3000 });
                              } catch { toast({ title: "Failed", variant: "destructive", duration: 2000 }); }
                              finally { setHorizonLoading(false); }
                            }}
                          >{horizonLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Detecting…</> : <><Crop className="h-2.5 w-2.5" />Auto-detect &amp; Level</>}</button>
                          {horizonResult && <span className="text-[8px] text-sky-300/80">{horizonResult.angle > 0 ? "+" : ""}{horizonResult.angle}° rotation set</span>}
                        </div>
                      ) : <p className="text-[8px] text-zinc-600">Select a clip in the Clips tab first.</p>}
                    </CardContent>
                  </Card>

                  {/* Color #18 — Frame Interpolation */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Film className="h-3 w-3 text-violet-400" />Frame Interpolation</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#18 Convert clips to a target FPS (24→60, 25, 50 PAL) using motion-compensated interpolation (MCI) via FFmpeg minterpolate.</p>
                      <div className="flex items-center gap-2">
                        <select value={frameInterpFps} onChange={e => setFrameInterpFps(parseInt(e.target.value))}
                          className="text-[8px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300">
                          {[24, 25, 30, 50, 60, 120].map(fps => <option key={fps} value={fps}>{fps} fps{fps === 25 || fps === 50 ? " (PAL)" : fps === 60 ? " (smooth)" : ""}</option>)}
                        </select>
                        <button disabled={frameInterpLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-violet-600/20 border border-violet-500/30 text-violet-300 disabled:opacity-50"
                          onClick={async () => {
                            setFrameInterpLoading(true);
                            try {
                              const r = await fetch(`${API_BASE}/projects/${id}/frame-interpolation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetFps: frameInterpFps, algorithm: "mci" }) });
                              const d = await r.json();
                              setFrameInterpResult(d);
                              toast({ title: "Frame interpolation set", description: d.message, duration: 3000 });
                              refetchSegments();
                            } catch { toast({ title: "Failed", variant: "destructive", duration: 2000 }); }
                            finally { setFrameInterpLoading(false); }
                          }}
                        >{frameInterpLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Applying…</> : <><Film className="h-2.5 w-2.5" />Apply to All Clips</>}</button>
                      </div>
                      {frameInterpResult && (
                        <div className="space-y-0.5">
                          <p className="text-[8px] text-violet-300/80">{frameInterpResult.message}</p>
                          <p className="text-[7px] font-mono text-zinc-500">{frameInterpResult.ffmpegFilter}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                </div>
              </ScrollArea>
            </TabsContent>

            {/* ── Social Intelligence + Export Tab ──────────────────────── */}
            <TabsContent value="social" className="flex-1 overflow-hidden m-0 data-[state=active]:flex flex-col">
              <ScrollArea className="flex-1 p-3">
                <div className="space-y-3">

                  {/* Social #1 — Hook Analyzer */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Zap className="h-3 w-3 text-pink-400" />Hook Analyzer</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#1 Score the first 3 seconds against viral hook patterns (question, shock, value promise, story, curiosity gap…).</p>
                      <button disabled={hookLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-pink-600/20 border border-pink-500/30 text-pink-300 hover:bg-pink-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setHookLoading(true);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/analyze-hook`, { method: "POST", headers: { "Content-Type": "application/json" } });
                            const d = await r.json();
                            setHookResult(d.analysis);
                            toast({ title: "Hook analyzed", description: d.message, duration: 3000 });
                          } catch { toast({ title: "Analysis failed", variant: "destructive", duration: 2000 }); }
                          finally { setHookLoading(false); }
                        }}
                      >{hookLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Analyzing…</> : <><Zap className="h-2.5 w-2.5" />Analyze Hook</>}</button>
                      {hookResult && (
                        <div className="space-y-1.5 mt-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-lg font-black ${hookResult.overallScore >= 75 ? "text-green-400" : hookResult.overallScore >= 50 ? "text-yellow-400" : "text-red-400"}`}>{hookResult.grade}</span>
                            <div className="flex-1 bg-zinc-800 rounded-full h-1.5"><div className="h-1.5 rounded-full bg-pink-500 transition-all" style={{ width: `${hookResult.overallScore}%` }} /></div>
                            <span className="text-[9px] font-mono text-pink-300">{hookResult.overallScore}/100</span>
                          </div>
                          <p className="text-[8px] text-zinc-400">Retention: <span className="text-green-400">{hookResult.retentionPrediction}</span></p>
                          {hookResult.strengths?.slice(0, 2).map((s, i) => <p key={i} className="text-[8px] text-green-400/80">✓ {s}</p>)}
                          {hookResult.improvements?.slice(0, 2).map((s, i) => <p key={i} className="text-[8px] text-yellow-400/80">→ {s}</p>)}
                          {hookResult.rewrittenHook && <div className="p-1.5 rounded bg-pink-500/10 border border-pink-500/20"><p className="text-[7px] text-zinc-500 uppercase tracking-wide mb-0.5">Rewritten hook suggestion</p><p className="text-[8px] text-pink-300 italic">"{hookResult.rewrittenHook}"</p></div>}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Social #3 — Optimal Length + Post Timing */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Clock className="h-3 w-3 text-indigo-400" />Platform Optimizer</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-3">
                      {/* Length */}
                      <div className="space-y-1.5">
                        <p className="text-[8px] text-zinc-400 font-semibold uppercase tracking-wide">#3 Optimal Length</p>
                        <div className="flex items-center gap-2">
                          <select className="text-[8px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300" id="lengthPlatformSel">
                            {["tiktok","instagram","youtube","youtube_shorts","linkedin","twitter"].map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                          <button disabled={lengthLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 disabled:opacity-50"
                            onClick={async () => {
                              const sel = (document.getElementById("lengthPlatformSel") as HTMLSelectElement)?.value ?? "youtube";
                              setLengthLoading(true);
                              try {
                                const r = await fetch(`${API_BASE}/projects/${id}/optimal-length`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: sel }) });
                                const d = await r.json();
                                setLengthResult(d.result);
                                toast({ title: "Length analysis done", description: d.message, duration: 3000 });
                              } catch { toast({ title: "Failed", variant: "destructive", duration: 2000 }); }
                              finally { setLengthLoading(false); }
                            }}
                          >{lengthLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />…</> : "Check"}</button>
                        </div>
                        {lengthResult && (
                          <div className="p-1.5 rounded bg-indigo-500/10 border border-indigo-500/20 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className={`text-[8px] font-semibold px-1 rounded ${lengthResult.assessment === "optimal" ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}>{lengthResult.assessment}</span>
                              <span className="text-[8px] text-zinc-400">{lengthResult.currentDuration?.toFixed(1)}s → ideal: {lengthResult.optimalDuration}s</span>
                            </div>
                            {lengthResult.recommendation && <p className="text-[8px] text-zinc-400">{String(lengthResult.recommendation).slice(0, 100)}</p>}
                          </div>
                        )}
                      </div>
                      {/* Post Timing */}
                      <div className="space-y-1.5">
                        <p className="text-[8px] text-zinc-400 font-semibold uppercase tracking-wide">#6 Post Timing</p>
                        <div className="flex items-center gap-2">
                          <select className="text-[8px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300" id="timingPlatformSel">
                            {["tiktok","instagram","youtube","youtube_shorts","linkedin","twitter","facebook"].map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                          <button className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-indigo-600/20 border border-indigo-500/30 text-indigo-300"
                            onClick={async () => {
                              const sel = (document.getElementById("timingPlatformSel") as HTMLSelectElement)?.value ?? "youtube";
                              const r = await fetch(`${API_BASE}/projects/${id}/post-timing?platform=${sel}`);
                              const d = await r.json();
                              setPostTimingResult(d);
                              toast({ title: "Post timing loaded", description: d.message?.slice(0, 60), duration: 2500 });
                            }}
                          ><Clock className="h-2.5 w-2.5" /> Get Best Times</button>
                        </div>
                        {postTimingResult && (
                          <div className="space-y-1">
                            <p className="text-[8px] text-indigo-300">🕐 Next best: <span className="font-bold">{postTimingResult.nextBestSlot}</span></p>
                            <div className="grid grid-cols-2 gap-0.5">
                              {postTimingResult.schedule.best.slice(0, 4).map((t, i) => <span key={i} className="text-[7px] bg-green-500/10 text-green-400 rounded px-1 py-0.5">✓ {t}</span>)}
                            </div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Social #5 — Caption Hook Generator (EN + NO) */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><MessageSquare className="h-3 w-3 text-fuchsia-400" />Caption Hook Generator</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#5 Generate 5 alternative first-line hooks in English and Norwegian for social captions.</p>
                      <div className="flex items-center gap-2">
                        <select value={captionPlatform} onChange={e => setCaptionPlatform(e.target.value)} className="text-[8px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300">
                          {["instagram","tiktok","youtube","linkedin","twitter"].map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <button disabled={captionLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-fuchsia-600/20 border border-fuchsia-500/30 text-fuchsia-300 hover:bg-fuchsia-600/30 disabled:opacity-50"
                          onClick={async () => {
                            setCaptionLoading(true);
                            try {
                              const r = await fetch(`${API_BASE}/projects/${id}/caption-hooks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: captionPlatform, count: 5, includeNorwegian: true, tone: "casual" }) });
                              const d = await r.json();
                              setCaptionResult(d.result);
                              toast({ title: `${d.result?.hooks?.length ?? 0} hooks generated`, duration: 2000 });
                            } catch { toast({ title: "Generation failed", variant: "destructive", duration: 2000 }); }
                            finally { setCaptionLoading(false); }
                          }}
                        >{captionLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Writing…</> : <><MessageSquare className="h-2.5 w-2.5" />Generate 5 Hooks (EN + NO)</>}</button>
                      </div>
                      {captionResult?.hooks && captionResult.hooks.length > 0 && (
                        <div className="space-y-1.5 mt-1">
                          {captionResult.hooks.map((h, i) => (
                            <div key={h.id ?? i} className={`p-1.5 rounded border space-y-0.5 ${i === captionResult.recommendedIndex ? "border-fuchsia-500/40 bg-fuchsia-500/10" : "border-zinc-800 bg-zinc-900/50"}`}>
                              <div className="flex items-center justify-between">
                                <span className="text-[7px] text-zinc-500 uppercase">{h.strategy} {h.emojiSuggestion}</span>
                                {i === captionResult.recommendedIndex && <span className="text-[6px] bg-fuchsia-500/30 text-fuchsia-300 rounded px-0.5">Recommended</span>}
                              </div>
                              <p className="text-[8px] text-zinc-200 cursor-pointer hover:text-fuchsia-300" onClick={() => { navigator.clipboard?.writeText(h.english); toast({ title: "Copied!", duration: 1000 }); }}>🇬🇧 {h.english}</p>
                              {h.norwegian && <p className="text-[8px] text-zinc-400 cursor-pointer hover:text-fuchsia-300" onClick={() => { navigator.clipboard?.writeText(h.norwegian); toast({ title: "Kopiert!", duration: 1000 }); }}>🇳🇴 {h.norwegian}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Export #20 — YouTube Metadata + Upload */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Upload className="h-3 w-3 text-red-400" />YouTube Auto-Upload</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#20 Generate SEO title/description/tags from transcript, then upload rendered video to YouTube as a draft.</p>
                      <button disabled={ytMetaLoading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-red-600/20 border border-red-500/30 text-red-300 hover:bg-red-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setYtMetaLoading(true);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/generate-youtube-metadata`, { method: "POST", headers: { "Content-Type": "application/json" } });
                            const d = await r.json();
                            setYtMeta(d.metadata);
                            toast({ title: "YouTube metadata ready", duration: 2500 });
                          } catch { toast({ title: "Failed", variant: "destructive", duration: 2000 }); }
                          finally { setYtMetaLoading(false); }
                        }}
                      >{ytMetaLoading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Generating…</> : <><Upload className="h-2.5 w-2.5" />Generate YouTube Metadata</>}</button>
                      {ytMeta && (
                        <div className="space-y-1.5 mt-1">
                          <div className="p-1.5 rounded bg-zinc-900 border border-zinc-800">
                            <p className="text-[7px] text-zinc-500 uppercase">Title</p>
                            <p className="text-[9px] text-zinc-200 font-medium">{ytMeta.title}</p>
                          </div>
                          <div className="flex flex-wrap gap-0.5">{ytMeta.tags?.slice(0, 8).map((t, i) => <span key={i} className="text-[7px] bg-red-500/10 text-red-400 rounded px-1 py-0.5">#{t}</span>)}</div>
                          <button className="w-full text-[9px] py-1.5 rounded bg-red-600 hover:bg-red-500 text-white font-bold"
                            onClick={async () => {
                              try {
                                const r = await fetch(`${API_BASE}/projects/${id}/upload-to-youtube`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: ytMeta.title, description: ytMeta.description, privacyStatus: "private" }) });
                                const d = await r.json();
                                if (d.videoUrl) toast({ title: "Uploaded to YouTube!", description: d.videoUrl, duration: 5000 });
                                else toast({ title: d.error ?? "Upload failed", variant: "destructive", duration: 3000 });
                              } catch { toast({ title: "Upload failed", variant: "destructive", duration: 2000 }); }
                            }}
                          >Upload to YouTube (Private Draft)</button>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* #31 — TikTok Direct Upload */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Upload className="h-3 w-3 text-[#ff0050]" />TikTok Direct Upload</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#31 Upload rendered MP4 directly to TikTok as a draft. Requires TIKTOK_ACCESS_TOKEN env var.</p>
                      {tikTokResult?.error && <p className="text-[8px] text-red-400 bg-red-900/20 border border-red-800/30 rounded p-1.5">{tikTokResult.error}</p>}
                      {tikTokResult?.shareUrl && <a href={tikTokResult.shareUrl} target="_blank" rel="noopener noreferrer" className="text-[8px] text-[#ff0050] underline block">View on TikTok →</a>}
                      <button disabled={tikTokUploading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-[#ff0050]/10 border border-[#ff0050]/30 text-[#ff0050] hover:bg-[#ff0050]/20 disabled:opacity-50"
                        onClick={async () => {
                          setTikTokUploading(true); setTikTokResult(null);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/upload-to-tiktok`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: project?.name ?? "CutAI Export", privacyLevel: "SELF_ONLY" }) });
                            const d = await r.json();
                            setTikTokResult(d);
                            if (d.publishId) toast({ title: "Uploaded to TikTok!", description: "Video is processing as a draft.", duration: 4000 });
                            else toast({ title: d.error ?? "Upload failed", variant: "destructive", duration: 3000 });
                          } catch (err: any) { setTikTokResult({ error: err.message }); toast({ title: "Upload failed", variant: "destructive", duration: 2000 }); }
                          finally { setTikTokUploading(false); }
                        }}
                      >{tikTokUploading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Uploading…</> : <><Upload className="h-2.5 w-2.5" />Upload to TikTok (Draft)</>}</button>
                    </CardContent>
                  </Card>

                  {/* #31 — Instagram Reels Direct Upload */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Upload className="h-3 w-3 text-[#e1306c]" />Instagram Reels Upload</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#31 Publish rendered MP4 as an Instagram Reel. Requires INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ACCOUNT_ID.</p>
                      {igResult?.error && <p className="text-[8px] text-red-400 bg-red-900/20 border border-red-800/30 rounded p-1.5">{igResult.error}</p>}
                      {igResult?.permalink && <a href={igResult.permalink} target="_blank" rel="noopener noreferrer" className="text-[8px] text-[#e1306c] underline block">View on Instagram →</a>}
                      <button disabled={igUploading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-[#e1306c]/10 border border-[#e1306c]/30 text-[#e1306c] hover:bg-[#e1306c]/20 disabled:opacity-50"
                        onClick={async () => {
                          setIgUploading(true); setIgResult(null);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/upload-to-instagram`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caption: `${project?.name ?? "CutAI Export"}\n\n#shorts #reels #cutai` }) });
                            const d = await r.json();
                            setIgResult(d);
                            if (d.mediaId) toast({ title: "Uploaded to Instagram!", description: "Reel is publishing.", duration: 4000 });
                            else toast({ title: d.error ?? "Upload failed", variant: "destructive", duration: 3000 });
                          } catch (err: any) { setIgResult({ error: err.message }); toast({ title: "Upload failed", variant: "destructive", duration: 2000 }); }
                          finally { setIgUploading(false); }
                        }}
                      >{igUploading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Uploading…</> : <><Upload className="h-2.5 w-2.5" />Publish as Instagram Reel</>}</button>
                    </CardContent>
                  </Card>

                  {/* #31 — LinkedIn Video Upload */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Upload className="h-3 w-3 text-[#0a66c2]" />LinkedIn Video Post</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#31 Share rendered MP4 as a LinkedIn video post. Requires LINKEDIN_ACCESS_TOKEN + LINKEDIN_PERSON_URN env vars.</p>
                      {liResult?.error && <p className="text-[8px] text-red-400 bg-red-900/20 border border-red-800/30 rounded p-1.5">{liResult.error}</p>}
                      {liResult?.postUrl && <a href={liResult.postUrl} target="_blank" rel="noopener noreferrer" className="text-[8px] text-[#0a66c2] underline block">View on LinkedIn →</a>}
                      <button disabled={liUploading} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-[#0a66c2]/10 border border-[#0a66c2]/30 text-[#0a66c2] hover:bg-[#0a66c2]/20 disabled:opacity-50"
                        onClick={async () => {
                          setLiUploading(true); setLiResult(null);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/upload-to-linkedin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${project?.name ?? "CutAI Export"}\n\n#video #content` }) });
                            const d = await r.json();
                            setLiResult(d);
                            if (d.postUrl || d.urn) toast({ title: "Posted to LinkedIn!", description: "Video post is processing.", duration: 4000 });
                            else toast({ title: d.error ?? "Upload failed", variant: "destructive", duration: 3000 });
                          } catch (err: any) { setLiResult({ error: err.message }); toast({ title: "Upload failed", variant: "destructive", duration: 2000 }); }
                          finally { setLiUploading(false); }
                        }}
                      >{liUploading ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Uploading…</> : <><Upload className="h-2.5 w-2.5" />Post to LinkedIn</>}</button>
                    </CardContent>
                  </Card>

                  {/* Export #2 — Batch Export */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Layers className="h-3 w-3 text-cyan-400" />Batch Export</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#2 Export 16:9 (landscape), 9:16 (portrait/Reels), and 1:1 (square) simultaneously. Requires rendered MP4.</p>
                      <button disabled={batchExporting} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-cyan-600/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setBatchExporting(true);
                          setBatchResult(null);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/batch-export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aspectRatios: ["16:9", "9:16", "1:1"] }) });
                            const d = await r.json();
                            if (d.renderRequired) toast({ title: "Render first", description: d.error, variant: "destructive", duration: 4000 });
                            else { setBatchResult(d); toast({ title: "Batch export done", description: d.message, duration: 3000 }); }
                          } catch { toast({ title: "Export failed", variant: "destructive", duration: 2000 }); }
                          finally { setBatchExporting(false); }
                        }}
                      >{batchExporting ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Exporting…</> : <><Layers className="h-2.5 w-2.5" />Export 16:9 + 9:16 + 1:1</>}</button>
                      {batchResult?.outputs && (
                        <div className="grid grid-cols-3 gap-1 mt-1">
                          {batchResult.outputs.map(o => (
                            <div key={o.aspectRatio} className="p-1 rounded bg-zinc-900 border border-zinc-800 text-center">
                              <p className="text-[8px] font-bold text-zinc-300">{o.aspectRatio}</p>
                              <p className="text-[7px] text-zinc-500">{o.label}</p>
                              {o.status === "ready" && o.downloadUrl
                                ? <a href={`${API_BASE}${o.downloadUrl}`} download className="text-[8px] text-cyan-400 underline">↓ MP4</a>
                                : <span className="text-[8px] text-red-400">error</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Export #19 — Mezzanine / ProRes */}
                  <Card className="border-border/40 bg-card/50">
                    <CardHeader className="py-2 px-3"><CardTitle className="text-xs flex items-center gap-1.5"><Film className="h-3 w-3 text-amber-400" />Mezzanine Export (ProRes)</CardTitle></CardHeader>
                    <CardContent className="px-3 pb-3 space-y-2">
                      <p className="text-[9px] text-zinc-500">#19 Export an uncompressed ProRes 422 HQ .mov archive for post-production handoff. Requires rendered MP4. File size will be large.</p>
                      <button disabled={mezzExporting} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold bg-amber-600/20 border border-amber-500/30 text-amber-300 hover:bg-amber-600/30 disabled:opacity-50"
                        onClick={async () => {
                          setMezzExporting(true);
                          setMezzResult(null);
                          try {
                            const r = await fetch(`${API_BASE}/projects/${id}/mezzanine-export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: "hq" }) });
                            const d = await r.json();
                            if (d.renderRequired) toast({ title: "Render first", description: d.error, variant: "destructive", duration: 4000 });
                            else { setMezzResult(d); toast({ title: "ProRes export ready", description: d.message, duration: 3000 }); }
                          } catch { toast({ title: "Export failed", variant: "destructive", duration: 2000 }); }
                          finally { setMezzExporting(false); }
                        }}
                      >{mezzExporting ? <><Loader2 className="h-2.5 w-2.5 animate-spin" />Encoding ProRes…</> : <><Film className="h-2.5 w-2.5" />Export ProRes 422 HQ</>}</button>
                      {mezzResult?.status === "ready" && (
                        <div className="p-1.5 rounded bg-amber-500/10 border border-amber-500/20">
                          <p className="text-[8px] text-amber-300">Profile: ProRes 422 {mezzResult.profile?.toUpperCase()} — {mezzResult.sizeMB}</p>
                          {mezzResult.downloadUrl && <a href={`${API_BASE}${mezzResult.downloadUrl}`} download className="text-[9px] font-bold text-amber-400 underline">↓ Download .mov</a>}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                </div>
              </ScrollArea>
            </TabsContent>

          </Tabs>
        </div>

        {/* Center Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "#1c1c1c" }}>
          {/* Top Half: Video Preview (primary) + Inspector panel */}
          <div className="h-1/2 flex overflow-hidden" style={{ borderBottom: "1px solid #3a3a3a" }}>

            {/* ── Primary Video Preview ────────────────────────────────── */}
            <div className="flex-1 bg-black relative overflow-hidden flex flex-col">

              {/* Source / Rendered tab bar — visible once a render exists */}
              <div className="h-7 bg-zinc-950/90 border-b border-white/5 flex items-center px-2 gap-0.5 shrink-0">
                <button
                  onClick={() => setPreviewMode("source")}
                  className={cn(
                    "flex items-center gap-1 h-5 px-2 rounded text-[9px] font-medium transition-colors",
                    previewMode === "source"
                      ? "bg-white/10 text-white"
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  <Activity className="h-2.5 w-2.5" /> Live Edit
                </button>
                <button
                  onClick={() => { if (renderStatus?.ready) setPreviewMode("rendered"); }}
                  disabled={!renderStatus?.ready}
                  className={cn(
                    "flex items-center gap-1 h-5 px-2 rounded text-[9px] font-medium transition-colors",
                    !renderStatus?.ready && "opacity-30 cursor-not-allowed",
                    previewMode === "rendered" && renderStatus?.ready
                      ? "bg-green-600/20 text-green-400"
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  <Play className="h-2.5 w-2.5" />
                  {renderStatus?.ready ? `Rendered (${renderStatus.sizeMB ?? 0} MB)` : "Rendered (render first)"}
                </button>
                {renderStatus?.ready && previewMode === "rendered" && renderStatus.downloadUrl && (
                  <a href={`${API_BASE}${renderStatus.downloadUrl}`} download className="ml-auto">
                    <button className="flex items-center gap-1 h-5 px-2 rounded text-[9px] text-zinc-500 hover:text-zinc-300 transition-colors">
                      <Download className="h-2.5 w-2.5" /> Download
                    </button>
                  </a>
                )}
              </div>

              {/* Source clips (live edit) mode */}
              {previewMode === "source" && (
                <VideoPlayer
                  segments={(segments ?? [])
                    .filter(s => s.included)
                    .map(s => ({
                      id: s.id,
                      videoId: s.videoId ?? "",
                      startTime: s.startTime,
                      endTime: s.endTime,
                      captionText: s.captionText,
                      colorGrade: s.colorGrade,
                      speedFactor: s.speedFactor,
                      orderIndex: s.orderIndex,
                      graphicOverlays: s.graphicOverlays,
                    }))}
                  videos={(videos ?? []).map(v => ({
                    id: v.id,
                    originalName: v.originalName ?? "clip",
                    mimeType: v.mimeType,
                    durationSeconds: v.durationSeconds,
                  }))}
                  activeSegmentId={playerActiveSegId ?? selectedSegment}
                  onSegmentChange={(segId) => {
                    setPlayerActiveSegId(segId);
                    setSelectedSegment(segId);
                  }}
                  onSegmentIndexChange={(idx, progress) => {
                    setPlayerSegIndex(idx);
                    setPlayerSegProgress(progress);
                  }}
                  liveBuilding={liveBuilding}
                  apiBase={API_BASE}
                  className="flex-1"
                  showSafeAreas={showSafeAreas}
                  onToggleSafeAreas={() => setShowSafeAreas(p => !p)}
                  showGrid={showGrid}
                  onToggleGrid={() => setShowGrid(p => !p)}
                  targetFormat={project?.targetFormat ?? undefined}
                />
              )}

              {/* Rendered output inline player */}
              {previewMode === "rendered" && (
                <div className="flex-1 flex items-center justify-center bg-black overflow-hidden">
                  {renderStatus?.ready ? (
                    <video
                      key={`render-${id}`}
                      src={`${API_BASE}/projects/${id}/render-preview`}
                      controls
                      autoPlay
                      preload="auto"
                      className="w-full h-full object-contain"
                      style={{ display: "block" }}
                    />
                  ) : (
                    <div className="text-center space-y-2">
                      <VideoIcon className="h-8 w-8 text-zinc-700 mx-auto" />
                      <p className="text-[11px] text-zinc-600">Run <span className="text-zinc-400 font-medium">Render Video</span> to see the final cut here</p>
                    </div>
                  )}
                </div>
              )}

              {/* AI Log ticker strip */}
              {previewMode === "source" && (
                <div className="h-7 bg-zinc-950/90 border-t border-white/5 px-3 flex items-center gap-2 shrink-0">
                  <Activity className="h-2.5 w-2.5 text-green-500 shrink-0" />
                  {lastJob && <Badge variant="outline" className="text-[7px] h-3.5 py-0 uppercase text-zinc-600 shrink-0">{lastJob.status}</Badge>}
                  <p className="text-[9px] font-mono text-green-500/60 truncate flex-1">
                    {logLines.length > 0 ? logLines[logLines.length - 1] : "Waiting for AI processes..."}
                  </p>
                  <button
                    onClick={() => setRightPanelTab("logs")}
                    className="text-[8px] text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
                    title="View full logs"
                  >
                    View logs ›
                  </button>
                </div>
              )}
            </div>

            {/* ── Right Inspector Panel ────────────────────────────────── */}
            <Card className="w-80 bg-zinc-900 border-l border-white/5 shadow-2xl overflow-hidden flex flex-col rounded-none border-t-0 border-b-0 border-r-0">
              {/* ── FCP-style Clip Inspector ─── */}
              {(() => {
                const selId = [...selectedSegmentIds][0] ?? null;
                const selSeg = selId ? segments?.find(s => s.id === selId) : null;
                const selVideo = selSeg ? videos?.find(v => v.id === selSeg.videoId) : null;
                const selTimes = selSeg ? getSegTimes(selSeg) : null;
                const selDur = selTimes ? selTimes.end - selTimes.start : null;
                return (
                  <div className={`border-b shrink-0 transition-all ${selSeg ? "border-white/10" : "border-transparent"}`}>
                    {selSeg ? (
                      <div style={{ background: "#1d1d1d" }}>
                        {/* Header row */}
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Klippedetaljer</span>
                          <span className="text-[8px] text-zinc-600 font-mono">{selDur ? selDur.toFixed(2) + "s" : ""}</span>
                        </div>
                        {/* Inspector rows */}
                        <div className="px-3 py-2 space-y-1.5">
                          {/* Name row */}
                          <div className="flex items-start gap-2">
                            <span className="text-[8px] text-zinc-500 w-16 shrink-0 pt-0.5">Navn</span>
                            <span className="text-[9px] text-zinc-200 font-medium leading-tight">{selSeg.label ?? selVideo?.originalName ?? "—"}</span>
                          </div>
                          {/* Type row */}
                          <div className="flex items-center gap-2">
                            <span className="text-[8px] text-zinc-500 w-16 shrink-0">Type</span>
                            <span className="text-[8px] font-medium uppercase tracking-wide" style={{ color: selSeg.segmentType === "dialogue" ? "#4a9eff" : selSeg.segmentType === "broll" ? "#34d399" : selSeg.segmentType === "hook" ? "#f59e0b" : "#a78bfa" }}>
                              {selSeg.segmentType ?? "—"}
                            </span>
                          </div>
                          {/* Timing row */}
                          <div className="flex items-center gap-2">
                            <span className="text-[8px] text-zinc-500 w-16 shrink-0">Tid</span>
                            <span className="text-[8px] font-mono text-zinc-300">{selTimes ? `${selTimes.start.toFixed(2)}s → ${selTimes.end.toFixed(2)}s` : "—"}</span>
                          </div>
                          {/* Source video */}
                          {selVideo && (
                            <div className="flex items-center gap-2">
                              <span className="text-[8px] text-zinc-500 w-16 shrink-0">Kilde</span>
                              <span className="text-[8px] text-zinc-400 truncate">{selVideo.originalName}</span>
                            </div>
                          )}
                          {/* Resolution */}
                          {selVideo?.width && selVideo?.height && (
                            <div className="flex items-center gap-2">
                              <span className="text-[8px] text-zinc-500 w-16 shrink-0">Oppløsning</span>
                              <span className="text-[8px] font-mono text-zinc-400">{selVideo.width}×{selVideo.height}</span>
                            </div>
                          )}
                          {/* Speed / volume quick controls */}
                          <div className="flex gap-2 mt-2 pt-1.5 border-t border-white/5">
                            <div className="flex-1">
                              <div className="text-[7px] text-zinc-600 uppercase tracking-wider mb-1">Hastighet</div>
                              <div className="flex items-center gap-1">
                                <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
                                  <div className="h-full bg-primary/70 rounded-full" style={{ width: "50%" }} />
                                </div>
                                <span className="text-[7px] font-mono text-zinc-500">1.0×</span>
                              </div>
                            </div>
                            <div className="flex-1">
                              <div className="text-[7px] text-zinc-600 uppercase tracking-wider mb-1">Volum</div>
                              <div className="flex items-center gap-1">
                                <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
                                  <div className="h-full bg-emerald-500/70 rounded-full" style={{ width: "100%" }} />
                                </div>
                                <span className="text-[7px] font-mono text-zinc-500">0dB</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="px-3 py-2 flex items-center gap-2" style={{ background: "#1d1d1d" }}>
                        <span className="text-[8px] text-zinc-600 italic">Ingen klipp valgt</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="h-8 bg-zinc-900 border-b border-white/10 flex items-center px-0 shrink-0">
                <button
                  onClick={() => setRightPanelTab("music")}
                  className={cn("flex-1 h-full flex items-center justify-center gap-1 text-[9px] font-medium transition-colors border-b-2", rightPanelTab === "music" ? "border-pink-500 text-pink-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}
                >
                  <Music className="h-2.5 w-2.5" /> Music
                </button>
                <button
                  onClick={() => setRightPanelTab("story")}
                  className={cn("flex-1 h-full flex items-center justify-center gap-1 text-[9px] font-medium transition-colors border-b-2 relative", rightPanelTab === "story" ? "border-primary text-primary" : "border-transparent text-zinc-500 hover:text-zinc-300")}
                >
                  <Sparkles className="h-2.5 w-2.5" /> Story
                  {(segments?.length ?? 0) > 0 && (
                    <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  )}
                </button>
                <button
                  onClick={() => setRightPanelTab("qc")}
                  className={cn("flex-1 h-full flex items-center justify-center gap-1 text-[9px] font-medium transition-colors border-b-2 relative", rightPanelTab === "qc" ? "border-emerald-500 text-emerald-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}
                >
                  <Gauge className="h-2.5 w-2.5" /> QC
                  {qcResult && (
                    <span className={cn("absolute top-0.5 right-1 text-[7px] font-bold px-0.5 rounded",
                      qcResult.grade === 'A' ? "bg-emerald-500/20 text-emerald-400" :
                      qcResult.grade === 'B' ? "bg-green-500/20 text-green-400" :
                      qcResult.grade === 'C' ? "bg-yellow-500/20 text-yellow-400" :
                      qcResult.grade === 'D' ? "bg-orange-500/20 text-orange-400" :
                      "bg-red-500/20 text-red-400"
                    )}>{qcResult.grade}</span>
                  )}
                </button>
                <button
                  onClick={() => setRightPanelTab("pacing")}
                  className={cn("flex-1 h-full flex items-center justify-center gap-1 text-[9px] font-medium transition-colors border-b-2 relative", rightPanelTab === "pacing" ? "border-cyan-500 text-cyan-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}
                >
                  <Gauge className="h-2.5 w-2.5" /> Pacing
                  {project?.pacingSuggestions && (
                    <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  )}
                </button>
                <button
                  onClick={() => setRightPanelTab("logs")}
                  className={cn("flex-1 h-full flex items-center justify-center gap-1 text-[9px] font-medium transition-colors border-b-2 relative", rightPanelTab === "logs" ? "border-green-500 text-green-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}
                >
                  <Activity className="h-2.5 w-2.5" /> Logs
                  {isAnyJobRunning && (
                    <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  )}
                </button>
              </div>

              {rightPanelTab === "music" && (
                <div className="flex-1 overflow-auto">
                  <AudioMixPanel
                    projectId={id}
                    videoId={previewVideoId ?? segments?.find(s => s.included)?.videoId ?? undefined}
                    segments={segments ?? []}
                    musicAnalysis={musicAnalysis ?? null}
                    musicSuggestions={project?.musicSuggestions ?? null}
                    onRunJob={(type, vid, opts) => handleRunJob(type as any, vid, opts)}
                    apiBase={API_BASE}
                  />
                </div>
              )}

              {rightPanelTab === "story" && (
                <div className="flex-1 overflow-hidden flex flex-col">
                  <StoryScriptPanel
                    segments={segments ?? []}
                    onLock={handleLockScript}
                    onBulkUpdate={handleBulkSegmentUpdate}
                    isLocking={isLockingScript}
                  />
                </div>
              )}

              {rightPanelTab === "pacing" && (
                <div className="flex-1 overflow-auto p-3">
                  <PacingPanel
                    pacingSuggestions={project?.pacingSuggestions ?? null}
                    onRunJob={(type) => handleRunJob(type as any)}
                    onApplyPacing={handleApplyPacing}
                    isJobRunning={(jobs ?? []).some((j: any) => j.type === "suggest_pacing" && j.status === "running")}
                    segmentCount={(segments ?? []).filter((s: any) => s.included !== false).length}
                  />
                </div>
              )}

              {rightPanelTab === "qc" && (
                <div className="flex-1 overflow-auto">
                  {qcResult ? (
                    <div className="p-3 space-y-3">
                      {/* Score badge */}
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-16 h-16 rounded-full flex flex-col items-center justify-center shrink-0 border-2",
                          qcResult.grade === 'A' ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" :
                          qcResult.grade === 'B' ? "border-green-500 bg-green-500/10 text-green-400" :
                          qcResult.grade === 'C' ? "border-yellow-500 bg-yellow-500/10 text-yellow-400" :
                          qcResult.grade === 'D' ? "border-orange-500 bg-orange-500/10 text-orange-400" :
                          "border-red-500 bg-red-500/10 text-red-400"
                        )}>
                          <span className="text-2xl font-black">{qcResult.grade}</span>
                          <span className="text-[9px] font-bold opacity-70">{qcResult.score}/100</span>
                        </div>
                        <div className="flex-1 space-y-1">
                          <Progress
                            value={qcResult.score}
                            className={cn("h-2", qcResult.score >= 90 ? "[&>div]:bg-emerald-500" : qcResult.score >= 75 ? "[&>div]:bg-green-500" : qcResult.score >= 60 ? "[&>div]:bg-yellow-500" : qcResult.score >= 40 ? "[&>div]:bg-orange-500" : "[&>div]:bg-red-500")}
                          />
                          <p className="text-[9px] text-zinc-500">{qcResult.passCount}/{qcResult.totalChecks} checks passed</p>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="outline" className="text-[7px] h-3 px-1">{qcResult.resolution}</Badge>
                            <Badge variant="outline" className="text-[7px] h-3 px-1">{qcResult.fps}fps</Badge>
                            <Badge variant="outline" className="text-[7px] h-3 px-1">{qcResult.videoCodec}</Badge>
                            {qcResult.sizeMB > 0 && <Badge variant="outline" className="text-[7px] h-3 px-1">{qcResult.sizeMB}MB</Badge>}
                          </div>
                        </div>
                      </div>

                      {/* Technical stats */}
                      <div className="grid grid-cols-2 gap-1.5">
                        <div className="bg-black/40 rounded p-1.5 text-center">
                          <p className="text-[8px] text-zinc-500 uppercase">Bitrate</p>
                          <p className="text-[10px] font-bold">{qcResult.bitrateMbps?.toFixed(1) ?? "—"} Mbps</p>
                        </div>
                        <div className="bg-black/40 rounded p-1.5 text-center">
                          <p className="text-[8px] text-zinc-500 uppercase">Loudness</p>
                          <p className="text-[10px] font-bold">{qcResult.lufs != null ? `${qcResult.lufs.toFixed(1)} LUFS` : "—"}</p>
                        </div>
                        <div className="bg-black/40 rounded p-1.5 text-center">
                          <p className="text-[8px] text-zinc-500 uppercase">Duration</p>
                          <p className="text-[10px] font-bold">{Math.round(qcResult.duration ?? 0)}s</p>
                        </div>
                        <div className="bg-black/40 rounded p-1.5 text-center">
                          <p className="text-[8px] text-zinc-500 uppercase">Audio</p>
                          <p className="text-[10px] font-bold">{qcResult.audioCodec ?? "—"}</p>
                        </div>
                      </div>

                      {/* Checks list */}
                      <div className="space-y-1">
                        <p className="text-[8px] uppercase font-bold text-zinc-500 tracking-wider">Checks</p>
                        {(qcResult.checks ?? []).map((check) => {
                          const Icon = check.pass ? ShieldCheck : check.severity === 'warn' ? ShieldAlert : ShieldX;
                          const color = check.pass ? "text-emerald-500" : check.severity === 'warn' ? "text-yellow-500" : "text-red-500";
                          return (
                            <div key={check.id} className={cn("flex items-start gap-1.5 rounded p-1.5 text-[9px]", check.pass ? "bg-emerald-500/5" : check.severity === 'warn' ? "bg-yellow-500/5" : "bg-red-500/5")}>
                              <Icon className={cn("h-3 w-3 mt-0.5 shrink-0", color)} />
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold leading-tight">{check.label}</p>
                                <p className="text-zinc-500 leading-tight">{check.detail}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Event warnings */}
                      {(qcResult.freezeEvents?.length > 0 || qcResult.blackEvents?.length > 0 || qcResult.silenceEvents?.length > 0) && (
                        <div className="space-y-1">
                          <p className="text-[8px] uppercase font-bold text-zinc-500 tracking-wider">Detected Events</p>
                          {qcResult.freezeEvents?.slice(0, 3).map((e, i) => (
                            <div key={`f${i}`} className="flex justify-between text-[8px] text-yellow-400 bg-yellow-500/5 rounded px-1.5 py-0.5">
                              <span>Freeze @ {e.start.toFixed(1)}s</span><span>{e.duration.toFixed(1)}s</span>
                            </div>
                          ))}
                          {qcResult.blackEvents?.slice(0, 3).map((e, i) => (
                            <div key={`b${i}`} className="flex justify-between text-[8px] text-zinc-400 bg-zinc-500/5 rounded px-1.5 py-0.5">
                              <span>Black @ {e.start.toFixed(1)}s</span><span>{e.duration.toFixed(1)}s</span>
                            </div>
                          ))}
                          {qcResult.silenceEvents?.slice(0, 3).map((e, i) => (
                            <div key={`s${i}`} className="flex justify-between text-[8px] text-blue-400 bg-blue-500/5 rounded px-1.5 py-0.5">
                              <span>Silence @ {e.start.toFixed(1)}s</span><span>{e.duration.toFixed(1)}s</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-6 text-[10px]"
                        onClick={() => handleRunJob('quality_check')}
                        disabled={isJobRunning('quality_check')}
                      >
                        {isJobRunning('quality_check') ? <><Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />Checking...</> : <><Gauge className="h-2.5 w-2.5 mr-1" />Re-run QC</>}
                      </Button>

                      {/* RL Quality Rating — feeds the learn_from_edit weight */}
                      <div className="mt-3 pt-3 border-t border-white/5">
                        <div className="flex items-center gap-1.5 mb-2">
                          <BrainCircuit className="h-2.5 w-2.5 text-teal-400" />
                          <span className="text-[9px] font-semibold text-zinc-300 uppercase tracking-wider">Rate this edit</span>
                          <span className="text-[8px] text-zinc-600 ml-auto">Trains the RL loop</span>
                        </div>
                        <div className="flex gap-1 justify-center">
                          {[1,2,3,4,5].map(star => (
                            <button
                              key={star}
                              onClick={() => handleSubmitRating(star)}
                              disabled={ratingSubmitting}
                              className="p-1 rounded transition-colors hover:bg-white/5 disabled:opacity-50"
                              title={star === 1 ? "Bad — AI will unlearn these choices" : star === 2 ? "Below average" : star === 3 ? "Ok" : star === 4 ? "Good" : "Excellent — boost these preferences"}
                            >
                              <Star className={`h-4 w-4 transition-colors ${qualityRating !== null && star <= qualityRating ? "text-yellow-400 fill-yellow-400" : "text-zinc-600"}`} />
                            </button>
                          ))}
                        </div>
                        {qualityRating !== null && (
                          <p className="text-[8px] text-zinc-500 text-center mt-1">
                            {qualityRating === 1 ? "Bad — AI will unlearn these choices" : qualityRating === 2 ? "Below average — mild penalty signal" : qualityRating === 3 ? "Ok — learning at half weight" : qualityRating === 4 ? "Good — learning at full weight" : "Excellent — boosted learning signal"}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center gap-3 p-6">
                      <Shield className="h-10 w-10 text-zinc-700" />
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold text-zinc-400">No QC Report Yet</p>
                        <p className="text-[9px] text-zinc-600 leading-relaxed">Render your video first, then run Quality Check to get a full codec, audio, freeze, and loudness report.</p>
                      </div>
                      <Button
                        size="sm"
                        className="h-7 text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={() => handleRunJob('quality_check')}
                        disabled={!renderStatus?.ready || isJobRunning('quality_check')}
                      >
                        {isJobRunning('quality_check') ? <><Loader2 className="h-2.5 w-2.5 mr-1.5 animate-spin" />Checking...</> : <><Gauge className="h-2.5 w-2.5 mr-1.5" />Run Quality Check</>}
                      </Button>
                      {!renderStatus?.ready && <p className="text-[8px] text-zinc-700">Render a video first (Step 9)</p>}

                      {/* RL Quality Rating available even without QC */}
                      <div className="mt-4 pt-3 border-t border-white/5 w-full">
                        <div className="flex items-center gap-1.5 mb-2 justify-center">
                          <BrainCircuit className="h-2.5 w-2.5 text-teal-400" />
                          <span className="text-[9px] font-semibold text-zinc-400 uppercase tracking-wider">Rate this edit</span>
                        </div>
                        <div className="flex gap-1 justify-center">
                          {[1,2,3,4,5].map(star => (
                            <button key={star} onClick={() => handleSubmitRating(star)} disabled={ratingSubmitting}
                              className="p-1 rounded hover:bg-white/5 disabled:opacity-50">
                              <Star className={`h-4 w-4 transition-colors ${qualityRating !== null && star <= qualityRating ? "text-yellow-400 fill-yellow-400" : "text-zinc-700"}`} />
                            </button>
                          ))}
                        </div>
                        {qualityRating !== null && (
                          <p className="text-[8px] text-zinc-600 text-center mt-1">Rated {qualityRating}/5 — used by Learn from Edit</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {rightPanelTab === "logs" && (
                <div className="flex-1 flex flex-col overflow-hidden bg-black">
                  <div className="h-7 bg-zinc-900 px-3 flex items-center justify-between border-b border-white/5 shrink-0">
                    <div className="flex items-center gap-2">
                      <Activity className="h-2.5 w-2.5 text-green-500" />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase tracking-wider">AI System Logs</span>
                    </div>
                    {lastJob && <Badge variant="outline" className="text-[7px] h-4 py-0 uppercase text-zinc-500">{lastJob.status}</Badge>}
                  </div>
                  <ScrollArea className="flex-1 p-3 font-mono text-xs text-green-500/80">
                    {logLines.length > 0 ? (
                      logLines.map((line: string, i: number) => (
                        <div key={i} className="mb-1 leading-relaxed break-all text-[10px]">
                          {line}
                        </div>
                      ))
                    ) : (
                      <div className="opacity-30 italic text-[10px]">Waiting for AI processes...</div>
                    )}
                    <div ref={logEndRef} />
                  </ScrollArea>
                </div>
              )}
            </Card>
          </div>

          {/* ── FCP-style Edit Toolbar ────────────────────────────────────── */}
          <div className="h-9 shrink-0 flex items-center px-2 gap-0.5 border-t border-b"
            style={{ background: "#252525", borderColor: "#3a3a3a" }}>
            {/* Edit tools */}
            {([ 
              { key: "select",   Icon: MousePointer2, label: "Select (A)",   kbd: "A" },
              { key: "trim",     Icon: Scissors,      label: "Trim (T)",     kbd: "T" },
              { key: "blade",    Icon: SplitSquareHorizontal, label: "Blade (B)", kbd: "B" },
              { key: "position", Icon: Move,          label: "Position (P)", kbd: "P" },
              { key: "hand",     Icon: Hand,          label: "Hand (H)",     kbd: "H" },
            ] as const).map(({ key, Icon, label }) => (
              <button
                key={key}
                title={label}
                onClick={() => setActiveTool(key as any)}
                className={cn(
                  "h-6 w-7 flex items-center justify-center rounded transition-colors",
                  activeTool === key
                    ? "bg-primary/25 text-primary ring-1 ring-primary/50"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-white/8"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
            <div className="w-px h-5 mx-1.5" style={{ background: "#3a3a3a" }} />
            {/* Timecode + duration display */}
            <div className="font-mono text-[11px] text-zinc-300 bg-black/40 px-2 py-0.5 rounded tabular-nums select-none"
              title="Playhead position">
              {(() => {
                const t = currentTime;
                const h = Math.floor(t / 3600);
                const m = Math.floor((t % 3600) / 60);
                const s = Math.floor(t % 60);
                const f = Math.floor((t % 1) * 30);
                return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}:${String(f).padStart(2,"0")}`;
              })()}
            </div>
            <div className="w-px h-5 mx-1.5" style={{ background: "#3a3a3a" }} />
            {/* Snapping toggle */}
            <button
              title={`Snapping ${snapEnabled ? "On" : "Off"} (N)`}
              onClick={() => setSnapEnabled(s => !s)}
              className={cn(
                "h-6 px-2 flex items-center gap-1 rounded text-[10px] font-medium transition-colors",
                snapEnabled
                  ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/8"
              )}
            >
              <Magnet className="h-3 w-3" /> Snap
            </button>
            {/* Show lanes toggle */}
            <button
              title="Toggle lane view"
              onClick={() => setShowTimelineLanes(v => !v)}
              className={cn(
                "h-6 px-2 flex items-center gap-1 rounded text-[10px] font-medium transition-colors",
                showTimelineLanes
                  ? "bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/40"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/8"
              )}
            >
              <Layers className="h-3 w-3" /> Lanes
            </button>
            <div className="flex-1" />
            {/* Right side: clip count / duration */}
            {segments && segments.filter(s => s.included).length > 0 && (
              <span className="text-[10px] text-zinc-500 font-mono tabular-nums mr-2">
                {segments.filter(s => s.included).length} clips ·{" "}
                {(() => {
                  const d = segments.filter(s => s.included).reduce((a, s) => a + Math.max(0, s.endTime - s.startTime), 0);
                  const m = Math.floor(d / 60); const s = Math.round(d % 60);
                  return `${m}:${String(s).padStart(2,"0")}`;
                })()}
              </span>
            )}
          </div>

          {/* Bottom Half: NLE Timeline Editor */}
          <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "#1a1a1a" }}>
            <div className="relative flex-1 overflow-hidden">
              {segments && segments.length === 0 && !isJobRunning('generate_edit_plan') && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center z-10" style={{ background: "#1a1a1a" }}>
                  <div className="p-4 rounded-full bg-primary/5 border border-primary/20">
                    <Wand2 className="h-8 w-8 text-primary opacity-70" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-300 mb-1">No edit plan yet</p>
                    <p className="text-[11px] text-zinc-500 max-w-xs">Run "Generate Edit Plan" in the AI Tools tab to have the AI build your cut timeline.</p>
                  </div>
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={() => { setActiveTab('ai'); handleRunJob('generate_edit_plan'); }}
                    disabled={videos?.length === 0}
                  >
                    <Wand2 className="h-3.5 w-3.5" /> Generate Edit Plan
                  </Button>
                </div>
              )}
              {isJobRunning('generate_edit_plan') && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#111] z-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-[11px] text-zinc-400 uppercase tracking-wider font-bold">AI is building your timeline...</p>
                </div>
              )}
              <TimelineEditor
                segments={(segments ?? []).map(s => ({
                  id: s.id,
                  videoId: s.videoId ?? "",
                  orderIndex: s.orderIndex,
                  startTime: s.startTime,
                  endTime: s.endTime,
                  label: s.label,
                  segmentType: s.segmentType,
                  included: s.included,
                  confidence: s.confidence,
                  silenceTrimInfo: (s as any).silenceTrimInfo ?? null,
                }))}
                videos={(videos ?? []).map(v => ({
                  id: v.id,
                  originalName: v.originalName ?? "clip",
                  durationSeconds: v.durationSeconds,
                }))}
                selectedSegmentId={selectedSegment}
                onSelectSegment={(id) => setSelectedSegment(id)}
                onTrimSegment={(segId, startTime, endTime) => {
                  pushUndo();
                  const oldSeg = segments?.find(s => s.id === segId);
                  updateSegment.mutate({ id: segId, data: { startTime, endTime } }, {
                    onSuccess: () => {
                      refetchSegments();
                      if (oldSeg) {
                        const deltaStart = startTime - oldSeg.startTime;
                        const deltaEnd = endTime - oldSeg.endTime;
                        if (Math.abs(deltaStart) > 0.05) fetch(`${API_BASE}/projects/${id}/signal-edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editType: "trim_start", segmentId: segId, deltaStart }) }).catch(() => {});
                        if (Math.abs(deltaEnd) > 0.05) fetch(`${API_BASE}/projects/${id}/signal-edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editType: "trim_end", segmentId: segId, deltaEnd }) }).catch(() => {});
                      }
                    },
                  });
                }}
                onToggleIncluded={(segId, included) => {
                  pushUndo();
                  const oldSeg = segments?.find(s => s.id === segId);
                  updateSegment.mutate({ id: segId, data: { included } }, {
                    onSuccess: () => {
                      refetchSegments(); refetchTrainSignals();
                      if (oldSeg) {
                        fetch(`${API_BASE}/projects/${id}/signal-edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editType: included ? "include" : "exclude", segmentId: segId, fromType: oldSeg.segmentType }) }).catch(() => {});
                      }
                    },
                  });
                }}
                onReorderSegments={async (orderedIds) => {
                  if (!segments) return;
                  pushUndo();
                  await Promise.all(orderedIds.map((sid, i) =>
                    fetch(`${API_BASE}/segments/${sid}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ orderIndex: i }),
                    })
                  ));
                  refetchSegments();
                  fetch(`${API_BASE}/projects/${id}/signal-edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editType: "reorder" }) }).catch(() => {});
                }}
                onScrubTo={(outputTimeSec) => {
                  if (!segments) return;
                  const included = [...segments].filter(s => s.included).sort((a, b) => a.orderIndex - b.orderIndex);
                  let acc = 0;
                  for (let i = 0; i < included.length; i++) {
                    const dur = included[i].endTime - included[i].startTime;
                    if (acc + dur >= outputTimeSec || i === included.length - 1) {
                      setPlayerSegIndex(i);
                      setPlayerSegProgress(dur > 0 ? Math.max(0, Math.min(1, (outputTimeSec - acc) / dur)) : 0);
                      break;
                    }
                    acc += dur;
                  }
                }}
                onResetTrim={(segId) => {
                  const seg = segments?.find(s => s.id === segId);
                  if (!seg) return;
                  const trimInfo = (seg as any).silenceTrimInfo ? JSON.parse((seg as any).silenceTrimInfo) : null;
                  if (trimInfo) {
                    pushUndo();
                    updateSegment.mutate({
                      id: segId,
                      data: { startTime: trimInfo.originalStart, endTime: trimInfo.originalEnd },
                    }, { onSuccess: () => refetchSegments() });
                  }
                }}
                currentSegIndex={playerSegIndex}
                segmentProgress={playerSegProgress}
                liveBuilding={liveBuilding}
                apiBase={API_BASE}
                className="absolute inset-0"
                showLanes={showTimelineLanes}
                zoomToFitTrigger={zoomToFitTrigger}
                activeTool={activeTool}
              />
            </div>
          </div>
        </div>

        {/* Right Sidebar - Details */}
        {selectedSegment && (
          <div className="w-64 border-l border-border bg-card flex flex-col shrink-0">
            <div className="h-10 flex items-center px-4 border-b border-border justify-between bg-zinc-900/50">
              <h3 className="font-bold text-[10px] uppercase tracking-wider">Clip Properties</h3>
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setSelectedSegment(null)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
            
            <ScrollArea className="flex-1 p-0">
              {segments?.filter(s => s.id === selectedSegment).map(segment => {
                const srcVideo = videos?.find(v => v.id === segment.videoId);
                return (
                  <div key={segment.id} className="h-full flex flex-col">
                    {/* Source Video */}
                    <div 
                      className="flex items-center gap-2 px-3 py-2 bg-black/30 border-b border-border/40 cursor-pointer hover:bg-black/50 transition-colors"
                      onClick={() => srcVideo && setPreviewVideoId(srcVideo.id)}
                      title="Click to preview source"
                    >
                      <div className="h-8 w-11 rounded overflow-hidden bg-zinc-900 shrink-0 relative">
                        {srcVideo && (
                          <>
                            <img
                              src={`${API_BASE}/videos/${srcVideo.id}/thumbnail.jpg`}
                              alt={srcVideo.originalName}
                              className="h-full w-full object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 bg-black/50 transition-opacity">
                              <Play className="h-2.5 w-2.5 fill-white text-white" />
                            </div>
                          </>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[9px] text-muted-foreground uppercase">Source</p>
                        <p className="text-[10px] font-medium truncate">{srcVideo?.originalName ?? "Unknown clip"}</p>
                      </div>
                    </div>

                    <div className="p-3 space-y-3 border-b border-border/50 bg-accent/10">
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <div className="text-[10px] text-muted-foreground uppercase">Type</div>
                          <Badge className="capitalize text-[10px] h-5">{segment.segmentType}</Badge>
                        </div>
                        <div className="text-right space-y-1">
                          <div className="text-[10px] text-muted-foreground uppercase">AI Score</div>
                          <div className="flex items-center gap-2 justify-end">
                            <span className="text-[10px] font-mono">{Math.round((segment.confidence || 0) * 100)}%</span>
                            <Progress value={(segment.confidence || 0) * 100} className="h-1 w-12" />
                          </div>
                        </div>
                      </div>
                      
                      <div className="space-y-1">
                        <div className="text-[10px] text-muted-foreground uppercase">Time Range</div>
                        <div className="text-[11px] font-mono bg-background/50 p-1.5 rounded border border-border/50 flex justify-between">
                          <span>{segment.startTime.toFixed(2)}s</span>
                          <span className="text-muted-foreground">→</span>
                          <span>{segment.endTime.toFixed(2)}s</span>
                          <span className="text-primary">{(segment.endTime - segment.startTime).toFixed(2)}s</span>
                        </div>
                      </div>

                      {segment.aiReason && (
                        <div className="text-[9px] text-zinc-500 italic leading-relaxed line-clamp-2">
                          "{segment.aiReason}"
                        </div>
                      )}

                      <Button 
                        variant={segment.included ? "destructive" : "default"} 
                        size="sm" 
                        className="w-full text-[10px] h-7 uppercase font-bold"
                        onClick={() => handleToggleSegment(segment.id, segment.included)}
                      >
                        {segment.included 
                          ? <><EyeOff className="h-3 w-3 mr-2" /> Exclude</> 
                          : <><Eye className="h-3 w-3 mr-2" /> Include</>}
                      </Button>
                    </div>

                    <div className="flex-1">
                      <ClipPropertiesPanel 
                        segment={segment}
                        currentTime={currentTime}
                        sourceDuration={srcVideo?.durationSeconds ?? undefined}
                        videoId={srcVideo?.id}
                        apiBase={API_BASE}
                        onSplit={handleSplit}
                        onUpdate={() => { refetchSegments(); }} 
                      />
                    </div>
                  </div>
                );
              })}
            </ScrollArea>
          </div>
        )}
      </div>

      {/* Render Export Preview Modal */}
      {showRenderPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-sm"
          onClick={() => setShowRenderPreview(false)}
        >
          <div
            className="relative w-full max-w-4xl mx-4 bg-zinc-950 rounded-xl border border-white/10 overflow-hidden shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between h-11 px-4 border-b border-white/10 bg-zinc-900 shrink-0">
              <div className="flex items-center gap-2">
                <Play className="h-3.5 w-3.5 text-green-400 fill-green-400" />
                <span className="text-xs font-semibold text-green-400">Export Preview</span>
                {renderStatus?.sizeMB && (
                  <span className="text-[10px] text-zinc-500">{renderStatus.sizeMB} MB · MP4</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {renderStatus?.downloadUrl && (
                  <a href={renderStatus.downloadUrl} download onClick={e => e.stopPropagation()}>
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1.5 text-zinc-400 hover:text-white">
                      <Download className="h-3.5 w-3.5" /> Download
                    </Button>
                  </a>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowRenderPreview(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="bg-black">
              <video
                src={`${API_BASE}/projects/${id}/render-preview`}
                controls
                autoPlay
                preload="auto"
                className="w-full max-h-[80vh]"
                style={{ display: 'block' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Source Clip Preview Modal */}
      {previewVideoId && !sequencePreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setPreviewVideoId(null)}
        >
          <div
            className="relative w-full max-w-3xl mx-4 bg-zinc-950 rounded-xl border border-white/10 overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between h-10 px-4 border-b border-white/10 bg-zinc-900">
              <div className="flex items-center gap-2">
                <VideoIcon className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium truncate max-w-xs">
                  {videos?.find(v => v.id === previewVideoId)?.originalName ?? "Video Preview"}
                </span>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPreviewVideoId(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="relative bg-black">
              <video
                ref={videoRef}
                src={`${API_BASE}/videos/${previewVideoId}/stream`}
                controls autoPlay preload="auto"
                className="w-full max-h-[70vh]"
                style={{ display: 'block' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Sequence (Edit) Preview Modal */}
      {sequencePreview && (() => {
        const includedSegs = (segments ?? []).filter(s => s.included).sort((a, b) => a.orderIndex - b.orderIndex);
        const seg = includedSegs[seqIndex];
        const segVideo = seg ? videos?.find(v => v.id === seg.videoId) : null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-sm">
            <div className="relative w-full max-w-3xl mx-4 bg-zinc-950 rounded-xl border border-white/10 overflow-hidden shadow-2xl flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between h-11 px-4 border-b border-white/10 bg-zinc-900 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <Play className="h-3.5 w-3.5 text-green-400 fill-green-400" />
                    <span className="text-xs font-semibold text-green-400">Edit Preview</span>
                  </div>
                  <Badge variant="secondary" className="text-[9px] h-4">
                    Clip {seqIndex + 1} / {includedSegs.length}
                  </Badge>
                  {segVideo && (
                    <span className="text-[10px] text-zinc-400 truncate max-w-32">{segVideo.originalName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost" size="sm" className="h-7 text-[10px] gap-1"
                    onClick={() => setSeqIndex(i => Math.max(0, i - 1))}
                    disabled={seqIndex === 0}
                  >
                    ‹ Prev
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-7 text-[10px] gap-1"
                    onClick={() => setSeqIndex(i => Math.min(includedSegs.length - 1, i + 1))}
                    disabled={seqIndex >= includedSegs.length - 1}
                  >
                    Next ›
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSequencePreview(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Video — single persistent element, imperatively seeked */}
              <div className="relative bg-black">
                <video
                  ref={seqVideoRef}
                  controls
                  preload="auto"
                  className="w-full max-h-[65vh]"
                  style={{ display: 'block' }}
                  onTimeUpdate={() => {
                    const video = seqVideoRef.current;
                    if (!video || !seg) return;
                    const endTime = seg.endTime ?? Infinity;
                    if (endTime !== Infinity && video.currentTime >= endTime) {
                      if (seqIndex < includedSegs.length - 1) {
                        setSeqIndex(i => i + 1);
                      } else {
                        video.pause();
                      }
                    }
                  }}
                  onWaiting={() => setSeqBuffering(true)}
                  onPlaying={() => setSeqBuffering(false)}
                  onCanPlay={() => setSeqBuffering(false)}
                />
                {seqBuffering && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
                    <Loader2 className="h-8 w-8 animate-spin text-white/70" />
                  </div>
                )}
                {!seg && (
                  <div className="h-48 flex items-center justify-center text-zinc-500 text-sm">
                    No clip available
                  </div>
                )}
              </div>

              {/* Segment Strip */}
              <div className="flex gap-1 p-2 overflow-x-auto bg-zinc-900/80 border-t border-white/5">
                {includedSegs.map((s, i) => {
                  const sv = videos?.find(v => v.id === s.videoId);
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSeqIndex(i)}
                      className={cn(
                        "shrink-0 h-9 w-14 rounded overflow-hidden border relative transition-all",
                        i === seqIndex ? "border-green-400 ring-1 ring-green-400" : "border-white/10 hover:border-white/30"
                      )}
                    >
                      {sv && (
                        <img
                          src={`${API_BASE}/videos/${sv.id}/thumbnail.jpg`}
                          alt=""
                          className="h-full w-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      <div className={cn(
                        "absolute inset-0 flex items-center justify-center text-[8px] font-bold",
                        i === seqIndex ? "bg-green-400/20 text-green-300" : "bg-black/40 text-zinc-500"
                      )}>
                        {i + 1}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Segment Info Bar */}
              {seg && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-950/80 border-t border-white/5 text-[9px] font-mono text-zinc-500">
                  <span>{seg.startTime.toFixed(2)}s → {seg.endTime.toFixed(2)}s</span>
                  <span className="capitalize text-zinc-400">{seg.segmentType}</span>
                  <span>{(seg.endTime - seg.startTime).toFixed(2)}s</span>
                  {seg.colorGrade && seg.colorGrade !== 'none' && (
                    <Badge className="text-[8px] h-3.5 py-0 capitalize">{seg.colorGrade}</Badge>
                  )}
                  {seg.captionText && (
                    <span className="text-yellow-400 truncate max-w-24">"{seg.captionText}"</span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Story Preferences Modal */}
      <StoryPrefsModal
        open={showStoryPrefs}
        onClose={() => setShowStoryPrefs(false)}
        onApply={(prefs) => {
          handleStoryPrefsApply(prefs);
          setRightPanelTab("story");
        }}
        projectFormat={project?.targetFormat ?? undefined}
      />

      {/* Drive Folder Picker Dialog */}
      <Dialog open={showDrivePicker} onOpenChange={setShowDrivePicker}>
        <DialogContent className="max-w-sm bg-background border-border" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v8.25" />
              </svg>
              Select Drive Folder
            </DialogTitle>
          </DialogHeader>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground min-h-[18px] flex-wrap">
            <button
              className="hover:text-foreground underline"
              onClick={() => {
                setDrivePickerParent([]);
                loadDriveFolders();
              }}
            >
              My Drive
            </button>
            {drivePickerParent.map((p, i) => (
              <span key={p.id} className="flex items-center gap-1">
                <span>/</span>
                <button
                  className="hover:text-foreground underline"
                  onClick={() => {
                    const next = drivePickerParent.slice(0, i + 1);
                    setDrivePickerParent(next);
                    loadDriveFolders(p.id);
                  }}
                >
                  {p.name}
                </button>
              </span>
            ))}
          </div>

          {/* Folder list */}
          <div className="border border-border rounded-md overflow-hidden">
            {driveFoldersLoading ? (
              <div className="p-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
                Loading folders…
              </div>
            ) : driveFolders.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">No subfolders found</div>
            ) : (
              <ScrollArea className="max-h-56">
                <div className="divide-y divide-border">
                  {driveFolders.map((folder) => (
                    <button
                      key={folder.id}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/40 transition-colors ${selectedDriveFolder?.id === folder.id ? "bg-emerald-500/10 text-emerald-300" : "text-foreground"}`}
                      onClick={() => {
                        if (folder.hasChildren) {
                          setDrivePickerParent((prev) => [...prev, { id: folder.id, name: folder.name }]);
                          loadDriveFolders(folder.id);
                        } else {
                          setSelectedDriveFolder({ id: folder.id, name: folder.name });
                        }
                      }}
                    >
                      <svg className="h-3.5 w-3.5 shrink-0 text-yellow-400/80" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l.64.641H13.5A1.5 1.5 0 0115 4.5v8a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/>
                      </svg>
                      <span className="flex-1 truncate">{folder.name}</span>
                      {folder.hasChildren && (
                        <svg className="h-3 w-3 text-muted-foreground shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 01.708 0l6 6a.5.5 0 010 .708l-6 6a.5.5 0 01-.708-.708L10.293 8 4.646 2.354a.5.5 0 010-.708z"/>
                        </svg>
                      )}
                      {!folder.hasChildren && selectedDriveFolder?.id !== folder.id && (
                        <span className="text-[9px] text-muted-foreground">Select</span>
                      )}
                      {selectedDriveFolder?.id === folder.id && (
                        <svg className="h-3 w-3 text-emerald-400 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/>
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" onClick={() => setShowDrivePicker(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="flex-1 h-7 text-xs bg-emerald-600 hover:bg-emerald-500"
              disabled={!selectedDriveFolder}
              onClick={() => setShowDrivePicker(false)}
            >
              {selectedDriveFolder ? `Use "${selectedDriveFolder.name}"` : "Choose a folder"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
