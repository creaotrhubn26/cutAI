import { useState, useEffect, useRef, useCallback } from "react";
import {
  Volume2, VolumeX, Mic2, Music2, Zap, Loader2, Check,
  AlertTriangle, Info, Upload, X, FileAudio, Sparkles,
  ExternalLink, ChevronDown, ChevronUp, Play, Pause, Search, Download
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import type { Segment } from "@workspace/api-client-react";

interface WaveformData {
  waveform: number[];
  duration: number;
  points: number;
}

interface MusicAnalysis {
  bpm: number;
  mood: string;
  energy: number;
  danceability: number;
  emotionalArc?: string;
}

interface MusicSuggestion {
  id: string;
  title: string;
  genre: string;
  subGenre?: string;
  mood: string;
  energy: "low" | "medium" | "high" | "very_high";
  bpmMin: number;
  bpmMax: number;
  instruments: string[];
  description: string;
  royaltyFreeKeywords: string[];
  platforms: string[];
  exampleArtists: string[];
  colorVisualization?: string;
}

interface JamendoTrack {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  previewUrl: string;
  downloadUrl: string;
  shareUrl: string;
  imageUrl: string;
  genres: string[];
  tags: string[];
  speed: string | null;
}

interface AudioMixPanelProps {
  projectId: string;
  videoId?: string;
  segments?: Segment[];
  musicAnalysis?: MusicAnalysis | null;
  musicSuggestions?: string | null;
  onRunJob: (type: string, videoId?: string, options?: string) => void;
  apiBase: string;
}

export function AudioMixPanel({
  projectId,
  videoId,
  segments,
  musicAnalysis,
  musicSuggestions,
  onRunJob,
  apiBase,
}: AudioMixPanelProps) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const musicFileRef = useRef<HTMLInputElement>(null);

  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [autoDuck, setAutoDuck] = useState(true);
  const [globalMusicVol, setGlobalMusicVol] = useState(80);
  const [speechVol, setSpeechVol] = useState(100);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);
  const [uploadedMusicName, setUploadedMusicName] = useState<string | null>(null);
  const [uploadingMusic, setUploadingMusic] = useState(false);
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const [musicSearchResults, setMusicSearchResults] = useState<Record<string, JamendoTrack[]>>({});
  const [musicSearchLoading, setMusicSearchLoading] = useState<Record<string, boolean>>({});
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const searchJamendoTracks = useCallback(async (sug: MusicSuggestion) => {
    setMusicSearchLoading(prev => ({ ...prev, [sug.id]: true }));
    try {
      const query = sug.royaltyFreeKeywords.slice(0, 2).join(" ") || sug.genre;
      const tags = [sug.genre.toLowerCase(), sug.mood.toLowerCase()].join(",");
      const params = new URLSearchParams({
        query,
        tags,
        bpmMin: String(sug.bpmMin),
        bpmMax: String(sug.bpmMax),
        limit: "6",
      });
      const res = await fetch(`${apiBase}/music/search?${params.toString()}`);
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json() as { tracks: JamendoTrack[] };
      setMusicSearchResults(prev => ({ ...prev, [sug.id]: data.tracks }));
    } catch (e: any) {
      toast({ title: "Music search failed", description: e.message, variant: "destructive" });
    } finally {
      setMusicSearchLoading(prev => ({ ...prev, [sug.id]: false }));
    }
  }, [apiBase, toast]);

  const togglePlay = useCallback((track: JamendoTrack) => {
    if (playingTrackId === track.id) {
      audioRef.current?.pause();
      setPlayingTrackId(null);
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(track.previewUrl);
      audio.onended = () => setPlayingTrackId(null);
      audioRef.current = audio;
      audio.play().catch(() => {});
      setPlayingTrackId(track.id);
    }
  }, [playingTrackId]);

  function formatDuration(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  async function handleMusicUpload(file: File) {
    if (!file.type.startsWith("audio/")) {
      toast({ title: "Invalid file", description: "Please upload an audio file (MP3, WAV, AAC…)", variant: "destructive" });
      return;
    }
    setUploadingMusic(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("projectId", projectId);
      const res = await fetch(`${apiBase}/videos`, { method: "POST", body: form });
      if (!res.ok) throw new Error("Upload failed");
      setUploadedMusicName(file.name);
      toast({ title: "Music track uploaded", description: `"${file.name}" will be mixed as background music on next render.` });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingMusic(false);
    }
  }

  useEffect(() => {
    if (!videoId) return;
    setWaveformLoading(true);
    setWaveformData(null);
    fetch(`${apiBase}/videos/${videoId}/waveform?points=250`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.waveform ? setWaveformData(d) : null)
      .catch(() => null)
      .finally(() => setWaveformLoading(false));
  }, [videoId, apiBase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const duration = waveformData?.duration ?? 1;
    const includedSegs = segments?.filter(s => s.included) ?? [];

    // Segment background bands
    for (const seg of includedSegs) {
      const x1 = (seg.startTime / duration) * W;
      const x2 = (seg.endTime / duration) * W;
      const isSpeech = (seg.audioMixLevel ?? 0) > 0.5;
      ctx.fillStyle = isSpeech ? "rgba(59,130,246,0.12)" : "rgba(168,85,247,0.07)";
      ctx.fillRect(x1, 0, x2 - x1, H);
    }

    if (!waveformData) return;
    const { waveform } = waveformData;
    const barW = W / waveform.length;
    const maxVal = Math.max(...waveform, 0.001);

    for (let i = 0; i < waveform.length; i++) {
      const x = i * barW;
      const norm = waveform[i] / maxVal;
      const barH = Math.max(2, norm * (H * 0.88));
      const y = (H - barH) / 2;

      const t = (i / waveform.length) * duration;
      const inSpeech = includedSegs.some(
        s => s.startTime <= t && s.endTime > t && (s.audioMixLevel ?? 0) > 0.5
      );

      ctx.fillStyle = inSpeech
        ? `rgba(96,165,250,${0.45 + norm * 0.55})`
        : `rgba(167,139,250,${0.25 + norm * 0.45})`;
      ctx.fillRect(x, y, Math.max(0.5, barW - 0.5), barH);
    }

    // Segment boundary lines
    for (const seg of includedSegs) {
      const x = (seg.startTime / duration) * W;
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }, [waveformData, segments]);

  const handleDetectSpeech = () => {
    if (detecting) return;
    setDetecting(true);
    setDetected(false);
    onRunJob("detect_speech");
    setTimeout(() => {
      setDetecting(false);
      setDetected(true);
      toast({
        title: "Speech detection running",
        description: "Segments will be updated with speech/music levels once complete.",
      });
    }, 1500);
  };

  const includedSegs = segments?.filter(s => s.included) ?? [];
  const speechSegs = includedSegs.filter(s => (s.audioMixLevel ?? 0) > 0.5);
  const hasSpeechData = speechSegs.length > 0;

  return (
    <div className="space-y-4 px-3 py-2">

      {/* Waveform canvas */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
            Audio Waveform
          </span>
          <div className="flex gap-3">
            <span className="flex items-center gap-1 text-[9px] text-blue-400">
              <span className="inline-block w-2 h-2 rounded-sm bg-blue-400/40 border border-blue-400/30" />
              Speech
            </span>
            <span className="flex items-center gap-1 text-[9px] text-purple-400">
              <span className="inline-block w-2 h-2 rounded-sm bg-purple-400/25 border border-purple-400/20" />
              Music-only
            </span>
          </div>
        </div>

        <div
          className="relative bg-zinc-950 rounded-md border border-zinc-800 overflow-hidden"
          style={{ height: 64 }}
        >
          {waveformLoading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
              <span className="ml-1.5 text-[9px] text-zinc-600">Generating waveform…</span>
            </div>
          )}
          {!videoId && !waveformLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-[9px] text-zinc-700">
              Select a clip to preview waveform
            </div>
          )}
          <canvas ref={canvasRef} width={400} height={64} className="w-full h-full" />
        </div>

        {hasSpeechData && (
          <p className="text-[9px] text-zinc-500">
            {speechSegs.length}/{includedSegs.length} clips have speech · music ducks to 12% during these
          </p>
        )}
        {!hasSpeechData && includedSegs.length > 0 && (
          <p className="text-[9px] text-zinc-600 flex items-center gap-1">
            <Info className="h-3 w-3 shrink-0" />
            Run "Detect Speech" to auto-tag clips and set ducking levels
          </p>
        )}
      </div>

      {/* Music track upload */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider flex items-center gap-1">
            <FileAudio className="h-3 w-3 text-pink-400" /> Background Music Track
          </span>
          {uploadedMusicName && (
            <button onClick={() => setUploadedMusicName(null)} className="text-zinc-600 hover:text-zinc-400">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {uploadedMusicName ? (
          <div className="flex items-center gap-1.5 bg-pink-500/10 border border-pink-500/20 rounded px-2 py-1">
            <Music2 className="h-3 w-3 text-pink-400 shrink-0" />
            <span className="text-[9px] text-pink-300 truncate">{uploadedMusicName}</span>
            <Badge className="ml-auto text-[8px] h-3.5 px-1.5 bg-green-600/80 text-white border-0">Ready</Badge>
          </div>
        ) : (
          <button
            onClick={() => musicFileRef.current?.click()}
            disabled={uploadingMusic}
            className="w-full h-8 border border-dashed border-zinc-700 rounded text-[9px] text-zinc-500 hover:border-pink-500/50 hover:text-pink-400 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {uploadingMusic ? (
              <><Loader2 className="h-3 w-3 animate-spin" />Uploading…</>
            ) : (
              <><Upload className="h-3 w-3" />Upload MP3 / WAV / AAC</>
            )}
          </button>
        )}
        <p className="text-[8px] text-zinc-600">Uploaded track auto-mixes with per-segment ducking on render</p>
        <input
          ref={musicFileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleMusicUpload(f); e.target.value = ""; }}
        />
      </div>

      {/* Auto-duck toggle */}
      <div className="flex items-center justify-between py-2.5 border-y border-zinc-800">
        <div className="flex items-center gap-2">
          <Zap className="h-3 w-3 text-yellow-400" />
          <div>
            <p className="text-[10px] font-bold leading-tight">Auto-Duck Music</p>
            <p className="text-[9px] text-zinc-500">Music drops during speech segments</p>
          </div>
        </div>
        <Switch checked={autoDuck} onCheckedChange={setAutoDuck} />
      </div>

      {/* Volume controls */}
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Music2 className="h-3 w-3 text-pink-400" />
              <span className="text-[10px] font-medium">Music Track</span>
            </div>
            <span className="text-[10px] font-mono text-pink-400">{globalMusicVol}%</span>
          </div>
          <Slider
            value={[globalMusicVol]}
            min={0} max={100} step={5}
            onValueChange={([v]) => setGlobalMusicVol(v)}
          />
          {autoDuck && (
            <p className="text-[9px] text-zinc-600 italic">↘ Ducked to ~12% during speech</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Mic2 className="h-3 w-3 text-blue-400" />
              <span className="text-[10px] font-medium">Dialogue / Speech</span>
            </div>
            <span className="text-[10px] font-mono text-blue-400">{speechVol}%</span>
          </div>
          <Slider
            value={[speechVol]}
            min={0} max={100} step={5}
            onValueChange={([v]) => setSpeechVol(v)}
          />
        </div>
      </div>

      {/* Music analysis card */}
      {musicAnalysis && (
        <div className="bg-zinc-900/60 rounded-md border border-zinc-800 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-zinc-500 uppercase font-bold tracking-wider">Background Music</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 text-pink-400 border-pink-400/30">
              {musicAnalysis.mood}
            </Badge>
          </div>
          <div className="flex gap-4 items-end">
            <div>
              <div className="text-[9px] text-zinc-500">BPM</div>
              <div className="text-xl font-bold tabular-nums">{musicAnalysis.bpm}</div>
            </div>
            <div className="flex-1 space-y-1.5">
              <div>
                <div className="flex justify-between text-[9px] text-zinc-500 mb-0.5">
                  <span>Energy</span><span>{Math.round(musicAnalysis.energy * 100)}%</span>
                </div>
                <Progress value={musicAnalysis.energy * 100} className="h-1 bg-zinc-800" />
              </div>
              <div>
                <div className="flex justify-between text-[9px] text-zinc-500 mb-0.5">
                  <span>Dance</span><span>{Math.round(musicAnalysis.danceability * 100)}%</span>
                </div>
                <Progress value={musicAnalysis.danceability * 100} className="h-1 bg-zinc-800" />
              </div>
            </div>
          </div>
          {musicAnalysis.emotionalArc && (
            <p className="text-[9px] text-zinc-400 italic leading-snug">
              "{musicAnalysis.emotionalArc}"
            </p>
          )}
        </div>
      )}

      {/* Detect speech CTA */}
      <Button
        className="w-full text-[10px] uppercase font-bold h-8"
        variant={detected ? "secondary" : "default"}
        onClick={handleDetectSpeech}
        disabled={detecting || includedSegs.length === 0}
      >
        {detecting ? (
          <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Detecting Speech…</>
        ) : detected ? (
          <><Check className="h-3 w-3 mr-1.5 text-green-400" />Speech Detected · Re-run?</>
        ) : (
          <><Mic2 className="h-3 w-3 mr-1.5" />Detect Speech &amp; Auto-Balance</>
        )}
      </Button>

      {hasSpeechData && (
        <div className="text-[9px] text-zinc-500 space-y-0.5 border-t border-zinc-800 pt-2">
          <p className="font-bold text-zinc-400">Per-clip audio summary</p>
          {speechSegs.slice(0, 5).map(s => (
            <div key={s.id} className="flex justify-between">
              <span className="truncate max-w-[130px] text-zinc-400">{s.label ?? s.segmentType}</span>
              <span className="text-blue-400 font-mono shrink-0 ml-1">
                🎙 vol={Math.round((s.audioMixLevel ?? 1) * 100)}% music={Math.round((s.musicDuckLevel ?? 1) * 100)}%
              </span>
            </div>
          ))}
          {speechSegs.length > 5 && (
            <p className="text-zinc-600">…and {speechSegs.length - 5} more speech clips</p>
          )}
        </div>
      )}

      {/* ── AI Music Suggestions ── */}
      {(() => {
        let suggestions: MusicSuggestion[] = [];
        try { if (musicSuggestions) suggestions = JSON.parse(musicSuggestions); } catch {}

        if (!suggestions.length) {
          return (
            <div className="rounded-md border border-dashed border-zinc-800 p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-pink-400" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">AI Music Suggestions</span>
              </div>
              <p className="text-[9px] text-zinc-600 leading-relaxed">
                Run <span className="text-pink-400 font-semibold">AI Music Suggestions</span> in the pipeline — Claude Vision will analyze your video and recommend music genres, moods, BPM ranges, and royalty-free search keywords.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-[9px] h-7 border-pink-500/30 text-pink-400 hover:bg-pink-500/10 hover:border-pink-500/60"
                onClick={() => onRunJob("suggest_music")}
              >
                <Sparkles className="h-3 w-3 mr-1" />
                Suggest Music for This Video
              </Button>
            </div>
          );
        }

        const energyColors: Record<string, string> = {
          low:       "text-blue-400",
          medium:    "text-green-400",
          high:      "text-yellow-400",
          very_high: "text-red-400",
        };
        const energyLabels: Record<string, string> = {
          low: "Calm", medium: "Moderate", high: "Energetic", very_high: "Intense",
        };

        return (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-pink-400" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">AI Music Suggestions</span>
              <span className="ml-auto text-[8px] text-zinc-600">{suggestions.length} options</span>
            </div>

            {suggestions.map(sug => {
              const isExpanded = expandedSuggestion === sug.id;
              const accentColor = sug.colorVisualization ?? "#ec4899";
              return (
                <div
                  key={sug.id}
                  className="rounded-md border border-zinc-800 overflow-hidden transition-all"
                  style={{ borderLeftColor: accentColor, borderLeftWidth: "3px" }}
                >
                  {/* Header — always visible */}
                  <button
                    className="w-full text-left p-2 flex items-center gap-2 hover:bg-zinc-800/40 transition-colors"
                    onClick={() => setExpandedSuggestion(isExpanded ? null : sug.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-bold text-white truncate">{sug.title}</span>
                        <span className="text-[8px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded shrink-0">{sug.genre}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[8px] font-semibold ${energyColors[sug.energy] ?? "text-zinc-400"}`}>
                          {energyLabels[sug.energy] ?? sug.energy}
                        </span>
                        <span className="text-[8px] text-zinc-500">{sug.bpmMin}–{sug.bpmMax} BPM</span>
                        <span className="text-[8px] text-zinc-500 italic">{sug.mood}</span>
                      </div>
                    </div>
                    {isExpanded
                      ? <ChevronUp className="h-3 w-3 text-zinc-500 shrink-0" />
                      : <ChevronDown className="h-3 w-3 text-zinc-500 shrink-0" />
                    }
                  </button>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-2 pb-2 space-y-2.5 border-t border-zinc-800">
                      {/* Description */}
                      <p className="text-[9px] text-zinc-400 leading-relaxed pt-1.5">{sug.description}</p>

                      {/* Instruments */}
                      {sug.instruments?.length > 0 && (
                        <div>
                          <p className="text-[8px] text-zinc-600 uppercase font-bold mb-0.5">Instruments</p>
                          <div className="flex flex-wrap gap-1">
                            {sug.instruments.map((inst, i) => (
                              <span key={i} className="text-[8px] bg-zinc-800/80 text-zinc-300 px-1.5 py-0.5 rounded">
                                {inst}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Example artists */}
                      {sug.exampleArtists?.length > 0 && (
                        <div>
                          <p className="text-[8px] text-zinc-600 uppercase font-bold mb-0.5">Similar Artists (reference)</p>
                          <p className="text-[9px] text-zinc-400">{sug.exampleArtists.join(", ")}</p>
                        </div>
                      )}

                      {/* Royalty-free search keywords */}
                      {sug.royaltyFreeKeywords?.length > 0 && (
                        <div>
                          <p className="text-[8px] text-zinc-600 uppercase font-bold mb-1">Search keywords</p>
                          <div className="flex flex-wrap gap-1">
                            {sug.royaltyFreeKeywords.map((kw, i) => (
                              <span
                                key={i}
                                className="text-[8px] px-1.5 py-0.5 rounded border border-pink-500/30 text-pink-300 bg-pink-500/5 cursor-pointer hover:bg-pink-500/15 transition-colors"
                                onClick={() => {
                                  navigator.clipboard.writeText(kw).catch(() => {});
                                  toast({ title: "Copied!", description: `"${kw}" copied to clipboard` });
                                }}
                                title="Click to copy"
                              >
                                {kw}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── Quick Search Links ── */}
                      {(() => {
                        const kws = sug.royaltyFreeKeywords.slice(0, 3).join(" ") || `${sug.genre} ${sug.mood}`;
                        const encoded = encodeURIComponent(kws);
                        const sites = [
                          {
                            name: "Jamendo",
                            url: `https://www.jamendo.com/search/tracks?q=${encoded}`,
                            color: "text-orange-400 hover:text-orange-300",
                            border: "border-orange-500/20 hover:border-orange-500/40 hover:bg-orange-500/5",
                            note: "600k+ CC tracks",
                          },
                          {
                            name: "Pixabay",
                            url: `https://pixabay.com/music/search/${encoded}/`,
                            color: "text-green-400 hover:text-green-300",
                            border: "border-green-500/20 hover:border-green-500/40 hover:bg-green-500/5",
                            note: "100% free",
                          },
                          {
                            name: "YouTube Audio Library",
                            url: `https://studio.youtube.com/channel/UC/music`,
                            color: "text-red-400 hover:text-red-300",
                            border: "border-red-500/20 hover:border-red-500/40 hover:bg-red-500/5",
                            note: "Free for YouTube",
                          },
                          {
                            name: "SoundStripe",
                            url: `https://www.soundstripe.com/songs?q=${encoded}`,
                            color: "text-blue-400 hover:text-blue-300",
                            border: "border-blue-500/20 hover:border-blue-500/40 hover:bg-blue-500/5",
                            note: "Subscription",
                          },
                        ];
                        return (
                          <div className="space-y-1.5">
                            <p className="text-[8px] text-zinc-500 uppercase font-bold">Search on music sites</p>
                            <div className="grid grid-cols-2 gap-1">
                              {sites.map(site => (
                                <a
                                  key={site.name}
                                  href={site.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`flex flex-col gap-0.5 rounded border px-2 py-1.5 transition-colors ${site.border}`}
                                >
                                  <div className="flex items-center gap-1">
                                    <span className={`text-[9px] font-semibold ${site.color}`}>{site.name}</span>
                                    <ExternalLink className="h-2.5 w-2.5 text-zinc-600" />
                                  </div>
                                  <span className="text-[7px] text-zinc-600">{site.note}</span>
                                </a>
                              ))}
                            </div>
                            <p className="text-[7px] text-zinc-700 leading-relaxed">
                              Søkeord: <span className="text-zinc-500 italic">{kws}</span>
                            </p>
                          </div>
                        );
                      })()}

                      {/* Platform links */}
                      {sug.platforms?.length > 0 && (
                        <div>
                          <p className="text-[8px] text-zinc-600 uppercase font-bold mb-1">Premium platforms</p>
                          <div className="flex flex-wrap gap-1.5">
                            {sug.platforms.map((pl, i) => {
                              const platformUrls: Record<string, string> = {
                                "Epidemic Sound": "https://www.epidemicsound.com",
                                "Artlist": "https://artlist.io",
                                "Musicbed": "https://www.musicbed.com",
                                "Pond5": "https://www.pond5.com",
                                "Free Music Archive": "https://freemusicarchive.org",
                                "YouTube Audio Library": "https://studio.youtube.com/channel/UC/music",
                              };
                              const url = platformUrls[pl];
                              return url ? (
                                <a
                                  key={i}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-0.5 text-[8px] text-blue-400 hover:text-blue-300 underline underline-offset-2"
                                >
                                  {pl} <ExternalLink className="h-2 w-2" />
                                </a>
                              ) : (
                                <span key={i} className="text-[8px] text-zinc-500">{pl}</span>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <Button
              size="sm"
              variant="ghost"
              className="w-full text-[9px] h-6 text-zinc-600 hover:text-zinc-400"
              onClick={() => onRunJob("suggest_music")}
            >
              Re-analyze music suggestions
            </Button>
          </div>
        );
      })()}
    </div>
  );
}
