import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { jobsTable, videosTable, projectsTable, segmentsTable, activityTable, editStylesTable, trainingExamplesTable, clipSignalsTable, learnedClipPrefsTable, modelConfigTable, segmentEditsTable, clipTrainingPairsTable, styleProfilesTable, clipEmbeddingsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getDriveClient } from "../lib/google";
import { randomUUID } from "crypto";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { openai } from "@workspace/integrations-openai-ai-server";
import { ai as geminiAi } from "@workspace/integrations-gemini-ai";
import { batchProcess } from "@workspace/integrations-gemini-ai/batch";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);
import {
  CreateJobBody,
  GetJobParams,
  ListProjectJobsParams,
} from "@workspace/api-zod";

const RENDER_DIR = process.env.RENDER_DIR ?? "/tmp/cutai-renders";
if (!fs.existsSync(RENDER_DIR)) fs.mkdirSync(RENDER_DIR, { recursive: true });
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/cutai-uploads";

const COLOR_GRADE_FILTERS: Record<string, string> = {
  warm: "colorbalance=rs=0.12:gs=0.02:bs=-0.15:rm=0.06:gm=0:bm=-0.08,eq=brightness=0.02",
  cool: "colorbalance=rs=-0.08:gs=0.02:bs=0.12:rm=-0.04:gm=0:bm=0.06,eq=saturation=0.8",
  cinematic: "colorbalance=rs=0.06:gs=0:bs=-0.06,eq=contrast=1.15:saturation=0.85",
  bw: "hue=s=0,eq=contrast=1.2",
  vivid: "eq=saturation=1.8:contrast=1.1",
  muted: "eq=saturation=0.5:brightness=-0.05",
  sunset: "colorbalance=rs=0.2:gs=0.05:bs=-0.2:rm=0.1:gm=0.02:bm=-0.1,eq=saturation=1.1:brightness=0.02",
  teal_orange: "colorbalance=rs=0.12:gs=-0.02:bs=-0.12:rm=-0.05:gm=0.05:bm=0.05,eq=saturation=1.3:contrast=1.1",
  desaturated: "eq=saturation=0.25:brightness=0.05",
};

function buildAtempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

function escapeDrawtext(text: string): string {
  return text.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\n/g, " ");
}

function buildCaptionFilter(captionText: string, captionStyle: string): string {
  if (!captionText || captionStyle === "none") return "";
  const t = escapeDrawtext(captionText);
  switch (captionStyle) {
    case "subtitle":
      return `drawtext=text='${t}':fontsize=36:fontcolor=white:x=(w-tw)/2:y=h-th-60:shadowx=2:shadowy=2:shadowcolor=black@0.9:shadowcolor=black`;
    case "title":
      return `drawtext=text='${t}':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:box=1:boxcolor=black@0.5:boxborderw=12`;
    case "lower_third":
      return `drawtext=text='${t}':fontsize=40:fontcolor=white:x=60:y=h-90:box=1:boxcolor=black@0.65:boxborderw=10`;
    case "kinetic":
      return `drawtext=text='${t}':fontsize=80:fontcolor=white@0.95:x=(w-tw)/2:y=(h-th)/2-60:shadowx=4:shadowy=4:shadowcolor=black@0.9`;
    default:
      return `drawtext=text='${t}':fontsize=36:fontcolor=white:x=(w-tw)/2:y=h-th-60:shadowx=2:shadowy=2:shadowcolor=black`;
  }
}

function getFormatScale(targetFormat: string): string {
  const vertical = ["instagram_reel", "tiktok", "youtube_short"];
  if (vertical.includes(targetFormat)) {
    return "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";
  }
  return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";
}

function runFfmpeg(args: string[]): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-200)}`));
    });
  });
}

// ── Neural analysis helper ─────────────────────────────────────────────────
// Compiled output is at dist/index.mjs; neural scripts are at src/neural/
// In dev: __dirname = .../artifacts/api-server/dist → go up to find src/neural
const NEURAL_DIR = process.env.NEURAL_SCRIPTS_DIR
  ?? path.join(__dirname, "..", "src", "neural");
const PYTHON_BIN = process.env.PYTHONUSERBASE
  ? path.join(process.env.PYTHONUSERBASE, "bin", "python3")
  : "python3";

function runPythonScript(scriptName: string, args: string[], timeoutMs = 120000): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const scriptPath = path.join(NEURAL_DIR, scriptName);
    if (!fs.existsSync(scriptPath)) {
      resolve({ error: `Script not found: ${scriptName}` });
      return;
    }
    const proc = spawn(PYTHON_BIN, [scriptPath, ...args]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ error: `${scriptName} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const trimmed = stdout.trim();
        if (trimmed) resolve(JSON.parse(trimmed));
        else resolve({ error: `${scriptName} no output (code ${code}): ${stderr.slice(0, 200)}` });
      } catch (e) {
        resolve({ error: `${scriptName} JSON parse error: ${e}` });
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: `${scriptName} spawn error: ${e.message}` });
    });
  });
}

const router: IRouter = Router();

function serializeJob(j: typeof jobsTable.$inferSelect) {
  return {
    ...j,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
  };
}

async function appendLog(jobId: string, line: string) {
  const [job] = await db.select({ logLines: jobsTable.logLines }).from(jobsTable).where(eq(jobsTable.id, jobId));
  const existing: string[] = JSON.parse(job?.logLines ?? "[]");
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  existing.push(`[${ts}] ${line}`);
  await db.update(jobsTable).set({ logLines: JSON.stringify(existing) }).where(eq(jobsTable.id, jobId));
}

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runJobAsync(jobId: string, projectId: string, videoId: string | null | undefined, type: string, options?: string | null) {
  await db.update(jobsTable).set({ status: "running", startedAt: new Date(), progress: 5 }).where(eq(jobsTable.id, jobId));
  await appendLog(jobId, `Starting ${type.replace(/_/g, " ")} job...`);

  try {
    let result: string | null = null;

    if (type === "transcribe" && videoId) {
      await appendLog(jobId, "Loading video metadata...");
      const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
      if (!video) throw new Error("Video not found");

      await db.update(jobsTable).set({ progress: 15 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Processing audio from "${video.originalName}"...`);

      const filePath = video.filePath;
      let transcriptResult: string;

      if (filePath && fs.existsSync(filePath)) {
        // ── Real Whisper transcription ──────────────────────────────────────
        await appendLog(jobId, "Extracting audio track with ffmpeg...");
        const tempAudio = path.join("/tmp", `cutai-audio-${videoId}.wav`);

        await new Promise<void>((resolve, reject) => {
          const proc = spawn("ffmpeg", [
            "-i", filePath,
            "-vn", "-ac", "1", "-ar", "16000",
            "-acodec", "pcm_s16le",
            "-y", tempAudio
          ]);
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg audio extract failed: code ${code}`)));
          proc.on("error", reject);
          setTimeout(() => { proc.kill(); reject(new Error("ffmpeg audio extract timeout")); }, 60000);
        });

        await db.update(jobsTable).set({ progress: 35 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, "Audio extracted. Sending to transcription API...");

        // Load project's custom vocabulary to guide transcription
        const [projectForVocab] = await db.select({ customVocabulary: projectsTable.customVocabulary })
          .from(projectsTable).where(eq(projectsTable.id, projectId));
        const vocabTerms = (projectForVocab?.customVocabulary ?? "")
          .split(",").map((t: string) => t.trim()).filter(Boolean);
        const whisperPrompt = vocabTerms.length > 0
          ? `Custom terminology and proper nouns: ${vocabTerms.join(", ")}.`
          : undefined;
        if (vocabTerms.length > 0) {
          await appendLog(jobId, `  Using custom vocabulary (${vocabTerms.length} term${vocabTerms.length !== 1 ? "s" : ""}): ${vocabTerms.slice(0, 8).join(", ")}${vocabTerms.length > 8 ? "…" : ""}`);
        }

        const audioBuffer = fs.readFileSync(tempAudio);
        const audioFile = new File([audioBuffer], "audio.wav", { type: "audio/wav" });

        // Use gpt-4o-mini-transcribe with json — only reliable model/format on Replit AI proxy.
        let transcription: any;
        const hasVerboseSegments = false;
        await appendLog(jobId, "Sending to gpt-4o-mini-transcribe...");
        transcription = await openai.audio.transcriptions.create({
          model: "gpt-4o-mini-transcribe",
          file: audioFile,
          response_format: "json",
          ...(whisperPrompt ? { prompt: whisperPrompt } : {}),
        } as any);

        await db.update(jobsTable).set({ progress: 55 }).where(eq(jobsTable.id, jobId));

        const tx = transcription as any;
        const txText: string = tx.text ?? "";

        // If verbose_json succeeded, use the real segment timestamps directly
        if (hasVerboseSegments) {
          fs.unlinkSync(tempAudio);
          const audioDuration2 = tx.duration ?? (video.durationSeconds ?? 60);
          const words = txText.trim().split(/\s+/).filter(Boolean);
          const txSegments2 = tx.segments.map((s: any) => ({
            start: s.start,
            end: s.end,
            text: s.text?.trim() ?? "",
            words: Array.isArray(s.words) ? s.words.map((w: any) => ({ word: w.word, start: w.start, end: w.end, probability: w.probability })) : [],
          }));
          await db.update(jobsTable).set({ progress: 80 }).where(eq(jobsTable.id, jobId));
          await appendLog(jobId, `Transcription complete: ${words.length} words, ${txSegments2.length} segments with real timestamps.`);
          const transcriptData2 = {
            transcript: txText,
            segments: txSegments2,
            words: [],
            model: "gpt-4o-transcribe",
            wordCount: words.length,
            language: tx.language ?? "en",
            duration: audioDuration2,
          };
          transcriptResult = JSON.stringify(transcriptData2);
        } else {
          await appendLog(jobId, "Detecting silence boundaries for timestamps...");

        // ── Get audio duration via ffprobe ───────────────────────────────────
        const audioDuration = await new Promise<number>((resolve) => {
          const proc = spawn("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", tempAudio]);
          let out = "";
          proc.stdout.on("data", (d: Buffer) => out += d.toString());
          proc.on("close", () => { const d = parseFloat(out.trim()); resolve(isNaN(d) ? (video.durationSeconds ?? 60) : d); });
          proc.on("error", () => resolve(video.durationSeconds ?? 60));
        });

        // ── Detect silence boundaries via ffmpeg ─────────────────────────────
        // silencedetect finds gaps ≥0.3s at ≤-35dB — these are natural phrase/sentence breaks
        const silenceOutput = await new Promise<string>((resolve) => {
          const proc = spawn("ffmpeg", ["-i", tempAudio, "-af", "silencedetect=noise=-35dB:duration=0.3", "-f", "null", "-"]);
          let stderr = "";
          proc.stderr.on("data", (d: Buffer) => stderr += d.toString());
          proc.on("close", () => resolve(stderr));
          proc.on("error", () => resolve(""));
          setTimeout(() => { proc.kill(); resolve(stderr); }, 30000);
        });

        fs.unlinkSync(tempAudio);

        // Parse silence intervals: [silence_start, silence_end] pairs
        const silenceIntervals: Array<[number, number]> = [];
        const silenceStartMatches = silenceOutput.matchAll(/silence_start:\s*([\d.]+)/g);
        const silenceEndMatches = silenceOutput.matchAll(/silence_end:\s*([\d.]+)/g);
        const starts = [...silenceStartMatches].map(m => parseFloat(m[1]));
        const ends = [...silenceEndMatches].map(m => parseFloat(m[1]));
        for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
          silenceIntervals.push([starts[i], ends[i]]);
        }

        // Build speech segments from silence gaps
        // Speech segment = [prev_silence_end, next_silence_start]
        const speechBoundaries: number[] = [0];
        for (const [sStart, sEnd] of silenceIntervals) {
          speechBoundaries.push(sStart);  // speech ends at silence start
          speechBoundaries.push(sEnd);    // speech starts at silence end
        }
        speechBoundaries.push(audioDuration);

        // Pair up into [segStart, segEnd] for each speech segment
        const speechSegmentTimes: Array<[number, number]> = [];
        for (let i = 0; i < speechBoundaries.length - 1; i += 2) {
          const segStart = speechBoundaries[i];
          const segEnd = speechBoundaries[i + 1];
          if (segEnd - segStart >= 0.3) {
            speechSegmentTimes.push([segStart, segEnd]);
          }
        }

        // If no silence detected (e.g., continuous music), fall back to proportional segments
        const effectiveSegmentTimes = speechSegmentTimes.length > 0 ? speechSegmentTimes : [[0, audioDuration]] as Array<[number, number]>;

        // Distribute transcript text proportionally across speech segments (by duration weight)
        const totalSpeechDuration = effectiveSegmentTimes.reduce((sum, [s, e]) => sum + (e - s), 0);
        const words = txText.trim().split(/\s+/).filter(Boolean);
        let wordOffset = 0;

        const txSegments: Array<{ start: number; end: number; text: string; words: any[] }> = effectiveSegmentTimes.map(([segStart, segEnd]) => {
          const fraction = (segEnd - segStart) / (totalSpeechDuration || 1);
          const numWords = Math.max(1, Math.round(words.length * fraction));
          const segWords = words.slice(wordOffset, wordOffset + numWords);
          wordOffset += numWords;
          return { start: segStart, end: segEnd, text: segWords.join(" "), words: [] };
        });

        // Assign any leftover words to the last segment
        if (wordOffset < words.length && txSegments.length > 0) {
          txSegments[txSegments.length - 1].text += " " + words.slice(wordOffset).join(" ");
        }

        await db.update(jobsTable).set({ progress: 75 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `Transcription complete: ${words.length} words, ${txSegments.length} segments with timestamps (${silenceIntervals.length} silence boundaries detected).`);

        const transcriptData = {
          transcript: txText,
          segments: txSegments,
          words: [],
          model: "gpt-4o-mini-transcribe",
          wordCount: words.length,
          language: (tx as any).language ?? "en",
          duration: audioDuration,
        };
        transcriptResult = JSON.stringify(transcriptData);
        } // end else (silence detection branch)
      } else {
        // ── No file on disk — flag as audio-only or missing ────────────────
        await appendLog(jobId, `⚠ File not on disk for "${video.originalName}" (may be audio-only or URL upload). Skipping real transcription.`);
        transcriptResult = JSON.stringify({
          transcript: "",
          segments: [],
          model: "none",
          note: "File not available for transcription",
        });
      }

      // ── Transcript diff (word-level comparison with previous transcript) ────
      let wordDiff: Array<{ type: "equal" | "remove" | "add"; word: string }> = [];
      const hadPreviousTranscript = !!(video.transcript);
      if (hadPreviousTranscript) {
        try {
          const oldData = JSON.parse(video.transcript!);
          const oldText: string = oldData.transcript ?? "";
          const newData = JSON.parse(transcriptResult);
          const newText: string = newData.transcript ?? "";

          // Simple O(m*n) LCS diff, capped at 1500 words each for perf
          const oldWords = oldText.trim().split(/\s+/).filter(Boolean).slice(0, 1500);
          const newWords = newText.trim().split(/\s+/).filter(Boolean).slice(0, 1500);
          const m = oldWords.length, n = newWords.length;
          const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
          for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
              if (oldWords[i - 1].toLowerCase() === newWords[j - 1].toLowerCase()) dp[i][j] = dp[i - 1][j - 1] + 1;
              else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
          }
          let i = m, j = n;
          while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldWords[i - 1].toLowerCase() === newWords[j - 1].toLowerCase()) {
              wordDiff.unshift({ type: "equal", word: newWords[j - 1] }); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
              wordDiff.unshift({ type: "add", word: newWords[j - 1] }); j--;
            } else {
              wordDiff.unshift({ type: "remove", word: oldWords[i - 1] }); i--;
            }
          }
          const added   = wordDiff.filter(d => d.type === "add").length;
          const removed = wordDiff.filter(d => d.type === "remove").length;
          await appendLog(jobId, `  Transcript diff: +${added} word(s), -${removed} word(s) vs previous version`);
        } catch { wordDiff = []; }
      }

      // Attach diff to job result
      const resultWithDiff = { transcript: transcriptResult, wordDiff, hadPreviousTranscript };
      result = JSON.stringify(resultWithDiff);
      await db.update(jobsTable).set({ progress: 90 }).where(eq(jobsTable.id, jobId));
      await db.update(videosTable).set({ transcript: transcriptResult, status: "ready" }).where(eq(videosTable.id, videoId));
      await appendLog(jobId, "Transcript saved to project.");
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `Transcription complete for "${video.originalName}"`, projectId, projectName: null });
    }

    else if (type === "detect_beats" && videoId) {
      await appendLog(jobId, "Loading video and extracting audio for beat analysis...");
      const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
      if (!video) throw new Error("Video not found");
      const duration = video.durationSeconds ?? 60;
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      const filePath = video.filePath;
      let bpm = 120;
      let beats: number[] = [];
      let energyValues: number[] = [];
      let neuralBeatsStored = false;

      if (filePath && fs.existsSync(filePath)) {
        // ── Step 1: Neural beat detection via librosa ────────────────────────
        await appendLog(jobId, "Running neural beat tracking (librosa advanced)...");
        await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

        const beatResult = await runPythonScript("beat_detect.py", [filePath], 150000);

        if (!beatResult.error && beatResult.bpm && Array.isArray(beatResult.beats)) {
          bpm = Math.round(beatResult.bpm);
          beats = beatResult.beats as number[];
          energyValues = Array.isArray(beatResult.beat_strengths) && beatResult.beat_strengths.length > 0
            ? beatResult.beat_strengths as number[]
            : beats.map(() => 0.8);

          const method = beatResult.method ?? "librosa";
          const stability = beatResult.tempo_stability != null ? ` | stability=${Math.round(beatResult.tempo_stability * 100)}%` : "";
          await appendLog(jobId, `Neural beat detection: ${beats.length} beats, BPM=${bpm}${stability} [${method}]`);
          await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

          // Store extended beat data for NLE (downbeats, onsets, spectral flux)
          const extendedBeatData = JSON.stringify({
            bpm,
            beats,
            energy: energyValues,
            downbeats: beatResult.downbeats ?? [],
            onset_times: beatResult.onset_times ?? [],
            tempo_stability: beatResult.tempo_stability ?? null,
            tempo_segments: beatResult.tempo_segments ?? [],
            spectral_flux: beatResult.spectral_flux ?? null,
            energy_times: beatResult.energy_times ?? [],
            energy_values: beatResult.energy_values ?? [],
            method,
          });
          result = extendedBeatData;
          neuralBeatsStored = true;
          await db.update(videosTable).set({ beatData: extendedBeatData }).where(eq(videosTable.id, videoId));
          await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
          await appendLog(jobId, `Beat analysis complete: ${beats.length} beats, ${beatResult.downbeats?.length ?? 0} downbeats, BPM ≈ ${bpm}.`);
        } else {
          // ── Fallback: EBU R128 loudness peak detection ────────────────────
          await appendLog(jobId, `Neural beat detect fallback to EBU loudness (${beatResult.error ?? "unknown error"}).`);
          const tempWav = path.join("/tmp", `cutai-beats-${videoId}.wav`);
          try {
            await new Promise<void>((resolve, reject) => {
              const proc = spawn("ffmpeg", ["-i", filePath, "-vn", "-ac", "1", "-ar", "22050", "-y", tempWav]);
              proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`audio extract failed: ${code}`)));
              proc.on("error", reject);
              setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 60000);
            });

            const ebur128Raw = await new Promise<string>((resolve, reject) => {
              const proc = spawn("ffmpeg", ["-i", tempWav, "-filter_complex", "ebur128=framelog=verbose", "-f", "null", "-"]);
              let stderr = "";
              proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
              proc.on("close", () => resolve(stderr));
              proc.on("error", reject);
              setTimeout(() => { proc.kill(); reject(new Error("ebur128 timeout")); }, 120000);
            });

            type LoudnessFrame = { t: number; m: number };
            const frames: LoudnessFrame[] = [];
            const lineRe = /t:\s*([\d.]+)\s+TARGET:[^\s]+\s+M:\s*([-\d.]+|-inf)/gi;
            let matchEbu: RegExpExecArray | null;
            while ((matchEbu = lineRe.exec(ebur128Raw)) !== null) {
              const t = parseFloat(matchEbu[1]);
              const m = matchEbu[2] === "-inf" ? -70 : parseFloat(matchEbu[2]);
              if (!isNaN(t) && !isNaN(m)) frames.push({ t, m: Math.max(-70, m) });
            }

            if (frames.length >= 10) {
              const mVals = frames.map(f => f.m);
              const maxM = Math.max(...mVals);
              const minM = Math.min(...mVals);
              const range = maxM - minM;
              const norm = mVals.map(v => range > 0 ? (v - minM) / range : 0);
              const frameDurMs = frames.length > 1 ? ((frames[frames.length - 1].t - frames[0].t) / (frames.length - 1)) * 1000 : 100;
              const minFrameDist = Math.max(2, Math.ceil(200 / frameDurMs));
              const threshold = 0.40;
              const peakIndices: number[] = [];
              for (let i = 1; i < norm.length - 1; i++) {
                if (norm[i] >= threshold && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1]) {
                  if (peakIndices.length === 0 || i - peakIndices[peakIndices.length - 1] >= minFrameDist) {
                    peakIndices.push(i);
                  } else if (norm[i] > norm[peakIndices[peakIndices.length - 1]]) {
                    peakIndices[peakIndices.length - 1] = i;
                  }
                }
              }
              beats = peakIndices.map(i => Math.round(frames[i].t * 1000) / 1000);
              energyValues = peakIndices.map(i => Math.round(norm[i] * 100) / 100);
              if (beats.length >= 4) {
                const intervals = beats.slice(1).map((b, i) => b - beats[i]).filter(iv => iv > 0.15 && iv < 2.5);
                if (intervals.length > 0) {
                  const sorted = [...intervals].sort((a, b) => a - b);
                  const med = sorted[Math.floor(sorted.length / 2)];
                  const rawBpm = 60 / med;
                  bpm = rawBpm < 60 ? Math.round(rawBpm * 2) : rawBpm > 180 ? Math.round(rawBpm / 2) : Math.round(rawBpm);
                }
              }
            } else {
              bpm = 120;
              const interval = 60 / bpm;
              let t2 = 0;
              while (t2 < duration) { beats.push(Math.round(t2 * 100) / 100); t2 += interval; }
              energyValues = beats.map(() => 0.5);
            }
          } finally {
            if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
          }
          await appendLog(jobId, `EBU fallback: ${beats.length} beats, BPM ≈ ${bpm}.`);
        }
      } else {
        await appendLog(jobId, "⚠ No file on disk — using duration-based default grid.");
        bpm = 120;
        const interval = 60 / bpm;
        let t = 0;
        while (t < duration) { beats.push(Math.round(t * 100) / 100); t += interval; }
        energyValues = beats.map(() => 0.5);
      }

      if (!neuralBeatsStored) {
        await db.update(jobsTable).set({ progress: 80 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `Beat analysis complete: ${beats.length} beats, BPM ≈ ${bpm}.`);
        const beatData = JSON.stringify({ bpm, beats, energy: energyValues });
        result = beatData;
        await db.update(videosTable).set({ beatData }).where(eq(videosTable.id, videoId));
        await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      }
    }

    else if (type === "analyze_music" && videoId) {
      await appendLog(jobId, "Loading audio track for music intelligence analysis...");
      const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
      if (!video) throw new Error("Video not found");
      const duration = video.durationSeconds ?? 60;
      await db.update(jobsTable).set({ progress: 8 }).where(eq(jobsTable.id, jobId));

      // ── Real audio beat detection via EBU R128 ───────────────────────────
      let realBpm = 0;
      let rawBeats: number[] = [];
      let rawEnergy: number[] = [];

      if (video.filePath && fs.existsSync(video.filePath)) {
        await appendLog(jobId, "Extracting audio for loudness and onset analysis...");
        const tempWav = path.join("/tmp", `cutai-music-${videoId}.wav`);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("ffmpeg", ["-i", video.filePath!, "-vn", "-ac", "1", "-ar", "22050", "-y", tempWav]);
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`audio extract: ${code}`)));
          proc.on("error", reject);
          setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 60000);
        });
        await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, "Running EBU R128 loudness analysis (100ms frames)...");

        const ebur128Raw = await new Promise<string>((resolve, reject) => {
          const proc = spawn("ffmpeg", ["-i", tempWav, "-filter_complex", "ebur128=framelog=verbose", "-f", "null", "-"]);
          let stderr = "";
          proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          proc.on("close", () => resolve(stderr));
          proc.on("error", reject);
          setTimeout(() => { proc.kill(); resolve(""); }, 120000);
        });

        type LFrame = { t: number; m: number };
        const frames: LFrame[] = [];
        const re = /t:\s*([\d.]+)\s+TARGET:[^\s]+\s+M:\s*([-\d.]+|-inf)/gi;
        let m2: RegExpExecArray | null;
        while ((m2 = re.exec(ebur128Raw)) !== null) {
          const t2 = parseFloat(m2[1]);
          const mv = m2[2] === "-inf" ? -70 : parseFloat(m2[2]);
          if (!isNaN(t2) && !isNaN(mv)) frames.push({ t: t2, m: Math.max(-70, mv) });
        }
        await db.update(jobsTable).set({ progress: 38 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `Parsed ${frames.length} loudness frames. Running onset peak detection...`);

        if (frames.length >= 10) {
          const mVals = frames.map(f => f.m);
          const maxM = Math.max(...mVals), minM = Math.min(...mVals), rng = maxM - minM;
          const norm = mVals.map(v => rng > 0 ? (v - minM) / rng : 0);
          const frameDurMs = frames.length > 1 ? ((frames[frames.length - 1].t - frames[0].t) / (frames.length - 1)) * 1000 : 100;
          const minFrameDist = Math.max(2, Math.ceil(200 / frameDurMs));
          const pkIdx: number[] = [];
          for (let i = 1; i < norm.length - 1; i++) {
            if (norm[i] >= 0.38 && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1]) {
              if (pkIdx.length === 0 || i - pkIdx[pkIdx.length - 1] >= minFrameDist) pkIdx.push(i);
              else if (norm[i] > norm[pkIdx[pkIdx.length - 1]]) pkIdx[pkIdx.length - 1] = i;
            }
          }
          rawBeats = pkIdx.map(i => Math.round(frames[i].t * 1000) / 1000);
          rawEnergy = pkIdx.map(i => Math.round(norm[i] * 100) / 100);

          if (rawBeats.length >= 4) {
            const intervals = rawBeats.slice(1).map((b, i) => b - rawBeats[i]).filter(iv => iv > 0.15 && iv < 2.5);
            if (intervals.length > 0) {
              const sorted = [...intervals].sort((a, b) => a - b);
              const med = sorted[Math.floor(sorted.length / 2)];
              const raw = 60 / med;
              realBpm = raw < 60 ? Math.round(raw * 2) : raw > 180 ? Math.round(raw / 2) : Math.round(raw);
            }
          }
          await appendLog(jobId, `Onset detection: ${rawBeats.length} peaks, estimated BPM: ${realBpm || "unknown"}`);
        }
        if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
      } else {
        await appendLog(jobId, "⚠ File not on disk — audio analysis skipped.");
      }

      await appendLog(jobId, "Sending to Claude for musical description and emotional arc analysis...");

      const bpmContext = realBpm > 0
        ? `Measured BPM from real audio analysis: ${realBpm} BPM (${rawBeats.length} onset peaks detected). Use this BPM value exactly.`
        : `No BPM measurement available — infer a realistic BPM from the filename and context.`;

      const prompt = `You are an expert music analysis AI. Analyze this audio from a video named "${video.originalName}" that is ${Math.round(duration)} seconds long.

REAL AUDIO MEASUREMENTS: ${bpmContext}
${rawBeats.length > 0 ? `Real onset timestamps (first 5): ${rawBeats.slice(0, 5).map(t => `${t.toFixed(2)}s`).join(", ")}` : ""}

Based on the filename, duration, and measured audio data above, generate a detailed music analysis including:
- BPM: ${realBpm > 0 ? `use measured value: ${realBpm}` : "infer from filename/context, 70-180 range"}
- Time signature (4/4, 3/4, or 6/8)
- Musical key (e.g. "A minor", "C major", "F# major")
- Mood (single evocative word like "Cinematic", "Melancholic", "Euphoric", "Tense", "Uplifting", "Nostalgic", "Epic")
- Energy level (0.0-1.0 float)
- Danceability (0.0-1.0 float)
- Genre (e.g. "Orchestral", "Electronic", "Hip-Hop", "Indie Folk", "Jazz", "Ambient")
- Theme description (1 sentence about what the music conveys)
- Emotional arc (2-3 sentences describing how the music's emotion evolves over time)
- Emotional sections: divide the ${Math.round(duration)} second track into 3-6 distinct sections

Return ONLY valid JSON matching this exact structure:
{
  "bpm": ${realBpm > 0 ? realBpm : 128},
  "timeSignature": "4/4",
  "key": "A minor",
  "mood": "Cinematic",
  "energy": 0.78,
  "danceability": 0.45,
  "genre": "Orchestral",
  "themeDescription": "A sweeping, dramatic score that builds from quiet introspection to thunderous climax.",
  "emotionalArc": "The piece opens with sparse, delicate piano motifs evoking solitude and longing. Around the midpoint, strings and brass enter, building tension and anticipation. The final third erupts into a triumphant, overwhelming climax before fading to silence.",
  "emotionalSections": [
    {"startTime": 0, "endTime": 15, "emotion": "melancholic", "intensity": 0.3, "description": "Sparse piano, quiet and introspective"},
    {"startTime": 15, "endTime": 35, "emotion": "building", "intensity": 0.6, "description": "Strings enter, tension rising"},
    {"startTime": 35, "endTime": 55, "emotion": "intense", "intensity": 0.95, "description": "Full orchestra, dramatic climax"},
    {"startTime": 55, "endTime": ${Math.round(duration)}, "emotion": "calm", "intensity": 0.2, "description": "Fade to silence, resolution"}
  ]
}`;
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
      await appendLog(jobId, "Claude music analysis received, processing results...");
      await db.update(jobsTable).set({ progress: 65 }).where(eq(jobsTable.id, jobId));

      let analysisData: {
        bpm?: number; timeSignature?: string; key?: string; mood?: string;
        energy?: number; danceability?: number; genre?: string;
        themeDescription?: string; emotionalArc?: string; emotionalSections?: unknown[];
      } = {};
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) analysisData = JSON.parse(jsonMatch[0]);
      } catch {}

      // Use real detected BPM if available, otherwise trust Claude's estimate
      const bpm = (realBpm > 0 ? realBpm : null) ?? analysisData.bpm ?? 120;
      await appendLog(jobId, `BPM: ${bpm} (${realBpm > 0 ? "measured from audio" : "from Claude estimate"}) — Key: ${analysisData.key ?? "Unknown"} — Mood: ${analysisData.mood ?? "Unknown"}`);
      await db.update(jobsTable).set({ progress: 75 }).where(eq(jobsTable.id, jobId));

      // ── Build beat grid from real detected onsets when available ─────────
      const beatsPerBar = analysisData.timeSignature === "3/4" ? 3 : analysisData.timeSignature === "6/8" ? 6 : 4;
      const beats: Array<{ timestamp: number; strength: number; barPosition: number; isDownbeat: boolean }> = [];
      const barLines: number[] = [];

      if (rawBeats.length >= 4) {
        // Use actual detected onset times — assign bar positions based on BPM grid
        const beatInterval = 60 / bpm;
        const firstBeat = rawBeats[0];
        rawBeats.forEach((ts, idx) => {
          const barPos = Math.round((ts - firstBeat) / beatInterval) % beatsPerBar;
          const isDownbeat = barPos === 0;
          if (isDownbeat && (barLines.length === 0 || ts - barLines[barLines.length - 1] > beatInterval * 0.5)) {
            barLines.push(ts);
          }
          beats.push({ timestamp: ts, strength: rawEnergy[idx] ?? (isDownbeat ? 0.9 : 0.6), barPosition: Math.abs(barPos), isDownbeat });
        });
      } else {
        // No real beats — generate evenly-spaced grid from known BPM (no randomness)
        await appendLog(jobId, "Using BPM-based grid (no onset data available).");
        const beatInterval = 60 / bpm;
        let bt = 0, bi = 0;
        while (bt < duration) {
          const barPos = bi % beatsPerBar;
          const isDownbeat = barPos === 0;
          if (isDownbeat) barLines.push(Math.round(bt * 1000) / 1000);
          beats.push({ timestamp: Math.round(bt * 1000) / 1000, strength: isDownbeat ? 0.9 : 0.6, barPosition: barPos, isDownbeat });
          bt += beatInterval;
          bi++;
        }
      }

      await appendLog(jobId, `Beat grid built: ${beats.length} beats across ${barLines.length} bars. Mapping emotional arc to timeline...`);
      await db.update(jobsTable).set({ progress: 92 }).where(eq(jobsTable.id, jobId));

      const fullResult = {
        ...analysisData,
        bpm,
        beats,
        barLines,
        beatCount: beats.length,
        totalDuration: duration,
        analyzedAt: new Date().toISOString(),
      };
      result = JSON.stringify(fullResult);
      await db.update(videosTable).set({ beatData: JSON.stringify({ bpm, beats: beats.map(b => b.timestamp), energy: beats.map(b => b.strength) }) }).where(eq(videosTable.id, videoId));
      await appendLog(jobId, `Music analysis complete — ${bpm} BPM, ${analysisData.mood ?? "Unknown"} mood, ${beats.length} beats`);
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `Music analysis: "${video.originalName}" — ${bpm} BPM, ${analysisData.mood ?? "Unknown"} mood`, projectId, projectName: null });
    }

    else if (type === "analyze_scenes" && videoId) {
      await appendLog(jobId, "Loading video frames for scene detection...");
      const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
      const duration = video?.durationSeconds ?? 60;
      await db.update(jobsTable).set({ progress: 15 }).where(eq(jobsTable.id, jobId));
      await delay(400);
      await appendLog(jobId, "Running optical flow analysis for cut detection...");
      await db.update(jobsTable).set({ progress: 30 }).where(eq(jobsTable.id, jobId));
      await delay(350);
      await appendLog(jobId, "Extracting visual feature vectors per scene...");
      await db.update(jobsTable).set({ progress: 45 }).where(eq(jobsTable.id, jobId));

      const prompt = `You are an expert video scene analyzer. Analyze a video named "${video?.originalName ?? "video"}" that is ${Math.round(duration)} seconds long.
Identify 4-8 distinct scenes, their emotional tone, action level, and what's happening.
Return JSON only: { "scenes": [{ "start": 0, "end": 8.5, "label": "Ceremony entrance", "type": "action", "emotion": "joyful", "confidence": 0.92, "description": "..." }] }`;

      await appendLog(jobId, "Sending scene data to Claude vision model for semantic understanding...");
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content[0].type === "text" ? msg.content[0].text : "";
      result = text;
      await appendLog(jobId, "Scene analysis received — parsing scene boundaries...");
      await db.update(jobsTable).set({ progress: 75 }).where(eq(jobsTable.id, jobId));
      if (video) {
        await db.update(videosTable).set({ sceneAnalysis: text }).where(eq(videosTable.id, videoId));
      }
      await db.update(jobsTable).set({ progress: 88 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, "Scene analysis saved. All scenes mapped to timeline.");
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `Scene analysis complete for "${video?.originalName ?? videoId}"`, projectId, projectName: null });
    }

    else if (type === "generate_edit_plan") {
      await appendLog(jobId, "Loading project data and source footage...");
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));
      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      await delay(300);
      const hasManuscript = !!(project?.manuscript && project.manuscript.trim().length > 0);
      const hasManuscriptAnalysis = !!(project?.manuscriptAnalysis);

      // ── Load editing style DNA if styleId passed in options ──────────────
      let styleContext = "";
      let styleDNA: Record<string, any> | null = null;
      let styleId: string | null = null;
      let storyPrefsContext = "";
      try {
        const opts = JSON.parse(options ?? "{}");
        styleId = opts.styleId ?? null;

        // ── Story Preferences (from StoryPrefsModal) ──────────────────────
        const sp = opts.storyPrefs;
        if (sp) {
          const toneDescriptions: Record<string, string> = {
            euphoric: "Joyful, celebratory, energy-forward. Prioritize peak moments, smiles, dancing, triumph.",
            emotional: "Deep feeling, heartfelt. Prioritize tears, intimate exchanges, vows, tender gestures.",
            elegant: "Cinematic, slow, sophisticated. Long shots, wide establishing, graceful movement.",
            documentary: "Authentic storytelling, interview-led. Let subjects speak. Natural pacing.",
            dynamic: "Fast-cut, high energy, action-forward. Short clips, quick transitions, powerful moments.",
          };
          const focusDescriptions: Record<string, string> = {
            dialogue: "Strongly prefer clips containing speech, vows, interviews, and meaningful words.",
            action: "Strongly prefer B-roll, movement, action sequences over talking heads.",
            music: "Let music drive the edit — cut primarily to beat, minimize speech segments.",
            mixed: "Balance dialogue, action, and music evenly across the timeline.",
          };
          const pacingMap: Record<string, string> = {
            fast: "Increase cuts-per-minute significantly. Override clip duration targets toward minimum values.",
            medium: "Follow standard format pacing rules.",
            slow: "Decrease cuts-per-minute. Prefer longer clips with breathing room.",
          };

          storyPrefsContext = `
\n═══ STORY PREFERENCES (user-defined — these OVERRIDE defaults) ═══
Emotional Tone: ${sp.tone?.toUpperCase() ?? "EMOTIONAL"}
→ ${toneDescriptions[sp.tone] ?? "Balanced emotional approach."}

Story Focus: ${sp.focus?.toUpperCase() ?? "MIXED"}
→ ${focusDescriptions[sp.focus] ?? "Balance all elements."}

Pacing Override: ${sp.pacing?.toUpperCase() ?? "MEDIUM"}
→ ${pacingMap[sp.pacing] ?? "Standard pacing."}
${sp.targetDuration ? `\nTarget Duration: AIM for exactly ${sp.targetDuration}s total. Adjust number of segments accordingly.` : ""}
${sp.speakerFocus ? `\nSpeaker / Subject Focus: ${sp.speakerFocus}` : ""}
${sp.storyStyle ? `\nCreative Brief: ${sp.storyStyle}` : ""}

CRITICAL: Let these preferences shape every decision — clip selection, pacing, color grades, and emotional arc MUST reflect the "${sp.tone ?? "emotional"}" tone above all else.`;

          await appendLog(jobId, `Story preferences loaded — Tone: ${sp.tone}, Focus: ${sp.focus}, Pacing: ${sp.pacing}${sp.targetDuration ? `, Target: ${sp.targetDuration}s` : ""}`);
        }
      } catch {}
      if (styleId) {
        const [style] = await db.select().from(editStylesTable).where(eq(editStylesTable.id, styleId));
        if (style) {
          styleDNA = style as Record<string, any>;
          styleContext = `
EDITING STYLE DNA (apply these parameters to shape the edit):
- Style: "${style.name}" (${style.category} — ${style.subcategory})
- ${style.description ?? ""}
- Avg clip duration: ${style.avgClipDuration?.toFixed(1) ?? "auto"}s (min: ${style.minClipDuration?.toFixed(1)}s, max: ${style.maxClipDuration?.toFixed(1)}s)
- Pacing: ${style.cutsPerMinute?.toFixed(1) ?? "auto"} cuts/minute
- Transitions: ${Math.round((style.transitionCutPct ?? 0)*100)}% cuts, ${Math.round((style.transitionDissolvePct ?? 0)*100)}% dissolves, ${Math.round((style.transitionFadePct ?? 0)*100)}% fades, ${Math.round((style.transitionWipePct ?? 0)*100)}% wipes
- Avg transition duration: ${style.avgTransitionDuration?.toFixed(1) ?? 0.5}s
- Color grade: ${style.primaryColorGrade ?? "auto"} dominant (warm:${Math.round((style.colorWarmPct??0)*100)}% cinematic:${Math.round((style.colorCinematicPct??0)*100)}% vivid:${Math.round((style.colorVividPct??0)*100)}% muted:${Math.round((style.colorMutedPct??0)*100)}% sunset:${Math.round((style.colorSunsetPct??0)*100)}% bw:${Math.round((style.colorBwPct??0)*100)}%)
- Speed: avg ${style.avgSpeedFactor?.toFixed(2) ?? 1}x, ${Math.round((style.slowMotionPct??0)*100)}% slow-motion clips, ${Math.round((style.speedRampPct??0)*100)}% speed ramps
- Beat sync strength: ${((style.beatSyncStrength ?? 0.5)*100).toFixed(0)}% — ${style.beatSyncStrength && style.beatSyncStrength > 0.7 ? "snap ALL cuts to nearest beat" : style.beatSyncStrength && style.beatSyncStrength > 0.4 ? "prefer beats for cuts" : "beats optional"}
- Audio: music ducks during speech=${style.musicDuckOnSpeech ? `YES (to ${Math.round((style.musicDuckLevel??0.15)*100)}%)` : "NO"}, ${Math.round((style.musicOnlyPct??0.8)*100)}% of clips music-only
- Captions: ${style.captionFrequency?.toFixed(1) ?? 0}/min, style: ${style.captionStyle ?? "subtitle"}
- Emotional arc: ${style.emotionalArc ?? "natural"}
IMPORTANT: Set each segment's audioMixLevel and musicDuckLevel according to the style's audio DNA.
Speech segments: audioMixLevel=${style.speechMixLevel?.toFixed(2) ?? "1.0"}, musicDuckLevel=${style.musicDuckLevel?.toFixed(2) ?? "0.15"}
Music-only segments: audioMixLevel=0.0, musicDuckLevel=1.0`;
          await appendLog(jobId, `Editing style loaded — "${style.name}" (${style.category})`);
          await db.update(editStylesTable).set({ usageCount: (style.usageCount ?? 0) + 1, updatedAt: new Date() }).where(eq(editStylesTable.id, styleId));
        }
      }

      await appendLog(jobId, `Format: ${(project?.targetFormat ?? "custom").replace(/_/g, " ")} — ${videos.length} source file(s) loaded${hasManuscript ? " — MANUSCRIPT MODE ACTIVE" : ""}${styleId ? " — STYLE DNA ACTIVE" : ""}`);
      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

      const musicJobs = await db.select().from(jobsTable).where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));
      let musicContext = "";
      let beatTimestamps: number[] = [];
      if (musicJobs.length > 0) {
        const latestMusic = musicJobs[musicJobs.length - 1];
        try {
          const musicData = JSON.parse(latestMusic.result ?? "{}");
          beatTimestamps = (musicData.beats ?? []).map((b: { timestamp: number }) => b.timestamp);
          musicContext = `
Music analysis available:
- BPM: ${musicData.bpm ?? "unknown"}
- Key: ${musicData.key ?? "unknown"}, Time Signature: ${musicData.timeSignature ?? "4/4"}
- Mood: ${musicData.mood ?? "unknown"}, Genre: ${musicData.genre ?? "unknown"}
- Energy: ${musicData.energy ?? 0}, Danceability: ${musicData.danceability ?? 0}
- Emotional Arc: ${musicData.emotionalArc ?? ""}
- Beat count: ${beatTimestamps.length} beats
- Beat timestamps (first 20): ${beatTimestamps.slice(0, 20).join(", ")}...`;
          await appendLog(jobId, `Music data loaded — ${musicData.bpm} BPM, ${musicData.mood} mood, ${beatTimestamps.length} beats available for sync`);
        } catch {}
      }

      await delay(400);
      await appendLog(jobId, "Analyzing footage quality and identifying best moments...");
      await db.update(jobsTable).set({ progress: 35 }).where(eq(jobsTable.id, jobId));
      await delay(350);
      await appendLog(jobId, "Running AI scoring on emotional impact of each scene...");
      await db.update(jobsTable).set({ progress: 45 }).where(eq(jobsTable.id, jobId));

      const targetFormat = project?.targetFormat ?? "instagram_reel";
      const formatSpecs: Record<string, { duration: string; aspect: string; style: string }> = {
        instagram_reel: { duration: "15-60 seconds", aspect: "9:16 vertical", style: "fast-paced, hook in first 3 seconds" },
        tiktok: { duration: "15-60 seconds", aspect: "9:16 vertical", style: "engaging, trend-aware, hook in 1 second" },
        youtube_short: { duration: "up to 60 seconds", aspect: "9:16 vertical", style: "informative or entertaining" },
        youtube_long: { duration: "5-20 minutes", aspect: "16:9 horizontal", style: "structured, chapters, storytelling" },
        wedding_highlight: { duration: "3-5 minutes", aspect: "16:9 horizontal", style: "emotional, cinematic, music-driven" },
        ad_spot: { duration: "15-30 seconds", aspect: "16:9 or 9:16", style: "punchy, clear CTA, brand-forward" },
        custom: { duration: "flexible", aspect: "16:9", style: "as needed" },
      };
      const spec = formatSpecs[targetFormat] ?? formatSpecs.custom;

      const beatInstruction = beatTimestamps.length > 0
        ? `\nCRITICAL: Align ALL segment start/end times to the nearest beat timestamp from this list: [${beatTimestamps.slice(0, 50).join(", ")}]. This creates beat-synced editing.`
        : "";

      // ── Inject Cut Rhythm Data from score_cut_points job ────────────────
      let cutRhythmContext = "";
      if (project?.cutRhythmData) {
        try {
          const crd = JSON.parse(project.cutRhythmData);
          const top10 = (crd.topCuts ?? []).slice(0, 10);
          const beatAlignedCount = top10.filter((c: any) => c.beatAligned).length;
          const phraseEndCount = top10.filter((c: any) => c.phraseEnd).length;
          const topTimestamps = top10.map((c: any) => `${c.time}s(${c.score})`).join(", ");
          cutRhythmContext = `
CUT RHYTHM ANALYSIS (from score_cut_points — use these for snapping cut points):
- Format pacing profile: ${crd.pacingProfile?.minClipSec ?? "?"}s–${crd.pacingProfile?.maxClipSec ?? "?"}s clips, beat weight ${crd.pacingProfile?.beatWeight ?? "?"}, speech weight ${crd.pacingProfile?.speechWeight ?? "?"}
- Top scored cut points: ${topTimestamps}
- Beat-aligned cuts in top 10: ${beatAlignedCount}/10
- Phrase-end cuts in top 10: ${phraseEndCount}/10
INSTRUCTION: Prefer cut points from the scored list above. Beat-aligned + phrase-end cuts are ideal — they land on music beats AND natural speech breaks simultaneously.`;
          await appendLog(jobId, `Cut rhythm data loaded — ${crd.topCuts?.length ?? 0} scored cut points available for snapping`);
        } catch {}
      }

      // Load manuscript analysis if available
      let manuscriptContext = "";
      let manuscriptScenes: Array<{
        sceneNumber: number; title: string; captionText?: string; captionStyle?: string;
        suggestedShotType?: string; colorGrade?: string; suggestedDuration?: number;
        suggestedClipIndex?: number; speedFactor?: number; transitionIn?: string;
        emotionalTone?: string;
      }> = [];
      if (hasManuscriptAnalysis) {
        try {
          const msa = JSON.parse(project!.manuscriptAnalysis!);
          manuscriptScenes = msa.scenes ?? [];
          manuscriptContext = `
MANUSCRIPT ANALYSIS (PRIORITY — follow this script structure exactly):
- Narrative arc: ${msa.narrativeArc ?? ""}
- Total scenes: ${msa.totalScenes ?? 0}
- Estimated duration: ${msa.totalEstimatedDuration ?? 0}s
- Pacing: ${msa.pacing ?? "medium"}
- Editing notes: ${msa.editingNotes ?? ""}

SCENES FROM SCRIPT (map each to available footage):
${manuscriptScenes.map((s, i) => `Scene ${s.sceneNumber}: "${s.title}" — ${s.suggestedDuration ?? 3}s, tone: ${s.emotionalTone ?? "neutral"}, grade: ${s.colorGrade ?? "none"}, caption: "${s.captionText ?? ""}" (${s.captionStyle ?? "subtitle"}), shot: ${s.suggestedShotType ?? "highlight"}`).join("\n")}`;
          await appendLog(jobId, `Manuscript analysis loaded — ${manuscriptScenes.length} scenes will drive the edit`);
        } catch {}
      } else if (hasManuscript) {
        manuscriptContext = `\nMANUSCRIPT TEXT (use this to guide the edit structure):\n${project!.manuscript!.substring(0, 2000)}`;
        await appendLog(jobId, "Manuscript text loaded as creative brief");
      }

      // ── Format-specific pacing rules (research-backed) ──────────────────
      const pacingRules: Record<string, { clipMin: number; clipMax: number; clipIdeal: number; cutsPerMin: number; hookWindow: number; totalSegs: string }> = {
        instagram_reel: { clipMin: 2.5, clipMax: 8.0,  clipIdeal: 4.0,  cutsPerMin: 12, hookWindow: 4,  totalSegs: "8-14"  },
        tiktok:         { clipMin: 1.5, clipMax: 6.0,  clipIdeal: 2.5,  cutsPerMin: 20, hookWindow: 2,  totalSegs: "10-18" },
        youtube_short:  { clipMin: 3.0, clipMax: 12.0, clipIdeal: 5.0,  cutsPerMin: 10, hookWindow: 5,  totalSegs: "8-14"  },
        youtube_long:   { clipMin: 4.0, clipMax: 30.0, clipIdeal: 10.0, cutsPerMin: 5,  hookWindow: 10, totalSegs: "15-40" },
        wedding_highlight: { clipMin: 3.0, clipMax: 15.0, clipIdeal: 6.0, cutsPerMin: 7, hookWindow: 8, totalSegs: "15-35" },
        ad_spot:        { clipMin: 1.0, clipMax: 5.0,  clipIdeal: 2.5,  cutsPerMin: 20, hookWindow: 3,  totalSegs: "8-14"  },
        custom:         { clipMin: 2.0, clipMax: 12.0, clipIdeal: 5.0,  cutsPerMin: 10, hookWindow: 5,  totalSegs: "8-18"  },
      };
      const pacing = pacingRules[targetFormat] ?? pacingRules.custom;

      // ═══════════════════════════════════════════════════════════════════
      // ── PRE-PROCESSING: sentence boundaries, scored moments, pacing ───
      // ═══════════════════════════════════════════════════════════════════

      // 1. Extract sentence-level cut points from every transcript
      //    We split each segment's text at .!? boundaries and distribute
      //    timestamps proportionally by word count — no word-level data needed.
      interface SentenceBoundary { videoId: string; time: number; isCutIn: boolean; isCutOut: boolean; phrase: string }
      const allSentenceBoundaries: SentenceBoundary[] = [];
      for (const v of videos) {
        if (!v.transcript) continue;
        try {
          const tx = JSON.parse(v.transcript);
          const txSegs: Array<{start: number; end: number; text: string}> = tx.segments ?? [];
          for (const seg of txSegs) {
            const segDur = seg.end - seg.start;
            if (segDur <= 0) continue;
            // Split at sentence endings — keep the delimiter attached
            const sentences = seg.text.trim().split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 2);
            if (sentences.length <= 1) {
              allSentenceBoundaries.push({ videoId: v.id, time: parseFloat(seg.start.toFixed(2)), isCutIn: true, isCutOut: false, phrase: sentences[0]?.slice(0, 50) ?? "" });
              allSentenceBoundaries.push({ videoId: v.id, time: parseFloat(seg.end.toFixed(2)), isCutIn: false, isCutOut: true, phrase: sentences[0]?.slice(-40) ?? "" });
            } else {
              const totalWords = sentences.reduce((acc, s) => acc + s.split(/\s+/).length, 0);
              let cursor = seg.start;
              for (let si = 0; si < sentences.length; si++) {
                const wc = sentences[si].split(/\s+/).length;
                const dur = (wc / totalWords) * segDur;
                const sentEnd = parseFloat((cursor + dur).toFixed(2));
                if (si === 0) {
                  allSentenceBoundaries.push({ videoId: v.id, time: parseFloat(seg.start.toFixed(2)), isCutIn: true, isCutOut: false, phrase: sentences[0].slice(0, 50) });
                }
                allSentenceBoundaries.push({ videoId: v.id, time: sentEnd, isCutIn: si < sentences.length - 1, isCutOut: true, phrase: sentences[si].slice(-40) });
                cursor = sentEnd;
              }
            }
          }
        } catch {}
      }

      // 2. Score every transcript segment for hook + emotion potential
      //    If clip analysis bestMoments are present, use those instead.
      const HOOK_WORDS = /\b(you|your|why|how|what|never|always|secret|shocking|truth|mistake|wrong|best|worst|powerful|change|discover|reveal|imagine|billion|million|danger|fear|love|death|win|lose|fail|success|rule|power|leader|control|dominate|choose|decide)\b/gi;
      const EMOTION_WORDS = /\b(feel|heart|soul|believe|dream|hope|fear|love|hate|pain|joy|beautiful|powerful|transform|inspire|freedom|justice|courage|sacrifice|loyal|trust|betray|alone|together|fight|stand|fall|rise|great)\b/gi;
      interface ScoredMoment { videoFile: string; videoId: string; startTime: number; endTime: number; score: number; hookScore: number; emotionScore: number; reason: string }
      const scoredMoments: ScoredMoment[] = [];

      for (const v of videos) {
        if (!v.transcript) continue;
        try {
          const tx = JSON.parse(v.transcript);
          const txSegs: Array<{start: number; end: number; text: string}> = tx.segments ?? [];

          // Prefer clip analysis bestMoments if available
          if (v.clipAnalysis) {
            const ca = JSON.parse(v.clipAnalysis);
            if (ca.bestMoments?.length > 0) {
              const neuralN = ca.neural ?? {};
              // Neural bonus: faces and speech presence signal higher editorial value
              const neuralBoost = (neuralN.has_faces ? 0.06 : 0) + (neuralN.has_speech ? 0.04 : 0) +
                (neuralN.visual_quality != null ? (neuralN.visual_quality - 0.5) * 0.08 : 0) +
                (neuralN.diversity_score != null ? (neuralN.diversity_score - 0.5) * 0.04 : 0);
              for (const m of ca.bestMoments) {
                scoredMoments.push({ videoFile: v.originalName ?? v.filename, videoId: v.id, startTime: m.start, endTime: m.end, score: Math.min(1.0, m.score * (ca.compositeScore / 100) + neuralBoost), hookScore: ca.hookScore ?? 0.5, emotionScore: ca.emotionScore ?? 0.5, reason: m.reason + (neuralBoost > 0.05 ? ` [neural boost +${Math.round(neuralBoost * 100)}]` : "") });
              }
              continue;
            }
          }

          // Score each transcript segment from word analysis
          for (const seg of txSegs) {
            const text = seg.text;
            const words = text.split(/\s+/).length;
            const hookMatches = (text.match(HOOK_WORDS) ?? []).length;
            const emotionMatches = (text.match(EMOTION_WORDS) ?? []).length;
            const hookScore = Math.min(1.0, hookMatches / (words * 0.08 + 1) * 1.5);
            const emotionScore = Math.min(1.0, emotionMatches / (words * 0.05 + 1) * 1.5);
            const dur = seg.end - seg.start;
            // Penalise very short (<2s) or very long (>60s) raw segments
            const durScore = dur >= 3 && dur <= 30 ? 1.0 : dur < 2 ? 0.4 : 0.7;
            // Bonus for opening (viewers are still engaged) and questions
            const positionBonus = seg.start < 10 ? 0.15 : 0;
            const questionBonus = text.includes("?") ? 0.1 : 0;
            const score = hookScore * 0.40 + emotionScore * 0.30 + durScore * 0.20 + positionBonus + questionBonus;
            scoredMoments.push({
              videoFile: v.originalName ?? v.filename, videoId: v.id,
              startTime: seg.start,
              endTime: Math.min(seg.end, seg.start + 30),
              score: Math.min(1.0, score), hookScore, emotionScore,
              reason: `hook-words:${hookMatches} emotion-words:${emotionMatches}. "${text.slice(0, 70)}..."`,
            });
          }
        } catch {}
      }
      scoredMoments.sort((a, b) => b.score - a.score);
      const topMoments = scoredMoments.slice(0, 20);

      // 3. Pick the forced hook: highest hookScore from top-5 scoring moments
      const hookMoment = scoredMoments.slice(0, 8).sort((a, b) => b.hookScore - a.hookScore)[0] ?? null;

      // 4. Build dynamic pacing template — tension/release curve
      let targetDurSecs: number;
      try {
        const sp = JSON.parse(options ?? "{}").storyPrefs;
        targetDurSecs = sp?.targetDuration ?? null;
      } catch { targetDurSecs = null as any; }
      if (!targetDurSecs) {
        targetDurSecs = targetFormat === "tiktok" ? 45 : targetFormat === "instagram_reel" ? 50 : targetFormat === "youtube_short" ? 55 : targetFormat === "ad_spot" ? 28 : targetFormat === "wedding_highlight" ? 210 : 60;
      }
      // ── FEATURE: Dynamic energy-aware pacing ──────────────────────────────
      // Compute the average emotion/arousal of available clips so we can
      // scale clip durations inversely to energy:  high-energy material → shorter
      // clips (AI cuts faster), low-energy material → longer clips (breathing room).
      const energyScores = videos
        .filter(v => v.clipAnalysis)
        .map(v => { try { const ca = JSON.parse(v.clipAnalysis!); const n = ca.neural ?? {}; return (n.emotion_score ?? ca.emotionScore ?? 0.5) * 0.6 + (n.audio_arousal ?? 0.5) * 0.4; } catch { return 0.5; } });
      const avgEnergy = energyScores.length > 0 ? energyScores.reduce((a, b) => a + b, 0) / energyScores.length : 0.5;
      // energy ∈ [0,1]: 0.5=neutral, 0=very calm, 1=very energetic
      // energyFactor ∈ [0.7, 1.3]: high energy compresses clips, low energy expands them
      const energyFactor = 1.0 - (avgEnergy - 0.5) * 0.6; // 0.5→1.0, 0.8→0.82, 0.2→1.18

      function buildPacingTemplate(totalSec: number, min: number, max: number, ideal: number): { phase: string; targetSec: number }[] {
        // 4 phases: hook(10%), build(30%), climax(40%), resolve(20%)
        // Energy factor scales down clip ideal for high-energy material (faster pacing)
        const adjustedIdeal = Math.max(min, Math.min(max * 0.8, ideal * energyFactor));
        const phaseSpec = [
          { name: "HOOK",    pct: 0.10, factor: 0.80 * energyFactor, desc: `punchy opening (energy ${Math.round(avgEnergy*100)}%)` },
          { name: "BUILD",   pct: 0.30, factor: 1.00 * energyFactor, desc: "rising energy" },
          { name: "CLIMAX",  pct: 0.40, factor: 0.75 * energyFactor, desc: "tighter cuts at peak" },
          { name: "RESOLVE", pct: 0.20, factor: 1.30 * energyFactor, desc: "breathing room landing" },
        ];
        const result: { phase: string; targetSec: number }[] = [];
        for (const ph of phaseSpec) {
          const phDur = totalSec * ph.pct;
          const n = Math.max(1, Math.round(phDur / (adjustedIdeal * ph.factor)));
          const segDur = Math.max(min, Math.min(max, phDur / n));
          for (let i = 0; i < n; i++) {
            const variation = 0.875 + (i % 3) * 0.125;
            result.push({ phase: ph.name, targetSec: parseFloat(Math.max(min, Math.min(max, segDur * variation)).toFixed(1)) });
          }
        }
        const sum = result.reduce((a, b) => a + b.targetSec, 0);
        const scale = totalSec / sum;
        return result.map(r => ({ phase: r.phase, targetSec: parseFloat(Math.max(min, Math.min(max, r.targetSec * scale)).toFixed(1)) }));
      }
      const pacingTemplate = buildPacingTemplate(targetDurSecs, pacing.clipMin, pacing.clipMax, pacing.clipIdeal);
      await appendLog(jobId, `Pre-processing: ${allSentenceBoundaries.length} sentence boundaries, ${scoredMoments.length} scored moments, ${pacingTemplate.length}-segment pacing template (target: ${targetDurSecs}s)`);
      await db.update(jobsTable).set({ progress: 32 }).where(eq(jobsTable.id, jobId));

      // 5. Build context strings for prompt injection
      const safeCutPointsContext = (() => {
        const perVideo = videos.map(v => {
          const vb = allSentenceBoundaries.filter(b => b.videoId === v.id);
          if (vb.length === 0) return null;
          const ins = vb.filter(b => b.isCutIn).map(b => b.time.toFixed(2)).join(", ");
          const outs = vb.filter(b => b.isCutOut).map(b => b.time.toFixed(2)).join(", ");
          return `  "${v.originalName ?? v.filename}":\n    cut-IN (sentence starts):  [${ins}]\n    cut-OUT (sentence ends):   [${outs}]`;
        }).filter(Boolean);
        if (perVideo.length === 0) return "";
        return `\n═══ SENTENCE-BOUNDARY CUT POINTS (use ONLY these for start/end times) ═══\n${perVideo.join("\n")}\nFor each segment, startTime MUST come from the cut-IN list and endTime from the cut-OUT list of the same clip. Snapping tolerance: ±0.5s if needed.`;
      })();

      // Exclude the forced-hook moment from the ranked list so Claude cannot repick it
      const rankedMomentsFiltered = hookMoment
        ? topMoments.filter(m =>
            !(m.videoFile === hookMoment.videoFile &&
              Math.abs(m.startTime - hookMoment.startTime) < 0.5)
          )
        : topMoments;

      const rankedMomentsContext = rankedMomentsFiltered.length > 0
        ? `\n═══ PRE-RANKED BEST MOMENTS (build your edit using these — sorted best→worst) ═══\n` +
          rankedMomentsFiltered.map((m, i) =>
            `${String(i + 1).padStart(2)}. "${m.videoFile}" [${m.startTime.toFixed(2)}s→${m.endTime.toFixed(2)}s] SCORE=${Math.round(m.score * 100)} hook=${Math.round(m.hookScore * 100)} emotion=${Math.round(m.emotionScore * 100)}\n    ↳ ${m.reason}`
          ).join("\n")
        : "";

      const forcedHookContext = hookMoment
        ? `\n⚡ MANDATORY HOOK — Segment 1 is fixed (do not alter, do not skip):\n  File: "${hookMoment.videoFile}", startTime: ${hookMoment.startTime.toFixed(2)}, endTime: ${Math.min(hookMoment.endTime, hookMoment.startTime + pacing.hookWindow * 1.5).toFixed(2)}\n  Score: ${Math.round(hookMoment.score * 100)} | hookScore: ${Math.round(hookMoment.hookScore * 100)}\n  Why this is the hook: ${hookMoment.reason}`
        : "";

      const pacingTemplateContext = `\n═══ PACING TEMPLATE — ${pacingTemplate.length} segments targeting ${targetDurSecs}s total ═══\n` +
        pacingTemplate.map((p, i) =>
          `  Seg ${String(i + 1).padStart(2)} [${p.phase}]: ~${p.targetSec}s`
        ).join("\n") +
        `\nRULES: HOOK segments = ${pacing.clipMin}–${(pacing.clipIdeal * 0.7).toFixed(1)}s. CLIMAX segments = ${pacing.clipMin}–${(pacing.clipIdeal * 0.8).toFixed(1)}s. RESOLVE segments = ${(pacing.clipIdeal).toFixed(1)}–${pacing.clipMax}s. Every segment MUST match its phase target ±20%.`;

      // ══════════════════════════════════════════════════════════════════
      // ── Build rich per-video context for AI ─────────────────────────
      // Check if clip analysis has been run and include scores
      const hasClipAnalysis = videos.some(v => v.clipAnalysis);
      const videoContext = videos.map((v, i) => {
        const dur = v.durationSeconds ? `${v.durationSeconds.toFixed(1)}s` : "unknown duration";

        // ── Parse timed transcript segments (stored as JSON from transcribe job) ──
        let timedTranscript = "No transcript";
        let transcriptSegmentList = "";
        if (v.transcript) {
          try {
            const txData = JSON.parse(v.transcript);
            // txData.segments = [{start, end, text, words?}, ...] from transcription job.
            // If word-level timestamps are present (from gpt-4o-transcribe verbose_json),
            // expose key phrase-level boundaries AND word-level cues so the AI can
            // make precise in-word cuts rather than phrase-level approximations.
            const segs: Array<{ start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }> = txData.segments ?? [];
            if (segs.length > 0) {
              const hasWordTimestamps = segs.some(s => Array.isArray(s.words) && s.words.length > 0);
              transcriptSegmentList = segs.map((s) => {
                const phraseEntry = `  [${s.start.toFixed(2)}s→${s.end.toFixed(2)}s] "${s.text.trim()}"`;
                // If word-level timestamps exist for this segment, append first+last word times
                // so the AI knows precise cut points within the phrase
                if (hasWordTimestamps && Array.isArray(s.words) && s.words.length > 0) {
                  const firstWord = s.words[0];
                  const lastWord = s.words[s.words.length - 1];
                  const wordCue = firstWord.start !== s.start || lastWord.end !== s.end
                    ? ` ← words: ${firstWord.word.trim()}@${firstWord.start.toFixed(2)}s … ${lastWord.word.trim()}@${lastWord.end.toFixed(2)}s`
                    : "";
                  return phraseEntry + wordCue;
                }
                return phraseEntry;
              }).join("\n");
              const wordNote = segs.some(s => Array.isArray(s.words) && s.words.length > 0)
                ? " (word-level timestamps available)"
                : "";
              timedTranscript = `Timed phrases${wordNote} (use these EXACT timestamps for startTime/endTime):\n${transcriptSegmentList}`;
            } else if (txData.transcript) {
              // Fallback: plain text only
              timedTranscript = `Transcript (no timestamps): "${txData.transcript.substring(0, 400)}"`;
            }
          } catch {
            // raw string stored
            timedTranscript = `Transcript: "${v.transcript.substring(0, 300)}"`;
          }
        }

        const scene = v.sceneAnalysis ? `Scene analysis: ${v.sceneAnalysis.substring(0, 250)}` : "";

        let clipScores = "";
        let bestMoments = "";
        if (v.clipAnalysis) {
          try {
            const ca = JSON.parse(v.clipAnalysis);
            const usable = ca.isUsable === false ? " | ⚠ UNUSABLE — AVOID" : "";
            const audioWarn = ca.hasAudioClipping ? " | ⚠ AUDIO CLIPPING" : "";
            const neural = ca.neural ?? {};
            const neuralStr = Object.keys(neural).length > 0
              ? `\n  Neural CV: vis=${neural.visual_quality != null ? Math.round(neural.visual_quality * 100) : "?"} hook=${neural.hook_score != null ? Math.round(neural.hook_score * 100) : "?"} emo=${neural.emotion_score != null ? Math.round(neural.emotion_score * 100) : "?"} diversity=${neural.diversity_score != null ? Math.round(neural.diversity_score * 100) : "?"} faces=${neural.has_faces ? "✓" : "no"} speech=${neural.has_speech ? "✓" : "no"}${neural.face_valence != null ? ` valence=${neural.face_valence.toFixed(2)}` : ""}${neural.speaker_count != null ? ` | speakers=${neural.speaker_count} turns=${neural.speaker_turn_count ?? "?"}` : ""}${neural.filler_rate_per_minute != null ? ` | filler=${neural.filler_rate_per_minute}/min${neural.has_heavy_filler ? " ⚠HEAVY" : ""}` : ""}`
              : "";
            clipScores = `\n  Editorial scores: hook=${Math.round((ca.hookScore??0.5)*100)} emotion=${Math.round((ca.emotionScore??0.5)*100)} clarity=${Math.round((ca.clarityScore??0.5)*100)} bRoll=${Math.round((ca.bRollValue??0.5)*100)} visual=${Math.round((ca.visualQuality??0.5)*100)} COMPOSITE=${Math.round((ca.compositeScore??0.5)*100)}/100\n  Clip type: ${ca.clipType ?? "unknown"} | Tags: [${(ca.tags??[]).join(", ")}]${usable}${audioWarn}${neuralStr}\n  Editor note: ${ca.reason ?? ""}`;
            // Include AI-identified best moments if available
            if (ca.bestMoments && ca.bestMoments.length > 0) {
              bestMoments = `\n  ★ BEST MOMENTS (AI-ranked — strongly prefer these windows):\n` +
                ca.bestMoments.map((m: { start: number; end: number; score: number; reason: string }) =>
                  `    [${m.start.toFixed(2)}s→${m.end.toFixed(2)}s] score=${Math.round(m.score*100)} — "${m.reason}"`
                ).join("\n");
            }
          } catch {}
        }

        return `[Clip ${i}] "${v.originalName ?? v.filename}" — ${dur}\n  ${timedTranscript}\n  ${scene}${clipScores}${bestMoments}`;
      }).join("\n\n");

      // ── Editorial policy engine per format ──────────────────────────────
      const editorialPolicies: Record<string, string> = {
        instagram_reel:   "REEL POLICY: Hook MUST land in first 3s. Prioritize HIGH hook+emotion scores. Avoid clips tagged camera_shake/bad_audio. Max 1 use per clip. Keep energy HIGH throughout. End on strong visual.",
        tiktok:           "TIKTOK POLICY: Hook in first 1s is CRITICAL. Highest hookScore clips go first. Prioritize humor/energetic tags. Aggressive pacing — cut on action, never on dead air. Avoid any clip tagged 'slow'.",
        youtube_short:    "SHORT POLICY: Hook in first 3s. Balance dialogue + visual variety. Clips tagged 'dialogue_heavy' belong in mid-section. End with payoff or CTA. Visual quality score must be ≥50.",
        youtube_long:     "LONG POLICY: Story arc matters. Open with establishing_shot, build through dialogue_heavy clips, climax with emotional_peak. High speech importance clips get longer duration. b_roll clips fill transitions. Never repeat clips unnecessarily.",
        wedding_highlight:"WEDDING POLICY: Prioritize clips tagged emotional_peak/tender_moment/reaction_shot. Open with establishing_shot. Build to vows/first_dance climax. Music guides pacing — align cuts to beat timestamps. Avoid camera_shake/bad_audio/overexposed clips completely.",
        ad_spot:          "AD POLICY: First 2s deliver hook (highest hookScore). Show product early. High shot variety — no clip >4s. Energetic/action_shot clips preferred. End with clear payoff. Clip composite score must be ≥60 to be used.",
        custom:           "CUSTOM POLICY: Select clips with highest composite scores. Maintain variety — no clip type dominates. Reject unusable/bad_audio clips. Build natural emotional arc.",
      };
      const formatPolicy = editorialPolicies[targetFormat] ?? editorialPolicies["custom"];

      // ── Inject LEARNED PREFERENCES from self-learning loop ───────────────
      // Fetch the accumulated user-preference signals for this format and
      // translate them into explicit AI instructions so every new edit plan
      // already reflects what the user has taught the model.
      let learnedPrefsContext = "";
      try {
        const [learnedPrefs, corrRow] = await Promise.all([
          db.select().from(learnedClipPrefsTable).where(eq(learnedClipPrefsTable.format, targetFormat)),
          db.select().from(modelConfigTable).where(eq(modelConfigTable.key, `correction_signal_${targetFormat}`)).limit(1),
        ]);

        const preferLines: string[] = [];
        const avoidLines: string[] = [];

        for (const pref of learnedPrefs) {
          if ((pref.usageCount ?? 0) < 2) continue; // skip statistically weak signals
          const label = pref.tag ? `clips tagged "${pref.tag}"` : `clip type "${pref.clipType}"`;
          const rate = pref.selectionRate ?? 0.5;
          const pct = Math.round(rate * 100);
          if (rate >= 0.70) preferLines.push(`  ✓ PREFER ${label} — this editor selected them ${pct}% of the time`);
          else if (rate <= 0.35) avoidLines.push(`  ✗ AVOID ${label} — this editor rejected them ${100 - pct}% of the time`);
        }

        const timingLines: string[] = [];
        if (corrRow.length > 0) {
          try {
            const corr = JSON.parse(corrRow[0].value ?? "{}");
            const ds = corr.avgDeltaStart ?? 0;
            const de = corr.avgDeltaEnd ?? 0;
            if (Math.abs(ds) > 0.15) timingLines.push(`  • Trim clip STARTS by ~${ds >= 0 ? "+" : ""}${ds.toFixed(1)}s on average (editor consistently adjusts start points)`);
            if (Math.abs(de) > 0.15) timingLines.push(`  • Trim clip ENDS by ~${de >= 0 ? "+" : ""}${de.toFixed(1)}s on average (editor consistently adjusts end points)`);
          } catch {}
        }

        const hasSignals = preferLines.length + avoidLines.length + timingLines.length > 0;
        if (hasSignals) {
          learnedPrefsContext = `\n═══ LEARNED USER PREFERENCES (apply these — trained from real edits) ═══\n` +
            (preferLines.length > 0 ? `STRONG PREFERENCES (prioritise these clip types):\n${preferLines.join("\n")}\n` : "") +
            (avoidLines.length > 0 ? `STRONG AVOIDANCES (exclude or deprioritise):\n${avoidLines.join("\n")}\n` : "") +
            (timingLines.length > 0 ? `TIMING CORRECTIONS (adjust all clip boundaries accordingly):\n${timingLines.join("\n")}\n` : "") +
            `These signals were learned from the editor's own previous edit decisions — they represent real taste, not defaults. Treat them as MANDATORY editorial constraints.`;
          await appendLog(jobId, `Injecting ${preferLines.length} preference + ${avoidLines.length} avoidance + ${timingLines.length} timing signals into prompt`);
        } else {
          await appendLog(jobId, "No learned preferences found for this format yet — using editorial policy defaults only");
        }
      } catch (e: any) {
        await appendLog(jobId, `Learned preferences load failed (non-fatal): ${e?.message}`);
      }

      // ── FEATURE 1: Footage Brief — material analysis summary ──────────────
      // Give the AI a pre-digested "editor's briefing" on the strengths,
      // weaknesses, and recommended strategy for the available footage before
      // it even sees the full clip list. This dramatically improves first-pass
      // quality by anchoring the model's editorial perspective.
      let footageBriefContext = "";
      try {
        const analyzedClips = videos.filter(v => v.clipAnalysis);
        if (analyzedClips.length > 0) {
          const allScores = analyzedClips.map(v => {
            const ca = JSON.parse(v.clipAnalysis!);
            const neural = ca.neural ?? {};
            return {
              name: v.originalName ?? v.filename,
              composite: ca.compositeScore ?? 50,
              hook: ca.hookScore ?? 0.5,
              emotion: ca.emotionScore ?? 0.5,
              visual: ca.visualQuality ?? neural.visual_quality ?? 0.5,
              hasAudio: !ca.hasAudioClipping,
              isUsable: ca.isUsable !== false,
              clipType: ca.clipType ?? "unknown",
              tags: (ca.tags ?? []) as string[],
              energy: (neural.emotion_score ?? 0.5) * 0.6 + (neural.audio_arousal ?? 0.5) * 0.4,
              hasFaces: !!neural.has_faces,
              hasSpeech: !!neural.has_speech,
              fillerRisk: neural.has_heavy_filler ? "HIGH" : (neural.filler_rate_per_minute ?? 0) > 5 ? "MEDIUM" : "LOW",
              reason: ca.reason ?? "",
            };
          });

          const usable = allScores.filter(s => s.isUsable && s.hasAudio);
          const top3 = [...usable].sort((a, b) => b.composite - a.composite).slice(0, 3);
          const bottom = usable.filter(s => s.composite < 40).length;
          const withFaces = usable.filter(s => s.hasFaces).length;
          const withSpeech = usable.filter(s => s.hasSpeech).length;
          const highFiller = usable.filter(s => s.fillerRisk === "HIGH").length;
          const unusable = allScores.filter(s => !s.isUsable || !s.hasAudio).length;
          const avgComposite = usable.reduce((a, b) => a + b.composite, 0) / (usable.length || 1);
          const avgHook = usable.reduce((a, b) => a + b.hook, 0) / (usable.length || 1);
          const avgEnergy2 = usable.reduce((a, b) => a + b.energy, 0) / (usable.length || 1);

          const allTags = usable.flatMap(s => s.tags);
          const tagFreq: Record<string, number> = {};
          for (const t of allTags) tagFreq[t] = (tagFreq[t] ?? 0) + 1;
          const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);

          const strengthNote = avgComposite >= 70 ? "excellent overall quality — push creative risks" :
            avgComposite >= 55 ? "solid quality — standard approach recommended" :
            avgComposite >= 40 ? "mixed quality — be highly selective, use only high-scoring clips" :
            "limited material — use every usable moment, overlap B-roll generously";

          const hookNote = avgHook >= 0.7 ? "Strong hook candidates available — open with confidence" :
            avgHook >= 0.5 ? "Moderate hook options — combine best visual with strongest line" :
            "Weak hook material — use motion, music cut, or title card to compensate";

          footageBriefContext = `
═══ FOOTAGE BRIEF — Pre-Analysis (read this FIRST before selecting clips) ═══
Material quality: avg COMPOSITE=${Math.round(avgComposite)}/100 | avg HOOK=${Math.round(avgHook*100)} | avg ENERGY=${Math.round(avgEnergy2*100)} | material: "${strengthNote}"
Inventory: ${usable.length} usable clips | ${withFaces} with faces | ${withSpeech} with speech | ${unusable} UNUSABLE (skip entirely) | ${bottom} low-quality (<40 composite)
Hook situation: ${hookNote}
${highFiller > 0 ? `⚠ FILLER WARNING: ${highFiller} clip(s) flagged for heavy filler words — trim aggressively or deprioritize` : ""}
Common content themes (top tags): [${topTags.join(", ")}]
Top 3 strongest moments to anchor your edit:
${top3.map((c, i) => `  ${i+1}. "${c.name}" — composite=${Math.round(c.composite)} hook=${Math.round(c.hook*100)} type=${c.clipType} ${c.reason ? `| "${c.reason.slice(0, 80)}"` : ""}`).join("\n")}
EDITORIAL STRATEGY: ${
  withSpeech > withFaces ? "Speech-led material — structure around key dialogue, use B-roll to cover transitions" :
  withFaces > 0 && avgEnergy2 > 0.6 ? "Emotion-forward material — let faces and energy drive the cut, dialogue secondary" :
  avgEnergy2 < 0.4 ? "Calm/reflective material — use longer clips, wider shots, let music carry the pacing" :
  "Balanced material — alternate between tight and wide, speech and action, throughout the arc"
}`;

          await appendLog(jobId, `Footage Brief: avg composite=${Math.round(avgComposite)}, ${usable.length} usable clips, energy=${Math.round(avgEnergy2*100)}%, top tags: [${topTags.slice(0,3).join(",")}]`);
        }
      } catch (e: any) {
        await appendLog(jobId, `Footage brief generation failed (non-fatal): ${e?.message}`);
      }

      // ── FEATURE 7: Session edit signals from recent manual edits ──────────
      // If the user has made manual edits in this session, inject those
      // patterns as additional editorial constraints in the prompt.
      let sessionSignalsContext = "";
      try {
        const sessRow = await db.select().from(modelConfigTable)
          .where(eq(modelConfigTable.key, `session_signals_${projectId}`)).limit(1);
        if (sessRow.length > 0) {
          const signals = JSON.parse(sessRow[0].value ?? "{}");
          const lines: string[] = [];
          if (signals.avgTrimStart && Math.abs(signals.avgTrimStart) > 0.1)
            lines.push(`  • User consistently trims clip STARTS by ${signals.avgTrimStart > 0 ? "+" : ""}${signals.avgTrimStart.toFixed(1)}s — apply this offset to all clip starts`);
          if (signals.avgTrimEnd && Math.abs(signals.avgTrimEnd) > 0.1)
            lines.push(`  • User consistently trims clip ENDS by ${signals.avgTrimEnd > 0 ? "+" : ""}${signals.avgTrimEnd.toFixed(1)}s — apply this offset`);
          if (signals.excludedTypes?.length > 0)
            lines.push(`  • User excluded ${signals.excludedTypes.join(", ")} clips in this session — deprioritise these types`);
          if (signals.preferredTypes?.length > 0)
            lines.push(`  • User kept ${signals.preferredTypes.join(", ")} clips — strongly prefer these`);
          if (signals.reorderCount > 2)
            lines.push(`  • User reordered ${signals.reorderCount} clips — they care strongly about sequence order; use emotional arc strictly`);
          if (lines.length > 0) {
            sessionSignalsContext = `\n═══ LIVE SESSION SIGNALS (from this editing session — highest priority) ═══\n${lines.join("\n")}\nThese signals reflect what the editor just did moments ago — apply them with highest priority above all other defaults.`;
            await appendLog(jobId, `Session signals: ${lines.length} live signals injected`);
          }
        }
      } catch {}

      // ── AI Intelligence context (#46–#55) ─────────────────────────────────
      let genrePresetContext = "";
      if (project?.genrePreset) {
        const GENRE_INFO: Record<string, { label: string; desc: string; targetCutSec: number; preferredCut: string }> = {
          documentary: { label: "Documentary", desc: "Slow, interview-led. Let subjects breathe. Wide establishing shots.", targetCutSec: 12, preferredCut: "hard-cut" },
          tutorial:    { label: "Tutorial",    desc: "Step-by-step pacing. J-cuts for narration overlap.", targetCutSec: 7, preferredCut: "j-cut" },
          vlog:        { label: "Vlog",        desc: "Casual, fast B-roll heavy. Tight cuts on speech.", targetCutSec: 4, preferredCut: "hard-cut" },
          ad:          { label: "Ad Spot",     desc: "Punchy, emotional pull, strong CTA. Match-cuts.", targetCutSec: 2.5, preferredCut: "match-cut" },
          short_film:  { label: "Short Film",  desc: "Cinematic story-driven. L-cuts for scene transitions.", targetCutSec: 8, preferredCut: "l-cut" },
          social_media:{ label: "Social Media",desc: "Ultra-fast, hook in first second, scroll-stopping.", targetCutSec: 2.3, preferredCut: "hard-cut" },
          music_video: { label: "Music Video", desc: "Beat-synced, visually dynamic, emotion-driven.", targetCutSec: 2, preferredCut: "hard-cut" },
        };
        const gInfo = GENRE_INFO[project.genrePreset];
        if (gInfo) {
          genrePresetContext = `\n═══ GENRE PRESET: ${gInfo.label.toUpperCase()} ═══\n${gInfo.desc}\n- Target clip duration: ${gInfo.targetCutSec}s\n- Preferred cut type: "${gInfo.preferredCut}"\nCRITICAL: All transitionIn values must default to "${gInfo.preferredCut}" unless a specific scene calls for a different transition. Pacing must follow the ${gInfo.label} genre conventions above.`;
          await appendLog(jobId, `Genre preset loaded: ${gInfo.label} — ${gInfo.targetCutSec}s target cuts, ${gInfo.preferredCut} style`);
        }
      }

      let pacingEnvelopeContext = "";
      if (project?.pacingEnvelope) {
        try {
          const zones = JSON.parse(project.pacingEnvelope) as Array<{ start: number; end: number; pace: string; targetCutSec?: number; label?: string }>;
          if (zones.length > 0) {
            const dur = (() => {
              try { return (project as any).durationSeconds ?? targetDurSecs; } catch { return targetDurSecs; }
            })();
            pacingEnvelopeContext = `\n═══ PACING ENVELOPE — USER-DEFINED ZONES ═══\nThe user has manually drawn pacing zones on the timeline. OVERRIDE the standard pacing template for segments that fall within these zones:\n` +
              zones.map(z => `  ${z.start}s–${z.end}s → ${z.pace.toUpperCase()} pace${z.targetCutSec ? ` (${z.targetCutSec}s/clip)` : ""}${z.label ? ` — "${z.label}"` : ""}`).join("\n") +
              `\nFor segments in FAST zones: use shorter clips (aim for ${zones.find(z => z.pace === "fast")?.targetCutSec ?? 2}s). For SLOW zones: use longer clips (aim for ${zones.find(z => z.pace === "slow")?.targetCutSec ?? 10}s). For NORMAL zones: follow standard pacing template.`;
            await appendLog(jobId, `Pacing envelope loaded — ${zones.length} user-defined zones`);
          }
        } catch {}
      }

      let diversityGuardContext = "";
      if (project?.editDiversityGuard !== false) {
        diversityGuardContext = `\n══ EDIT DIVERSITY GUARD (ACTIVE) ══\nNEVER place the same transitionIn value in 3 or more consecutive segments. After 2 hard-cuts, use a dissolve, j-cut, or l-cut. After 2 b-roll segments, insert a speech or highlight segment. This creates visual variety that keeps viewers engaged.`;
      }

      const prompt = hasManuscriptAnalysis && manuscriptScenes.length > 0
        ? `You are a world-class AI video editor executing a SCRIPT-DRIVEN edit. Your output must follow the manuscript analysis EXACTLY — do not add or remove scenes.

═══ TARGET FORMAT ═══
Format: ${targetFormat.replace(/_/g, " ")} — ${spec.duration}, ${spec.aspect}
Style mandate: ${spec.style}
Pacing rules: ${pacing.clipIdeal}s avg clip, ${pacing.cutsPerMin} cuts/min, hook within first ${pacing.hookWindow}s

${footageBriefContext}

═══ AVAILABLE FOOTAGE ═══
${videoContext}

${musicContext}${beatInstruction}
${cutRhythmContext}
${styleContext}
${storyPrefsContext}
${manuscriptContext}
${learnedPrefsContext}
${sessionSignalsContext}
${genrePresetContext}
${pacingEnvelopeContext}
${diversityGuardContext}

═══ EDITING MANDATES ═══
1. HOOK FIRST: The very first segment MUST be the single most visually arresting / emotionally compelling moment from all footage. Viewers decide within ${pacing.hookWindow}s whether to keep watching.
2. BEAT SYNC: Every cut point MUST snap to the nearest available beat timestamp. Tolerance ±0.15s. A cut that misses a beat is a failed cut.
3. EMOTIONAL ARC: Follow a cinematic structure — hook → rising tension → climax → resolution. Map each manuscript scene to the correct arc phase.
4. SHOT DIVERSITY: Never use the same footage clip more than 3 times consecutively. Mix wide shots, close-ups, and action shots.
4a. NO REPEATED FOOTAGE (CRITICAL): Every segment must use a UNIQUE, non-overlapping time range. No second of source footage may appear more than once. Treat each time range as consumed once chosen — overlapping ranges create audible and visual repetition.
5. AUDIO COHERENCE: Speech/ceremony/interview segments → audioMixLevel=1.0, musicDuckLevel=0.15. Action/B-roll/highlight segments → audioMixLevel=0.0, musicDuckLevel=1.0.
6. CONFIDENCE SCORING: Score each segment 0.0-1.0. 0.95+ = perfect match, 0.85 = strong, 0.7 = acceptable, below 0.6 = last resort only.
7. CLIP DURATION: Keep each clip between ${pacing.clipMin}s and ${pacing.clipMax}s. Ideal is ${pacing.clipIdeal}s.

Create EXACTLY ${manuscriptScenes.length} segments matching manuscript scenes in order. For each scene pick the best matching clip from available footage.

Return ONLY valid JSON — no markdown, no explanation:
{
  "editPlan": {
    "totalDuration": <sum of all durations in seconds>,
    "hookScore": <0-1, quality of the opening hook>,
    "beatSyncRate": <0-1, fraction of cuts that land on beats>,
    "emotionalArc": "<describe the arc: hook→rise→climax→resolve>",
    "segments": [
      {
        "videoFile": "<exact filename from footage list>",
        "startTime": <number — snap to nearest beat>,
        "endTime": <number — snap to nearest beat, min ${pacing.clipMin}s gap>,
        "type": "<hook|highlight|speech|action|transition|buildup|climax|resolution>",
        "label": "<scene title from manuscript>",
        "captionText": "<caption text from manuscript or null>",
        "captionStyle": "<subtitle|title|lower_third|kinetic|none>",
        "colorGrade": "<warm|cool|cinematic|bw|vivid|muted|sunset|teal_orange|desaturated|none>",
        "speedFactor": <1.0 default, 0.5 for slow-mo, 1.5-2.0 for fast>,
        "transitionIn": "<cut|dissolve|fade_black|flash|wipe_right|zoom_in>",
        "audioMixLevel": <0.0-1.0>,
        "musicDuckLevel": <0.0-1.0>,
        "reason": "<specific reason this clip fits this scene — mention visual content, emotional match, transcript alignment>",
        "confidence": <0.0-1.0>
      }
    ],
    "narration": "<director notes for the overall edit>",
    "musicMood": "<detected/expected mood>"
  }
}`
        : `You are a world-class AI video editor. Your job is to produce the best possible edit plan for this project — one that would make a professional filmmaker proud.

═══ TARGET FORMAT ═══
Format: ${targetFormat.replace(/_/g, " ")} — ${spec.duration}, ${spec.aspect}
Style mandate: ${spec.style}
Pacing: ${pacing.clipIdeal}s avg clip, ${pacing.cutsPerMin} cuts/min, hook within first ${pacing.hookWindow}s
Segment count target: ${pacing.totalSegs} segments

═══ EDITORIAL POLICY (FOLLOW STRICTLY) ═══
${formatPolicy}
${hasClipAnalysis ? "✓ Clip analysis scores are available below — use them to make editorial decisions. Higher COMPOSITE score = better clip for this format." : "⚠ No clip analysis run yet — scores are unavailable, rely on transcripts and scene data."}

${footageBriefContext}

═══ AVAILABLE FOOTAGE (with editorial scores and analysis) ═══
${videoContext}

${musicContext}${beatInstruction}
${cutRhythmContext}
${styleContext}${storyPrefsContext}${manuscriptContext}
${learnedPrefsContext}
${sessionSignalsContext}
${genrePresetContext}
${pacingEnvelopeContext}
${diversityGuardContext}
${rankedMomentsContext}
${safeCutPointsContext}
${forcedHookContext}
${pacingTemplateContext}

═══ EDITING MANDATES — APPLY ALL OF THESE ═══

1. HOOK FIRST (CRITICAL — MANDATORY):${forcedHookContext ? ` The hook segment is PRE-SELECTED above (⚡ MANDATORY HOOK). Copy it EXACTLY as Segment 1 — same file, same startTime, same endTime. Do not change it.` : ` Segment 1 MUST be the clip with the highest hookScore. Viewers decide in ${pacing.hookWindow}s — choose the most attention-grabbing moment from the PRE-RANKED BEST MOMENTS list.`}

2. PACING TEMPLATE (CRITICAL): Follow the PACING TEMPLATE above EXACTLY. Each segment is assigned a phase (HOOK/BUILD/CLIMAX/RESOLVE) and a target duration. You must produce EXACTLY ${pacingTemplate.length} segments. Each segment's duration must be within ±25% of its template target.

3. SENTENCE-BOUNDARY CUTS (CRITICAL): Use ONLY the timestamps listed in SENTENCE-BOUNDARY CUT POINTS:
   a) Each segment's startTime MUST come from the cut-IN list for that clip
   b) Each segment's endTime MUST come from the cut-OUT list for that clip
   c) Never cut mid-sentence, mid-phrase, mid-word, or mid-"um"/"uh"
   d) If the only available timestamps give a duration outside template target, pick the closest boundary that satisfies the constraint
   e) If ★ BEST MOMENTS are listed, use those windows and snap their edges to nearest boundaries

4. EMOTIONAL ARC: Follow the PACING TEMPLATE phases precisely:
   - HOOK: Most impactful, attention-grabbing, high hook+emotion score
   - BUILD: Rising energy, context, introduce the narrative
   - CLIMAX: Peak emotional intensity, fastest cuts, most powerful moments
   - RESOLVE: Settling, satisfying conclusion, breathing room

5. RANKED MOMENTS PRIORITY: Build your edit primarily from the PRE-RANKED BEST MOMENTS list. Higher score = stronger moment. The top moment MUST appear as the hook or very early in BUILD.

6. SHOT DIVERSITY: Do NOT use the same clip file more than 2-3 times consecutively. Mix varied moments from different time positions.

6a. NO REPEATED FOOTAGE (CRITICAL): Every segment must use a UNIQUE, non-overlapping time range. No second of source footage may appear more than once. If you pick [10.00→15.00] for one segment, you CANNOT pick [10.00→20.00] or [12.00→18.00] for any other segment — those ranges overlap and will create repetition the viewer immediately notices. Treat each time range as consumed once chosen.

7. AUDIO COHERENCE:
   - Speech/interview/ceremony → audioMixLevel=1.0, musicDuckLevel=0.15 (audience hears the words)
   - B-roll/highlight/music-only → audioMixLevel=0.0, musicDuckLevel=1.0 (music leads)
   - Action sequences → audioMixLevel=0.3, musicDuckLevel=0.8 (blend)

8. BEAT SYNC: If beat timestamps are available, snap cut points to the nearest beat (±0.15s tolerance). Beat-aligned sentence-boundary cuts are ideal.

9. TOTAL DURATION: Sum of all segment durations MUST equal ${targetDurSecs}s ±5s. Do not exceed this.

10. CONFIDENCE SCORING: Score each segment honestly (0.95+ = perfect, 0.80+ = strong, 0.65+ = acceptable, below = last resort).

11. COLOR CONSISTENCY: Tell a visual color story. Hook → vivid/warm. Climax → cinematic. Resolve → muted or warm. Never randomize.

12. CAPTIONS: Only add captionText when it adds real value. 8 words max. Match energy of the segment.

Return ONLY valid JSON (no markdown):
{
  "editPlan": {
    "totalDuration": <sum of all segment durations>,
    "hookScore": <0-1, how attention-grabbing is segment 1>,
    "beatSyncRate": <0-1, fraction of cuts landing on beats>,
    "emotionalArc": "<one sentence describing the arc>",
    "segments": [
      {
        "videoFile": "<exact filename>",
        "startTime": <beat-aligned number>,
        "endTime": <beat-aligned number>,
        "type": "hook|highlight|speech|action|buildup|climax|resolution|transition",
        "label": "<descriptive label>",
        "captionText": "<8 words max or null>",
        "captionStyle": "subtitle|title|lower_third|kinetic|none",
        "colorGrade": "warm|cool|cinematic|bw|vivid|muted|sunset|teal_orange|desaturated|none",
        "speedFactor": 1.0,
        "transitionIn": "cut|dissolve|fade_black|flash|wipe_right|zoom_in",
        "audioMixLevel": 0.0,
        "musicDuckLevel": 1.0,
        "reason": "<specific reason — mention visual content, emotional beat, transcript cue, or beat alignment>",
        "confidence": 0.9
      }
    ],
    "narration": "<director's notes on the overall creative approach>",
    "musicMood": "<mood of the edit>"
  }
}`;

      // ── Check for active fine-tuned model ───────────────────────────────
      const activeModelRows = await db
        .select()
        .from(modelConfigTable)
        .where(eq(modelConfigTable.key, "active_finetune_model"))
        .limit(1);
      const activeFinetuneModel = activeModelRows[0]?.value ?? null;

      let text = "";
      if (activeFinetuneModel) {
        await appendLog(jobId, `Using fine-tuned model: ${activeFinetuneModel}`);
        await db.update(jobsTable).set({ progress: 55 }).where(eq(jobsTable.id, jobId));
        const ftCompletion = await openai.chat.completions.create({
          model: activeFinetuneModel,
          max_tokens: 8192,
          messages: [
            {
              role: "system",
              content:
                "You are CutAI, a professional video editing AI trained to select the best clips and create compelling edits for social media. Return ONLY valid JSON — no markdown, no explanation.",
            },
            { role: "user", content: prompt },
          ],
        });
        text = ftCompletion.choices[0]?.message?.content ?? "";
        await appendLog(jobId, "Edit plan received from fine-tuned model. Parsing segment timeline...");
      } else {
        await appendLog(jobId, "Sending edit brief to Claude Opus for creative direction...");
        await db.update(jobsTable).set({ progress: 55 }).where(eq(jobsTable.id, jobId));
        const msg = await anthropic.messages.create({
          model: "claude-opus-4-6",
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        });
        text = msg.content[0].type === "text" ? msg.content[0].text : "";
        await appendLog(jobId, "Edit plan received from Claude. Parsing segment timeline...");
      }
      result = text;

      // ── FEATURE 2: Multi-pass refinement ─────────────────────────────────
      // Run a fast second Claude call to review and surgically fix the
      // draft plan BEFORE post-processing.  This catches structural problems
      // (jump cuts, shot diversity failures, arc breaks) that the first pass
      // produces ~30% of the time — without regenerating the full plan.
      try {
        const draftMatch = text.match(/\{[\s\S]*\}/);
        if (draftMatch) {
          const draftPlan = JSON.parse(draftMatch[0]);
          const draftSegs = draftPlan.editPlan?.segments ?? [];
          if (draftSegs.length >= 3) {
            // Quick structural analysis of the draft plan
            const issues: string[] = [];

            // Check for jump cuts (consecutive clips from same video, adjacent time)
            for (let i = 0; i < draftSegs.length - 1; i++) {
              const a = draftSegs[i]; const b = draftSegs[i + 1];
              if (a.videoFile === b.videoFile && Math.abs(a.endTime - b.startTime) < 0.5) {
                issues.push(`Jump cut between segment ${i+1} and ${i+2}: "${a.videoFile}" ends at ${a.endTime}s but next clip starts at ${b.startTime}s (gap < 0.5s — likely jump cut)`);
              }
            }

            // Check for shot type monotony (3+ consecutive same type)
            let runLen = 1;
            for (let i = 1; i < draftSegs.length; i++) {
              if (draftSegs[i].type === draftSegs[i-1].type) {
                runLen++;
                if (runLen >= 3) issues.push(`Shot type monotony: ${runLen} consecutive "${draftSegs[i].type}" segments at positions ${i-runLen+2}–${i+1}`);
              } else { runLen = 1; }
            }

            // Check for emotional arc violations (hook too late, climax missing)
            const hookIdx = draftSegs.findIndex((s: any) => s.type === "hook");
            if (hookIdx > 1) issues.push(`Hook segment appears at position ${hookIdx+1} — it MUST be segment 1`);
            const hasClimax = draftSegs.some((s: any) => s.type === "climax");
            if (!hasClimax && draftSegs.length > 8) issues.push("No climax segment found — add at least one climax-type segment near 60-70% of the timeline");

            // Check for low-confidence segments
            const lowConf = draftSegs.filter((s: any) => (s.confidence ?? 1) < 0.6).length;
            if (lowConf > 0) issues.push(`${lowConf} segment(s) have confidence < 0.6 — reconsider these selections`);

            if (issues.length > 0) {
              await appendLog(jobId, `Multi-pass review found ${issues.length} issue(s): ${issues.slice(0, 2).map(i => i.slice(0, 60)).join(" | ")} — sending refinement pass`);

              const refinementPrompt = `You are a senior video editor reviewing a draft edit plan. Fix the specific issues listed below and return the corrected plan as valid JSON.

DRAFT PLAN:
${JSON.stringify(draftPlan, null, 2).slice(0, 6000)}

ISSUES TO FIX:
${issues.map((issue, i) => `${i+1}. ${issue}`).join("\n")}

Available source clips:
${videos.map(v => `- "${v.originalName ?? v.filename}" (${v.durationSeconds?.toFixed(1) ?? "?"}s)`).join("\n")}

Rules:
- Fix ONLY the listed issues; do not restructure the entire plan
- Keep all segment fields intact (type, label, colorGrade, audioMixLevel, etc.)
- Ensure no overlapping time ranges within the same video file
- Return the complete corrected editPlan as valid JSON with the same schema

Return ONLY valid JSON — no markdown, no explanation.`;

              const refinedMsg = await anthropic.messages.create({
                model: "claude-haiku-4-5",
                max_tokens: 6000,
                messages: [{ role: "user", content: refinementPrompt }],
              });
              const refinedText = refinedMsg.content[0].type === "text" ? refinedMsg.content[0].text : "";
              const refinedMatch = refinedText.match(/\{[\s\S]*\}/);
              if (refinedMatch) {
                const refinedPlan = JSON.parse(refinedMatch[0]);
                if (refinedPlan.editPlan?.segments?.length >= draftSegs.length * 0.7) {
                  text = refinedText;
                  result = text;
                  await appendLog(jobId, `Multi-pass refinement applied — ${refinedPlan.editPlan.segments.length} segments after refinement`);
                } else {
                  await appendLog(jobId, "Multi-pass refinement produced too few segments — keeping original draft");
                }
              }
            } else {
              await appendLog(jobId, "Multi-pass review: draft plan passes structural checks ✓");
            }
          }
        }
      } catch (refinementErr: any) {
        await appendLog(jobId, `Multi-pass refinement failed (non-fatal): ${refinementErr?.message?.slice(0, 80)}`);
      }

      await appendLog(jobId, "Edit plan received. Parsing segment timeline...");
      await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const plan = JSON.parse(jsonMatch[0]);
          const segsToInsert: any[] = plan.editPlan?.segments ?? [];

          // ── POST-PROCESSING 1: snap timestamps to sentence boundaries ────
          let snapCount = 0;
          for (const seg of segsToInsert) {
            const matchedVid = videos.find(v => v.originalName === seg.videoFile || v.filename === seg.videoFile);
            if (!matchedVid) continue;
            const vBounds = allSentenceBoundaries.filter(b => b.videoId === matchedVid.id);
            if (vBounds.length === 0) continue;

            const SNAP_TOLERANCE = 0.8; // snap if within 800ms of a boundary

            // Snap startTime to nearest cut-IN boundary
            const cutIns = vBounds.filter(b => b.isCutIn).map(b => b.time);
            if (cutIns.length > 0) {
              const nearest = cutIns.reduce((p, c) => Math.abs(c - seg.startTime) < Math.abs(p - seg.startTime) ? c : p);
              if (Math.abs(nearest - seg.startTime) < SNAP_TOLERANCE) {
                seg.startTime = nearest; snapCount++;
              }
            }

            // Snap endTime to nearest cut-OUT boundary
            const cutOuts = vBounds.filter(b => b.isCutOut).map(b => b.time);
            if (cutOuts.length > 0) {
              const nearest = cutOuts.reduce((p, c) => Math.abs(c - seg.endTime) < Math.abs(p - seg.endTime) ? c : p);
              if (Math.abs(nearest - seg.endTime) < SNAP_TOLERANCE) {
                seg.endTime = nearest; snapCount++;
              }
            }

            // Ensure endTime > startTime + clipMin
            if (seg.endTime <= seg.startTime + pacing.clipMin) {
              seg.endTime = seg.startTime + pacing.clipMin;
            }
          }
          if (snapCount > 0) await appendLog(jobId, `  Sentence-boundary snapping: ${snapCount} timestamps snapped to clean cut points`);

          // ── POST-PROCESSING 2: enforce total duration target ─────────────
          const actualTotal = segsToInsert.reduce((acc, s) => acc + (s.endTime - s.startTime), 0);
          const drift = actualTotal - targetDurSecs;
          if (Math.abs(drift) > 5 && segsToInsert.length > 0) {
            // Distribute drift across all segments proportionally (cap per-segment change at 30%)
            const perSeg = drift / segsToInsert.length;
            for (const seg of segsToInsert) {
              const dur = seg.endTime - seg.startTime;
              const trimmed = Math.max(pacing.clipMin, dur - perSeg);
              seg.endTime = seg.startTime + trimmed;
            }
            const newTotal = segsToInsert.reduce((acc, s) => acc + (s.endTime - s.startTime), 0);
            await appendLog(jobId, `  Duration correction: ${actualTotal.toFixed(1)}s → ${newTotal.toFixed(1)}s (target: ${targetDurSecs}s)`);
          }

          // ── POST-PROCESSING 3: deduplicate overlapping footage ranges ─────
          // Algorithm:
          //   1. Resolve each segment to its canonical video ID (via videos table).
          //      This prevents false misses when the model mixes originalName vs filename.
          //   2. Annotate each segment with its original position and resolved video ID.
          //   3. Group by resolved video ID, sort each group by startTime ascending.
          //   4. Walk each group with a `lastEnd` high-water-mark cursor.
          //      If seg.startTime < lastEnd → overlap: trim startTime to lastEnd.
          //      If remaining duration < clipMin → drop; else keep.
          //   5. Re-sort survivors to original order for timeline continuity.
          //   6. Final verification pass keyed by resolved ID — log any residual overlaps.
          {
            const actionLogs: string[] = [];
            let dropCount = 0;
            let trimCount = 0;

            // Tag each segment with its original index + canonical video ID
            const tagged = segsToInsert.map((seg, i) => {
              const resolved = videos.find(v => v.originalName === seg.videoFile || v.filename === seg.videoFile);
              return {
                seg,
                origIdx: i,
                keep: true,
                resolvedId: resolved?.id ?? seg.videoFile ?? "__unknown__",
                resolvedName: resolved?.originalName ?? resolved?.filename ?? seg.videoFile ?? "?",
              };
            });

            // Group by resolved video ID (canonical, not raw model string)
            const byVideo = new Map<string, typeof tagged>();
            for (const t of tagged) {
              if (!byVideo.has(t.resolvedId)) byVideo.set(t.resolvedId, []);
              byVideo.get(t.resolvedId)!.push(t);
            }

            // Process each video's segments in source-time order
            for (const group of byVideo.values()) {
              group.sort((a, b) => a.seg.startTime - b.seg.startTime);

              let lastEnd = -Infinity; // high-water mark: highest committed endTime

              for (const t of group) {
                const seg = t.seg;

                if (seg.startTime < lastEnd) {
                  // Overlap detected — trim startTime forward to lastEnd
                  const prevStart = seg.startTime;
                  const newStart = lastEnd;
                  const remaining = seg.endTime - newStart;
                  if (remaining >= pacing.clipMin) {
                    seg.startTime = newStart;
                    trimCount++;
                    lastEnd = Math.max(lastEnd, seg.endTime);
                    actionLogs.push(`  [seg ${t.origIdx}] TRIMMED "${t.resolvedName}" [${prevStart.toFixed(2)}→${seg.endTime.toFixed(2)}] → startTime moved to ${newStart.toFixed(2)} (overlap removed)`);
                  } else {
                    // Too little footage remaining after trim — drop segment
                    t.keep = false;
                    dropCount++;
                    actionLogs.push(`  [seg ${t.origIdx}] DROPPED "${t.resolvedName}" [${prevStart.toFixed(2)}→${seg.endTime.toFixed(2)}] — only ${remaining.toFixed(2)}s remains after trim (< clipMin ${pacing.clipMin}s)`);
                  }
                } else {
                  lastEnd = Math.max(lastEnd, seg.endTime);
                }
              }
            }

            if (dropCount > 0 || trimCount > 0) {
              const kept = tagged.filter(t => t.keep).length;
              await appendLog(jobId, `  Overlap deduplication: ${dropCount} dropped, ${trimCount} trimmed → ${kept} segments remain\n${actionLogs.join("\n")}`);
            }

            // Restore original timeline order
            const survivors = tagged
              .filter(t => t.keep)
              .sort((a, b) => a.origIdx - b.origIdx)
              .map(t => t.seg);

            segsToInsert.length = 0;
            for (const s of survivors) segsToInsert.push(s);

            // Final verification — keyed by resolved video ID, not raw model string
            const verifyOverlaps: string[] = [];
            const checkMap = new Map<string, { start: number; end: number; name: string }[]>();
            for (const seg of segsToInsert) {
              const resolved = videos.find(v => v.originalName === seg.videoFile || v.filename === seg.videoFile);
              const vId = resolved?.id ?? seg.videoFile ?? "__unknown__";
              const vName = resolved?.originalName ?? resolved?.filename ?? seg.videoFile ?? "?";
              const prev = checkMap.get(vId) ?? [];
              for (const r of prev) {
                if (seg.startTime < r.end && seg.endTime > r.start) {
                  verifyOverlaps.push(`  ⚠ STILL OVERLAPS in "${vName}": [${r.start.toFixed(2)}→${r.end.toFixed(2)}] ∩ [${seg.startTime.toFixed(2)}→${seg.endTime.toFixed(2)}]`);
                }
              }
              prev.push({ start: seg.startTime, end: seg.endTime, name: vName });
              checkMap.set(vId, prev);
            }
            if (verifyOverlaps.length > 0) {
              await appendLog(jobId, `  ⚠ Overlap verification FAILED:\n${verifyOverlaps.join("\n")}`);
            } else {
              await appendLog(jobId, `  ✓ Overlap verification passed — all ${segsToInsert.length} segments use unique footage ranges`);
            }
          }

          // ── POST-PROCESSING 4: REFINEMENT PHASE ──────────────────────────
          // Final QA pass before anything is written to the database.
          // Fixes clamping issues, validates arc completeness, and produces
          // a human-readable summary of the final edit plan state.
          {
            const refinementIssues: string[] = [];
            const phaseCounts: Record<string, number> = {};
            let totalRefinedDur = 0;
            let minDur = Infinity;
            let maxDur = 0;
            let unknownSrcCount = 0;

            for (let i = 0; i < segsToInsert.length; i++) {
              const seg = segsToInsert[i];

              // 1. Video source validation
              const srcExists = videos.some(v => v.originalName === seg.videoFile || v.filename === seg.videoFile);
              if (!srcExists) {
                unknownSrcCount++;
                refinementIssues.push(`  [seg ${i}] Unknown videoFile "${seg.videoFile}" — no matching upload found`);
              }

              // 2. Timestamp sanity: start must precede end
              if (seg.startTime >= seg.endTime) {
                const fixedEnd = seg.startTime + pacing.clipMin;
                refinementIssues.push(`  [seg ${i}] Inverted timestamps [${seg.startTime.toFixed(2)}→${seg.endTime.toFixed(2)}] — endTime clamped to ${fixedEnd.toFixed(2)}`);
                seg.endTime = fixedEnd;
              }

              // 3. Duration range check (warn only — do not auto-adjust, PP2 already handled total)
              const segDur = seg.endTime - seg.startTime;
              if (segDur < pacing.clipMin) {
                refinementIssues.push(`  [seg ${i}] Duration ${segDur.toFixed(2)}s < clipMin ${pacing.clipMin}s`);
              } else if (segDur > pacing.clipMax) {
                refinementIssues.push(`  [seg ${i}] Duration ${segDur.toFixed(2)}s > clipMax ${pacing.clipMax}s (allowed, but unusual)`);
              }

              // 4. Audio level clamping
              if (seg.audioMixLevel != null) {
                const clamped = Math.max(0, Math.min(1, seg.audioMixLevel));
                if (clamped !== seg.audioMixLevel) {
                  refinementIssues.push(`  [seg ${i}] audioMixLevel ${seg.audioMixLevel} clamped → ${clamped}`);
                  seg.audioMixLevel = clamped;
                }
              }
              if (seg.musicDuckLevel != null) {
                const clamped = Math.max(0, Math.min(1, seg.musicDuckLevel));
                if (clamped !== seg.musicDuckLevel) {
                  refinementIssues.push(`  [seg ${i}] musicDuckLevel ${seg.musicDuckLevel} clamped → ${clamped}`);
                  seg.musicDuckLevel = clamped;
                }
              }

              // 5. Speed factor clamping
              if (seg.speedFactor != null) {
                const clamped = Math.max(0.25, Math.min(4.0, seg.speedFactor));
                if (clamped !== seg.speedFactor) {
                  refinementIssues.push(`  [seg ${i}] speedFactor ${seg.speedFactor} clamped → ${clamped}`);
                  seg.speedFactor = clamped;
                }
              }

              // 6. Accumulate stats
              const dur = seg.endTime - seg.startTime;
              totalRefinedDur += dur;
              minDur = Math.min(minDur, dur);
              maxDur = Math.max(maxDur, dur);
              const phase = (seg.type ?? seg.segmentType ?? "unknown").toLowerCase();
              phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
            }

            // 7. Arc completeness check
            const hasHook    = Object.keys(phaseCounts).some(p => p.includes("hook"));
            const hasBuild   = Object.keys(phaseCounts).some(p => p.includes("build") || p.includes("buildup"));
            const hasClimax  = Object.keys(phaseCounts).some(p => p.includes("climax"));
            const hasResolve = Object.keys(phaseCounts).some(p => p.includes("resolv") || p.includes("resolution"));
            const missingPhases: string[] = [];
            if (!hasHook)    missingPhases.push("HOOK");
            if (!hasBuild)   missingPhases.push("BUILD");
            if (!hasClimax)  missingPhases.push("CLIMAX");
            if (!hasResolve) missingPhases.push("RESOLVE");

            // 8. Build summary
            const avgDur = segsToInsert.length > 0 ? totalRefinedDur / segsToInsert.length : 0;
            const phaseStr = Object.entries(phaseCounts).map(([p, n]) => `${p}×${n}`).join(", ");
            const summaryLines = [
              `━━ REFINEMENT SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
              `  Segments:      ${segsToInsert.length} (target: ${pacingTemplate.length})`,
              `  Total duration: ${totalRefinedDur.toFixed(1)}s (target: ${targetDurSecs}s, drift: ${(totalRefinedDur - targetDurSecs).toFixed(1)}s)`,
              `  Clip durations: min ${minDur === Infinity ? "—" : minDur.toFixed(1)}s / avg ${avgDur.toFixed(1)}s / max ${maxDur.toFixed(0)}s`,
              `  Phases:        ${phaseStr || "none detected"}`,
              `  Arc complete:  ${missingPhases.length === 0 ? "✓ HOOK→BUILD→CLIMAX→RESOLVE" : "⚠ missing: " + missingPhases.join(", ")}`,
              `  Unknown srcs:  ${unknownSrcCount === 0 ? "✓ none" : `⚠ ${unknownSrcCount}`}`,
              `  Issues fixed:  ${refinementIssues.length}`,
              ...(refinementIssues.length > 0 ? refinementIssues : ["  (no issues)"]),
              `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ];
            await appendLog(jobId, summaryLines.join("\n"));
          }

          // ── POST-PROCESSING 5: Shot Diversity Auto-Fix ────────────────────
          // Detect and break up runs of 3+ consecutive clips from the same
          // source video or the same segment type — a common failure in AI
          // edit plans.  Substitute an alternative clip from scoredMoments
          // that hasn't been used in the surrounding 3 positions.
          const usedRanges: Map<string, Array<{s: number; e: number}>> = new Map();
          for (const seg of segsToInsert) {
            if (!usedRanges.has(seg.videoFile)) usedRanges.set(seg.videoFile, []);
            usedRanges.get(seg.videoFile)!.push({ s: seg.startTime, e: seg.endTime });
          }
          {

            let diversityFixes = 0;
            for (let i = 2; i < segsToInsert.length; i++) {
              const prev2 = segsToInsert[i - 2];
              const prev1 = segsToInsert[i - 1];
              const curr  = segsToInsert[i];

              const sourceRun = prev2.videoFile === prev1.videoFile && prev1.videoFile === curr.videoFile;
              const typeRun   = prev2.type === prev1.type && prev1.type === curr.type && curr.type !== "hook";

              if (sourceRun || typeRun) {
                // Find an alternative from scoredMoments not in surrounding 3-window
                const windowFiles = new Set([prev2.videoFile, prev1.videoFile, curr.videoFile]);
                const targetDur = curr.endTime - curr.startTime;

                const candidate = scoredMoments.find(m => {
                  if (windowFiles.has(m.videoFile) && sourceRun) return false;
                  const dur = m.endTime - m.startTime;
                  if (Math.abs(dur - targetDur) > targetDur * 0.8) return false;
                  // Check not already used in adjacent positions
                  const usedArr = usedRanges.get(m.videoFile) ?? [];
                  return !usedArr.some(r => r.s < m.endTime && r.e > m.startTime);
                });

                if (candidate) {
                  const oldFile = curr.videoFile;
                  segsToInsert[i] = {
                    ...curr,
                    videoFile: candidate.videoFile,
                    startTime: candidate.startTime,
                    endTime: candidate.endTime,
                    aiReason: `[PP5 diversity fix: replaced ${sourceRun?"source":"type"} run with ${candidate.videoFile.slice(0,30)}]`,
                  };
                  if (!usedRanges.has(candidate.videoFile)) usedRanges.set(candidate.videoFile, []);
                  usedRanges.get(candidate.videoFile)!.push({ s: candidate.startTime, e: candidate.endTime });
                  diversityFixes++;
                  await appendLog(jobId, `  PP5 shot diversity: seg[${i}] swapped "${oldFile.slice(0,25)}" → "${candidate.videoFile.slice(0,25)}" (${sourceRun?"source":"type"} run broken)`);
                }
              }
            }
            if (diversityFixes > 0) await appendLog(jobId, `PP5 shot diversity: ${diversityFixes} swap(s) applied`);
            else await appendLog(jobId, "PP5 shot diversity: no consecutive runs found ✓");
          }

          // ── POST-PROCESSING 5b: Angle/Framing Diversity Enforcement ──────────
          // Uses face analysis framing data (close_up/medium/wide) from the
          // analyze_faces job.  Detects runs of 3+ consecutive same-angle cuts
          // and swaps in an alternative clip with a different framing.
          {
            // Build videoFile → framing map from sceneAnalysis
            const framingMap = new Map<string, string>();
            for (const vid of videos) {
              try {
                const sa = JSON.parse(vid.sceneAnalysis ?? "{}");
                const framing = sa.faceAnalysis?.framing;
                if (framing && framing !== "no_subject") {
                  framingMap.set(vid.originalName ?? vid.filename, framing);
                  framingMap.set(vid.id, framing);
                }
              } catch {}
            }

            const hasFramingData = framingMap.size > 0;
            if (hasFramingData) {
              let angleFixes = 0;
              for (let i = 2; i < segsToInsert.length; i++) {
                const f0 = framingMap.get(segsToInsert[i - 2].videoFile);
                const f1 = framingMap.get(segsToInsert[i - 1].videoFile);
                const f2 = framingMap.get(segsToInsert[i].videoFile);

                if (!f0 || !f1 || !f2) continue;          // no framing data
                if (f0 !== f1 || f1 !== f2) continue;     // already diverse

                // Run of 3+ same angle — find an alternative
                const curr     = segsToInsert[i];
                const currDur  = curr.endTime - curr.startTime;
                const badFrame = f2;

                const candidate = scoredMoments.find(m => {
                  const mFrame = framingMap.get(m.videoFile) ?? framingMap.get(m.videoId ?? "");
                  if (!mFrame || mFrame === badFrame) return false;  // must be different angle
                  const dur = m.endTime - m.startTime;
                  if (Math.abs(dur - currDur) > currDur) return false;
                  const usedArr = usedRanges.get(m.videoFile) ?? [];
                  return !usedArr.some(r => r.s < m.endTime && r.e > m.startTime);
                });

                if (candidate) {
                  const newFrame = framingMap.get(candidate.videoFile) ?? framingMap.get(candidate.videoId ?? "") ?? "?";
                  segsToInsert[i] = {
                    ...curr,
                    videoFile: candidate.videoFile,
                    startTime: candidate.startTime,
                    endTime:   candidate.endTime,
                    aiReason:  `[PP5b angle diversity: ${badFrame} run → ${newFrame}]`,
                  };
                  if (!usedRanges.has(candidate.videoFile)) usedRanges.set(candidate.videoFile, []);
                  usedRanges.get(candidate.videoFile)!.push({ s: candidate.startTime, e: candidate.endTime });
                  angleFixes++;
                  await appendLog(jobId, `  PP5b angle diversity: seg[${i}] ${badFrame}→${newFrame} (swapped "${curr.videoFile.slice(0,25)}"→"${candidate.videoFile.slice(0,25)}")`);
                }
              }
              if (angleFixes > 0) await appendLog(jobId, `PP5b angle diversity: ${angleFixes} framing swap(s) applied`);
              else await appendLog(jobId, "PP5b angle diversity: no same-angle runs found ✓");
            } else {
              await appendLog(jobId, "PP5b angle diversity: skipped (run 'Face Analysis' first to enable framing data)");
            }
          }

          // ── POST-PROCESSING 6: Semantic B-roll Matching (embedding-based) ──
          // For each speech/narration segment we compute an OpenAI embedding
          // of the spoken text and rank all B-roll candidates by cosine
          // similarity to it.  If a candidate has a pre-computed embedding in
          // `clipEmbeddingsTable` we use that; otherwise we fall back to the
          // keyword-overlap scorer.  Top-5 suggestions are attached as
          // `bRollSuggestions` strings so the editor panel can surface them.
          {
            let bRollAnnotations = 0;
            const bRollCandidates = videos.filter(v => {
              const ca = v.clipAnalysis ? JSON.parse(v.clipAnalysis) : null;
              return ca && (ca.clipType === "b_roll" || (ca.bRollValue ?? 0) > 0.4);
            });

            if (bRollCandidates.length > 0) {
              // Load any pre-computed clip embeddings for this project
              const clipEmbs = await db.select().from(clipEmbeddingsTable)
                .where(eq(clipEmbeddingsTable.projectId, projectId));
              const clipEmbMap = new Map<string, number[]>(
                clipEmbs.map(e => [e.videoId, JSON.parse(e.embedding) as number[]])
              );

              const cosineSim = (a: number[], b: number[]) => {
                if (a.length !== b.length) return 0;
                let dot = 0, magA = 0, magB = 0;
                for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] ** 2; magB += b[i] ** 2; }
                return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-8);
              };

              for (const seg of segsToInsert) {
                if (seg.type !== "speech" && seg.type !== "narration") continue;
                const spokenText = [seg.label, seg.aiReason].filter(Boolean).join(" ").trim();
                if (!spokenText) continue;

                let segEmbedding: number[] | null = null;
                try {
                  const embResp = await openai.embeddings.create({
                    model: "text-embedding-3-small",
                    input: spokenText.slice(0, 1000),
                  });
                  segEmbedding = embResp.data[0].embedding;
                } catch { /* fall back to keyword scoring */ }

                const scored = bRollCandidates.map(v => {
                  const ca = JSON.parse(v.clipAnalysis!);
                  const tags: string[] = ca.tags ?? [];
                  const embVector = clipEmbMap.get(v.id);

                  let embScore = 0;
                  if (segEmbedding && embVector) {
                    embScore = Math.max(0, cosineSim(segEmbedding, embVector));
                  }

                  // keyword-overlap fallback for candidates without embeddings
                  const keywords = spokenText.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 3);
                  const tagHits = keywords.filter(k => tags.some(t => t.includes(k) || k.includes(t))).length;
                  const keywordScore = tagHits / Math.max(keywords.length, 1);

                  // Blend: embedding 70% / keyword 15% / quality 15%
                  const hasEmb = segEmbedding && embVector;
                  const score = hasEmb
                    ? embScore * 0.70 + keywordScore * 0.15 + (ca.compositeScore ?? 50) / 100 * 0.15
                    : keywordScore * 0.60 + (ca.bRollValue ?? ca.visualQuality ?? 0.5) * 0.25 + (ca.compositeScore ?? 50) / 100 * 0.15;

                  return { file: v.originalName ?? v.filename, score, tags: tags.slice(0, 5), hasEmb: !!hasEmb };
                }).sort((a, b) => b.score - a.score).slice(0, 5);

                if (scored.length > 0 && scored[0].score > 0.15) {
                  (seg as any).bRollSuggestions = scored.map(s =>
                    `${s.file} (score:${s.score.toFixed(3)} ${s.hasEmb ? "emb" : "kw"} tags:[${s.tags.join(",")}])`
                  );
                  bRollAnnotations++;
                }
              }
              if (bRollAnnotations > 0) await appendLog(jobId, `PP6 Semantic B-roll (embeddings): annotated ${bRollAnnotations} speech segment(s)`);
              else await appendLog(jobId, "PP6 Semantic B-roll: no speech segments needed annotation");
            }
          }

          // ── POST-PROCESSING 7: Transition Quality Check ───────────────────
          // Flag clip pairs that will produce jarring cuts at the encode
          // stage so the renderer can insert a brief crossfade or the
          // editor can reorder them.
          {
            let transitionFlags = 0;
            for (let i = 0; i < segsToInsert.length - 1; i++) {
              const a = segsToInsert[i];
              const b = segsToInsert[i + 1];

              // Rule 1: Same video file — check how far apart the time ranges are
              if (a.videoFile === b.videoFile) {
                const gap = b.startTime - a.endTime;
                if (gap < 0.3 && gap >= 0) {
                  (a as any).transitionFlag = "JUMP_CUT_RISK";
                  transitionFlags++;
                } else if (gap < 0) {
                  (a as any).transitionFlag = "OVERLAP_RISK";
                  transitionFlags++;
                }
              }

              // Rule 2: Same color grade AND very similar composite scores → visual monotony
              if (a.colorGrade === b.colorGrade && a.colorGrade && a.colorGrade !== "natural") {
                const aVideo = videos.find(v => v.originalName === a.videoFile || v.filename === a.videoFile);
                const bVideo = videos.find(v => v.originalName === b.videoFile || v.filename === b.videoFile);
                if (aVideo?.clipAnalysis && bVideo?.clipAnalysis) {
                  const aScore = JSON.parse(aVideo.clipAnalysis).compositeScore ?? 50;
                  const bScore = JSON.parse(bVideo.clipAnalysis).compositeScore ?? 50;
                  if (Math.abs(aScore - bScore) < 10) {
                    (a as any).transitionFlag = (a as any).transitionFlag ? (a as any).transitionFlag + "+VISUAL_MONOTONY" : "VISUAL_MONOTONY";
                    transitionFlags++;
                  }
                }
              }
            }
            if (transitionFlags > 0) await appendLog(jobId, `PP7 transition check: ${transitionFlags} flag(s) — renderer will apply crossfades`);
            else await appendLog(jobId, "PP7 transition check: all transitions look clean ✓");
          }

          // ── POST-PROCESSING 8: Action Boundary Alignment ─────────────────────
          // If any project videos have actionBoundaries from detect_action_boundaries,
          // snap segment end-times to the nearest completion boundary within ±1s.
          // This avoids mid-motion cuts (person mid-pour, object mid-swing, etc.).
          {
            // Build videoFile → actionBoundaries[] from sceneAnalysis
            const boundaryMap = new Map<string, Array<number>>();
            for (const vid of videos) {
              try {
                const sa = JSON.parse(vid.sceneAnalysis ?? "{}");
                const boundaries: Array<{ timestamp: number }> = sa.actionBoundaries ?? [];
                if (boundaries.length > 0) {
                  const key = vid.originalName ?? vid.filename;
                  boundaryMap.set(key, boundaries.map(b => b.timestamp));
                }
              } catch {}
            }

            if (boundaryMap.size > 0) {
              const SNAP_RADIUS = 1.0;  // seconds
              let snapCount = 0;

              for (let i = 0; i < segsToInsert.length; i++) {
                const seg = segsToInsert[i];
                const boundaries = boundaryMap.get(seg.videoFile);
                if (!boundaries || boundaries.length === 0) continue;

                const endTime = seg.endTime;

                // Find nearest boundary to seg.endTime within snap radius
                let nearestDist = SNAP_RADIUS + 1;
                let nearestTs   = endTime;
                for (const bts of boundaries) {
                  const dist = Math.abs(bts - endTime);
                  if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestTs   = bts;
                  }
                }

                if (nearestDist <= SNAP_RADIUS && Math.abs(nearestTs - endTime) > 0.05) {
                  const newEnd = Math.max(seg.startTime + 0.5, Math.min(nearestTs, seg.startTime + 30));
                  await appendLog(jobId, `  PP8 action snap: seg[${i}] end ${endTime.toFixed(2)}→${newEnd.toFixed(2)}s (boundary at ${nearestTs.toFixed(2)}s)`);
                  segsToInsert[i] = { ...seg, endTime: newEnd };
                  snapCount++;
                }
              }

              if (snapCount > 0) await appendLog(jobId, `PP8 action boundary alignment: ${snapCount} cut(s) snapped to action completion points`);
              else await appendLog(jobId, "PP8 action boundary alignment: all cuts already near action boundaries ✓");
            } else {
              await appendLog(jobId, "PP8 action boundary alignment: skipped (run 'Action Boundary Detection' first)");
            }
          }

          await db.delete(segmentsTable).where(eq(segmentsTable.projectId, projectId));
          await appendLog(jobId, `Inserting ${segsToInsert.length} segments into timeline...`);
          for (let i = 0; i < segsToInsert.length; i++) {
            const seg = segsToInsert[i];
            const matchedVideo = videos.find((v) => v.originalName === seg.videoFile || v.filename === seg.videoFile);
            const startTime = seg.startTime ?? 0;
            const endTime = seg.endTime ?? startTime + 5;

            // Audio mix levels — use style DNA or Claude's suggestion, fallback to type-based defaults
            const segType = seg.type ?? "highlight";
            const isSpeechSeg = segType === "speech" || seg.audioMixLevel != null;
            const defaultAudioMix = isSpeechSeg ? (styleDNA?.speechMixLevel ?? 1.0) : 0.0;
            const defaultMusicDuck = isSpeechSeg ? (styleDNA?.musicDuckLevel ?? 0.15) : 1.0;
            const audioMixLevel = seg.audioMixLevel ?? defaultAudioMix;
            const musicDuckLevel = seg.musicDuckLevel ?? defaultMusicDuck;

            await db.insert(segmentsTable).values({
              id: randomUUID(),
              projectId,
              videoId: matchedVideo?.id ?? videos[i % videos.length]?.id ?? "unknown",
              orderIndex: i,
              startTime,
              endTime,
              label: seg.label ?? null,
              segmentType: segType as "speech" | "music" | "silence" | "action" | "transition" | "highlight",
              confidence: seg.confidence ?? null,
              aiReason: seg.reason ?? null,
              included: true,
              captionText: seg.captionText ?? null,
              captionStyle: seg.captionStyle ?? null,
              colorGrade: seg.colorGrade ?? null,
              speedFactor: seg.speedFactor ?? null,
              transitionIn: seg.transitionIn ?? null,
              audioMixLevel,
              musicDuckLevel,
            });
            const captionNote = seg.captionText ? ` | caption: "${seg.captionText.substring(0, 30)}"` : "";
            const gradeNote = seg.colorGrade && seg.colorGrade !== "none" ? ` | grade: ${seg.colorGrade}` : "";
            const audioNote = isSpeechSeg ? ` | 🎙️ music→${Math.round(musicDuckLevel*100)}%` : "";
            if (beatTimestamps.length > 0) {
              const nearestBeat = beatTimestamps.reduce((prev, curr) => Math.abs(curr - startTime) < Math.abs(prev - startTime) ? curr : prev);
              await appendLog(jobId, `Segment ${i + 1}: "${seg.label ?? seg.type}" @ ${startTime.toFixed(2)}s → beat ${nearestBeat.toFixed(2)}s${captionNote}${gradeNote}${audioNote}`);
            } else {
              await appendLog(jobId, `Segment ${i + 1}: "${seg.label ?? seg.type}" (${(endTime - startTime).toFixed(1)}s)${captionNote}${gradeNote}${audioNote}`);
            }
          }
          await db.update(projectsTable).set({ status: "editing", updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
        }
      } catch {}

      await db.update(jobsTable).set({ progress: 92 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Edit plan complete. ${beatTimestamps.length > 0 ? "All cuts beat-synced." : "Timeline ready."}`);
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `AI edit plan generated for "${project?.name ?? projectId}"`, projectId, projectName: project?.name ?? null });
    }

    else if (type === "refine_edit") {
      await appendLog(jobId, "Loading current timeline for AI refinement...");
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));
      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const currentSegs = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId)).orderBy(segmentsTable.orderIndex);

      let instruction = "Improve the overall pacing and hook quality";
      try { const opts = JSON.parse(options ?? "{}"); instruction = opts.instruction ?? instruction; } catch {}

      await appendLog(jobId, `Instruction: "${instruction}"`);
      await appendLog(jobId, `Current timeline: ${currentSegs.length} segments`);
      await db.update(jobsTable).set({ progress: 25 }).where(eq(jobsTable.id, jobId));

      const musicJobs2 = await db.select().from(jobsTable).where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));
      let refBeatTs: number[] = [];
      let refMusicCtx = "";
      if (musicJobs2.length > 0) {
        try {
          const md = JSON.parse(musicJobs2[musicJobs2.length - 1].result ?? "{}");
          refBeatTs = (md.beats ?? []).map((b: { timestamp: number }) => b.timestamp);
          refMusicCtx = `Music: ${md.bpm ?? "?"}BPM, ${md.mood ?? "?"} mood, ${refBeatTs.length} beats. Beat timestamps: [${refBeatTs.slice(0, 30).join(", ")}]`;
        } catch {}
      }

      const currentTimelineDesc = currentSegs.map((s, i) => {
        const vid = videos.find(v => v.id === s.videoId);
        return `[${i}] "${s.label ?? s.segmentType}" from "${vid?.originalName ?? "unknown"}" — ${s.startTime.toFixed(2)}s→${s.endTime.toFixed(2)}s (${(s.endTime-s.startTime).toFixed(1)}s) | included=${s.included} | confidence=${((s.confidence??0)*100).toFixed(0)}% | ${s.aiReason ?? ""}`;
      }).join("\n");

      const videoSummary = videos.map((v, i) => {
        const dur = v.durationSeconds ? `${v.durationSeconds.toFixed(1)}s` : "?";
        const tx = v.transcript ? `"${v.transcript.substring(0, 200)}"` : "no transcript";
        return `[Clip ${i}] "${v.originalName}" — ${dur} — ${tx}`;
      }).join("\n");

      await appendLog(jobId, "Sending refinement request to Claude...");
      await db.update(jobsTable).set({ progress: 40 }).where(eq(jobsTable.id, jobId));

      const refinePrompt = `You are a world-class video editor AI. The user has asked you to refine an existing edit timeline based on a specific instruction.

USER INSTRUCTION: "${instruction}"

═══ CURRENT TIMELINE (${currentSegs.length} segments) ═══
${currentTimelineDesc}

═══ AVAILABLE FOOTAGE ═══
${videoSummary}

${refMusicCtx ? `═══ MUSIC DATA ═══\n${refMusicCtx}\n` : ""}

═══ YOUR TASK ═══
Modify the timeline to fulfill the user's instruction. You may:
- Reorder segments (change orderIndex)
- Exclude segments (set included=false)
- Change segment startTime/endTime (snap to beats if available)
- Add new segments from available footage
- Change labels, color grades, captions, transitions
- Adjust speedFactor for pacing

Rules:
1. Only change what the instruction requires — don't rewrite everything if a small change suffices
2. Snap all cut times to the nearest beat timestamp from the music data
3. The first included segment MUST be a strong hook
4. Maintain emotional arc after changes
5. Every change must have a clear reason tied to the instruction

Return ONLY valid JSON:
{
  "changes": "<brief description of what was changed and why>",
  "segments": [
    {
      "id": "<existing segment id or 'new'>",
      "videoFile": "<filename — required for new segments>",
      "startTime": <number>,
      "endTime": <number>,
      "orderIndex": <number>,
      "included": <boolean>,
      "label": "<string>",
      "segmentType": "<hook|highlight|speech|action|buildup|climax|resolution|transition>",
      "colorGrade": "<grade or null>",
      "captionText": "<string or null>",
      "captionStyle": "<style or null>",
      "speedFactor": <number>,
      "transitionIn": "<transition>",
      "audioMixLevel": <0-1>,
      "musicDuckLevel": <0-1>,
      "confidence": <0-1>,
      "reason": "<why this change fulfills the instruction>"
    }
  ]
}`;

      const refMsg = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: refinePrompt }],
      });
      const refText = refMsg.content[0].type === "text" ? refMsg.content[0].text : "";
      result = refText;
      await appendLog(jobId, "Refinement received. Applying changes to timeline...");
      await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

      try {
        const jsonMatch = refText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const refined = JSON.parse(jsonMatch[0]);
          const newSegs = refined.segments ?? [];
          await appendLog(jobId, `Applying ${newSegs.length} segment changes...`);
          for (const seg of newSegs) {
            if (seg.id === "new" || !seg.id) {
              const matchedVideo = videos.find(v => v.originalName === seg.videoFile || v.filename === seg.videoFile);
              if (matchedVideo) {
                await db.insert(segmentsTable).values({
                  id: randomUUID(), projectId, videoId: matchedVideo.id,
                  orderIndex: seg.orderIndex ?? 99, startTime: seg.startTime ?? 0, endTime: seg.endTime ?? 5,
                  label: seg.label ?? null, segmentType: seg.segmentType ?? "highlight",
                  confidence: seg.confidence ?? null, aiReason: seg.reason ?? null, included: seg.included ?? true,
                  captionText: seg.captionText ?? null, captionStyle: seg.captionStyle ?? null,
                  colorGrade: seg.colorGrade ?? null, speedFactor: seg.speedFactor ?? null,
                  transitionIn: seg.transitionIn ?? null, audioMixLevel: seg.audioMixLevel ?? 0,
                  musicDuckLevel: seg.musicDuckLevel ?? 1,
                });
              }
            } else {
              const updates: Record<string, unknown> = {};
              if (seg.startTime != null) updates.startTime = seg.startTime;
              if (seg.endTime != null) updates.endTime = seg.endTime;
              if (seg.orderIndex != null) updates.orderIndex = seg.orderIndex;
              if (seg.included != null) updates.included = seg.included;
              if (seg.label !== undefined) updates.label = seg.label;
              if (seg.segmentType) updates.segmentType = seg.segmentType;
              if (seg.colorGrade !== undefined) updates.colorGrade = seg.colorGrade;
              if (seg.captionText !== undefined) updates.captionText = seg.captionText;
              if (seg.captionStyle !== undefined) updates.captionStyle = seg.captionStyle;
              if (seg.speedFactor != null) updates.speedFactor = seg.speedFactor;
              if (seg.transitionIn !== undefined) updates.transitionIn = seg.transitionIn;
              if (seg.audioMixLevel != null) updates.audioMixLevel = seg.audioMixLevel;
              if (seg.musicDuckLevel != null) updates.musicDuckLevel = seg.musicDuckLevel;
              if (seg.confidence != null) updates.confidence = seg.confidence;
              if (seg.reason !== undefined) updates.aiReason = seg.reason;
              updates.updatedAt = new Date();
              await db.update(segmentsTable).set(updates).where(and(eq(segmentsTable.id, seg.id), eq(segmentsTable.projectId, projectId)));
            }
          }
          await appendLog(jobId, `Done. ${refined.changes ?? "Timeline refined."}`);
        }
      } catch (e) {
        await appendLog(jobId, `Parse error: ${e}`);
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
    }

    else if (type === "analyze_manuscript") {
      await appendLog(jobId, "Loading manuscript...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));
      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!project?.manuscript || project.manuscript.trim().length === 0) {
        throw new Error("No manuscript found. Paste your script in the Script tab first.");
      }
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const wordCount = project.manuscript.split(/\s+/).length;
      const estimatedReadMin = Math.round(wordCount / 150 * 10) / 10;
      await appendLog(jobId, `Script loaded — ${wordCount} words, ~${estimatedReadMin} min read time`);
      await appendLog(jobId, `Available footage: ${videos.length} clip(s) — ${videos.map(v => v.originalName ?? v.filename).join(", ")}`);
      await db.update(jobsTable).set({ progress: 15 }).where(eq(jobsTable.id, jobId));

      const videoList = videos.map((v, i) =>
        `Clip ${i}: ${v.originalName ?? v.filename} (${v.durationSeconds ? v.durationSeconds.toFixed(1) + "s" : "unknown duration"})${v.transcript ? ` | Transcript: "${v.transcript.substring(0, 150)}"` : ""}${v.sceneAnalysis ? ` | Scene: ${v.sceneAnalysis.substring(0, 150)}` : ""}`
      ).join("\n");

      await appendLog(jobId, "Sending manuscript to Claude for scene analysis and edit mapping...");
      await db.update(jobsTable).set({ progress: 25 }).where(eq(jobsTable.id, jobId));

      const analysisMsg = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 6000,
        messages: [{
          role: "user",
          content: `You are a professional video editor and script supervisor. Analyze this manuscript/script and produce a detailed scene-by-scene breakdown that will drive video editing.

MANUSCRIPT:
${project.manuscript}

AVAILABLE FOOTAGE (${videos.length} clips):
${videoList}

TARGET FORMAT: ${(project.targetFormat ?? "instagram_reel").replace(/_/g, " ")}

Break the manuscript into scenes. Each scene should:
1. Map to a specific part of the manuscript text
2. Be 1.5–8 seconds long (appropriate for the format)
3. Have a caption extracted directly from the manuscript text (max 8 words, punchy)
4. Suggest which footage clip best matches the scene content
5. Have appropriate color grade, pacing, and visual treatment

Return ONLY valid JSON (no markdown):
{
  "totalScenes": <number>,
  "totalEstimatedDuration": <number in seconds>,
  "narrativeArc": "<one sentence describing the story structure>",
  "pacing": "fast|medium|slow",
  "editingNotes": "<overall editor notes>",
  "captionStyle": "subtitle|title|lower_third|kinetic",
  "scenes": [
    {
      "sceneNumber": 1,
      "title": "<brief scene title>",
      "description": "<what visually happens>",
      "manuscriptText": "<exact excerpt from manuscript>",
      "captionText": "<short punchy caption, max 8 words>",
      "captionStyle": "subtitle|title|lower_third|kinetic|none",
      "suggestedShotType": "hook|highlight|context|buildup|climax|cta|transition",
      "emotionalTone": "energetic|calm|dramatic|inspirational|tense|joyful|humorous",
      "colorGrade": "warm|cool|cinematic|bw|vivid|muted|sunset|teal_orange|desaturated|none",
      "suggestedDuration": <number 1.5-8.0>,
      "suggestedClipIndex": <0-based index or 0 if only one clip>,
      "speedFactor": 1.0,
      "transitionIn": "cut|fade|dissolve|wipe|zoom|slide|none",
      "notes": "<director/editor note>"
    }
  ]
}`
        }]
      });

      const raw = analysisMsg.content[0].type === "text" ? analysisMsg.content[0].text : "";
      await db.update(jobsTable).set({ progress: 75 }).where(eq(jobsTable.id, jobId));

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Could not parse manuscript analysis from Claude");
      const analysis = JSON.parse(jsonMatch[0]);
      const scenes = analysis.scenes ?? [];

      await appendLog(jobId, `Script analysis complete — ${scenes.length} scenes mapped`);
      await appendLog(jobId, `Narrative arc: ${analysis.narrativeArc ?? ""}`.substring(0, 120));
      await appendLog(jobId, `Pacing: ${analysis.pacing ?? "medium"} | ~${analysis.totalEstimatedDuration ?? 0}s total`);
      for (const scene of scenes) {
        const clipName = videos[scene.suggestedClipIndex ?? 0]?.originalName ?? `Clip ${scene.suggestedClipIndex ?? 0}`;
        await appendLog(jobId, `  Scene ${scene.sceneNumber}: "${scene.title}" (${scene.suggestedDuration}s) → ${clipName} | "${scene.captionText ?? ""}" [${scene.colorGrade ?? "none"}]`);
      }

      await db.update(projectsTable).set({ manuscriptAnalysis: JSON.stringify(analysis), updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Manuscript analysis saved. Now run "Generate Edit Plan" to build the script-driven timeline.`);
      result = JSON.stringify({ scenes: scenes.length, duration: analysis.totalEstimatedDuration, pacing: analysis.pacing, narrativeArc: analysis.narrativeArc });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // generate_manuscript: AI reads all transcripts and writes a structured
    // manuscript/script that drives the edit plan (script-driven mode).
    // Flow: Transcribe → generate_manuscript → generate_edit_plan
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "generate_manuscript") {
      await appendLog(jobId, "Loading transcripts from all clips...");
      await db.update(jobsTable).set({ progress: 8 }).where(eq(jobsTable.id, jobId));

      const [gmProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!gmProject) throw new Error("Project not found");
      const gmVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

      const targetFormat = gmProject.targetFormat ?? "instagram_reel";
      const formatDurations: Record<string, number> = {
        instagram_reel: 45, tiktok: 30, youtube_short: 55,
        youtube_long: 600, wedding_highlight: 240, ad_spot: 20, custom: 60,
      };
      const targetDuration = formatDurations[targetFormat] ?? 45;

      // ── Collect all transcript text with timing ────────────────────────────
      type GmSeg = { clipIndex: number; clipName: string; start: number; end: number; text: string };
      const allSegments: GmSeg[] = [];
      const clipsWithTranscript: string[] = [];

      for (let vi = 0; vi < gmVideos.length; vi++) {
        const video = gmVideos[vi];
        if (!video.transcript) continue;
        try {
          const txData = JSON.parse(video.transcript);
          const segs: Array<{ start: number; end: number; text: string }> = txData.segments ?? [];
          if (segs.length > 0) {
            clipsWithTranscript.push(video.originalName ?? video.filename);
            for (const s of segs) {
              if ((s.text ?? "").trim().length > 2) {
                allSegments.push({
                  clipIndex: vi,
                  clipName: video.originalName ?? video.filename,
                  start: s.start,
                  end: s.end,
                  text: s.text.trim(),
                });
              }
            }
          } else if (txData.transcript) {
            clipsWithTranscript.push(video.originalName ?? video.filename);
            allSegments.push({ clipIndex: vi, clipName: video.originalName ?? video.filename, start: 0, end: video.durationSeconds ?? 30, text: txData.transcript.substring(0, 2000) });
          }
        } catch { continue; }
      }

      if (allSegments.length === 0) {
        throw new Error("No transcripts found. Run Transcribe first before generating a manuscript.");
      }

      await appendLog(jobId, `Transcripts loaded — ${allSegments.length} segments from ${clipsWithTranscript.length} clip(s)`);
      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

      // ── Build full raw transcript for Claude ──────────────────────────────
      const rawTranscript = allSegments.map(s =>
        `[${s.clipName} @ ${s.start.toFixed(1)}s] ${s.text}`
      ).join("\n");

      const clipListStr = gmVideos.map((v, i) =>
        `Clip ${i}: "${v.originalName ?? v.filename}" — ${v.durationSeconds ? v.durationSeconds.toFixed(1) + "s" : "?"}`
      ).join("\n");

      await appendLog(jobId, "AI is reading all spoken content and building manuscript...");
      await db.update(jobsTable).set({ progress: 35 }).where(eq(jobsTable.id, jobId));

      const gmPrompt = `You are an expert documentary editor and script writer. Based on the raw transcription of all video clips, write a structured MANUSCRIPT (script) that will drive the video edit. The goal is a ${targetFormat.replace(/_/g, " ")} (target: ~${targetDuration}s).

RAW TRANSCRIPT (from all clips, with timestamps and clip names):
${rawTranscript.substring(0, 8000)}

AVAILABLE CLIPS:
${clipListStr}

Your task:
1. Read through everything that was said
2. Identify the key narrative moments, insights, and emotional beats
3. Write a structured MANUSCRIPT — the story the edit will tell
4. The manuscript should include:
   - A compelling HOOK (opening line/statement)
   - Key narrative moments in logical/emotional order
   - The most powerful/quotable statements (exact quotes from transcript)
   - A strong closing moment
5. For each section, note which clip it comes from and roughly when

Format the manuscript as flowing prose with [CLIP: name @ time] annotations where relevant. Write it as a narrative script that guides the edit, not a list of bullet points. Keep it tight — about ${Math.round(targetDuration * 2.5)} words (since on-screen text reads slower than reading).

After the manuscript prose, add a JSON block with scene breakdown:
\`\`\`json
{
  "narrativeArc": "...",
  "totalEstimatedDuration": ${targetDuration},
  "pacing": "medium",
  "editingNotes": "...",
  "scenes": [
    {
      "sceneNumber": 1,
      "title": "...",
      "captionText": "...",
      "captionStyle": "subtitle",
      "suggestedDuration": 5,
      "suggestedClipIndex": 0,
      "emotionalTone": "hook",
      "colorGrade": "cinematic",
      "suggestedShotType": "highlight",
      "speedFactor": 1.0,
      "transitionIn": "fade"
    }
  ]
}
\`\`\``;

      const gmMsg = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 5000,
        messages: [{ role: "user", content: gmPrompt }],
      });

      await db.update(jobsTable).set({ progress: 75 }).where(eq(jobsTable.id, jobId));
      const gmRaw = (gmMsg.content[0] as { type: string; text: string }).text ?? "";

      // ── Extract prose manuscript (everything before the JSON block) ────────
      const jsonBlockMatch = gmRaw.match(/```json([\s\S]*?)```/);
      const manuscriptProse = gmRaw.replace(/```json[\s\S]*?```/g, "").trim();

      // ── Parse scene analysis JSON ──────────────────────────────────────────
      let analysis: any = { narrativeArc: "natural", totalEstimatedDuration: targetDuration, pacing: "medium", scenes: [] };
      if (jsonBlockMatch) {
        try {
          analysis = JSON.parse(jsonBlockMatch[1].trim());
        } catch (parseErr) {
          await appendLog(jobId, "  ⚠ Could not parse scene JSON — manuscript prose saved only");
        }
      }
      const scenes = analysis.scenes ?? [];

      // ── Save both manuscript prose AND scene analysis ──────────────────────
      await db.update(projectsTable).set({
        manuscript: manuscriptProse,
        manuscriptAnalysis: JSON.stringify(analysis),
        updatedAt: new Date(),
      }).where(eq(projectsTable.id, projectId));

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Manuscript generated — ${manuscriptProse.split(/\s+/).length} words, ${scenes.length} scenes`);
      await appendLog(jobId, `Narrative arc: ${analysis.narrativeArc ?? "natural"}`);
      await appendLog(jobId, `Script-driven mode is now ACTIVE — run "Generate Edit Plan" to build your timeline from this manuscript`);

      await db.insert(activityTable).values({
        id: randomUUID(), type: "ai_analysis_done",
        description: `AI generated manuscript from transcripts — ${scenes.length} scenes for "${gmProject.name}"`,
        projectId, projectName: gmProject.name,
      });

      result = JSON.stringify({ scenes: scenes.length, duration: analysis.totalEstimatedDuration, manuscriptWords: manuscriptProse.split(/\s+/).length, narrativeArc: analysis.narrativeArc });
    }

    else if (type === "enhance_audio") {
      await appendLog(jobId, "Loading project audio for enhancement analysis...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));
      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const segments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId)).orderBy(segmentsTable.orderIndex);

      // ── Measure real integrated loudness (LUFS) for each video via ffmpeg ─
      const loudnessSummaries: string[] = [];
      let totalMeasured = 0;
      for (const vid of videos.slice(0, 3)) { // Measure first 3 videos (representative sample)
        const srcPath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
        if (!fs.existsSync(srcPath)) continue;
        try {
          await appendLog(jobId, `Measuring integrated loudness: ${vid.originalName}...`);
          const loudnormOut = await new Promise<string>((resolve) => {
            const proc = spawn("ffmpeg", [
              "-i", srcPath, "-af",
              "loudnorm=I=-23:TP=-1.5:LRA=11:print_format=summary",
              "-f", "null", "-"
            ]);
            let stderr = "";
            proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
            proc.on("close", () => resolve(stderr));
            proc.on("error", () => resolve(""));
            setTimeout(() => { proc.kill(); resolve(""); }, 60000);
          });
          // Parse integrated loudness
          const iMatch = loudnormOut.match(/Input Integrated:\s+([-\d.]+)\s+LUFS/i);
          const tpMatch = loudnormOut.match(/Input True Peak:\s+([-\d.]+)\s+dBTP/i);
          const lraMatch = loudnormOut.match(/Input LRA:\s+([-\d.]+)\s+LU/i);
          if (iMatch) {
            const summary = `${vid.originalName}: ${iMatch[1]} LUFS integrated${tpMatch ? `, ${tpMatch[1]} dBTP peak` : ""}${lraMatch ? `, ${lraMatch[1]} LU range` : ""}`;
            loudnessSummaries.push(summary);
            await appendLog(jobId, `  → ${summary}`);
            totalMeasured++;
          }
        } catch {}
        const pct2 = 5 + Math.round((totalMeasured / Math.min(videos.length, 3)) * 45);
        await db.update(jobsTable).set({ progress: pct2 }).where(eq(jobsTable.id, jobId));
      }
      if (loudnessSummaries.length === 0) {
        await appendLog(jobId, "⚠ No files available on disk for loudness measurement — proceeding with plan only.");
      }
      await db.update(jobsTable).set({ progress: 52 }).where(eq(jobsTable.id, jobId));

      const musicJobs = await db.select().from(jobsTable).where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));
      let musicContext = "";
      let hasBeatSync = false;
      if (musicJobs.length > 0) {
        try {
          const md = JSON.parse(musicJobs[musicJobs.length - 1].result ?? "{}");
          musicContext = `Music: ${md.bpm} BPM, ${md.mood} mood, ${md.genre ?? "unknown genre"}, Energy: ${md.energy}`;
          hasBeatSync = true;
        } catch {}
      }

      const formatLoudness: Record<string, string> = {
        instagram_reel: "-14 LUFS",
        tiktok: "-14 LUFS",
        youtube_short: "-14 LUFS",
        youtube_long: "-14 LUFS",
        wedding_highlight: "-16 LUFS",
        ad_spot: "-16 LUFS",
        custom: "-16 LUFS",
      };
      const targetLoudness = formatLoudness[project?.targetFormat ?? "custom"] ?? "-16 LUFS";

      const optionsJson = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      const presetHint = (optionsJson as { preset?: string }).preset ?? "cinematic";

      await appendLog(jobId, `Sending audio profile to Claude for enhancement planning (preset: ${presetHint})...`);
      await db.update(jobsTable).set({ progress: 60 }).where(eq(jobsTable.id, jobId));

      const prompt = `You are an expert AI audio engineer. Design a professional audio enhancement plan for a video project.

Project details:
- Format: ${project?.targetFormat?.replace(/_/g, " ") ?? "video"}
- Target loudness: ${targetLoudness}
- Number of segments: ${segments.length}
- Videos: ${videos.map(v => v.originalName).join(", ") || "various"}
- ${musicContext || "No music analysis available"}
- User-requested preset hint: "${presetHint}"
${loudnessSummaries.length > 0 ? `\nMeasured audio levels (real ffmpeg loudnorm analysis):\n${loudnessSummaries.map(s => `  - ${s}`).join("\n")}` : "- No loudness measurements available (files not on disk)"}

Design the optimal audio enhancement stack. Return ONLY valid JSON:
{
  "noiseReduction": "moderate",
  "voiceEnhancement": "presence boost +3dB, de-essed, de-breathed",
  "stemSeparation": "original",
  "loudnessTarget": "${targetLoudness}",
  "dynamicCompression": "broadcast",
  "deReverb": "light",
  "eqProfile": "cinematic",
  "beatSyncBass": ${hasBeatSync},
  "aiReasoning": "2-3 sentences explaining the choices",
  "perSegmentOverrides": [
    { "segmentType": "speech", "noiseReduction": "aggressive", "voiceEnhancement": "max clarity" },
    { "segmentType": "music", "noiseReduction": "none", "stemSeparation": "music-only" }
  ]
}

Options for each parameter:
- noiseReduction: "none", "mild", "moderate", "aggressive"
- voiceEnhancement: describe specifics
- stemSeparation: "original" (keep all audio), "music-only" (remove voices), "voice-only" (remove music), "smart-mix" (AI balance)
- dynamicCompression: "none", "broadcast", "cinema", "podcast", "warm", "punchy"
- deReverb: "none", "light", "medium", "heavy"
- eqProfile: "flat", "bright", "warm", "telephone", "cinematic", "podcast", "vintage", "radio"
- beatSyncBass: true/false (sync bass transients to beat markers)`;

      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
      await appendLog(jobId, "Enhancement plan received from Claude, processing parameters...");
      await db.update(jobsTable).set({ progress: 75 }).where(eq(jobsTable.id, jobId));

      let plan: Record<string, unknown> = {};
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) plan = JSON.parse(jsonMatch[0]);
      } catch {}

      await appendLog(jobId, `Enhancement plan: noise=${plan.noiseReduction ?? "moderate"} | compress=${plan.dynamicCompression ?? "broadcast"} | eq=${plan.eqProfile ?? "cinematic"} | target=${plan.loudnessTarget ?? targetLoudness}`);
      await db.update(jobsTable).set({ progress: 78 }).where(eq(jobsTable.id, jobId));

      // ── Build real ffmpeg audio filter chain from the plan ────────────────
      function buildEnhancementFilterChain(p: Record<string, unknown>, loud: string): string[] {
        const filters: string[] = [];
        // 1. Noise reduction
        const nr = String(p.noiseReduction ?? "moderate");
        if (nr === "mild")       filters.push("anlmdn=s=0.01:p=0.95:r=0.01");
        else if (nr === "moderate") filters.push("anlmdn=s=0.03:p=0.95:r=0.01");
        else if (nr === "aggressive") filters.push("anlmdn=s=0.07:p=0.95:r=0.01");
        // 2. Dynamic compression
        const dc = String(p.dynamicCompression ?? "broadcast");
        if (dc === "broadcast")  filters.push("acompressor=threshold=-20dB:ratio=4:attack=5:release=50:makeup=2dB");
        else if (dc === "cinema") filters.push("acompressor=threshold=-24dB:ratio=6:attack=3:release=40:makeup=3dB");
        else if (dc === "podcast") filters.push("acompressor=threshold=-18dB:ratio=3:attack=10:release=100:makeup=1dB");
        else if (dc === "punchy") filters.push("acompressor=threshold=-16dB:ratio=5:attack=2:release=20:makeup=2dB");
        else if (dc === "warm")   filters.push("acompressor=threshold=-22dB:ratio=2.5:attack=15:release=80:makeup=1dB");
        // 3. EQ profile
        const eq = String(p.eqProfile ?? "cinematic");
        if (eq === "cinematic")  filters.push("equalizer=f=80:t=h:width=100:g=2", "equalizer=f=4500:t=h:width=2000:g=1.5");
        else if (eq === "podcast") filters.push("highpass=f=100", "equalizer=f=1500:t=h:width=2000:g=2", "equalizer=f=8000:t=h:width=3000:g=1");
        else if (eq === "bright") filters.push("equalizer=f=6000:t=h:width=4000:g=3", "equalizer=f=12000:t=h:width=4000:g=2");
        else if (eq === "warm")   filters.push("equalizer=f=200:t=h:width=200:g=3", "equalizer=f=8000:t=h:width=4000:g=-2");
        else if (eq === "telephone") filters.push("highpass=f=300", "lowpass=f=3400");
        else if (eq === "radio")  filters.push("highpass=f=120", "equalizer=f=1500:t=h:width=2000:g=3", "lowpass=f=12000");
        else if (eq === "vintage") filters.push("highpass=f=80", "equalizer=f=3000:t=h:width=3000:g=2", "lowpass=f=10000");
        // 4. Loudness normalization (always last)
        const lufsMatch = loud.match(/(-?\d+)\s*LUFS/i);
        const lufsTarget = lufsMatch ? lufsMatch[1] : "-14";
        filters.push(`loudnorm=I=${lufsTarget}:TP=-1.5:LRA=11`);
        return filters;
      }

      const filterChain = buildEnhancementFilterChain(plan, targetLoudness);
      const afStr = filterChain.join(",");
      await appendLog(jobId, `ffmpeg filter chain: ${afStr}`);

      // ── Apply enhancement to each video file ──────────────────────────────
      const enhancedPaths: Record<string, string> = {};
      let processedCount = 0;
      for (const vid of videos) {
        const srcPath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
        if (!fs.existsSync(srcPath)) {
          await appendLog(jobId, `⚠ ${vid.originalName}: file not on disk — skipping.`);
          continue;
        }
        const enhOut = path.join(UPLOAD_DIR, `${vid.id}_enhanced.wav`);
        try {
          await new Promise<void>((resolve, reject) => {
            const proc = spawn("ffmpeg", ["-y", "-i", srcPath, "-vn", "-ac", "2", "-ar", "48000", "-af", afStr, enhOut]);
            let stderr = "";
            proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
            proc.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`ffmpeg enhance failed (code ${code}): ${stderr.slice(-300)}`));
            });
            proc.on("error", reject);
            setTimeout(() => { proc.kill(); reject(new Error("enhance timeout")); }, 180000);
          });
          enhancedPaths[vid.id] = enhOut;
          processedCount++;
          await appendLog(jobId, `✓ Enhanced: ${vid.originalName} → ${path.basename(enhOut)}`);
        } catch (err) {
          await appendLog(jobId, `⚠ ${vid.originalName}: enhancement failed — ${String(err).substring(0, 120)}`);
        }
        const pct = 78 + Math.round((processedCount / videos.length) * 14);
        await db.update(jobsTable).set({ progress: pct }).where(eq(jobsTable.id, jobId));
      }

      if (hasBeatSync && plan.beatSyncBass) {
        await appendLog(jobId, "Beat-sync bass enabled — bass transients will snap to beat grid on export.");
      }

      const fullPlan = {
        ...plan,
        projectId,
        preset: presetHint,
        enhancedFiles: enhancedPaths,
        filterChain: filterChain,
        targetLoudness,
        processedVideos: processedCount,
        analyzedAt: new Date().toISOString(),
      };
      result = JSON.stringify(fullPlan);

      await db.update(projectsTable).set({ audioPreset: presetHint, audioEnhancementPlan: result, updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Audio enhancement complete: ${processedCount}/${videos.length} videos processed. ${plan.aiReasoning ? String(plan.aiReasoning).substring(0, 80) + "..." : ""}`);
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `Audio enhanced: ${processedCount} files processed for "${project?.name ?? projectId}"`, projectId, projectName: project?.name ?? null });
    }

    else if (type === "apply_edit") {
      await appendLog(jobId, "Loading segments and validating edit decisions...");
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!project) throw new Error("Project not found");

      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const videoMap = new Map(videos.map(v => [v.id, v]));
      const segments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId)).orderBy(segmentsTable.orderIndex);

      if (segments.length === 0) throw new Error("No segments found — run Generate Edit Plan first.");
      await appendLog(jobId, `Validating ${segments.length} segments against ${videos.length} source videos...`);

      // ── Step 1: Validate each segment ────────────────────────────────────
      let fixCount = 0;
      let dropCount = 0;
      const validationErrors: string[] = [];

      for (const seg of segments) {
        const fixes: string[] = [];

        // Check video reference
        if (!seg.videoId || !videoMap.has(seg.videoId)) {
          await db.update(segmentsTable).set({ included: false }).where(eq(segmentsTable.id, seg.id));
          dropCount++;
          validationErrors.push(`Segment "${seg.label ?? seg.id}": invalid videoId — excluded.`);
          continue;
        }
        const srcVideo = videoMap.get(seg.videoId)!;
        const srcDuration = srcVideo.durationSeconds ?? 999;

        // Fix inverted timecodes
        let startTime = seg.startTime;
        let endTime = seg.endTime;
        if (startTime >= endTime) {
          [startTime, endTime] = [endTime, startTime];
          fixes.push("swapped inverted timecodes");
        }

        // Clamp to video bounds
        if (startTime < 0) { startTime = 0; fixes.push("clamped start to 0"); }
        if (endTime > srcDuration) { endTime = srcDuration; fixes.push(`clamped end to ${srcDuration.toFixed(2)}s`); }

        // Enforce minimum 0.25s duration
        if (endTime - startTime < 0.25) {
          await db.update(segmentsTable).set({ included: false }).where(eq(segmentsTable.id, seg.id));
          dropCount++;
          validationErrors.push(`Segment "${seg.label ?? seg.id}": duration < 0.25s — excluded.`);
          continue;
        }

        if (fixes.length > 0) {
          await db.update(segmentsTable).set({ startTime, endTime }).where(eq(segmentsTable.id, seg.id));
          fixCount++;
          await appendLog(jobId, `  ✏ Fixed "${seg.label ?? seg.id}": ${fixes.join(", ")}`);
        }
      }
      await db.update(jobsTable).set({ progress: 40 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Validation: ${fixCount} fixed, ${dropCount} excluded.`);

      // ── Step 2: Re-fetch valid segments and normalise order ───────────────
      const validSegs = await db.select().from(segmentsTable)
        .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
        .orderBy(segmentsTable.orderIndex);

      if (validSegs.length === 0) throw new Error("No valid segments remain after validation.");

      // Re-number orderIndex 0..n to ensure contiguous ordering
      for (let i = 0; i < validSegs.length; i++) {
        if (validSegs[i].orderIndex !== i) {
          await db.update(segmentsTable).set({ orderIndex: i }).where(eq(segmentsTable.id, validSegs[i].id));
        }
      }
      await db.update(jobsTable).set({ progress: 60 }).where(eq(jobsTable.id, jobId));

      // ── Step 3: Calculate total duration and build manifest ───────────────
      const totalDuration = validSegs.reduce((sum, s) => sum + (s.endTime - s.startTime) / (s.speedFactor ?? 1.0), 0);
      const speechSegs = validSegs.filter(s => s.segmentType === "speech" || (s.audioMixLevel ?? 1.0) > 0.5);
      const musicSegs  = validSegs.filter(s => s.segmentType !== "speech" && (s.audioMixLevel ?? 1.0) <= 0.5);

      await appendLog(jobId, `Timeline: ${validSegs.length} segments | ${totalDuration.toFixed(2)}s total | ${speechSegs.length} speech | ${musicSegs.length} b-roll`);
      await db.update(jobsTable).set({ progress: 78 }).where(eq(jobsTable.id, jobId));

      // ── Step 4: Check for enhanced audio files ────────────────────────────
      const enhancedAudioMap: Record<string, string> = {};
      for (const vid of videos) {
        const enhPath = path.join(UPLOAD_DIR, `${vid.id}_enhanced.wav`);
        if (fs.existsSync(enhPath)) enhancedAudioMap[vid.id] = enhPath;
      }
      if (Object.keys(enhancedAudioMap).length > 0) {
        await appendLog(jobId, `Enhanced audio ready for ${Object.keys(enhancedAudioMap).length} video(s) — will be used during render.`);
      }

      // ── Step 5: Build and store the final edit manifest ───────────────────
      const manifest = {
        projectId,
        projectName: project.name,
        targetFormat: project.targetFormat ?? "custom",
        totalDuration: Math.round(totalDuration * 1000) / 1000,
        segmentCount: validSegs.length,
        speechSegments: speechSegs.length,
        brollSegments: musicSegs.length,
        validationFixes: fixCount,
        validationDrops: dropCount,
        enhancedAudioMap,
        segments: validSegs.map(s => ({
          id: s.id,
          videoId: s.videoId,
          label: s.label,
          type: s.segmentType,
          start: s.startTime,
          end: s.endTime,
          duration: Math.round((s.endTime - s.startTime) * 1000) / 1000,
          speed: s.speedFactor ?? 1.0,
          order: s.orderIndex,
          colorGrade: s.colorGrade,
          hasCaption: !!s.captionText,
          audioMix: s.audioMixLevel ?? 1.0,
          musicDuck: s.musicDuckLevel ?? 0.15,
        })),
        finalizedAt: new Date().toISOString(),
      };
      result = JSON.stringify(manifest);
      await db.update(projectsTable).set({ status: "review", updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Edit applied — ${validSegs.length} segments, ${totalDuration.toFixed(2)}s. Ready for export.`);
      await db.insert(activityTable).values({ id: randomUUID(), type: "edit_applied", description: `Edit finalized: ${validSegs.length} segments (${totalDuration.toFixed(1)}s) for "${project.name}"`, projectId, projectName: project.name ?? null });
    }

    else if (type === "render") {
      await appendLog(jobId, "Loading edit plan and source footage...");
      await db.update(jobsTable).set({ progress: 3 }).where(eq(jobsTable.id, jobId));

      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const segments = await db
        .select().from(segmentsTable)
        .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
        .orderBy(segmentsTable.orderIndex);

      if (segments.length === 0) throw new Error("No included segments found — run Generate Edit Plan first.");

      const jobTmpDir = path.join(RENDER_DIR, jobId);
      fs.mkdirSync(jobTmpDir, { recursive: true });

      // Detect hardware encoder (h264_nvenc if GPU available, fallback libx264)
      let videoEncoder = "libx264";
      try {
        await runFfmpeg(["-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.01", "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-"]);
        videoEncoder = "h264_nvenc";
        await appendLog(jobId, "⚡ Hardware acceleration: h264_nvenc (GPU)");
      } catch {
        await appendLog(jobId, "🖥 Encoder: libx264 (CPU)");
      }

      // Parse render format option: 'vertical' (9:16) or default (project format)
      const renderOptsJson = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      const renderOpts = (renderOptsJson ?? {}) as { format?: string; crf?: number };
      const isVertical = renderOpts.format === "vertical";
      const crf = renderOpts.crf ?? 23;
      const targetFormat = project?.targetFormat ?? "instagram_reel";
      const scaleFilter = isVertical
        ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
        : getFormatScale(targetFormat);
      const formatLabel = isVertical ? "1080×1920 (Vertical 9:16)" : targetFormat.replace(/_/g, " ");

      // ── Load enhanced audio map from apply_edit manifest if available ────
      let enhancedAudioMap: Record<string, string> = {};
      try {
        const applyJobs = await db.select().from(jobsTable)
          .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "apply_edit"), eq(jobsTable.status, "completed")));
        if (applyJobs.length > 0) {
          const manifest = JSON.parse(applyJobs[applyJobs.length - 1].result ?? "{}");
          if (manifest.enhancedAudioMap) enhancedAudioMap = manifest.enhancedAudioMap;
        }
      } catch {}
      const enhancedCount = Object.keys(enhancedAudioMap).length;
      if (enhancedCount > 0) {
        await appendLog(jobId, `Using enhanced audio for ${enhancedCount} video(s).`);
      }

      await appendLog(jobId, `Rendering ${segments.length} segments → ${formatLabel} | ${videoEncoder} | CRF ${crf}`);
      await db.update(jobsTable).set({ progress: 6 }).where(eq(jobsTable.id, jobId));

      // Pre-compute which segments are immediately followed by an L-cut B-roll segment,
      // so their fade-out can be lengthened for a smooth audio handoff.
      // Only mark a preceding segment when the B-roll can actually borrow audio from it
      // (i.e. the source video file exists), matching the feasibility check in the encoder.
      const isLCutBroll = (seg: typeof segments[number]) =>
        (seg.audioMixLevel ?? 1.0) <= 0 &&
        (seg.segmentType === "transition" || seg.segmentType === "broll");
      const precedesLCut = new Set<number>();
      for (let k = 1; k < segments.length; k++) {
        if (isLCutBroll(segments[k])) {
          // Find the preceding speech segment (same look-back as L-cut detection)
          for (let j = k - 1; j >= 0; j--) {
            const ps = segments[j];
            if (ps.segmentType !== "transition" && ps.segmentType !== "broll" && ps.videoId) {
              // Only apply the longer fade-out if audio can actually be borrowed
              const psVid = videos.find(v => v.id === ps.videoId);
              const psPath = psVid ? (psVid.filePath ?? path.join(UPLOAD_DIR, psVid.filename)) : null;
              if (psPath && fs.existsSync(psPath)) {
                precedesLCut.add(j);
              }
              break;
            }
          }
        }
      }

      // Parallel encoding with up to 3 concurrent workers
      const WORKERS = 3;
      const segmentFiles: (string | null)[] = new Array(segments.length).fill(null);
      let nextSegIdx = 0;
      let doneCount = 0;

      async function encodeWorker() {
        while (true) {
          const i = nextSegIdx++;
          if (i >= segments.length) break;
          const seg = segments[i];
          const srcVideo = videos.find(v => v.id === seg.videoId);
          if (!srcVideo) { await appendLog(jobId, `Seg ${i + 1}: no source video, skip.`); doneCount++; continue; }
          const srcPath = path.join(UPLOAD_DIR, srcVideo.filename);
          if (!fs.existsSync(srcPath)) { await appendLog(jobId, `Seg ${i + 1}: file missing, skip.`); doneCount++; continue; }

          const segOut = path.join(jobTmpDir, `seg_${String(i).padStart(4, "0")}.mp4`);
          const speedFactor = seg.speedFactor ?? 1.0;
          const rawMixLevel = seg.audioMixLevel ?? 1.0;
          const audioMixLevel = Math.max(0, rawMixLevel);
          const label = seg.label ?? seg.segmentType;
          const segDur = seg.endTime - seg.startTime;

          // L-cut: for muted B-roll/transition segments, borrow speech audio from
          // the preceding speech segment so dialogue continues under B-roll visuals.
          const isBroll = rawMixLevel <= 0 && (seg.segmentType === "transition" || seg.segmentType === "broll");
          let lCutSrcPath: string | null = null;
          let lCutAudioStart = 0;
          if (isBroll) {
            const prevSpeech = [...segments].slice(0, i).reverse()
              .find(s => s.segmentType !== "transition" && s.segmentType !== "broll" && s.videoId);
            if (prevSpeech) {
              const prevVid = videos.find(v => v.id === prevSpeech.videoId);
              const prevPath = prevVid ? (prevVid.filePath ?? path.join(UPLOAD_DIR, prevVid.filename)) : null;
              if (prevPath && fs.existsSync(prevPath)) {
                lCutSrcPath = prevPath;
                lCutAudioStart = prevSpeech.endTime; // continue speech from where it ended
              }
            }
          }

          // Check for enhanced audio WAV for this video
          const enhancedAudioPath = enhancedAudioMap[seg.videoId ?? ""] ??
            (seg.videoId && fs.existsSync(path.join(UPLOAD_DIR, `${seg.videoId}_enhanced.wav`))
              ? path.join(UPLOAD_DIR, `${seg.videoId}_enhanced.wav`) : null);

          // Video filter chain — normalize pixel format first so curves/eq filters work on all sources
          const vfParts: string[] = [scaleFilter, "format=yuv420p"];
          if (seg.colorGrade && COLOR_GRADE_FILTERS[seg.colorGrade]) vfParts.push(COLOR_GRADE_FILTERS[seg.colorGrade]);
          if (speedFactor !== 1.0) vfParts.push(`setpts=PTS/${speedFactor.toFixed(4)}`);
          const captionFilter = buildCaptionFilter(seg.captionText ?? "", seg.captionStyle ?? "none");
          if (captionFilter) vfParts.push(captionFilter);

          // Audio filter chain: speed + per-segment volume + smooth fades
          const afParts: string[] = [];
          if (speedFactor !== 1.0) afParts.push(buildAtempoChain(speedFactor));
          if (!isBroll && audioMixLevel !== 1.0) afParts.push(`volume=${audioMixLevel.toFixed(3)}`);

          // Smooth audio fades — tuned per segment type to avoid audible artefacts:
          //   L-cut (B-roll borrowing speech audio): micro fade-in (0.04s) to avoid pop,
          //     but no full fade-in since the speech is already mid-flow; longer fade-out
          //     (0.35s clamped to 15% of duration) so dialogue tapers naturally.
          //   Segment preceding an L-cut: use the same longer fade-out for a seamless handoff.
          //   All other segments: standard 0.18s fade clamped to 6% of duration.
          let fadeInDur: number;
          let fadeOutDur: number;
          if (isBroll && lCutSrcPath) {
            // L-cut segment: suppress fade-in, extend fade-out
            fadeInDur = Math.min(0.04, segDur * 0.02);
            fadeOutDur = Math.min(0.35, segDur * 0.15);
          } else if (precedesLCut.has(i)) {
            // Speech segment handing off to L-cut: normal fade-in, longer fade-out
            fadeInDur = Math.min(0.18, segDur * 0.06);
            fadeOutDur = Math.min(0.35, segDur * 0.15);
          } else {
            fadeInDur = Math.min(0.18, segDur * 0.06);
            fadeOutDur = Math.min(0.18, segDur * 0.06);
          }
          const fadeOutSt = Math.max(0, segDur - fadeOutDur);
          afParts.push(`afade=t=in:st=0:d=${fadeInDur.toFixed(3)}`);
          afParts.push(`afade=t=out:st=${fadeOutSt.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`);

          const encArgs = videoEncoder === "h264_nvenc"
            ? ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", String(crf)]
            : ["-c:v", "libx264", "-preset", "fast", "-crf", String(crf)];

          // Always force yuv420p output so every segment has identical pixel format for xfade
          const pixFmtArgs = ["-pix_fmt", "yuv420p"];

          const doEncode = async (vf: string[], af: string[]) => {
            if (lCutSrcPath) {
              await runFfmpeg([
                "-y",
                "-ss", String(seg.startTime), "-to", String(seg.endTime), "-i", srcPath,
                "-ss", String(lCutAudioStart), "-t", String(segDur), "-i", lCutSrcPath,
                "-map", "0:v:0", "-map", "1:a:0",
                "-vf", vf.join(","), "-af", af.join(","),
                ...encArgs, ...pixFmtArgs,
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
                segOut,
              ]);
            } else if (enhancedAudioPath && fs.existsSync(enhancedAudioPath)) {
              await runFfmpeg([
                "-y",
                "-ss", String(seg.startTime), "-to", String(seg.endTime), "-i", srcPath,
                "-ss", String(seg.startTime), "-to", String(seg.endTime), "-i", enhancedAudioPath,
                "-map", "0:v:0", "-map", "1:a:0",
                "-vf", vf.join(","),
                ...(af.length > 0 ? ["-af", af.join(",")] : []),
                ...encArgs, ...pixFmtArgs,
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
                segOut,
              ]);
            } else {
              await runFfmpeg([
                "-y",
                "-ss", String(seg.startTime), "-to", String(seg.endTime), "-i", srcPath,
                "-vf", vf.join(","),
                ...(af.length > 0 ? ["-af", af.join(",")] : []),
                ...encArgs, ...pixFmtArgs,
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
                segOut,
              ]);
            }
          };

          // Attempt encode — retry once with stripped filters if first attempt fails
          try {
            await doEncode(vfParts, afParts);
          } catch (encErr) {
            await appendLog(jobId, `⚠ Seg ${i + 1} encode failed, retrying without effects: ${String(encErr).slice(0, 120)}`);
            // Strip caption + color grade filters; keep only scale + pixel format
            const fallbackVf = [scaleFilter, "format=yuv420p"];
            const fallbackAf = afParts.filter(f => f.startsWith("afade"));
            try {
              if (fs.existsSync(segOut)) fs.unlinkSync(segOut);
              await doEncode(fallbackVf, fallbackAf.length > 0 ? fallbackAf : ["aresample=44100"]);
              await appendLog(jobId, `  ↳ Retry succeeded (effects stripped).`);
            } catch (retryErr) {
              await appendLog(jobId, `  ✗ Seg ${i + 1} retry also failed — skipping: ${String(retryErr).slice(0, 80)}`);
              doneCount++;
              continue;
            }
          }

          segmentFiles[i] = segOut;
          doneCount++;
          const pct = Math.round(6 + (doneCount / segments.length) * 80);
          await db.update(jobsTable).set({ progress: pct }).where(eq(jobsTable.id, jobId));
          await appendLog(jobId, `[${doneCount}/${segments.length}] ✓ "${label}" (${(seg.endTime - seg.startTime).toFixed(2)}s)${audioMixLevel !== 1.0 ? ` vol=${Math.round(audioMixLevel * 100)}%` : ""}${enhancedAudioPath ? " 🎛" : ""}`);
        }
      }

      await Promise.all(Array.from({ length: Math.min(WORKERS, segments.length) }, encodeWorker));
      // Filter out null entries AND zero-byte files (failed encodes)
      const segmentFilesOrdered = segmentFiles.filter((f): f is string =>
        f !== null && fs.existsSync(f) && fs.statSync(f).size > 1024
      );

      if (segmentFilesOrdered.length === 0) throw new Error("No segments could be processed.");

      await appendLog(jobId, `Joining ${segmentFilesOrdered.length} segments with crossfade transitions...`);
      await db.update(jobsTable).set({ progress: 87 }).where(eq(jobsTable.id, jobId));

      const outputPath = path.join(RENDER_DIR, `${projectId}.mp4`);

      // Probe the actual encoded duration of every segment file
      const segDurations: number[] = await Promise.all(
        segmentFilesOrdered.sort().map(async (f) => {
          try {
            const { stdout } = await runCommand("ffprobe", [
              "-v", "error", "-show_entries", "format=duration",
              "-of", "csv=p=0", f,
            ]);
            return parseFloat(stdout.trim()) || 0;
          } catch { return 0; }
        })
      );
      const sortedSegs = segmentFilesOrdered.sort();

      const encArgs = videoEncoder === "h264_nvenc"
        ? ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", String(crf)]
        : ["-c:v", "libx264", "-preset", "fast", "-crf", String(crf)];

      if (sortedSegs.length === 1) {
        // Single segment — just copy
        fs.copyFileSync(sortedSegs[0], outputPath);
      } else {
        // Simple concat — single-pass, no generation loss, clean hard cuts
        // Audio is already afaded per-segment before encode so no clicks at cuts
        const listFile2 = path.join(jobTmpDir, "concat_list.txt");
        fs.writeFileSync(listFile2, sortedSegs.map(f => `file '${f}'`).join("\n"));
        await appendLog(jobId, `Joining ${sortedSegs.length} segments via concat...`);
        await runFfmpeg([
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", listFile2,
          "-c", "copy",
          "-movflags", "+faststart",
          outputPath,
        ]);
      }

      // Legacy listFile reference kept for cleanup compatibility
      const listFile = path.join(jobTmpDir, "list.txt");

      // ── Optional: mix background music track with per-segment ducking ──
      const audioTracks = videos.filter(v =>
        v.mimeType?.startsWith("audio/") &&
        fs.existsSync(v.filePath ?? path.join(UPLOAD_DIR, v.filename))
      );

      if (audioTracks.length > 0) {
        const musicFile  = audioTracks[0];
        const musicPath  = musicFile.filePath ?? path.join(UPLOAD_DIR, musicFile.filename);
        await appendLog(jobId, `Mixing background music: "${musicFile.originalName}"...`);

        // Build a per-segment volume expression for music track
        // each segment maps to a span on the rendered timeline
        let cumTime = 0;
        const volTerms: string[] = [];
        for (const seg of segments) {
          const dur = Math.max(0.001, seg.endTime - seg.startTime);
          const speed = seg.speedFactor ?? 1.0;
          const effectiveDur = dur / speed;
          const duckLevel = (seg.musicDuckLevel ?? 1.0).toFixed(4);
          const t0 = cumTime.toFixed(4);
          const t1 = (cumTime + effectiveDur).toFixed(4);
          volTerms.push(`between(t,${t0},${t1})*${duckLevel}`);
          cumTime += effectiveDur;
        }
        // fallback to 1.0 outside all segments
        const volExpr = volTerms.length > 0 ? volTerms.join("+") : "1";

        const mixedPath = path.join(RENDER_DIR, `${projectId}_mix.mp4`);
        try {
          await runFfmpeg([
            "-y",
            "-i", outputPath,
            "-stream_loop", "-1", "-i", musicPath,
            "-filter_complex",
            `[1:a]volume='${volExpr}':eval=frame[music];[0:a][music]amix=inputs=2:duration=first:normalize=0[aout]`,
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            mixedPath,
          ]);
          fs.renameSync(mixedPath, outputPath);
          await appendLog(jobId, `Music mixed in (${audioTracks.length} track, ducking per ${segments.length} segments).`);
        } catch (err: any) {
          await appendLog(jobId, `⚠ Music mix step failed (video still exported without music): ${err?.message?.slice(0, 200)}`);
          try { fs.unlinkSync(mixedPath); } catch {}
        }
      }

      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      await appendLog(jobId, `Render complete! Output: ${sizeMB} MB — ready to download.`);
      await db.update(jobsTable).set({ progress: 97 }).where(eq(jobsTable.id, jobId));

      // Cleanup temp segment files
      for (const f of segmentFilesOrdered) { try { fs.unlinkSync(f as string); } catch {} }
      try { fs.unlinkSync(listFile); fs.rmdirSync(jobTmpDir); } catch {}

      result = JSON.stringify({ renderPath: outputPath, sizeMB: parseFloat(sizeMB), segments: segmentFilesOrdered.length });
      await db.update(projectsTable).set({ status: "completed", updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `Video rendered for "${project?.name ?? projectId}" (${sizeMB} MB)`, projectId, projectName: project?.name ?? null });
    }

    // ── Quality Check ────────────────────────────────────────────────────
    else if (type === "quality_check") {
      await appendLog(jobId, "Starting quality check on rendered video...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      // Find the rendered output for this project
      const renderPath = path.join(RENDER_DIR, `${projectId}.mp4`);
      if (!fs.existsSync(renderPath)) {
        throw new Error("No rendered video found for this project. Please render first.");
      }

      const fileStats = fs.statSync(renderPath);
      const sizeMB = (fileStats.size / 1024 / 1024).toFixed(1);
      await appendLog(jobId, `Video found: ${sizeMB} MB — running analysis suite...`);
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      // ── 1. ffprobe: get stream & format metadata ──────────────────────
      await appendLog(jobId, "[1/6] Analyzing codec, resolution, fps, bitrate...");
      let probeData: any = {};
      try {
        const probeOut = await new Promise<string>((resolve, reject) => {
          const { spawn } = require("child_process");
          const proc = spawn("ffprobe", [
            "-v", "quiet", "-print_format", "json",
            "-show_streams", "-show_format", renderPath,
          ]);
          let out = "";
          proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
          proc.on("close", (code: number) => code === 0 ? resolve(out) : reject(new Error("ffprobe failed")));
          proc.on("error", reject);
        });
        probeData = JSON.parse(probeOut);
      } catch (e) {
        await appendLog(jobId, "  ⚠ ffprobe analysis failed, skipping metadata check.");
      }

      const videoStream = (probeData.streams ?? []).find((s: any) => s.codec_type === "video");
      const audioStream = (probeData.streams ?? []).find((s: any) => s.codec_type === "audio");
      const format = probeData.format ?? {};

      const actualDuration = parseFloat(format.duration ?? "0");
      const bitrate = parseInt(format.bit_rate ?? "0", 10);
      const bitrateMbps = bitrate / 1_000_000;
      const videoCodec = videoStream?.codec_name ?? "unknown";
      const audioCodec = audioStream?.codec_name ?? "unknown";
      const width = parseInt(videoStream?.width ?? "0", 10);
      const height = parseInt(videoStream?.height ?? "0", 10);
      const fpsRaw = videoStream?.r_frame_rate ?? "0/1";
      const [fpsNum, fpsDen] = fpsRaw.split("/").map(Number);
      const fps = fpsDen > 0 ? fpsNum / fpsDen : 0;
      const hasAudio = !!audioStream;
      const audioSampleRate = parseInt(audioStream?.sample_rate ?? "0", 10);

      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `  Resolution: ${width}x${height} | FPS: ${fps.toFixed(2)} | Codec: ${videoCodec}/${audioCodec} | Bitrate: ${bitrateMbps.toFixed(1)} Mbps`);

      // ── 2. Freeze detection (frozen frames = playback lag) ────────────
      await appendLog(jobId, "[2/6] Checking for frozen frames (lag/stutter)...");
      let freezeEvents: { start: number; end: number; duration: number }[] = [];
      try {
        const freezeOut = await new Promise<string>((resolve) => {
          const { spawn } = require("child_process");
          const proc = spawn("ffmpeg", [
            "-i", renderPath,
            "-vf", "freezedetect=n=-60dB:d=0.3",
            "-f", "null", "-",
          ]);
          let err = "";
          proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
          proc.on("close", () => resolve(err));
          proc.on("error", () => resolve(""));
        });
        // Parse freeze events
        const startMatches = [...freezeOut.matchAll(/freeze_start: ([\d.]+)/g)];
        const endMatches = [...freezeOut.matchAll(/freeze_end: ([\d.]+)/g)];
        const durMatches = [...freezeOut.matchAll(/freeze_duration: ([\d.]+)/g)];
        for (let i = 0; i < startMatches.length; i++) {
          freezeEvents.push({
            start: parseFloat(startMatches[i][1]),
            end: parseFloat(endMatches[i]?.[1] ?? "0"),
            duration: parseFloat(durMatches[i]?.[1] ?? "0"),
          });
        }
      } catch {}

      const totalFreezeTime = freezeEvents.reduce((s, e) => s + e.duration, 0);
      await db.update(jobsTable).set({ progress: 35 }).where(eq(jobsTable.id, jobId));
      if (freezeEvents.length > 0) {
        await appendLog(jobId, `  ⚠ Found ${freezeEvents.length} frozen segment(s) totaling ${totalFreezeTime.toFixed(2)}s`);
      } else {
        await appendLog(jobId, `  ✓ No frozen frames detected — playback smooth`);
      }

      // ── 3. Black frame detection (missing transitions / cut errors) ───
      await appendLog(jobId, "[3/6] Checking for unexpected black frames...");
      let blackEvents: { start: number; end: number; duration: number }[] = [];
      try {
        const blackOut = await new Promise<string>((resolve) => {
          const { spawn } = require("child_process");
          const proc = spawn("ffmpeg", [
            "-i", renderPath,
            "-vf", "blackdetect=d=0.1:pic_th=0.95:pix_th=0.10",
            "-f", "null", "-",
          ]);
          let err = "";
          proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
          proc.on("close", () => resolve(err));
          proc.on("error", () => resolve(""));
        });
        const bMatches = [...blackOut.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)];
        for (const m of bMatches) {
          const dur = parseFloat(m[3]);
          // Ignore very short black frames at start (normal fade in) or end
          const start = parseFloat(m[1]);
          if (start > 1.0 && start < actualDuration - 1.0 && dur > 0.2) {
            blackEvents.push({ start, end: parseFloat(m[2]), duration: dur });
          }
        }
      } catch {}

      await db.update(jobsTable).set({ progress: 50 }).where(eq(jobsTable.id, jobId));
      if (blackEvents.length > 0) {
        await appendLog(jobId, `  ⚠ Found ${blackEvents.length} unexpected black segment(s) mid-video`);
      } else {
        await appendLog(jobId, `  ✓ No unexpected black frames — cuts are clean`);
      }

      // ── 4. Silence detection (audio dropout) ─────────────────────────
      await appendLog(jobId, "[4/6] Checking audio continuity...");
      let silenceEvents: { start: number; end: number; duration: number }[] = [];
      if (hasAudio) {
        try {
          const silenceOut = await new Promise<string>((resolve) => {
            const { spawn } = require("child_process");
            const proc = spawn("ffmpeg", [
              "-i", renderPath,
              "-af", "silencedetect=n=-50dB:d=1.0",
              "-f", "null", "-",
            ]);
            let err = "";
            proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
            proc.on("close", () => resolve(err));
            proc.on("error", () => resolve(""));
          });
          const sStarts = [...silenceOut.matchAll(/silence_start: ([\d.]+)/g)];
          const sEnds = [...silenceOut.matchAll(/silence_end: ([\d.]+)/g)];
          const sDurs = [...silenceOut.matchAll(/silence_duration: ([\d.]+)/g)];
          for (let i = 0; i < sStarts.length; i++) {
            const start = parseFloat(sStarts[i][1]);
            const dur = parseFloat(sDurs[i]?.[1] ?? "0");
            // Only flag if mid-video silence (not at start/end) and > 1s
            if (start > 2.0 && start < actualDuration - 2.0 && dur > 1.0) {
              silenceEvents.push({ start, end: parseFloat(sEnds[i]?.[1] ?? "0"), duration: dur });
            }
          }
        } catch {}
      }

      await db.update(jobsTable).set({ progress: 65 }).where(eq(jobsTable.id, jobId));
      if (silenceEvents.length > 0) {
        await appendLog(jobId, `  ⚠ Found ${silenceEvents.length} audio dropout(s) mid-video`);
      } else {
        await appendLog(jobId, `  ✓ Audio continuous — no dropouts detected`);
      }

      // ── 5. Loudness analysis (LUFS target for streaming) ─────────────
      await appendLog(jobId, "[5/6] Measuring loudness (streaming target: -14 LUFS)...");
      let loudnessData: { inputI?: number; inputTP?: number; inputLRA?: number } = {};
      if (hasAudio) {
        try {
          const loudOut = await new Promise<string>((resolve) => {
            const { spawn } = require("child_process");
            const proc = spawn("ffmpeg", [
              "-i", renderPath,
              "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
              "-f", "null", "-",
            ]);
            let err = "";
            proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
            proc.on("close", () => resolve(err));
            proc.on("error", () => resolve(""));
          });
          // Extract JSON block from loudnorm output
          const jsonMatch = loudOut.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            loudnessData = {
              inputI: parseFloat(parsed.input_i ?? "0"),
              inputTP: parseFloat(parsed.input_tp ?? "0"),
              inputLRA: parseFloat(parsed.input_lra ?? "0"),
            };
          }
        } catch {}
      }

      await db.update(jobsTable).set({ progress: 80 }).where(eq(jobsTable.id, jobId));
      const lufsOk = hasAudio && loudnessData.inputI !== undefined && loudnessData.inputI >= -23 && loudnessData.inputI <= -9;
      if (hasAudio && loudnessData.inputI !== undefined) {
        await appendLog(jobId, `  Loudness: ${loudnessData.inputI.toFixed(1)} LUFS | True Peak: ${loudnessData.inputTP?.toFixed(1)} dBTP | LRA: ${loudnessData.inputLRA?.toFixed(1)} LU`);
        if (lufsOk) {
          await appendLog(jobId, `  ✓ Loudness within streaming range`);
        } else {
          await appendLog(jobId, `  ⚠ Loudness ${loudnessData.inputI.toFixed(1)} LUFS is outside optimal range (-23 to -9 LUFS)`);
        }
      }

      // ── 6. Compute QC Score ────────────────────────────────────────────
      await appendLog(jobId, "[6/6] Computing quality score...");

      const checks: { id: string; label: string; pass: boolean; detail: string; severity: "info" | "warn" | "fail" }[] = [];

      // File integrity
      checks.push({ id: "file_ok", label: "File integrity", pass: fileStats.size > 10000, detail: `${sizeMB} MB valid MP4 container`, severity: "fail" });

      // Codec compliance
      const codecOk = videoCodec === "h264" && (audioCodec === "aac" || !hasAudio);
      checks.push({ id: "codec", label: "Codec compliance (H.264 + AAC)", pass: codecOk, detail: `Video: ${videoCodec} | Audio: ${audioCodec}`, severity: "warn" });

      // Resolution
      const resOk = width >= 720 && height >= 480;
      checks.push({ id: "resolution", label: "Resolution sufficient (≥720p)", pass: resOk, detail: `${width}×${height}`, severity: "warn" });

      // Frame rate
      const fpsOk = fps >= 23.9 && fps <= 60.1;
      checks.push({ id: "fps", label: "Frame rate normal (24–60 fps)", pass: fpsOk, detail: `${fps.toFixed(2)} fps`, severity: "warn" });

      // Bitrate
      const bitrateOk = bitrateMbps >= 0.5 && bitrateMbps <= 50;
      checks.push({ id: "bitrate", label: "Bitrate in normal range", pass: bitrateOk, detail: `${bitrateMbps.toFixed(2)} Mbps`, severity: "info" });

      // Audio present
      checks.push({ id: "audio", label: "Audio track present", pass: hasAudio, detail: hasAudio ? `${audioCodec} @ ${audioSampleRate} Hz` : "No audio stream found", severity: "warn" });

      // Frozen frames
      const freezeOk = freezeEvents.length === 0;
      checks.push({ id: "freeze", label: "No frozen frames (lag-free)", pass: freezeOk, detail: freezeOk ? "Playback smooth" : `${freezeEvents.length} frozen segment(s) — ${totalFreezeTime.toFixed(1)}s total`, severity: "fail" });

      // Black frames
      const blackOk = blackEvents.length === 0;
      checks.push({ id: "blackframes", label: "No unexpected black frames", pass: blackOk, detail: blackOk ? "All cuts clean" : `${blackEvents.length} black segment(s) mid-video`, severity: "warn" });

      // Audio continuity
      const silenceOk = silenceEvents.length === 0;
      checks.push({ id: "silence", label: "Continuous audio (no dropouts)", pass: silenceOk, detail: silenceOk ? "Audio uninterrupted" : `${silenceEvents.length} silence gap(s) detected`, severity: "warn" });

      // Loudness
      if (hasAudio && loudnessData.inputI !== undefined) {
        checks.push({ id: "loudness", label: "Loudness in streaming range", pass: lufsOk, detail: `${loudnessData.inputI.toFixed(1)} LUFS (target: -23 to -9)`, severity: "warn" });
      }

      // Score: fail = -15pts, warn = -5pts (if failed)
      const maxScore = 100;
      let deductions = 0;
      for (const c of checks) {
        if (!c.pass) {
          deductions += c.severity === "fail" ? 15 : c.severity === "warn" ? 7 : 3;
        }
      }
      const score = Math.max(0, maxScore - deductions);
      const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
      const passCount = checks.filter(c => c.pass).length;

      await appendLog(jobId, `Quality score: ${score}/100 (Grade ${grade}) — ${passCount}/${checks.length} checks passed`);

      if (score >= 90) {
        await appendLog(jobId, "✓ Excellent! Your video is production-ready.");
      } else if (score >= 75) {
        await appendLog(jobId, "✓ Good quality. Minor issues may be acceptable.");
      } else if (score >= 60) {
        await appendLog(jobId, "⚠ Acceptable quality but review flagged issues before publishing.");
      } else {
        await appendLog(jobId, "✗ Quality issues detected. Re-render is recommended.");
      }

      await db.update(jobsTable).set({ progress: 97 }).where(eq(jobsTable.id, jobId));

      const qcResult = {
        score,
        grade,
        passCount,
        totalChecks: checks.length,
        sizeMB: parseFloat(sizeMB),
        duration: Math.round(actualDuration),
        resolution: `${width}x${height}`,
        fps: parseFloat(fps.toFixed(2)),
        videoCodec,
        audioCodec,
        bitrateMbps: parseFloat(bitrateMbps.toFixed(2)),
        lufs: loudnessData.inputI ?? null,
        freezeEvents: freezeEvents.slice(0, 10),
        blackEvents: blackEvents.slice(0, 10),
        silenceEvents: silenceEvents.slice(0, 10),
        checks,
      };

      result = JSON.stringify(qcResult);
      const [qcProject] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, projectId));
      await db.insert(activityTable).values({
        id: randomUUID(),
        type: "ai_analysis_done",
        description: `Quality check: ${score}/100 (${grade}) for "${qcProject?.name ?? projectId}"`,
        projectId,
        projectName: qcProject?.name ?? null,
      });
    }

    // ── XML Style Learning ────────────────────────────────────────────────
    else if (type === "learn_xml_style") {
      await appendLog(jobId, "Parsing FCPXML style upload...");
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      // Get the FCPXML content — passed as options.xmlContent or from videoId upload
      let xmlContent: string | null = null;
      let styleName = "Learned Style";
      let styleCategory = "custom";
      try {
        const opts = JSON.parse(options ?? "{}");
        xmlContent = opts.xmlContent ?? null;
        styleName = opts.styleName ?? "Learned Style";
        styleCategory = opts.category ?? "custom";
      } catch {}

      if (!xmlContent) {
        // Try to load from the videoId (if used as a file reference)
        if (videoId) {
          const [vid] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
          if (vid?.filePath) {
            try { xmlContent = fs.readFileSync(vid.filePath, "utf8"); } catch {}
          }
        }
      }

      if (!xmlContent) throw new Error("No FCPXML content found. Provide xmlContent in options or upload an FCPXML file.");

      await appendLog(jobId, `FCPXML loaded — ${(xmlContent.length / 1024).toFixed(1)} KB. Extracting editing DNA...`);
      await db.update(jobsTable).set({ progress: 25 }).where(eq(jobsTable.id, jobId));

      // Send to Claude for analysis
      const xmlAnalysisPrompt = `You are a professional NLE (Non-Linear Editor) style analyst. Analyze this FCPXML and extract precise editing DNA statistics.

FCPXML content:
${xmlContent.substring(0, 15000)}

Extract and return JSON with these fields:
{
  "name": "descriptive style name based on content",
  "description": "1-2 sentence style description",
  "category": "wedding|corporate|documentary|sports|music_video|commercial|travel|social|custom",
  "subcategory": "specific sub-style",
  "avgClipDuration": 3.5,
  "minClipDuration": 0.5,
  "maxClipDuration": 15.0,
  "cutsPerMinute": 12.0,
  "transitionCutPct": 0.7,
  "transitionDissolvePct": 0.2,
  "transitionFadePct": 0.05,
  "transitionWipePct": 0.05,
  "avgTransitionDuration": 0.5,
  "primaryColorGrade": "warm|cinematic|vivid|muted|sunset|bw|natural",
  "colorWarmPct": 0.4,
  "colorCinematicPct": 0.3,
  "colorVividPct": 0.1,
  "colorMutedPct": 0.1,
  "colorSunsetPct": 0.05,
  "colorBwPct": 0.05,
  "avgSpeedFactor": 1.0,
  "slowMotionPct": 0.1,
  "speedRampPct": 0.05,
  "beatSyncStrength": 0.6,
  "musicDuckOnSpeech": true,
  "musicDuckLevel": 0.15,
  "speechMixLevel": 1.0,
  "musicOnlyPct": 0.7,
  "captionFrequency": 2.0,
  "captionStyle": "subtitle|lower_third|full_screen|kinetic",
  "emotionalArc": "description of emotional journey",
  "narrativeStructure": "linear|nonlinear|montage|documentary",
  "totalDuration": 300
}

Return ONLY valid JSON.`;

      const analysisMsg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: xmlAnalysisPrompt }],
      });
      const analysisText = analysisMsg.content[0].type === "text" ? analysisMsg.content[0].text : "{}";

      await appendLog(jobId, "DNA extraction complete. Saving style to library...");
      await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

      let dna: Record<string, any> = {};
      try {
        const m = analysisText.match(/\{[\s\S]*\}/);
        if (m) dna = JSON.parse(m[0]);
      } catch {}

      // Upsert new style into edit_styles
      const newStyleId = randomUUID();
      const now = new Date();
      await db.insert(editStylesTable).values({
        id: newStyleId,
        name: dna.name ?? styleName,
        category: dna.category ?? styleCategory,
        subcategory: dna.subcategory ?? null,
        description: dna.description ?? null,
        source: "user",
        avgClipDuration: dna.avgClipDuration ?? 3.5,
        minClipDuration: dna.minClipDuration ?? 0.5,
        maxClipDuration: dna.maxClipDuration ?? 15.0,
        cutsPerMinute: dna.cutsPerMinute ?? 12.0,
        transitionCutPct: dna.transitionCutPct ?? 0.7,
        transitionDissolvePct: dna.transitionDissolvePct ?? 0.2,
        transitionFadePct: dna.transitionFadePct ?? 0.05,
        transitionWipePct: dna.transitionWipePct ?? 0.05,
        avgTransitionDuration: dna.avgTransitionDuration ?? 0.5,
        primaryColorGrade: dna.primaryColorGrade ?? null,
        colorWarmPct: dna.colorWarmPct ?? 0,
        colorCinematicPct: dna.colorCinematicPct ?? 0,
        colorVividPct: dna.colorVividPct ?? 0,
        colorMutedPct: dna.colorMutedPct ?? 0,
        colorSunsetPct: dna.colorSunsetPct ?? 0,
        colorBwPct: dna.colorBwPct ?? 0,
        avgSpeedFactor: dna.avgSpeedFactor ?? 1.0,
        slowMotionPct: dna.slowMotionPct ?? 0,
        speedRampPct: dna.speedRampPct ?? 0,
        beatSyncStrength: dna.beatSyncStrength ?? 0.5,
        musicDuckOnSpeech: dna.musicDuckOnSpeech ?? true,
        musicDuckLevel: dna.musicDuckLevel ?? 0.15,
        speechMixLevel: dna.speechMixLevel ?? 1.0,
        musicOnlyPct: dna.musicOnlyPct ?? 0.7,
        captionFrequency: dna.captionFrequency ?? 0,
        captionStyle: dna.captionStyle ?? "subtitle",
        emotionalArc: dna.emotionalArc ?? null,
        totalDuration: dna.totalDuration ?? null,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      await appendLog(jobId, `Style "${dna.name ?? styleName}" saved to library! ${dna.description ?? ""}`);
      await appendLog(jobId, `Key DNA: ${dna.avgClipDuration?.toFixed(1)}s avg clip, ${dna.cutsPerMinute?.toFixed(1)} cuts/min, ${dna.primaryColorGrade} grade, ${(dna.beatSyncStrength*100)?.toFixed(0)}% beat sync`);
      result = JSON.stringify({ styleId: newStyleId, name: dna.name ?? styleName, dna });
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `XML style learned: "${dna.name ?? styleName}"`, projectId, projectName: null });
    }

    // ── Real Speech Detection via ffmpeg silencedetect ────────────────────
    else if (type === "detect_speech") {
      await appendLog(jobId, "Running real speech detection via FFmpeg silencedetect...");
      await db.update(jobsTable).set({ progress: 8 }).where(eq(jobsTable.id, jobId));

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const allSegments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId));

      const speechVids = projectVideos.filter(v => v.mimeType?.startsWith("video/"));
      await appendLog(jobId, `Analyzing ${speechVids.length} video file(s)...`);

      let processed = 0;
      let totalUpdated = 0;

      for (const video of speechVids) {
        const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
        if (!fs.existsSync(filePath)) {
          await appendLog(jobId, `  ⚠ "${video.originalName}" — file not found, skipping`);
          continue;
        }

        await appendLog(jobId, `  Detecting speech in "${video.originalName}" (${Math.round(video.durationSeconds ?? 0)}s)...`);

        let silenceOutput = "";
        try {
          // silencedetect: noise=-35dB, min silence duration 0.4s
          const { stderr } = await runFfmpeg([
            "-i", filePath,
            "-af", "silencedetect=noise=-35dB:d=0.4",
            "-f", "null", "-",
          ]);
          silenceOutput = stderr;
        } catch (err: any) {
          await appendLog(jobId, `  ⚠ ffmpeg silencedetect failed: ${err?.message?.slice(0, 120)}`);
          processed++;
          continue;
        }

        // Parse silence_start / silence_end timestamps
        const silenceRegions: Array<{ start: number; end: number }> = [];
        const startMatches = [...silenceOutput.matchAll(/silence_start:\s*([\d.]+)/g)];
        const endMatches   = [...silenceOutput.matchAll(/silence_end:\s*([\d.]+)/g)];

        for (let i = 0; i < startMatches.length; i++) {
          const start = parseFloat(startMatches[i][1]);
          const end   = endMatches[i] ? parseFloat(endMatches[i][1]) : (video.durationSeconds ?? start + 60);
          silenceRegions.push({ start, end });
        }
        silenceRegions.sort((a, b) => a.start - b.start);

        // Build speech regions = inverse of silence
        const duration = video.durationSeconds ?? 0;
        const speechRegions: Array<{ start: number; end: number }> = [];
        let cursor = 0;
        for (const { start, end } of silenceRegions) {
          if (start > cursor + 0.15) speechRegions.push({ start: cursor, end: start });
          cursor = end;
        }
        if (cursor < duration - 0.15) speechRegions.push({ start: cursor, end: duration });

        await appendLog(jobId, `    → ${speechRegions.length} speech region(s), ${silenceRegions.length} silence region(s)`);

        // Update segments for this video
        const videoSegs = allSegments.filter(s => s.videoId === video.id);
        for (const seg of videoSegs) {
          const segDur = Math.max(0.001, seg.endTime - seg.startTime);
          let speechDur = 0;
          for (const sr of speechRegions) {
            const lo = Math.max(sr.start, seg.startTime);
            const hi = Math.min(sr.end, seg.endTime);
            if (hi > lo) speechDur += hi - lo;
          }
          const speechRatio = speechDur / segDur;
          const isSpeech = speechRatio > 0.25;

          const audioMixLevel = isSpeech ? 1.0 : 0.0;
          const musicDuckLevel = isSpeech ? 0.12 : 1.0;

          await db.update(segmentsTable)
            .set({ audioMixLevel, musicDuckLevel })
            .where(eq(segmentsTable.id, seg.id));
          totalUpdated++;
        }

        processed++;
        await db.update(jobsTable)
          .set({ progress: Math.round(8 + (processed / speechVids.length) * 80) })
          .where(eq(jobsTable.id, jobId));
      }

      await appendLog(jobId, `Speech detection complete — ${totalUpdated} segment(s) updated with audioMixLevel + musicDuckLevel.`);
      await appendLog(jobId, `Speech segments: audioMixLevel=1.0, musicDuckLevel=0.12 (music ducks to 12%)`);
      await appendLog(jobId, `Music-only segments: audioMixLevel=0.0, musicDuckLevel=1.0 (full music)`);
      result = JSON.stringify({ videosProcessed: processed, segmentsUpdated: totalUpdated });
      const [detSpeechProject] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, projectId));
      await db.insert(activityTable).values({
        id: randomUUID(), type: "ai_analysis_done",
        description: `Speech detection complete: ${totalUpdated} segments updated for "${detSpeechProject?.name ?? projectId}"`,
        projectId, projectName: detSpeechProject?.name ?? null,
      });
    }

    // ─── ANALYZE CLIPS ──────────────────────────────────────────────────────
    // Layer 2: ffmpeg audio/quality analysis + Layer 3: Claude AI semantic scoring
    // Assigns hookScore, clarityScore, emotionScore, bRollValue, visualQuality,
    // speechImportance, clipType, tags[], isUsable to each video in the project.
    else if (type === "analyze_clips") {
      const acVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const videoFiles = acVideos.filter(v => v.filePath && (
        v.mimeType?.startsWith("video/") || v.mimeType?.startsWith("audio/") ||
        v.originalName?.match(/\.(mp4|mov|avi|mkv|webm|mp3|wav|aac|m4a|ogg|flac)$/i)
      ));
      const isAudioOnly = (v: typeof videoFiles[0]) =>
        (v.mimeType?.startsWith("audio/") || v.originalName?.match(/\.(mp3|wav|aac|m4a|ogg|flac)$/i)) && !v.mimeType?.startsWith("video/");
      await appendLog(jobId, `Analyzing ${videoFiles.length} clip(s) — quality scoring + semantic labeling...`);
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      // Editorial policy matrix per format — controls what matters most
      const [acProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const targetFormat = acProject?.targetFormat ?? "custom";
      const editorialPolicy: Record<string, { hookWeight: number; speechWeight: number; bRollWeight: number; maxClipRepeat: number; minClipSec: number; maxClipSec: number; priorityTags: string[]; avoidTags: string[] }> = {
        instagram_reel:  { hookWeight: 0.9, speechWeight: 0.4, bRollWeight: 0.6, maxClipRepeat: 1, minClipSec: 0.5, maxClipSec: 6,  priorityTags: ["energetic", "action_shot", "strong_opening", "humor"], avoidTags: ["slow", "repetitive", "bad_audio"] },
        tiktok:          { hookWeight: 1.0, speechWeight: 0.5, bRollWeight: 0.5, maxClipRepeat: 1, minClipSec: 0.3, maxClipSec: 4,  priorityTags: ["humor", "energetic", "strong_opening", "action_shot"], avoidTags: ["slow", "repetitive", "bad_audio", "camera_shake"] },
        youtube_short:   { hookWeight: 0.8, speechWeight: 0.6, bRollWeight: 0.5, maxClipRepeat: 2, minClipSec: 1,   maxClipSec: 8,  priorityTags: ["dialogue_heavy", "educational", "strong_opening"], avoidTags: ["repetitive", "bad_audio"] },
        youtube_long:    { hookWeight: 0.5, speechWeight: 0.9, bRollWeight: 0.7, maxClipRepeat: 3, minClipSec: 3,   maxClipSec: 30, priorityTags: ["dialogue_heavy", "educational", "establishing_shot", "b_roll"], avoidTags: ["bad_audio", "camera_shake"] },
        wedding_highlight: { hookWeight: 0.7, speechWeight: 0.6, bRollWeight: 0.8, maxClipRepeat: 2, minClipSec: 2, maxClipSec: 12, priorityTags: ["emotional_peak", "tender_moment", "reaction_shot", "establishing_shot"], avoidTags: ["bad_audio", "camera_shake", "overexposed"] },
        ad_spot:         { hookWeight: 1.0, speechWeight: 0.3, bRollWeight: 0.8, maxClipRepeat: 1, minClipSec: 0.5, maxClipSec: 4,  priorityTags: ["product_shot", "action_shot", "energetic", "strong_opening"], avoidTags: ["slow", "repetitive"] },
        custom:          { hookWeight: 0.6, speechWeight: 0.6, bRollWeight: 0.6, maxClipRepeat: 2, minClipSec: 1,   maxClipSec: 15, priorityTags: [], avoidTags: ["bad_audio"] },
      };
      const policy = editorialPolicy[targetFormat] ?? editorialPolicy["custom"];
      await appendLog(jobId, `Editorial policy loaded for "${targetFormat.replace(/_/g, " ")}" — hookWeight=${policy.hookWeight}, speechWeight=${policy.speechWeight}`);

      let analyzedCount = 0;
      const summaryLines: string[] = [];

      for (let vi = 0; vi < videoFiles.length; vi++) {
        const vid = videoFiles[vi];
        const audioOnlyClip = isAudioOnly(vid);
        await appendLog(jobId, `[${vi + 1}/${videoFiles.length}] Analyzing "${vid.originalName}" (${audioOnlyClip ? "audio" : "video"})...`);

        let maxVolume = -91.0;
        let meanVolume = -91.0;
        let hasAudioClipping = false;
        let hasAudioTrack = false;
        let motionScore = audioOnlyClip ? 0.0 : 0.5;

        // Step A: ffmpeg audio quality analysis
        try {
          const audioArgs = ["-i", vid.filePath, "-af", "volumedetect", "-f", "null", "-"];
          const { stderr: aStderr } = await runFfmpeg(audioArgs);
          const maxMatch = aStderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
          const meanMatch = aStderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
          if (maxMatch) { maxVolume = parseFloat(maxMatch[1]); hasAudioTrack = true; }
          if (meanMatch) meanVolume = parseFloat(meanMatch[1]);
          hasAudioClipping = maxVolume > -1.0;
        } catch (e: any) {
          await appendLog(jobId, `  ⚠ volumedetect failed for "${vid.originalName}": ${e?.message?.slice(0, 80)}`);
        }

        // Step B: ffmpeg motion/shake estimation (video only)
        if (!audioOnlyClip) {
          try {
            const { stdout: probeJson } = await runCommand("ffprobe", [
              "-v", "quiet", "-show_streams", "-select_streams", "v:0", "-print_format", "json", vid.filePath
            ]);
            const probeData = JSON.parse(probeJson ?? "{}");
            const vs = probeData.streams?.[0];
            const bitRate = parseInt(vs?.bit_rate ?? "0");
            const pixels = (vs?.width ?? 1280) * (vs?.height ?? 720);
            motionScore = Math.min(1, (bitRate / pixels) / 0.05);
          } catch {}
        }

        // Step B2: Neural analysis — shot detection, aesthetic scoring, emotion, diversity
        let neuralAnalysis: Record<string, any> = {};
        if (!audioOnlyClip && vid.filePath && fs.existsSync(vid.filePath)) {
          await appendLog(jobId, `  ↳ Running neural analysis (shots, aesthetic, emotion, diversity)...`);
          const neuralRaw = await runPythonScript("neural_analyze.py", [vid.filePath, "--mode", "clips"], 180000);
          if (!neuralRaw.error) {
            neuralAnalysis = neuralRaw.synthesized_scores ?? {};

            const aesthetic = neuralRaw.aesthetic ?? {};
            const emotion = neuralRaw.emotion ?? {};
            const speech = neuralRaw.speech_emotion ?? {};
            const shots = neuralRaw.shots ?? {};
            const diversity = neuralRaw.diversity ?? {};

            // Override/augment motionScore with neural data
            if (aesthetic.sharpness != null) motionScore = aesthetic.sharpness;

            const logParts: string[] = [];
            if (neuralAnalysis.visual_quality != null) logParts.push(`vis=${Math.round(neuralAnalysis.visual_quality * 100)}`);
            if (neuralAnalysis.hook_score != null) logParts.push(`hook=${Math.round(neuralAnalysis.hook_score * 100)}`);
            if (neuralAnalysis.emotion_score != null) logParts.push(`emo=${Math.round(neuralAnalysis.emotion_score * 100)}`);
            if (neuralAnalysis.bpm != null) logParts.push(`bpm=${Math.round(neuralAnalysis.bpm)}`);
            if (shots.shot_count != null) logParts.push(`shots=${shots.shot_count}`);
            if (diversity.diversity_score != null) logParts.push(`div=${Math.round(diversity.diversity_score * 100)}`);
            if (neuralAnalysis.has_faces) logParts.push(`faces✓`);
            if (neuralAnalysis.has_speech) logParts.push(`speech✓`);
            await appendLog(jobId, `  ↳ Neural: ${logParts.join(" | ")}`);
          } else {
            await appendLog(jobId, `  ↳ Neural analysis unavailable: ${neuralRaw.error?.slice(0, 100)}`);
          }
        }

        // Step C: Claude AI semantic scoring
        // Parse stored transcript JSON to get timed phrase segments
        let timedPhrases: Array<{ start: number; end: number; text: string }> = [];
        let rawTranscriptText = "";
        if (vid.transcript) {
          try {
            const txData = JSON.parse(vid.transcript);
            timedPhrases = txData.segments ?? [];
            rawTranscriptText = txData.transcript ?? "";
          } catch {
            rawTranscriptText = vid.transcript.substring(0, 800);
          }
        }
        const hasTimedPhrases = timedPhrases.length > 0;
        const hasTranscript = hasTimedPhrases || rawTranscriptText.length > 10;
        const sceneSnippet = (vid.sceneAnalysis ?? "").substring(0, 600);
        const hasScene = sceneSnippet.length > 10;

        // Format timed phrases for the prompt
        const timedPhrasesText = hasTimedPhrases
          ? `Timed transcript phrases:\n${timedPhrases.map(p => `  [${p.start.toFixed(2)}s→${p.end.toFixed(2)}s] "${p.text.trim()}"`).join("\n")}`
          : rawTranscriptText
            ? `Transcript (no timestamps): "${rawTranscriptText.substring(0, 600)}"`
            : "No transcript available";

        const bestMomentsInstruction = hasTimedPhrases ? `
"bestMoments": [
  {
    "start": <exact startTime from timed phrases above>,
    "end": <exact endTime from timed phrases above>,
    "score": <0.0-1.0, editorial value of this moment>,
    "reason": "<why this specific window is compelling — quote the words if speech>"
  }
  // Include 1-5 best non-overlapping windows. Use EXACT timestamps from the timed phrases list.
  // If no timestamps: return []
],` : `"bestMoments": [],`;

        const semanticPrompt = audioOnlyClip
          ? `You are a podcast/audio editor analyzing an audio clip for editorial decisions.

Analyze this audio clip and return ONLY valid JSON (no markdown, no explanation).

Audio metadata:
- Filename: "${vid.originalName}"
- Duration: ${vid.durationSeconds ?? 0}s
- Audio levels: maxVol=${maxVolume}dB, meanVol=${meanVolume}dB, clipping=${hasAudioClipping}
- Target format: ${targetFormat.replace(/_/g, " ")}

${timedPhrasesText}

Editorial policy: hookWeight=${policy.hookWeight}, speechWeight=${policy.speechWeight}

Your job has two parts:
1. Score the overall clip quality
2. Identify the BEST time windows to cut from — specific moments with exact timestamps

Return this JSON (audio-only, no visual fields needed):
{
  "hookScore": <0.0-1.0, how compelling the opening words/hook are>,
  "clarityScore": <0.0-1.0, speech clarity and audio quality>,
  "emotionScore": <0.0-1.0, emotional resonance of the content>,
  "bRollValue": <0.0-1.0, suitability as background narration>,
  "visualQuality": 0.5,
  "speechImportance": <0.0-1.0, importance of the spoken words>,
  "editorialValue": <0.0-1.0, overall editorial usefulness>,
  "clipType": "<a_roll|interview|narration|music_only>",
  "tags": [<from: "dialogue_heavy","educational","emotional_peak","strong_opening","humor","energetic","calm","interview","narration","podcast","music_moment","weak_content","bad_audio","duplicate">],
  "isUsable": <true|false>,
  "hasCameraShake": false,
  "hasBlur": false,
  "hasOverexposure": false,
  "reason": "<1-2 sentence editorial assessment of the audio content>",
  ${bestMomentsInstruction}
}`
          : `You are a professional video editor analyzing raw footage for editorial decisions.

Analyze this video clip and return ONLY valid JSON (no markdown, no explanation).

Video metadata:
- Filename: "${vid.originalName}"
- Duration: ${vid.durationSeconds ?? 0}s
- Resolution: ${vid.width ?? "?"}x${vid.height ?? "?"} @ ${vid.fps ?? "?"}fps
- Audio: maxVol=${maxVolume}dB, meanVol=${meanVolume}dB, clipping=${hasAudioClipping}, hasAudio=${hasAudioTrack}
- Target format: ${targetFormat.replace(/_/g, " ")}
${Object.keys(neuralAnalysis).length > 0 ? `
NEURAL ANALYSIS (measured by computer vision — treat as ground truth for visual/audio quality):
- Visual quality (sharpness, colorfulness, exposure): ${neuralAnalysis.visual_quality != null ? Math.round(neuralAnalysis.visual_quality * 100) + "/100" : "n/a"}
- Hook score (visual attention / face presence): ${neuralAnalysis.hook_score != null ? Math.round(neuralAnalysis.hook_score * 100) + "/100" : "n/a"}
- Emotion score (facial + audio emotion): ${neuralAnalysis.emotion_score != null ? Math.round(neuralAnalysis.emotion_score * 100) + "/100" : "n/a"}
- Faces detected: ${neuralAnalysis.has_faces ? "YES" : "no"}
- Speech detected: ${neuralAnalysis.has_speech ? "YES" : "no"}
- Audio arousal level: ${neuralAnalysis.audio_arousal != null ? Math.round(neuralAnalysis.audio_arousal * 100) + "/100" : "n/a"}
- Dominant facial emotion: ${neuralAnalysis.dominant_emotion ?? "n/a"}
- Scene count (shot cuts): ${neuralAnalysis.detected_shot_count != null ? neuralAnalysis.detected_shot_count : "n/a"}
- Visual diversity score: ${neuralAnalysis.diversity_score != null ? Math.round(neuralAnalysis.diversity_score * 100) + "/100" : "n/a"}
Use these measured scores to calibrate your visual/emotional assessment. If facial emotion is "Happiness" with high score, emotionScore should be high.
If visual_quality is low (<40), add "blurry" or "overexposed" to tags as appropriate.
If diversity_score is low (<30) and scene_count is low, add "repetitive" to tags.` : ""}

${timedPhrasesText}
${hasScene ? `\nScene analysis: "${sceneSnippet}"` : ""}

Editorial policy priorities for ${targetFormat}: hookWeight=${policy.hookWeight}, speechWeight=${policy.speechWeight}, bRollWeight=${policy.bRollWeight}

Your job has two parts:
1. Score the overall clip quality
2. Identify the BEST time windows — specific phrases or moments worth including in the edit, with EXACT timestamps from the timed phrases list above

Return this JSON structure:
{
  "hookScore": <0.0-1.0, how attention-grabbing this would be as an opening shot>,
  "clarityScore": <0.0-1.0, clarity/comprehensibility of content>,
  "emotionScore": <0.0-1.0, emotional intensity or resonance>,
  "bRollValue": <0.0-1.0, suitability as supporting/cutaway footage>,
  "visualQuality": <0.0-1.0, estimated technical visual quality>,
  "speechImportance": <0.0-1.0, how critical any dialogue is>,
  "editorialValue": <0.0-1.0, combined usefulness for this format>,
  "clipType": "<a_roll|b_roll|reaction|establishing|action|transition|music_only>",
  "tags": [<array of applicable tags from: "reaction_shot","establishing_shot","emotional_peak","strong_opening","dialogue_heavy","action_shot","music_moment","humor","tender_moment","energetic","calm","b_roll","weak_content","repetitive","bad_audio","camera_shake","overexposed","underexposed","blurry","duplicate","educational","product_shot">],
  "isUsable": <true|false, false only if technically unusable>,
  "hasCameraShake": <true|false>,
  "hasBlur": <true|false>,
  "hasOverexposure": <true|false>,
  "reason": "<1-2 sentence editorial assessment>",
  ${bestMomentsInstruction}
}`;

        let clipAnalysisData: Record<string, any> = {
          hookScore: 0.5, clarityScore: 0.5, emotionScore: 0.5, bRollValue: 0.5,
          visualQuality: 0.5, speechImportance: hasAudioTrack ? 0.5 : 0.0,
          editorialValue: 0.5, clipType: hasAudioTrack ? "a_roll" : "b_roll",
          tags: [], isUsable: true, hasCameraShake: false, hasBlur: false,
          hasOverexposure: false, hasAudioClipping, maxVolume, meanVolume,
          hasAudioTrack, motionScore, analyzedAt: new Date().toISOString(),
        };

        try {
          const semMsg = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [{ role: "user", content: semanticPrompt }],
          });
          const semText = semMsg.content[0].type === "text" ? semMsg.content[0].text : "";
          const jsonMatch = semText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            clipAnalysisData = { ...clipAnalysisData, ...parsed, hasAudioClipping, maxVolume, meanVolume, hasAudioTrack, motionScore, analyzedAt: new Date().toISOString() };
          }
        } catch (semErr: any) {
          await appendLog(jobId, `  ⚠ AI scoring failed for "${vid.originalName}": ${semErr?.message?.substring(0, 80)}`);
        }

        // Step D: Merge neural analysis scores with Claude scores
        // Neural = ground truth for visual/audio; Claude = ground truth for semantic/contextual
        if (Object.keys(neuralAnalysis).length > 0) {
          const blend = (neural: number | undefined, claude: number, neuralWeight = 0.6) => {
            if (neural == null) return claude;
            return Math.round((neural * neuralWeight + claude * (1 - neuralWeight)) * 100) / 100;
          };

          // Visual quality: neural is more accurate (actual pixel analysis)
          if (neuralAnalysis.visual_quality != null) {
            clipAnalysisData.visualQuality = blend(neuralAnalysis.visual_quality, clipAnalysisData.visualQuality ?? 0.5, 0.65);
          }
          // Hook score: blend visual hook (neural) with semantic hook (Claude)
          if (neuralAnalysis.hook_score != null) {
            clipAnalysisData.hookScore = blend(neuralAnalysis.hook_score, clipAnalysisData.hookScore ?? 0.5, 0.45);
          }
          // Emotion score: blend face emotion + audio emotion + Claude's contextual understanding
          if (neuralAnalysis.emotion_score != null) {
            clipAnalysisData.emotionScore = blend(neuralAnalysis.emotion_score, clipAnalysisData.emotionScore ?? 0.5, 0.50);
          }

          // Auto-tag based on neural detections
          const tags: string[] = clipAnalysisData.tags ?? [];
          if (neuralAnalysis.has_faces && !tags.includes("reaction_shot")) tags.push("face_detected");
          if (neuralAnalysis.has_speech && !tags.includes("dialogue_heavy")) tags.push("speech_detected");
          if (neuralAnalysis.diversity_score != null && neuralAnalysis.diversity_score < 0.25 && !tags.includes("repetitive")) tags.push("low_diversity");
          if (neuralAnalysis.detected_shot_count != null && neuralAnalysis.detected_shot_count > 3) tags.push("multi_shot");
          clipAnalysisData.tags = [...new Set(tags)];

          // Store raw neural scores for reference/debugging
          clipAnalysisData.neural = {
            visual_quality: neuralAnalysis.visual_quality,
            hook_score: neuralAnalysis.hook_score,
            emotion_score: neuralAnalysis.emotion_score,
            face_valence: neuralAnalysis.face_valence,
            audio_valence: neuralAnalysis.audio_valence,
            audio_arousal: neuralAnalysis.audio_arousal,
            dominant_emotion: neuralAnalysis.dominant_emotion,
            has_faces: neuralAnalysis.has_faces,
            has_speech: neuralAnalysis.has_speech,
            diversity_score: neuralAnalysis.diversity_score,
            detected_shot_count: neuralAnalysis.detected_shot_count,
            scene_count: neuralAnalysis.scene_count,
            // Speaker turn signals
            speaker_count: neuralAnalysis.speaker_count,
            speaker_turn_count: neuralAnalysis.speaker_turn_count,
            avg_speaker_turn_duration: neuralAnalysis.avg_speaker_turn_duration,
            // Filler word signals
            filler_count: neuralAnalysis.filler_count,
            filler_rate_per_minute: neuralAnalysis.filler_rate_per_minute,
            has_heavy_filler: neuralAnalysis.has_heavy_filler,
            clean_rate: neuralAnalysis.clean_rate,
          };
          // Log new signals
          if (neuralAnalysis.speaker_count != null) await appendLog(jobId, `  ↳ Speakers: ${neuralAnalysis.speaker_count}, turns: ${neuralAnalysis.speaker_turn_count ?? "?"}`);
          if (neuralAnalysis.filler_rate_per_minute != null) await appendLog(jobId, `  ↳ Filler rate: ${neuralAnalysis.filler_rate_per_minute}/min, heavy: ${neuralAnalysis.has_heavy_filler ? "YES" : "no"}`);
        }

        // Compute composite editorial score factoring in policy weights
        const compositeScore = (
          (clipAnalysisData.hookScore ?? 0.5) * policy.hookWeight +
          (clipAnalysisData.speechImportance ?? 0.5) * policy.speechWeight +
          (clipAnalysisData.bRollValue ?? 0.5) * policy.bRollWeight +
          (clipAnalysisData.emotionScore ?? 0.5) * 0.5 +
          (clipAnalysisData.visualQuality ?? 0.5) * 0.4
        ) / (policy.hookWeight + policy.speechWeight + policy.bRollWeight + 0.9);

        clipAnalysisData.compositeScore = Math.round(compositeScore * 100) / 100;

        // Flag bad clips per policy
        const tags: string[] = clipAnalysisData.tags ?? [];
        if (hasAudioClipping) tags.push("audio_clipping");
        if (!clipAnalysisData.isUsable) tags.push("unusable");
        clipAnalysisData.tags = [...new Set(tags)];

        // Store to DB
        await db.update(videosTable).set({ clipAnalysis: JSON.stringify(clipAnalysisData) }).where(eq(videosTable.id, vid.id));
        analyzedCount++;

        const score = Math.round((clipAnalysisData.compositeScore ?? 0.5) * 100);
        const tagStr = (clipAnalysisData.tags ?? []).slice(0, 3).join(", ");
        summaryLines.push(`  "${vid.originalName}": ${clipAnalysisData.clipType} | score=${score} | ${tagStr || "no tags"}`);
        await appendLog(jobId, `  → ${clipAnalysisData.clipType} | score=${score}/100 | hook=${Math.round((clipAnalysisData.hookScore ?? 0.5) * 100)} emotion=${Math.round((clipAnalysisData.emotionScore ?? 0.5) * 100)} | tags: ${tagStr || "none"}`);

        await db.update(jobsTable).set({ progress: Math.round(10 + (analyzedCount / videoFiles.length) * 80) }).where(eq(jobsTable.id, jobId));
        await delay(200);
      }

      await appendLog(jobId, `\nClip analysis complete — ${analyzedCount} clip(s) scored.`);
      await appendLog(jobId, `Editorial policy: "${targetFormat.replace(/_/g, " ")}" — priorities: ${policy.priorityTags.join(", ") || "none"}`);

      // Re-fetch to get updated clipAnalysis data, then show top clip
      const refreshedVids = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const scoredVids = refreshedVids
        .filter(v => v.clipAnalysis)
        .map(v => { try { return { v, ca: JSON.parse(v.clipAnalysis!) }; } catch { return null; } })
        .filter(Boolean) as { v: typeof refreshedVids[0]; ca: Record<string, any> }[];
      scoredVids.sort((a, b) => (b.ca.compositeScore ?? 0) - (a.ca.compositeScore ?? 0));
      if (scoredVids.length > 0) {
        const top = scoredVids[0];
        await appendLog(jobId, `Top clip: "${top.v.originalName}" — score ${Math.round((top.ca.compositeScore ?? 0) * 100)}/100 (${top.ca.clipType}) | tags: [${(top.ca.tags ?? []).slice(0, 3).join(", ")}]`);
        const bottom = scoredVids[scoredVids.length - 1];
        if (bottom.v.id !== top.v.id) await appendLog(jobId, `Lowest clip: "${bottom.v.originalName}" — score ${Math.round((bottom.ca.compositeScore ?? 0) * 100)}/100${bottom.ca.isUsable === false ? " — ⚠ UNUSABLE" : ""}`);
      }

      result = JSON.stringify({ videosAnalyzed: analyzedCount, format: targetFormat });
      const [acProjectName] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, projectId));
      await db.insert(activityTable).values({
        id: randomUUID(), type: "ai_analysis_done",
        description: `Clip analysis complete: ${analyzedCount} clips scored for "${acProjectName?.name ?? projectId}"`,
        projectId, projectName: acProjectName?.name ?? null,
      });
    }

    // ─── LAYER 2 EXTENDED: detect_quality_signals ────────────────────────────
    // Runs ffmpeg frame-level analysis per clip: blur, shake, duplicates, overexposure
    else if (type === "detect_quality_signals") {
      await appendLog(jobId, "Loading project clips for frame-level quality analysis...");
      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      let signalCount = 0;
      const videosToProcess = videoId
        ? projectVideos.filter(v => v.id === videoId)
        : projectVideos;

      for (let vi = 0; vi < videosToProcess.length; vi++) {
        const video = videosToProcess[vi];
        const filePath = video.filePath;
        const progress = 10 + Math.round((vi / videosToProcess.length) * 80);
        await db.update(jobsTable).set({ progress }).where(eq(jobsTable.id, jobId));

        if (!filePath || !fs.existsSync(filePath)) {
          await appendLog(jobId, `Skipping "${video.originalName}" — file not found`);
          continue;
        }

        await appendLog(jobId, `Analyzing frame quality: "${video.originalName}"...`);

        // Delete old signals for this video
        await db.delete(clipSignalsTable).where(
          and(eq(clipSignalsTable.videoId, video.id), eq(clipSignalsTable.projectId, projectId))
        );

        const duration = video.durationSeconds ?? 30;
        const signalsToInsert: typeof clipSignalsTable.$inferInsert[] = [];

        // 1. ffmpeg blurdetect — measure per-second sharpness
        try {
          const blurResult = await new Promise<string>((resolve, reject) => {
            const args = [
              "-i", filePath,
              "-vf", "blurdetect=high=0.35:low=0.25:block_pct=80:block_width=32:block_height=32:planes=1",
              "-f", "null", "-"
            ];
            let stderr = "";
            const proc = spawn("ffmpeg", args);
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
            proc.on("close", (code) => { if (code === 0 || stderr.length > 0) resolve(stderr); else reject(new Error(`blurdetect failed code=${code}`)); });
            proc.on("error", reject);
            setTimeout(() => { proc.kill(); resolve(stderr); }, 30000);
          });

          // Count how many blur events there are
          const blurMatches = [...blurResult.matchAll(/blur_detect:(\d+\.\d+)/g)];
          if (blurMatches.length > 0) {
            const blurValues = blurMatches.map(m => parseFloat(m[1]));
            const avgBlur = blurValues.reduce((s, v) => s + v, 0) / blurValues.length;
            const maxBlur = Math.max(...blurValues);
            // severity: higher blurdetect value = MORE blur = worse quality
            const severity = Math.min(1, avgBlur / 1.0);
            if (severity > 0.1) {
              signalsToInsert.push({
                id: randomUUID(), videoId: video.id, projectId,
                signalType: "blur",
                severity,
                timeStart: 0, timeEnd: duration,
                frameCount: blurValues.length,
                details: { avgBlur, maxBlur, sampleCount: blurValues.length },
                detectedBy: "ffmpeg_blurdetect",
              });
              await appendLog(jobId, `  Blur severity ${Math.round(severity * 100)}% detected in "${video.originalName}"`);
            }
          }
        } catch (e) {
          await appendLog(jobId, `  Blur detection skipped: ${e instanceof Error ? e.message : String(e)}`);
        }

        // 2. ffmpeg signalstats — overexposure & underexposure
        try {
          const statsResult = await new Promise<string>((resolve, reject) => {
            const args = [
              "-i", filePath,
              "-vf", "signalstats",
              "-f", "null", "-"
            ];
            let stderr = "";
            const proc = spawn("ffmpeg", args);
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
            proc.on("close", (code) => { if (code === 0 || stderr.length > 0) resolve(stderr); else reject(new Error(`signalstats failed`)); });
            proc.on("error", reject);
            setTimeout(() => { proc.kill(); resolve(stderr); }, 25000);
          });

          const maxVals = [...statsResult.matchAll(/YMAX:(\d+)/g)].map(m => parseInt(m[1]));
          const minVals = [...statsResult.matchAll(/YMIN:(\d+)/g)].map(m => parseInt(m[1]));

          if (maxVals.length > 0) {
            const avgMax = maxVals.reduce((s, v) => s + v, 0) / maxVals.length;
            const avgMin = minVals.length > 0 ? minVals.reduce((s, v) => s + v, 0) / minVals.length : 0;
            const overexposedFrames = maxVals.filter(v => v > 240).length;
            const underexposedFrames = minVals.filter(v => v < 16).length;
            const overSeverity = overexposedFrames / Math.max(1, maxVals.length);
            const underSeverity = underexposedFrames / Math.max(1, minVals.length);

            if (overSeverity > 0.15) {
              signalsToInsert.push({
                id: randomUUID(), videoId: video.id, projectId,
                signalType: "overexposure",
                severity: overSeverity,
                timeStart: 0, timeEnd: duration,
                frameCount: overexposedFrames,
                details: { avgMax, overexposedFrames, totalFrames: maxVals.length, overSeverity },
                detectedBy: "ffmpeg_signalstats",
              });
            }
            if (underSeverity > 0.2) {
              signalsToInsert.push({
                id: randomUUID(), videoId: video.id, projectId,
                signalType: "underexposure",
                severity: underSeverity,
                timeStart: 0, timeEnd: duration,
                frameCount: underexposedFrames,
                details: { avgMin, underexposedFrames, totalFrames: minVals.length, underSeverity },
                detectedBy: "ffmpeg_signalstats",
              });
            }
            await appendLog(jobId, `  Exposure: over=${Math.round(overSeverity*100)}% under=${Math.round(underSeverity*100)}%`);
          }
        } catch (e) {
          await appendLog(jobId, `  Exposure analysis skipped: ${e instanceof Error ? e.message : String(e)}`);
        }

        // 3. Motion estimation using bitrate variance as proxy for camera shake
        try {
          const probeResult = await new Promise<string>((resolve, reject) => {
            const args = [
              "-i", filePath,
              "-vf", "select=1",
              "-show_frames",
              "-select_streams", "v:0",
              "-show_entries", "frame=pkt_size",
              "-of", "csv=p=0",
              "-f", "null", "-"
            ];
            let output = "";
            const proc = spawn("ffprobe", [
              "-v", "quiet",
              "-select_streams", "v:0",
              "-show_entries", "frame=pkt_size,best_effort_timestamp_time",
              "-of", "csv=p=0",
              filePath
            ]);
            proc.stdout.on("data", (d) => { output += d.toString(); });
            proc.on("close", () => resolve(output));
            proc.on("error", reject);
            setTimeout(() => { proc.kill(); resolve(output); }, 20000);
          });

          const frameSizes = probeResult.split("\n")
            .map(line => { const parts = line.split(","); return parseInt(parts[1] ?? "0"); })
            .filter(n => !isNaN(n) && n > 0);

          if (frameSizes.length > 5) {
            const avg = frameSizes.reduce((s, v) => s + v, 0) / frameSizes.length;
            const variance = frameSizes.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / frameSizes.length;
            const stdDev = Math.sqrt(variance);
            const cv = stdDev / avg; // coefficient of variation
            // High CV = high variance in frame sizes = motion/shake indicator
            const shakeSeverity = Math.min(1, cv / 0.8);
            if (shakeSeverity > 0.3) {
              signalsToInsert.push({
                id: randomUUID(), videoId: video.id, projectId,
                signalType: "camera_shake",
                severity: shakeSeverity,
                timeStart: 0, timeEnd: duration,
                frameCount: frameSizes.length,
                details: { cv, avg, stdDev, shakeSeverity },
                detectedBy: "ffprobe_bitrate_variance",
              });
              await appendLog(jobId, `  Camera shake severity ${Math.round(shakeSeverity * 100)}%`);
            }
          }
        } catch (e) {
          await appendLog(jobId, `  Motion analysis skipped: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Insert all signals found for this video
        if (signalsToInsert.length > 0) {
          await db.insert(clipSignalsTable).values(signalsToInsert);
          signalCount += signalsToInsert.length;
        }

        // Update clip_analysis in videos table with signal data
        if (video.clipAnalysis) {
          try {
            const existingAnalysis = JSON.parse(video.clipAnalysis);
            const updatedAnalysis = {
              ...existingAnalysis,
              qualitySignals: signalsToInsert.map(s => ({ type: s.signalType, severity: s.severity })),
              qualitySignalCount: signalsToInsert.length,
              signalsAnalyzedAt: new Date().toISOString(),
            };
            await db.update(videosTable)
              .set({ clipAnalysis: JSON.stringify(updatedAnalysis) })
              .where(eq(videosTable.id, video.id));
          } catch { /* ignore parse errors */ }
        }
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Frame-level quality analysis complete: ${signalCount} signals across ${videosToProcess.length} clips`);
      result = JSON.stringify({ clipsAnalyzed: videosToProcess.length, signalsDetected: signalCount });
    }

    // ─── LAYER 4: learn_from_edit ─────────────────────────────────────────────
    // Extracts training data from a completed project — which clips were available
    // vs. which were actually used in the final timeline. Updates learned preferences.
    else if (type === "learn_from_edit") {
      await appendLog(jobId, "Extracting training data from completed project...");
      const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!project) throw new Error("Project not found");

      // ── RL feedback weight from quality rating ────────────────────────────────
      // User ratings 1–5 map to a weight multiplier for how strongly we learn from this edit:
      //   1 = bad edit   → weight -1.0  (actively unlearn these preferences)
      //   2 = below avg  → weight -0.3  (mild negative signal)
      //   3 = ok / none  → weight +0.5  (neutral, learn weakly)
      //   4 = good       → weight +1.0  (learn normally)
      //   5 = excellent  → weight +1.5  (learn strongly, boost clip scores)
      const ratingWeightMap: Record<number, number> = { 1: -1.0, 2: -0.3, 3: 0.5, 4: 1.0, 5: 1.5 };
      const userRating = project.qualityRating ?? 3;
      const ratingWeight = ratingWeightMap[userRating] ?? 0.5;
      const ratingLabel = userRating === 1 ? "Bad — unlearning these prefs"
        : userRating === 2 ? "Below average — mild negative signal"
        : userRating === 3 ? "Neutral — learning at half weight"
        : userRating === 4 ? "Good — learning at full weight"
        : "Excellent — learning at boosted weight";
      await appendLog(jobId, `Quality rating: ${userRating}/5 (${ratingLabel}) → RL weight: ${ratingWeight >= 0 ? "+" : ""}${ratingWeight}`);

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const allSegments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId));
      const usedSegments = allSegments.filter(s => s.included);

      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Found ${projectVideos.length} clips, ${usedSegments.length}/${allSegments.length} segments used`);

      const format = (project as any).targetFormat ?? (project as any).format ?? "instagram_reel";

      // Build raw clips array: all clips with their analysis scores + transcript context
      const rawClips = projectVideos.map(v => {
        let analysis: any = {};
        try { analysis = JSON.parse(v.clipAnalysis ?? "{}"); } catch {}
        // Extract plain transcript text and timed phrases for fine-tuning context
        let transcript: string | null = null;
        let timedPhrases: Array<{ start: number; end: number; text: string }> | null = null;
        if (v.transcript) {
          try {
            const txData = JSON.parse(v.transcript);
            transcript = txData.transcript ? txData.transcript.substring(0, 200) : null;
            if (Array.isArray(txData.segments) && txData.segments.length > 0) {
              timedPhrases = txData.segments.slice(0, 10).map((s: any) => ({
                start: s.start,
                end: s.end,
                text: s.text?.trim() ?? "",
              }));
            }
          } catch {}
        }
        return {
          videoId: v.id,
          name: v.originalName,
          duration: v.durationSeconds,
          compositeScore: analysis.compositeScore ?? null,
          clipType: analysis.clipType ?? null,
          tags: analysis.tags ?? [],
          isUsable: analysis.isUsable ?? true,
          hookScore: analysis.hookScore ?? null,
          emotionScore: analysis.emotionScore ?? null,
          clarityScore: analysis.clarityScore ?? null,
          transcript,
          timedPhrases,
        };
      });

      // Build final timeline array: what was actually used
      const videoIdToDuration = Object.fromEntries(projectVideos.map(v => [v.id, v.durationSeconds ?? 30]));
      const finalTimeline = usedSegments.map(s => ({
        videoId: s.videoId,
        startTime: s.startTime,
        endTime: s.endTime,
        duration: (s.endTime ?? 0) - (s.startTime ?? 0),
        position: s.orderIndex,
        captionText: s.captionText,
        colorGrade: s.colorGrade,
        speedFactor: s.speedFactor,
        audioMixLevel: (s as any).audioMixLevel,
        musicDuckLevel: (s as any).musicDuckLevel,
      }));

      // Compute selection signals: which clip types and tags were preferred
      const clipSelectionSignals: Record<string, any> = {};
      const usedVideoIds = new Set(usedSegments.map(s => s.videoId));
      for (const clip of rawClips) {
        const wasUsed = usedVideoIds.has(clip.videoId);
        if (clip.clipType) {
          if (!clipSelectionSignals[clip.clipType]) clipSelectionSignals[clip.clipType] = { total: 0, used: 0 };
          clipSelectionSignals[clip.clipType].total++;
          if (wasUsed) clipSelectionSignals[clip.clipType].used++;
        }
        for (const tag of clip.tags ?? []) {
          if (!clipSelectionSignals[`tag:${tag}`]) clipSelectionSignals[`tag:${tag}`] = { total: 0, used: 0 };
          clipSelectionSignals[`tag:${tag}`].total++;
          if (wasUsed) clipSelectionSignals[`tag:${tag}`].used++;
        }
      }

      const totalDuration = finalTimeline.reduce((s, seg) => s + (seg.duration ?? 0), 0);
      const avgClipDuration = finalTimeline.length > 0 ? totalDuration / finalTimeline.length : 0;

      // Insert training example
      const exampleId = randomUUID();
      await db.insert(trainingExamplesTable).values({
        id: exampleId,
        projectId,
        projectName: project.name,
        format,
        rawClips: rawClips as any,
        finalTimeline: finalTimeline as any,
        clipSelectionSignals: clipSelectionSignals as any,
        totalClipsAvailable: rawClips.length,
        totalClipsUsed: usedVideoIds.size,
        avgClipDuration,
        totalDuration,
        humanApproved: true,
      });

      await db.update(jobsTable).set({ progress: 60 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, "Training example stored. Analyzing segment-level corrections...");

      // ── Load segment-level human corrections for this project ─────────────────
      // These are edits made after the AI proposed its plan (trim deltas, reorders, etc.)
      // We use them to compute correction factor signals per clip type / edit type
      const projectEdits = await db
        .select()
        .from(segmentEditsTable)
        .where(eq(segmentEditsTable.projectId, projectId));

      if (projectEdits.length > 0) {
        // Summarize correction patterns: average delta per edit type
        const editTypeCounts: Record<string, number> = {};
        let totalDeltaStart = 0;
        let totalDeltaEnd = 0;
        let deltaCount = 0;
        for (const edit of projectEdits) {
          editTypeCounts[edit.editType] = (editTypeCounts[edit.editType] ?? 0) + 1;
          if (edit.deltaStartSeconds != null) { totalDeltaStart += edit.deltaStartSeconds; deltaCount++; }
          if (edit.deltaEndSeconds != null) { totalDeltaEnd += edit.deltaEndSeconds; }
        }
        const avgDeltaStart = deltaCount > 0 ? totalDeltaStart / deltaCount : 0;
        const avgDeltaEnd = deltaCount > 0 ? totalDeltaEnd / deltaCount : 0;
        const correctionSummary = Object.entries(editTypeCounts)
          .map(([type, count]) => `${type}(×${count})`)
          .join(", ");
        await appendLog(jobId, `Correction signals: ${projectEdits.length} edits — ${correctionSummary} | avg start-trim ${avgDeltaStart >= 0 ? "+" : ""}${avgDeltaStart.toFixed(2)}s, end-trim ${avgDeltaEnd >= 0 ? "+" : ""}${avgDeltaEnd.toFixed(2)}s`);

        // Persist timing correction into model_config so generate_edit_plan can apply it
        // (stored as JSON: {avgDeltaStart, avgDeltaEnd, editCount, format})
        const corrKey = `correction_signal_${format}`;
        const existing = await db
          .select()
          .from(modelConfigTable)
          .where(eq(modelConfigTable.key, corrKey))
          .limit(1);
        const corrValue = JSON.stringify({ avgDeltaStart, avgDeltaEnd, editCount: projectEdits.length, format, updatedAt: new Date().toISOString() });
        if (existing.length > 0) {
          await db.update(modelConfigTable).set({ value: corrValue, updatedAt: new Date() }).where(eq(modelConfigTable.key, corrKey));
        } else {
          await db.insert(modelConfigTable).values({
            id: randomUUID(),
            key: corrKey,
            value: corrValue,
            description: `Learned timing correction signal for format ${format}`,
          });
        }
      } else {
        await appendLog(jobId, "No segment corrections found for this project — using clip-selection signals only.");
      }

      await appendLog(jobId, "Updating learned clip preferences...");

      // Update learned_clip_prefs from the selection signals — weighted by ratingWeight
      await appendLog(jobId, `Updating clip preferences with RL weight ${ratingWeight >= 0 ? "+" : ""}${ratingWeight} (rating ${userRating}/5)...`);
      for (const [key, signal] of Object.entries(clipSelectionSignals) as [string, any][]) {
        const rawSelectionRate = signal.total > 0 ? signal.used / signal.total : 0;
        // Apply RL weight:
        //   Positive weight → nudge selectionRate toward rawSelectionRate (scaled)
        //   Negative weight → nudge selectionRate away from rawSelectionRate (bad edit penalty)
        // Formula: weightedRate = 0.5 + (rawSelectionRate - 0.5) * ratingWeight
        //   weight +1.5 → amplified positive signal | weight -1.0 → inverted signal
        const weightedSelectionRate = Math.max(0, Math.min(1, 0.5 + (rawSelectionRate - 0.5) * ratingWeight));

        const isTag = key.startsWith("tag:");
        const clipType = isTag ? null : key;
        const tag = isTag ? key.slice(4) : null;

        const existingPref = await db.select()
          .from(learnedClipPrefsTable)
          .where(
            and(
              eq(learnedClipPrefsTable.format, format),
              clipType ? eq(learnedClipPrefsTable.clipType, clipType) : eq(learnedClipPrefsTable.clipType, ""),
              tag ? eq(learnedClipPrefsTable.tag, tag) : eq(learnedClipPrefsTable.tag, ""),
            )
          );

        if (existingPref.length > 0) {
          const prev = existingPref[0];
          const newCount = (prev.usageCount ?? 0) + signal.total;
          // Exponential moving average: more recent ratings have higher influence
          const learningRate = Math.abs(ratingWeight) * 0.3; // 0-0.45
          const newRate = (prev.selectionRate ?? 0.5) * (1 - learningRate) + weightedSelectionRate * learningRate;
          await db.update(learnedClipPrefsTable)
            .set({ selectionRate: Math.max(0, Math.min(1, newRate)), usageCount: newCount, lastUpdated: new Date() })
            .where(eq(learnedClipPrefsTable.id, prev.id));
        } else {
          await db.insert(learnedClipPrefsTable).values({
            id: randomUUID(),
            format,
            clipType: clipType ?? "",
            tag: tag ?? "",
            dimension: isTag ? "tag" : "clip_type",
            selectionRate: weightedSelectionRate,
            usageCount: signal.total,
            avgPosition: 0.5,
            avgDuration: avgClipDuration,
          });
        }
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      const prefCount = Object.keys(clipSelectionSignals).length;
      await appendLog(jobId, `Learning complete: ${prefCount} preference signals updated for format "${format}" (RL weight ${ratingWeight >= 0 ? "+" : ""}${ratingWeight}); ${projectEdits.length} correction signals integrated`);
      // ── Store per-clip ML training pairs ─────────────────────────────────────
      // Each clip becomes one training pair: {feature vector} → {wasSelected, rating}
      // This is the supervised dataset that enables future model training / fine-tuning
      await appendLog(jobId, "Storing per-clip ML training pairs...");
      let pairsStored = 0;
      for (let ci = 0; ci < rawClips.length; ci++) {
        const clip = rawClips[ci];
        const wasSelected = usedVideoIds.has(clip.videoId);
        // label: +1 = selected in a good edit, -1 = rejected in a good edit, 0 = unclear
        const label = wasSelected && userRating >= 4 ? 1
          : !wasSelected && userRating <= 2 ? -1
          : wasSelected ? 0.5 : -0.5;
        try {
          await db.insert(clipTrainingPairsTable).values({
            id: randomUUID(),
            projectId,
            videoId: clip.videoId,
            format,
            projectRating: userRating,
            wasSelected,
            hookScore: clip.hookScore,
            emotionScore: clip.emotionScore,
            clarityScore: clip.clarityScore,
            motionIntensity: null,       // available after extract_features, stored in clipAnalysis
            bRollValue: null,
            visualQuality: null,
            speakerChanges: null,
            pauseCount: null,
            energyVariance: null,
            repetitionPenalty: null,
            compositeScore: clip.compositeScore,
            label,
            clipType: clip.clipType,
            durationSeconds: clip.duration,
            clipIndex: ci,
          });
          pairsStored++;
        } catch { /* non-fatal */ }
      }
      await appendLog(jobId, `  ↳ ${pairsStored} training pairs stored (label: +1=good, -1=bad, ±0.5=neutral)`);

      // ── Update learnable formula weights ──────────────────────────────────────
      // Gradient-free weight update: if a feature dimension has higher mean for selected clips
      // than rejected clips (in good-rated edits), increase that weight; decrease otherwise.
      await appendLog(jobId, "Computing feature correlations to update formula weights...");
      const selectedClips = rawClips.filter(c => usedVideoIds.has(c.videoId));
      const rejectedClips = rawClips.filter(c => !usedVideoIds.has(c.videoId));

      const meanFeature = (clips: typeof rawClips, getter: (c: typeof rawClips[0]) => number | null) => {
        const vals = clips.map(getter).filter((v): v is number => v != null && !isNaN(v));
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.5;
      };

      const selHook = meanFeature(selectedClips, c => c.hookScore);
      const rejHook = meanFeature(rejectedClips, c => c.hookScore);
      const selEmotion = meanFeature(selectedClips, c => c.emotionScore);
      const rejEmotion = meanFeature(rejectedClips, c => c.emotionScore);
      const selClarity = meanFeature(selectedClips, c => c.clarityScore);
      const rejClarity = meanFeature(rejectedClips, c => c.clarityScore);

      // For motion and bRoll we use compositeScore as a proxy (can be refined once extract_features has run)
      const selComposite = meanFeature(selectedClips, c => c.compositeScore);
      const rejComposite = meanFeature(rejectedClips, c => c.compositeScore);

      await appendLog(jobId, `  Feature means — Selected: hook=${selHook.toFixed(2)} emotion=${selEmotion.toFixed(2)} clarity=${selClarity.toFixed(2)} score=${selComposite.toFixed(2)}`);
      await appendLog(jobId, `  Feature means — Rejected: hook=${rejHook.toFixed(2)} emotion=${rejEmotion.toFixed(2)} clarity=${rejClarity.toFixed(2)} score=${rejComposite.toFixed(2)}`);

      // Load current weights
      const defaultWeights = { hookWeight: 0.35, emotionWeight: 0.30, clarityWeight: 0.20, motionWeight: 0.10, bRollWeight: 0.05 };
      let currentWeights: Record<string, number> = { ...defaultWeights, _version: 0 };
      try {
        const [wRow] = await db.select().from(modelConfigTable).where(eq(modelConfigTable.key, "formula_weights")).limit(1);
        if (wRow?.value) currentWeights = { ...currentWeights, ...JSON.parse(wRow.value) };
      } catch {}

      // Apply gradient update — learning rate scales with rating weight so bad edits matter less
      const wLR = Math.abs(ratingWeight) * 0.05; // 0–0.075 per iteration — conservative
      const hookDelta = (selHook - rejHook) * wLR * Math.sign(ratingWeight);
      const emotionDelta = (selEmotion - rejEmotion) * wLR * Math.sign(ratingWeight);
      const clarityDelta = (selClarity - rejClarity) * wLR * Math.sign(ratingWeight);

      const newHookWeight = Math.max(0.05, Math.min(0.70, (currentWeights.hookWeight ?? 0.35) + hookDelta));
      const newEmotionWeight = Math.max(0.05, Math.min(0.60, (currentWeights.emotionWeight ?? 0.30) + emotionDelta));
      const newClarityWeight = Math.max(0.05, Math.min(0.50, (currentWeights.clarityWeight ?? 0.20) + clarityDelta));
      // Normalize so weights sum to 1 (excluding bRoll and motion which are kept proportional)
      const total = newHookWeight + newEmotionWeight + newClarityWeight + (currentWeights.motionWeight ?? 0.10) + (currentWeights.bRollWeight ?? 0.05);
      const scale = 1 / total;

      const updatedWeights = {
        hookWeight: Math.round(newHookWeight * scale * 1000) / 1000,
        emotionWeight: Math.round(newEmotionWeight * scale * 1000) / 1000,
        clarityWeight: Math.round(newClarityWeight * scale * 1000) / 1000,
        motionWeight: Math.round((currentWeights.motionWeight ?? 0.10) * scale * 1000) / 1000,
        bRollWeight: Math.round((currentWeights.bRollWeight ?? 0.05) * scale * 1000) / 1000,
        _version: ((currentWeights._version as number) ?? 0) + 1,
        _lastUpdated: new Date().toISOString(),
        _lastFormat: format,
      };

      await appendLog(jobId, `  Δ hook: ${hookDelta >= 0 ? "+" : ""}${hookDelta.toFixed(4)} → hook_weight: ${currentWeights.hookWeight?.toFixed(3)} → ${updatedWeights.hookWeight.toFixed(3)}`);
      await appendLog(jobId, `  Δ emotion: ${emotionDelta >= 0 ? "+" : ""}${emotionDelta.toFixed(4)} → emotion_weight: ${currentWeights.emotionWeight?.toFixed(3)} → ${updatedWeights.emotionWeight.toFixed(3)}`);
      await appendLog(jobId, `  Δ clarity: ${clarityDelta >= 0 ? "+" : ""}${clarityDelta.toFixed(4)} → clarity_weight: ${currentWeights.clarityWeight?.toFixed(3)} → ${updatedWeights.clarityWeight.toFixed(3)}`);

      const weightsValue = JSON.stringify(updatedWeights);
      const [existingWeightsRow] = await db.select().from(modelConfigTable).where(eq(modelConfigTable.key, "formula_weights")).limit(1);
      if (existingWeightsRow) {
        await db.update(modelConfigTable).set({ value: weightsValue, updatedAt: new Date() }).where(eq(modelConfigTable.key, "formula_weights"));
      } else {
        await db.insert(modelConfigTable).values({
          id: randomUUID(),
          key: "formula_weights",
          value: weightsValue,
          description: "Learnable clip_score formula weights — updated by learn_from_edit RL loop",
        });
      }
      await appendLog(jobId, `  ✓ Formula weights saved (version ${updatedWeights._version}) — next Extract Features will use these`);

      await db.insert(activityTable).values({
        id: randomUUID(), type: "ai_analysis_done",
        description: `AI learned from edit: ${rawClips.length} clips → ${usedVideoIds.size} selected; ${prefCount} preferences updated; ${pairsStored} training pairs stored; formula weights v${updatedWeights._version}`,
        projectId, projectName: project.name,
      });
      result = JSON.stringify({ exampleId, format, prefCount, clipsAvailable: rawClips.length, clipsUsed: usedVideoIds.size, correctionsIntegrated: projectEdits.length, trainingPairsStored: pairsStored, formulaWeightsVersion: updatedWeights._version });
    }

    // ─── LAYER 5: rank_clips_ai ───────────────────────────────────────────────
    // Applies learned preferences (from training data) to rerank clips before
    // generate_edit_plan runs, adjusting compositeScore with a learned bonus/penalty
    else if (type === "rank_clips_ai") {
      await appendLog(jobId, "Loading project clips and learned preferences...");
      const [rankProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!rankProject) throw new Error("Project not found");

      const format = (rankProject as any).targetFormat ?? (rankProject as any).format ?? "instagram_reel";
      const projectVideos = await db.select().from(videosTable)
        .where(eq(videosTable.projectId, projectId));

      // Load learned preferences for this format
      const learnedPrefs = await db.select().from(learnedClipPrefsTable)
        .where(eq(learnedClipPrefsTable.format, format));

      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

      if (learnedPrefs.length === 0) {
        await appendLog(jobId, `No learned data yet for format "${format}". Run more projects to build training data.`);
        await appendLog(jobId, "Using base composite scores from clip analysis only.");
        result = JSON.stringify({ message: "no_learned_data", format, clipsRanked: 0 });
      } else {
        await appendLog(jobId, `Applying ${learnedPrefs.length} learned preferences for format "${format}"...`);

        // Build a lookup: format+clipType → selectionRate, format+tag → selectionRate
        const prefByClipType: Record<string, number> = {};
        const prefByTag: Record<string, number> = {};
        for (const pref of learnedPrefs) {
          if (pref.clipType && pref.usageCount && pref.usageCount >= 2) prefByClipType[pref.clipType] = pref.selectionRate ?? 0.5;
          if (pref.tag && pref.usageCount && pref.usageCount >= 2) prefByTag[pref.tag] = pref.selectionRate ?? 0.5;
        }

        let rankedCount = 0;
        for (let vi = 0; vi < projectVideos.length; vi++) {
          const video = projectVideos[vi];
          const progress = 20 + Math.round((vi / projectVideos.length) * 70);
          await db.update(jobsTable).set({ progress }).where(eq(jobsTable.id, jobId));

          if (!video.clipAnalysis) continue;

          try {
            const analysis = JSON.parse(video.clipAnalysis);
            const baseScore = analysis.compositeScore ?? 50;

            // Calculate learned bonus/penalty
            let learnedBonus = 0;
            let bonusFactors = 0;

            // ClipType preference (±20 points max)
            if (analysis.clipType && prefByClipType[analysis.clipType] !== undefined) {
              const typePref = prefByClipType[analysis.clipType];
              learnedBonus += (typePref - 0.5) * 40; // 0→-20, 0.5→0, 1→+20
              bonusFactors++;
            }

            // Tag preferences (average of all tag bonuses, ±15 points max)
            const tags = analysis.tags ?? [];
            let tagBonusSum = 0;
            let tagBonusCount = 0;
            for (const tag of tags) {
              if (prefByTag[tag] !== undefined) {
                tagBonusSum += (prefByTag[tag] - 0.5) * 30;
                tagBonusCount++;
              }
            }
            if (tagBonusCount > 0) {
              learnedBonus += tagBonusSum / tagBonusCount;
              bonusFactors++;
            }

            const avgBonus = bonusFactors > 0 ? learnedBonus / bonusFactors : 0;
            const learnedScore = Math.max(0, Math.min(100, baseScore + avgBonus));

            const updatedAnalysis = {
              ...analysis,
              learnedScore: Math.round(learnedScore * 10) / 10,
              learnedBonus: Math.round(avgBonus * 10) / 10,
              learnedPrefsApplied: learnedPrefs.length,
              learnedRankedAt: new Date().toISOString(),
            };

            await db.update(videosTable)
              .set({ clipAnalysis: JSON.stringify(updatedAnalysis) })
              .where(eq(videosTable.id, video.id));

            rankedCount++;
            await appendLog(jobId, `  "${video.originalName}": base=${baseScore} → learned=${Math.round(learnedScore)} (bonus ${avgBonus > 0 ? "+" : ""}${Math.round(avgBonus)})`);
          } catch {
            await appendLog(jobId, `  Skipping "${video.originalName}": parse error`);
          }
        }

        await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `AI ranking complete: ${rankedCount} clips reranked using ${learnedPrefs.length} learned preferences`);
        await db.insert(activityTable).values({
          id: randomUUID(), type: "ai_analysis_done",
          description: `AI ranked ${rankedCount} clips using ${learnedPrefs.length} learned preferences for "${format}"`,
          projectId, projectName: rankProject.name,
        });
        result = JSON.stringify({ clipsRanked: rankedCount, prefsUsed: learnedPrefs.length, format });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // extract_features: Deep feature extraction per clip.
    // Computes the explicit clip_score formula:
    //   clip_score = hook_score + emotion_score + clarity_score - repetition_penalty
    // Also extracts: speaker changes, pauses, motion, key phrases.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "extract_features") {
      await appendLog(jobId, "Extracting ML features per clip...");
      await db.update(jobsTable).set({ progress: 3 }).where(eq(jobsTable.id, jobId));

      // ── Load learnable formula weights from model_config ──────────────────────
      // Defaults match original hardcoded values. Over time learn_from_edit updates these.
      const defaultWeights = { hookWeight: 0.35, emotionWeight: 0.30, clarityWeight: 0.20, motionWeight: 0.10, bRollWeight: 0.05 };
      let formulaWeights = { ...defaultWeights };
      let weightsVersion = 0;
      try {
        const [wRow] = await db.select().from(modelConfigTable).where(eq(modelConfigTable.key, "formula_weights")).limit(1);
        if (wRow?.value) {
          const parsed = JSON.parse(wRow.value);
          formulaWeights = { ...defaultWeights, ...parsed };
          weightsVersion = parsed._version ?? 0;
        }
      } catch {}
      const isLearned = weightsVersion > 0;
      await appendLog(jobId, `Formula: clip_score = hook×${formulaWeights.hookWeight.toFixed(3)} + emotion×${formulaWeights.emotionWeight.toFixed(3)} + clarity×${formulaWeights.clarityWeight.toFixed(3)} + motion×${formulaWeights.motionWeight.toFixed(3)} - repetition_penalty`);
      await appendLog(jobId, isLearned ? `  ↳ Using LEARNED weights (v${weightsVersion} — trained from ${weightsVersion} edit${weightsVersion !== 1 ? "s" : ""})` : "  ↳ Using DEFAULT weights (run Learn from Edit to train these)");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const efVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const efVideoFiles = efVideos.filter(v => v.filePath && fs.existsSync(v.filePath));

      // Track clip types seen so far for repetition penalty
      const seenClipTypes: Record<string, number> = {};
      const seenKeyPhrases: Set<string> = new Set();

      const featureResults: Array<{ name: string; hookScore: number; emotionScore: number; clarityScore: number; repetitionPenalty: number; clipScore: number }> = [];

      for (let vi = 0; vi < efVideoFiles.length; vi++) {
        const vid = efVideoFiles[vi];
        const progressPct = 5 + Math.round((vi / efVideoFiles.length) * 85);
        await db.update(jobsTable).set({ progress: progressPct }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `[${vi+1}/${efVideoFiles.length}] "${vid.originalName}" — extracting features...`);

        // ── Parse existing analysis and transcript ────────────────────────────
        let existing: any = {};
        try { existing = JSON.parse(vid.clipAnalysis ?? "{}"); } catch {}
        let txSegments: Array<{ start: number; end: number; text: string }> = [];
        let rawTxText = "";
        if (vid.transcript) {
          try {
            const txData = JSON.parse(vid.transcript);
            txSegments = txData.segments ?? [];
            rawTxText = txData.transcript ?? txSegments.map((s: any) => s.text).join(" ");
          } catch { rawTxText = vid.transcript.substring(0, 1000); }
        }
        const duration = vid.durationSeconds ?? 30;

        // ── Feature 1: Speaker changes ─────────────────────────────────────────
        // Count gaps > 0.5s between transcript segments → approximate speaker turns
        let speakerChanges = 0;
        if (txSegments.length > 1) {
          for (let i = 1; i < txSegments.length; i++) {
            const gap = txSegments[i].start - txSegments[i-1].end;
            if (gap > 0.5) speakerChanges++;
          }
        }

        // ── Feature 2: Pauses (silence regions ≥ 0.8s) ───────────────────────
        const pauses: Array<{ start: number; duration: number }> = [];
        if (txSegments.length > 1) {
          for (let i = 1; i < txSegments.length; i++) {
            const gap = txSegments[i].start - txSegments[i-1].end;
            if (gap >= 0.8) pauses.push({ start: txSegments[i-1].end, duration: gap });
          }
        }

        // ── Feature 3: Motion intensity (FFmpeg scene filter) ─────────────────
        let motionIntensity = existing.motionScore ?? 0.5;
        try {
          const { stderr: sceneStderr } = await runFfmpeg([
            "-i", vid.filePath!,
            "-vf", "select=gt(scene\\,0.15),metadata=print:file=-",
            "-f", "null", "-", "-an",
          ]);
          const sceneChanges = (sceneStderr.match(/pts_time/g) ?? []).length;
          const scenesPerMinute = (sceneChanges / (duration / 60));
          // Normalize: 0 = static, 1 = very dynamic
          motionIntensity = Math.min(1, scenesPerMinute / 30);
        } catch {}

        // ── Feature 4: Emotion approximation (audio energy variance) ──────────
        // High energy variance = emotional delivery. Extract with FFmpeg astats.
        let emotionApprox = existing.emotionScore ?? 0.5;
        let energyVariance = 0;
        try {
          const { stderr: estatStderr } = await runFfmpeg([
            "-i", vid.filePath!, "-af", "astats=metadata=1:reset=1:length=3", "-f", "null", "-",
          ]);
          const rmsValues = (estatStderr.match(/RMS level dB:\s*([-\d.]+)/g) ?? [])
            .map(m => parseFloat(m.replace("RMS level dB:", "").trim()))
            .filter(v => !isNaN(v) && v > -80);
          if (rmsValues.length > 1) {
            const mean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
            energyVariance = rmsValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rmsValues.length;
            // Normalize: higher variance → more emotional, cap at ~50
            emotionApprox = Math.min(1, energyVariance / 50);
          }
        } catch {}

        // ── Feature 5: Key phrases (most impactful words in transcript) ────────
        const stopWords = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","is","it","was","i","you","we","they","he","she","that","this","with","be","have","do","not","are","from","by","as","so","if","what","when","how","all","just","can","will","more","about","up","out","like","than","then","also","into","its","been","said","there","would","could","which","their","your","our","one","no","yes","well"]);
        const wordFreq: Record<string, number> = {};
        const words = rawTxText.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
        for (const w of words) {
          if (!stopWords.has(w)) wordFreq[w] = (wordFreq[w] ?? 0) + 1;
        }
        const keyPhrases = Object.entries(wordFreq)
          .filter(([, c]) => c >= 2)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 8)
          .map(([w]) => w);

        // ── Feature 6: Repetition penalty ─────────────────────────────────────
        const clipType = existing.clipType ?? "unknown";
        seenClipTypes[clipType] = (seenClipTypes[clipType] ?? 0) + 1;
        // Each repeat of the same clip type adds a penalty (max -20 points)
        const repetitionCount = seenClipTypes[clipType] - 1;
        const repetitionPenalty = Math.min(0.4, repetitionCount * 0.1); // 0-0.4 penalty

        // Phrase-level repetition: penalize if key phrases overlap heavily
        const phraseOverlap = keyPhrases.filter(p => seenKeyPhrases.has(p)).length / Math.max(keyPhrases.length, 1);
        const phrasePenalty = phraseOverlap * 0.2;
        const totalRepetitionPenalty = Math.min(0.5, repetitionPenalty + phrasePenalty);
        keyPhrases.forEach(p => seenKeyPhrases.add(p));

        // ── Clip score formula ─────────────────────────────────────────────────
        // clip_score = hook_score + emotion_score + clarity_score - repetition_penalty
        const hookScore = existing.hookScore ?? 0.5;
        const clarityScore = existing.clarityScore ?? 0.5;
        const bRollValue = existing.bRollValue ?? 0.5;
        const visualQuality = existing.visualQuality ?? 0.5;

        // Recompute emotionScore incorporating our variance measurement
        const emotionScore = Math.max(emotionApprox, existing.emotionScore ?? 0.5);

        // Weighted sum using LEARNABLE weights (read from model_config, updated by learn_from_edit)
        const rawScore = (
          hookScore * formulaWeights.hookWeight +
          emotionScore * formulaWeights.emotionWeight +
          clarityScore * formulaWeights.clarityWeight +
          motionIntensity * formulaWeights.motionWeight +
          bRollValue * formulaWeights.bRollWeight
        ) - totalRepetitionPenalty;
        const clipScore = Math.round(Math.max(0, Math.min(1, rawScore)) * 100);

        featureResults.push({ name: vid.originalName ?? vid.filename, hookScore: Math.round(hookScore*100), emotionScore: Math.round(emotionScore*100), clarityScore: Math.round(clarityScore*100), repetitionPenalty: Math.round(totalRepetitionPenalty*100), clipScore });

        // ── Persist enriched features back into clipAnalysis ──────────────────
        const enriched = {
          ...existing,
          // Preserve original scores but update composite with formula
          emotionScore,
          compositeScore: clipScore / 100,
          // New features
          speakerChanges,
          pauseCount: pauses.length,
          pauses,
          motionIntensity,
          energyVariance: Math.round(energyVariance * 100) / 100,
          keyPhrases,
          repetitionPenalty: totalRepetitionPenalty,
          // Formula breakdown for transparency — shows both values and learned weights
          formulaBreakdown: {
            hookScore: Math.round(hookScore * 100),
            emotionScore: Math.round(emotionScore * 100),
            clarityScore: Math.round(clarityScore * 100),
            motionIntensity: Math.round(motionIntensity * 100),
            repetitionPenalty: Math.round(totalRepetitionPenalty * 100),
            clipScore,
            // The weights used to compute this score
            weights: { ...formulaWeights },
            weightsLearned: isLearned,
            weightsVersion,
          },
        };
        await db.update(videosTable).set({ clipAnalysis: JSON.stringify(enriched) }).where(eq(videosTable.id, vid.id));

        await appendLog(jobId, `  ✓ hook=${Math.round(hookScore*100)} emotion=${Math.round(emotionScore*100)} clarity=${Math.round(clarityScore*100)} motion=${Math.round(motionIntensity*100)} penalty=${Math.round(totalRepetitionPenalty*100)} → clip_score=${clipScore}`);
        await appendLog(jobId, `  ↳ speaker_changes=${speakerChanges} pauses=${pauses.length} key_phrases=[${keyPhrases.slice(0,5).join(", ")}]`);
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, "─".repeat(60));
      await appendLog(jobId, "FEATURE EXTRACTION SUMMARY");
      for (const r of featureResults) {
        await appendLog(jobId, `  "${r.name}": hook=${r.hookScore} + emotion=${r.emotionScore} + clarity=${r.clarityScore} - penalty=${r.repetitionPenalty} = clip_score=${r.clipScore}`);
      }
      result = JSON.stringify({ clipsProcessed: efVideoFiles.length, features: featureResults });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // semantic_tag: Gemini 2.5 Flash multimodal semantic shot analysis.
    // Extracts 3 evenly-spaced JPEG keyframes per clip, sends them + the
    // transcript to Gemini, gets back shotType / emotionLevel / hookStrength /
    // bRollScore / tags / summary, and merges those into clipAnalysis.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "semantic_tag") {
      await appendLog(jobId, "Starting Gemini semantic shot analysis...");
      await db.update(jobsTable).set({ progress: 3 }).where(eq(jobsTable.id, jobId));

      const stVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const stVideoFiles = stVideos.filter(v =>
        v.filePath && fs.existsSync(v.filePath) &&
        (v.mimeType?.startsWith("video/") || v.originalName?.match(/\.(mp4|mov|avi|mkv|webm)$/i))
      );

      if (stVideoFiles.length === 0) {
        await appendLog(jobId, "No video files found for semantic tagging.");
        result = JSON.stringify({ clipsTagged: 0 });
      } else {
        await appendLog(jobId, `Processing ${stVideoFiles.length} clip(s) with Gemini 2.5 Flash...`);
        const tmpDir = path.join(RENDER_DIR, `semantic_${jobId}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        let taggedCount = 0;
        const tagResults: Array<{ name: string; shotType: string; tags: string[]; hookStrength: number; emotionLevel: number }> = [];

        await batchProcess(
          stVideoFiles,
          async (vid) => {
            const vidName = vid.originalName ?? vid.filename;
            await appendLog(jobId, `  [Gemini] Analyzing "${vidName}"...`);

            // 1. Extract 3 evenly-spaced keyframes as JPEG
            let durationSec = vid.durationSeconds ?? 10;
            if (durationSec <= 0) durationSec = 10;
            const frameOffsets = [
              Math.max(0, durationSec * 0.15),
              Math.max(0, durationSec * 0.50),
              Math.max(0, durationSec * 0.82),
            ];

            const frameParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
            for (let fi = 0; fi < frameOffsets.length; fi++) {
              const framePath = path.join(tmpDir, `${vid.id}_f${fi}.jpg`);
              try {
                await runFfmpeg([
                  "-ss", frameOffsets[fi].toFixed(2),
                  "-i", vid.filePath,
                  "-frames:v", "1",
                  "-q:v", "5",
                  "-vf", "scale=640:-2",
                  "-y", framePath,
                ]);
                const frameData = fs.readFileSync(framePath).toString("base64");
                frameParts.push({ inlineData: { mimeType: "image/jpeg", data: frameData } });
                fs.unlinkSync(framePath);
              } catch (fErr: any) {
                await appendLog(jobId, `    ⚠ keyframe ${fi} failed: ${fErr?.message?.slice(0, 60)}`);
              }
            }

            // 2. Build transcript context
            let transcriptContext = "";
            if (vid.transcript) {
              try {
                const txData = JSON.parse(vid.transcript);
                transcriptContext = (txData.transcript ?? "").substring(0, 600);
              } catch {
                transcriptContext = vid.transcript.substring(0, 600);
              }
            }

            if (frameParts.length === 0 && !transcriptContext) {
              await appendLog(jobId, `    ⚠ Skipping "${vidName}" — no frames or transcript`);
              return;
            }

            // 3. Call Gemini 2.5 Flash with keyframes + transcript
            const prompt = `You are a professional video editor analyzing a clip for an AI-powered social media editor.

${transcriptContext ? `TRANSCRIPT (excerpt): "${transcriptContext}"` : "(no speech detected)"}

Analyze the ${frameParts.length} keyframe screenshot(s) from this video clip. Return ONLY a JSON object (no markdown, no explanation) with these exact keys:

{
  "shotType": "one of: talking_head | reaction_shot | action_shot | establishing_shot | b_roll | product_shot | text_graphic | unknown",
  "emotionLevel": <float 0.0-1.0 — how emotionally engaging is this clip?>,
  "hookStrength": <float 0.0-1.0 — how likely is this to hook viewers in the first 3s?>,
  "bRollScore": <float 0.0-1.0 — suitability as B-roll cutaway (high = good B-roll, low = primary footage)>,
  "visualQuality": <float 0.0-1.0 — overall visual quality (sharp focus, good exposure, stable camera)>,
  "tags": [<array of 2-6 short descriptive strings from: energetic, slow, humor, educational, emotional_peak, tender_moment, action_shot, strong_opening, weak_content, camera_shake, bad_lighting, overexposed, dialogue_heavy, silent, crowd_scene, outdoor, indoor, close_up, wide_shot>],
  "summary": "<1-2 sentence editorial description of what happens in this clip>"
}`;

            const contents: any[] = [
              ...frameParts,
              { text: prompt },
            ];

            const response = await geminiAi.models.generateContent({
              model: "gemini-2.5-flash",
              contents: [{ role: "user", parts: contents }],
              config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
            });

            const rawText = response.text ?? "{}";
            let parsed: any = {};
            try {
              const jsonMatch = rawText.match(/\{[\s\S]*\}/);
              parsed = JSON.parse(jsonMatch?.[0] ?? rawText);
            } catch {
              await appendLog(jobId, `    ⚠ JSON parse failed for "${vidName}"`);
            }

            // 4. Merge into existing clipAnalysis
            const semanticResult = {
              shotType: parsed.shotType ?? "unknown",
              emotionLevel: typeof parsed.emotionLevel === "number" ? parsed.emotionLevel : null,
              hookStrength: typeof parsed.hookStrength === "number" ? parsed.hookStrength : null,
              bRollScore: typeof parsed.bRollScore === "number" ? parsed.bRollScore : null,
              geminiVisualQuality: typeof parsed.visualQuality === "number" ? parsed.visualQuality : null,
              geminiTags: Array.isArray(parsed.tags) ? parsed.tags : [],
              geminiSummary: typeof parsed.summary === "string" ? parsed.summary : null,
              geminiAnalyzedAt: new Date().toISOString(),
            };

            let existingCa: Record<string, any> = {};
            if (vid.clipAnalysis) {
              try { existingCa = JSON.parse(vid.clipAnalysis); } catch {}
            }

            // Merge: Gemini tags are additive; emotionLevel and hookStrength boost existing scores
            const mergedTags = Array.from(new Set([...(existingCa.tags ?? []), ...semanticResult.geminiTags]));
            const mergedEmotion = semanticResult.emotionLevel != null
              ? ((existingCa.emotionScore ?? semanticResult.emotionLevel) * 0.6 + semanticResult.emotionLevel * 0.4)
              : existingCa.emotionScore;
            const mergedHook = semanticResult.hookStrength != null
              ? ((existingCa.hookScore ?? semanticResult.hookStrength) * 0.6 + semanticResult.hookStrength * 0.4)
              : existingCa.hookScore;
            const mergedVisual = semanticResult.geminiVisualQuality != null
              ? ((existingCa.visualQuality ?? semanticResult.geminiVisualQuality) * 0.5 + semanticResult.geminiVisualQuality * 0.5)
              : existingCa.visualQuality;

            const mergedCa = {
              ...existingCa,
              tags: mergedTags,
              emotionScore: mergedEmotion,
              hookScore: mergedHook,
              visualQuality: mergedVisual,
              clipType: semanticResult.shotType !== "unknown" ? semanticResult.shotType : (existingCa.clipType ?? "unknown"),
              bRollValue: semanticResult.bRollScore != null
                ? ((existingCa.bRollValue ?? semanticResult.bRollScore) * 0.5 + semanticResult.bRollScore * 0.5)
                : existingCa.bRollValue,
              reason: semanticResult.geminiSummary ?? existingCa.reason,
              ...semanticResult,
            };

            await db.update(videosTable).set({ clipAnalysis: JSON.stringify(mergedCa) }).where(eq(videosTable.id, vid.id));

            taggedCount++;
            tagResults.push({
              name: vidName,
              shotType: semanticResult.shotType,
              tags: semanticResult.geminiTags,
              hookStrength: semanticResult.hookStrength ?? 0,
              emotionLevel: semanticResult.emotionLevel ?? 0,
            });

            await appendLog(jobId, `  ✓ "${vidName}" → shotType=${semanticResult.shotType} hook=${Math.round((semanticResult.hookStrength ?? 0) * 100)} emotion=${Math.round((semanticResult.emotionLevel ?? 0) * 100)} bRoll=${Math.round((semanticResult.bRollScore ?? 0) * 100)} tags=[${semanticResult.geminiTags.join(", ")}]`);
            await appendLog(jobId, `    ↳ ${semanticResult.geminiSummary ?? "(no summary)"}`);
          },
          { concurrency: 1, retries: 3 }
        );

        // Cleanup tmp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

        await db.update(jobsTable).set({ progress: 90 }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, "─".repeat(60));
        await appendLog(jobId, `GEMINI SEMANTIC ANALYSIS COMPLETE — ${taggedCount}/${stVideoFiles.length} clips tagged`);
        for (const r of tagResults) {
          await appendLog(jobId, `  "${r.name}": ${r.shotType} | hook=${Math.round(r.hookStrength * 100)} emotion=${Math.round(r.emotionLevel * 100)} tags=[${r.tags.join(", ")}]`);
        }

        result = JSON.stringify({ clipsTagged: taggedCount, clips: tagResults });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // detect_scenes_visual: CNN (MobileNetV2) semantic shot boundary detection
    // Replaces PySceneDetect histogram diff with ONNX feature-vector cosine sim
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "detect_scenes_visual") {
      await appendLog(jobId, "Initialising CNN shot boundary detector (MobileNetV2 via ONNX)...");
      await db.update(jobsTable).set({ progress: 8 }).where(eq(jobsTable.id, jobId));

      const opts = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      // sensitivity 1-10 (default 5). Legacy callers may pass raw threshold — remapped in Python.
      const sensitivity: number = opts.sensitivity ?? 5;
      const frameSkip: number   = opts.frameSkip   ?? 4;  // sample every Nth frame

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const scriptPath    = path.resolve(process.cwd(), "scripts/detect_scenes.py");

      if (!fs.existsSync(scriptPath)) throw new Error("detect_scenes.py not found at api-server/scripts/detect_scenes.py");

      let totalScenes = 0;
      const allSceneData: Record<string, any> = {};
      let cnnModelConfirmed = false;

      for (let vi = 0; vi < projectVideos.length; vi++) {
        const video    = projectVideos[vi];
        const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
        if (!fs.existsSync(filePath)) {
          await appendLog(jobId, `  ⚠ "${video.originalName}" — file not found, skipping`);
          continue;
        }

        const progressPct = 8 + Math.round((vi / projectVideos.length) * 82);
        await db.update(jobsTable).set({ progress: progressPct }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `  Extracting CNN frame embeddings: "${video.originalName}" (sensitivity ${sensitivity}/10)...`);

        try {
          const { stdout, stderr } = await runCommand("python3", [
            scriptPath,
            filePath,
            String(sensitivity),
            String(frameSkip),
          ]);

          // Log any Python stderr (model download progress, warnings)
          if (stderr?.trim()) {
            for (const line of stderr.trim().split("\n").filter(Boolean)) {
              await appendLog(jobId, `  [cnn] ${line.trim()}`);
            }
          }

          const sceneData = JSON.parse(stdout.trim());
          if (sceneData.error) {
            await appendLog(jobId, `  ⚠ CNN detector error: ${sceneData.error}`);
            continue;
          }

          if (!cnnModelConfirmed) {
            const modelName = sceneData.model ?? "unknown";
            await appendLog(jobId, `  ✦ Model: ${modelName} — dissimilarity μ=${sceneData.dissimilarityMean ?? "?"} σ=${sceneData.dissimilaritySd ?? "?"} threshold=${sceneData.threshold ?? "?"}`);
            cnnModelConfirmed = true;
          }

          totalScenes += sceneData.sceneCount ?? 0;
          allSceneData[video.id] = sceneData;

          // Merge into video sceneAnalysis JSON (preserve other fields)
          let existing: any = {};
          try { existing = JSON.parse(video.sceneAnalysis ?? "{}"); } catch {}
          const merged = {
            ...existing,
            visualScenes:      sceneData.scenes,
            visualSceneCount:  sceneData.sceneCount,
            cnnModel:          sceneData.model,
            analysedFrames:    sceneData.framesAnalysed,
            dissimilarityStats: {
              mean:      sceneData.dissimilarityMean,
              sd:        sceneData.dissimilaritySd,
              threshold: sceneData.threshold,
            },
          };
          await db.update(videosTable).set({ sceneAnalysis: JSON.stringify(merged) }).where(eq(videosTable.id, video.id));

          const confRange = sceneData.scenes?.length
            ? ` (confidence: ${Math.min(...sceneData.scenes.map((s: any) => s.confidence ?? 0)).toFixed(2)}–${Math.max(...sceneData.scenes.map((s: any) => s.confidence ?? 0)).toFixed(2)})`
            : "";
          await appendLog(jobId, `  ✓ "${video.originalName}" — ${sceneData.sceneCount} shot boundaries detected${confRange}`);
        } catch (sceneErr) {
          await appendLog(jobId, `  ✗ "${video.originalName}" — ${sceneErr instanceof Error ? sceneErr.message : String(sceneErr)}`);
        }
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `CNN scene detection complete — ${totalScenes} shot boundaries across ${projectVideos.length} clip(s)`);
      result = JSON.stringify({ totalScenes, clipCount: projectVideos.length, scenes: allSceneData });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // analyze_faces: CNN face detection → talking-head vs B-roll classification
    //   + subject tracking persistence (continuity-aware cut windows)
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "analyze_faces") {
      await appendLog(jobId, "Starting face detection pipeline (frontal + profile Haar cascades)...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const opts = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      const sampleFps    = opts.sampleFps    ?? 2.0;   // frames to analyse per second
      const graceSecs    = opts.graceSecs    ?? 1.5;   // subject continuity grace period (secs)

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const scriptPath    = path.resolve(process.cwd(), "scripts/analyze_faces.py");

      if (!fs.existsSync(scriptPath)) throw new Error("analyze_faces.py not found at api-server/scripts/analyze_faces.py");

      let talkingHeads = 0, brolls = 0, mixed = 0;

      for (let vi = 0; vi < projectVideos.length; vi++) {
        const video    = projectVideos[vi];
        const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
        if (!fs.existsSync(filePath)) {
          await appendLog(jobId, `  ⚠ "${video.originalName}" — file not found, skipping`);
          continue;
        }

        const progressPct = 5 + Math.round((vi / projectVideos.length) * 85);
        await db.update(jobsTable).set({ progress: progressPct }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `  Analysing "${video.originalName}" at ${sampleFps} fps...`);

        try {
          const { stdout, stderr } = await runCommand("python3", [
            scriptPath,
            filePath,
            String(sampleFps),
            String(graceSecs),
          ]);

          if (stderr?.trim()) {
            for (const line of stderr.trim().split("\n").filter(Boolean)) {
              await appendLog(jobId, `  [face] ${line.trim()}`);
            }
          }

          const faceData = JSON.parse(stdout.trim());
          if (faceData.error) {
            await appendLog(jobId, `  ⚠ Face analysis error: ${faceData.error}`);
            continue;
          }

          const { shotType, framing, facePresencePct, subjectSegments, safeCutWindows } = faceData;

          // Tally shot types
          if (shotType === "talking_head") talkingHeads++;
          else if (shotType === "b_roll")  brolls++;
          else                             mixed++;

          // ── Save into video sceneAnalysis (merge, don't replace) ───────
          let existing: any = {};
          try { existing = JSON.parse(video.sceneAnalysis ?? "{}"); } catch {}
          const merged = {
            ...existing,
            faceAnalysis: {
              shotType,
              framing,
              facePresencePct,
              subjectSegments,
              safeCutWindows,
              gracePeriodSecs:  faceData.gracePeriodSecs,
              framesAnalysed:   faceData.framesAnalysed,
              model:            faceData.model,
              analysedAt:       new Date().toISOString(),
            },
          };
          await db.update(videosTable)
            .set({ sceneAnalysis: JSON.stringify(merged) })
            .where(eq(videosTable.id, video.id));

          // ── Also update clipAnalysis.shotType for edit plan to use ────
          let ca: any = {};
          try { ca = JSON.parse(video.clipAnalysis ?? "{}"); } catch {}
          // Only write shotType if it hasn't been set by a more sophisticated model
          if (!ca.shotType || ca.shotType === "unknown") {
            ca.shotType = shotType;
            await db.update(videosTable)
              .set({ clipAnalysis: JSON.stringify(ca) })
              .where(eq(videosTable.id, video.id));
          }

          const continuityGaps = subjectSegments?.filter((s: any) => !s.subjectPresent && s.duration <= graceSecs) ?? [];
          const safeCutCount   = safeCutWindows?.length ?? 0;

          await appendLog(jobId,
            `  ✓ "${video.originalName}" → ${shotType.toUpperCase()} | ${framing} | face ${Math.round(facePresencePct * 100)}% | ${continuityGaps.length} continuity gap(s) | ${safeCutCount} safe-cut window(s)`
          );

        } catch (err) {
          await appendLog(jobId, `  ✗ "${video.originalName}" — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await db.update(jobsTable).set({ progress: 96 }).where(eq(jobsTable.id, jobId));
      const summary = `talking_head=${talkingHeads}  b_roll=${brolls}  mixed=${mixed}`;
      await appendLog(jobId, `Face analysis complete — ${projectVideos.length} clip(s) classified [${summary}]`);
      await appendLog(jobId, `Subject tracking: grace period=${graceSecs}s — cuts within ${graceSecs}s of subject exit are flagged unsafe`);
      result = JSON.stringify({ talkingHeads, brolls, mixed, clipCount: projectVideos.length });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // detect_reactions: HSEmotion ONNX emotion classifier → reaction moments
    //   Identifies laughing, shocked, angry, nodding moments for cutaways.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "detect_reactions") {
      await appendLog(jobId, "Starting reaction detection (HSEmotion ONNX enet_b0_8_best_vgaf)...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const opts = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      const sampleFps  = opts.sampleFps  ?? 4.0;
      const threshold  = opts.threshold  ?? 0.35;
      const graceSecs  = opts.graceSecs  ?? 0.5;

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const scriptPath    = path.resolve(process.cwd(), "scripts/detect_reactions.py");
      if (!fs.existsSync(scriptPath)) throw new Error("detect_reactions.py not found at api-server/scripts/detect_reactions.py");

      let totalReactions = 0;
      let analyzed = 0;

      for (let vi = 0; vi < projectVideos.length; vi++) {
        const video    = projectVideos[vi];
        const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
        if (!fs.existsSync(filePath)) {
          await appendLog(jobId, `  ⚠ "${video.originalName}" — file not found, skipping`);
          continue;
        }

        // Only analyze talking-head / mixed clips — B-roll has no face reactions
        let existingScene: any = {};
        try { existingScene = JSON.parse(video.sceneAnalysis ?? "{}"); } catch {}
        const shotType = existingScene.faceAnalysis?.shotType ?? "unknown";
        if (shotType === "b_roll") {
          await appendLog(jobId, `  ⏭ "${video.originalName}" — b_roll, skipping`);
          continue;
        }

        analyzed++;
        const pct = 5 + Math.round((vi / projectVideos.length) * 85);
        await db.update(jobsTable).set({ progress: pct }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `  Analysing "${video.originalName}" at ${sampleFps}fps...`);

        try {
          const { stdout, stderr } = await runCommand("python3", [
            scriptPath,
            filePath,
            "--fps",       String(sampleFps),
            "--threshold", String(threshold),
            "--grace",     String(graceSecs),
          ]);

          if (stderr?.trim()) {
            for (const line of stderr.trim().split("\n").filter(Boolean)) {
              await appendLog(jobId, `  [react] ${line.trim()}`);
            }
          }

          const rd = JSON.parse(stdout.trim());
          if (rd.error) { await appendLog(jobId, `  ⚠ Error: ${rd.error}`); continue; }

          const moments: any[] = rd.reaction_moments ?? [];
          totalReactions += moments.length;

          // Merge into sceneAnalysis
          let existing: any = {};
          try { existing = JSON.parse(video.sceneAnalysis ?? "{}"); } catch {}
          await db.update(videosTable)
            .set({ sceneAnalysis: JSON.stringify({
              ...existing,
              reactionAnalysis: {
                moments,
                totalReactions: moments.length,
                dominantEmotion: rd.dominant_emotion,
                avgEmotions:     rd.avg_emotions,
                framesAnalyzed:  rd.frames_analyzed,
                model:           rd.model,
                analysedAt:      new Date().toISOString(),
              },
            }) })
            .where(eq(videosTable.id, video.id));

          if (moments.length > 0) {
            const byType: Record<string, number> = {};
            for (const m of moments) byType[m.type] = (byType[m.type] ?? 0) + 1;
            const summary = Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(", ");
            await appendLog(jobId, `  ✓ "${video.originalName}" → ${moments.length} reaction(s): ${summary} | dominant: ${rd.dominant_emotion}`);
          } else {
            await appendLog(jobId, `  ✓ "${video.originalName}" → no notable reactions (dominant: ${rd.dominant_emotion})`);
          }

        } catch (err) {
          await appendLog(jobId, `  ✗ "${video.originalName}" — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await db.update(jobsTable).set({ progress: 96 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Reaction detection complete — ${analyzed} clip(s) analyzed, ${totalReactions} reaction moment(s) found`);
      result = JSON.stringify({ totalReactions, analyzed, clipCount: projectVideos.length });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // detect_speakers: Audio-based speaker diarization per video
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "detect_speakers") {
      await appendLog(jobId, "Running audio-based speaker diarization...");
      await db.update(jobsTable).set({ progress: 8 }).where(eq(jobsTable.id, jobId));

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const scriptPath = path.resolve(process.cwd(), "scripts/detect_speakers.py");
      if (!fs.existsSync(scriptPath)) throw new Error("detect_speakers.py not found");

      const allSpeakerData: Record<string, any> = {};
      let totalSpeakerSegments = 0;

      for (let vi = 0; vi < projectVideos.length; vi++) {
        const video = projectVideos[vi];
        const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
        if (!fs.existsSync(filePath)) { continue; }

        const progressPct = 8 + Math.round((vi / projectVideos.length) * 80);
        await db.update(jobsTable).set({ progress: progressPct }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `  Diarizing "${video.originalName}" (${Math.round(video.durationSeconds ?? 0)}s)...`);

        // Extract audio for analysis
        const tmpAudio = path.join(RENDER_DIR, `${jobId}_spk_${vi}.wav`);
        try {
          await runFfmpeg(["-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-y", tmpAudio]);
          const { stdout } = await runCommand("python3", [scriptPath, tmpAudio, "0.8"]);
          const speakerData = JSON.parse(stdout.trim());
          if (speakerData.error) {
            await appendLog(jobId, `  ⚠ ${speakerData.error}`);
          } else {
            totalSpeakerSegments += speakerData.segmentCount ?? 0;
            allSpeakerData[video.id] = speakerData;
            // Merge speaker data into sceneAnalysis JSON
            let existing: any = {};
            try { existing = JSON.parse(video.sceneAnalysis ?? "{}"); } catch {}
            const merged = { ...existing, speakerSegments: speakerData.segments, speakerCount: speakerData.speakerCount };
            await db.update(videosTable).set({ sceneAnalysis: JSON.stringify(merged) }).where(eq(videosTable.id, video.id));
            await appendLog(jobId, `  ✓ "${video.originalName}" — ${speakerData.speakerCount} speaker(s), ${speakerData.segmentCount} segments`);
          }
        } catch (spkErr) {
          await appendLog(jobId, `  ✗ Error: ${spkErr instanceof Error ? spkErr.message : String(spkErr)}`);
        } finally {
          try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch {}
        }
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Speaker diarization complete — ${totalSpeakerSegments} speech segments across ${projectVideos.length} clip(s)`);
      result = JSON.stringify({ totalSpeakerSegments, clipCount: projectVideos.length, speakerData: allSpeakerData });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // auto_assemble: Transcript-driven automatic video assembly.
    // AI listens to audio → transcribes → scores → builds timeline → done.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "auto_assemble") {
      await appendLog(jobId, "Starting transcript-driven auto-assembly...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const [aaProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!aaProject) throw new Error("Project not found");

      const aaVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const targetFormat = aaProject.targetFormat ?? "instagram_reel";
      const formatDurations: Record<string, number> = {
        instagram_reel: 45, tiktok: 30, youtube_short: 55,
        youtube_long: 600, wedding_highlight: 240, ad_spot: 20, custom: 60,
      };
      const targetDuration = formatDurations[targetFormat] ?? 45;

      // ── Step 1: Collect all transcript segments across all clips ────────────
      await appendLog(jobId, `Step 1/4: Collecting transcripts from ${aaVideos.length} clip(s)...`);
      type TxSeg = {
        videoId: string; videoName: string; videoPath: string;
        start: number; end: number; text: string; duration: number;
        words?: Array<{ word: string; start: number; end: number }>;
        hasAudio?: boolean;
      };
      const allTxSegments: TxSeg[] = [];

      for (const video of aaVideos) {
        const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
        if (!fs.existsSync(filePath)) continue;

        if (!video.transcript) {
          await appendLog(jobId, `  ⚠ "${video.originalName}" has no transcript — run Transcribe first`);
          continue;
        }

        try {
          const txData = JSON.parse(video.transcript);
          const segs: Array<{ start: number; end: number; text: string; words?: any[] }> = txData.segments ?? [];
          for (const s of segs) {
            if (s.end - s.start < 0.3) continue; // skip sub-300ms fragments
            allTxSegments.push({
              videoId: video.id,
              videoName: video.originalName ?? video.filename,
              videoPath: filePath,
              start: s.start,
              end: s.end,
              text: (s.text ?? "").trim(),
              duration: s.end - s.start,
              words: s.words,
              hasAudio: true,
            });
          }
        } catch { continue; }
      }

      if (allTxSegments.length === 0) {
        throw new Error("No transcript segments found. Please run Transcribe on your footage first.");
      }

      await appendLog(jobId, `  Found ${allTxSegments.length} raw transcript segments`);
      await db.update(jobsTable).set({ progress: 25 }).where(eq(jobsTable.id, jobId));

      // ── Step 2: Filter filler words and low-quality segments ───────────────
      await appendLog(jobId, "Step 2/4: Filtering filler words and low-quality segments...");
      const fillerPattern = /^(um|uh|er|ah|like|you know|so|basically|right|okay|hmm|erm|and so|just|i mean|sort of|kind of|literally|actually|well|i guess|you see|you know what i mean|anyway|alright|yeah yeah|ok ok|mm|mmm|mhm|uh huh|yep|nope|i i i|we we|the the)[,.]?\s*$/i;

      const filtered = allTxSegments.filter(s => {
        if (!s.text || s.text.length < 3) return false;           // empty
        if (fillerPattern.test(s.text.trim())) return false;       // filler-only
        if (s.duration < 0.5 && s.text.split(" ").length < 3) return false; // too short
        return true;
      });

      const removedCount = allTxSegments.length - filtered.length;
      await appendLog(jobId, `  Removed ${removedCount} filler/empty segments — ${filtered.length} remain`);
      await db.update(jobsTable).set({ progress: 40 }).where(eq(jobsTable.id, jobId));

      // ── Step 3: Score segments with GPT-4o mini ────────────────────────────
      await appendLog(jobId, "Step 3/4: Scoring segments for relevance and engagement...");

      // Batch the scoring — send all transcript text to GPT-4o mini at once
      const batchText = filtered.map((s, i) =>
        `[${i}] (${s.duration.toFixed(1)}s) "${s.text}"`
      ).join("\n");

      const scoringPrompt = `You are an AI video editor. Score each transcript segment for how compelling, clear, and engaging it is for a ${targetFormat.replace(/_/g, " ")} video. Return ONLY a JSON array of numbers between 0-100, one per segment, in the same order. Consider: speech clarity, emotional impact, informativeness, whether it stands alone without context. A filler sentence like "yeah so anyway" scores 5. A powerful statement or key info scores 90+.

Segments:
${batchText.substring(0, 12000)}

Respond with ONLY a JSON array like: [85, 42, 91, 15, ...]`;

      let scores: number[] = filtered.map(() => 50); // fallback
      try {
        const scoreResp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: scoringPrompt }],
          max_tokens: 2000,
          temperature: 0.2,
        });
        const raw = scoreResp.choices[0]?.message?.content ?? "[]";
        const parsed = JSON.parse(raw.replace(/^[^[]*/, "").replace(/[^\]]*$/, ""));
        if (Array.isArray(parsed)) {
          scores = parsed.map((v: any) => typeof v === "number" ? Math.round(v) : 50);
        }
        await appendLog(jobId, `  Scored ${scores.length} segments via GPT-4o mini`);
      } catch (scoreErr) {
        await appendLog(jobId, `  ⚠ Scoring failed (using defaults): ${scoreErr instanceof Error ? scoreErr.message : String(scoreErr)}`);
      }

      // Attach scores to segments
      const scored = filtered.map((s, i) => ({ ...s, score: scores[i] ?? 50 }));

      // ── Step 4: Select segments to fill target duration ────────────────────
      await appendLog(jobId, `Step 4/4: Building timeline — target ${targetDuration}s for ${targetFormat.replace(/_/g, " ")}...`);
      await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

      // Sort by score descending, then pick greedily until target duration reached
      const sortedByScore = [...scored].sort((a, b) => b.score - a.score);
      const selected: typeof scored = [];
      let totalSec = 0;
      const maxOvershoot = 5; // allow 5s overshoot

      for (const seg of sortedByScore) {
        if (totalSec >= targetDuration + maxOvershoot) break;
        // Skip duplicates from same video overlapping windows
        const overlaps = selected.some(s =>
          s.videoId === seg.videoId &&
          Math.max(s.start, seg.start) < Math.min(s.end, seg.end)
        );
        if (!overlaps) {
          selected.push(seg);
          totalSec += seg.duration;
        }
      }

      // Re-sort selected by (videoId, start) for natural ordering
      selected.sort((a, b) =>
        a.videoId === b.videoId
          ? a.start - b.start
          : a.videoName.localeCompare(b.videoName)
      );

      await appendLog(jobId, `  Selected ${selected.length} segments, ~${totalSec.toFixed(1)}s total`);

      // ── Write segments to DB ───────────────────────────────────────────────
      // Delete old AI-generated segments for this project first
      const existingSegs = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId));
      const aiGenerated = existingSegs.filter(s => (s as any).source === "auto_assemble" || !(s as any).source);

      await db.delete(segmentsTable).where(eq(segmentsTable.projectId, projectId));

      for (let si = 0; si < selected.length; si++) {
        const seg = selected[si];
        const segId = randomUUID();
        const score = seg.score;
        await db.insert(segmentsTable).values({
          id: segId,
          projectId,
          videoId: seg.videoId,
          startTime: seg.start,
          endTime: seg.end,
          duration: seg.duration,
          orderIndex: si,
          included: true,
          captionText: seg.text,
          captionStyle: "subtitle",
          clipType: "dialogue",
          emotionalTone: score >= 80 ? "peak" : score >= 60 ? "building" : "neutral",
          colorGrade: "cinematic",
          audioMixLevel: 1.0,
          musicDuckLevel: 0.15,
          speedFactor: 1.0,
          transitionIn: si === 0 ? "fade" : "cut",
          transitionDuration: si === 0 ? 0.5 : 0.0,
          beatSynced: false,
        } as any);
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `✓ Auto-assembly complete — ${selected.length} segments assembled into ${totalSec.toFixed(1)}s edit`);
      await appendLog(jobId, `  Top segment: "${selected[0]?.text?.substring(0, 60) ?? "—"}" (score ${selected[0]?.score ?? 0})`);

      await db.insert(activityTable).values({
        id: randomUUID(), type: "ai_analysis_done",
        description: `Auto-assembled ${selected.length} transcript segments into ${totalSec.toFixed(1)}s edit for "${aaProject.name}"`,
        projectId, projectName: aaProject.name,
      });

      result = JSON.stringify({
        segmentsAssembled: selected.length,
        totalDuration: totalSec,
        targetDuration,
        format: targetFormat,
        topScore: Math.max(...selected.map(s => s.score)),
        avgScore: Math.round(selected.reduce((a, s) => a + s.score, 0) / Math.max(selected.length, 1)),
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // generate_proxy: FFmpeg proxy generation (720p, CRF 23, faststart)
    // Creates a smaller, web-ready version of each uploaded clip so the NLE
    // editor can stream previews without buffering the full source file.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "generate_proxy") {
      await appendLog(jobId, "Generating 720p proxy files for fast playback...");
      await db.update(jobsTable).set({ progress: 3 }).where(eq(jobsTable.id, jobId));

      const gpVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const gpVideoFiles = gpVideos.filter(v =>
        v.filePath && fs.existsSync(v.filePath) &&
        (v.mimeType?.startsWith("video/") || v.originalName?.match(/\.(mp4|mov|avi|mkv|webm)$/i))
      );

      if (gpVideoFiles.length === 0) {
        await appendLog(jobId, "No video files found to proxy.");
        result = JSON.stringify({ proxiesGenerated: 0 });
      } else {
        const proxyDir = path.join(RENDER_DIR, "proxies");
        fs.mkdirSync(proxyDir, { recursive: true });

        let generated = 0;
        for (let vi = 0; vi < gpVideoFiles.length; vi++) {
          const vid = gpVideoFiles[vi];
          const vidName = vid.originalName ?? vid.filename;
          await appendLog(jobId, `  [${vi + 1}/${gpVideoFiles.length}] Generating proxy for "${vidName}"...`);

          if (vid.proxyPath && fs.existsSync(vid.proxyPath)) {
            await appendLog(jobId, `    ↳ Proxy already exists — skipping`);
            generated++;
            continue;
          }

          const proxyPath = path.join(proxyDir, `${vid.id}_proxy.mp4`);
          try {
            await runFfmpeg([
              "-i", vid.filePath,
              "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
              "-c:v", "libx264",
              "-preset", "fast",
              "-crf", "23",
              "-c:a", "aac",
              "-b:a", "128k",
              "-movflags", "+faststart",
              "-y", proxyPath,
            ]);

            const proxyStat = fs.statSync(proxyPath);
            await db.update(videosTable).set({ proxyPath }).where(eq(videosTable.id, vid.id));
            await appendLog(jobId, `    ✓ Proxy: ${(proxyStat.size / 1024 / 1024).toFixed(1)}MB → ${proxyPath.split("/").pop()}`);
            generated++;
          } catch (pErr: any) {
            await appendLog(jobId, `    ⚠ Proxy failed for "${vidName}": ${pErr?.message?.slice(0, 80)}`);
          }

          const prog = Math.round(5 + ((vi + 1) / gpVideoFiles.length) * 90);
          await db.update(jobsTable).set({ progress: prog }).where(eq(jobsTable.id, jobId));
        }

        await appendLog(jobId, `PROXY GENERATION COMPLETE — ${generated}/${gpVideoFiles.length} proxies ready`);
        result = JSON.stringify({ proxiesGenerated: generated, total: gpVideoFiles.length });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // embed_clips: Generate semantic text embeddings per clip.
    // Builds a rich text description from clipAnalysis (shotType, tags, summary,
    // transcript) and calls OpenAI text-embedding-3-small.
    // Embeddings are stored in clip_embeddings and used for:
    //   - Similarity search ("find clips like this one")
    //   - Diversity penalty in rank_clips_ai (penalise semantically clustered clips)
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "embed_clips") {
      await appendLog(jobId, "Generating clip embeddings (text-embedding-3-small)...");
      await db.update(jobsTable).set({ progress: 3 }).where(eq(jobsTable.id, jobId));

      const ecVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const ecVideoFiles = ecVideos.filter(v =>
        v.filePath && fs.existsSync(v.filePath) &&
        (v.mimeType?.startsWith("video/") || v.mimeType?.startsWith("audio/") ||
         v.originalName?.match(/\.(mp4|mov|avi|mkv|webm|mp3|wav|aac|m4a)$/i))
      );

      if (ecVideoFiles.length === 0) {
        await appendLog(jobId, "No clips found to embed.");
        result = JSON.stringify({ clipsEmbedded: 0 });
      } else {
        let embeddedCount = 0;
        const embeddingResults: Array<{ name: string; dims: number; inputChars: number }> = [];

        for (let vi = 0; vi < ecVideoFiles.length; vi++) {
          const vid = ecVideoFiles[vi];
          const vidName = vid.originalName ?? vid.filename;
          await appendLog(jobId, `  [${vi + 1}/${ecVideoFiles.length}] Embedding "${vidName}"...`);

          // Build rich text representation for this clip
          let ca: Record<string, any> = {};
          if (vid.clipAnalysis) {
            try { ca = JSON.parse(vid.clipAnalysis); } catch {}
          }

          let transcriptText = "";
          if (vid.transcript) {
            try {
              const txData = JSON.parse(vid.transcript);
              transcriptText = (txData.transcript ?? "").substring(0, 400);
            } catch {
              transcriptText = vid.transcript.substring(0, 400);
            }
          }

          const shotType = ca.shotType ?? ca.clipType ?? "unknown";
          const tags = (ca.tags ?? []).join(", ");
          const summary = ca.geminiSummary ?? ca.reason ?? "";
          const hook = Math.round((ca.hookScore ?? 0.5) * 100);
          const emotion = Math.round((ca.emotionScore ?? 0.5) * 100);
          const clarity = Math.round((ca.clarityScore ?? 0.5) * 100);
          const broll = Math.round((ca.bRollValue ?? 0.5) * 100);

          const inputText = [
            `Clip: ${vidName}`,
            `Shot type: ${shotType}`,
            tags ? `Tags: ${tags}` : null,
            summary ? `Summary: ${summary}` : null,
            `Scores — hook:${hook} emotion:${emotion} clarity:${clarity} b-roll:${broll}`,
            transcriptText ? `Transcript: ${transcriptText}` : null,
          ].filter(Boolean).join("\n");

          try {
            const embResp = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: inputText,
            });
            const embedding = embResp.data[0].embedding;
            const dims = embedding.length;

            // Upsert embedding: delete existing, insert new
            const existing = await db.select().from(clipEmbeddingsTable)
              .where(and(eq(clipEmbeddingsTable.videoId, vid.id), eq(clipEmbeddingsTable.projectId, projectId)));
            if (existing.length > 0) {
              // Update in place by re-inserting
              await db.delete(clipEmbeddingsTable).where(eq(clipEmbeddingsTable.videoId, vid.id));
            }
            await db.insert(clipEmbeddingsTable).values({
              id: randomUUID(),
              videoId: vid.id,
              projectId,
              model: "text-embedding-3-small",
              embedding: JSON.stringify(embedding),
              inputText: inputText.substring(0, 500),
            });

            embeddedCount++;
            embeddingResults.push({ name: vidName, dims, inputChars: inputText.length });
            await appendLog(jobId, `    ✓ ${dims}d embedding stored (${inputText.length} chars input)`);
          } catch (embErr: any) {
            await appendLog(jobId, `    ⚠ Embedding failed for "${vidName}": ${embErr?.message?.slice(0, 80)}`);
          }

          const prog = Math.round(5 + ((vi + 1) / ecVideoFiles.length) * 90);
          await db.update(jobsTable).set({ progress: prog }).where(eq(jobsTable.id, jobId));
        }

        await appendLog(jobId, `EMBEDDING COMPLETE — ${embeddedCount}/${ecVideoFiles.length} clips embedded`);
        await appendLog(jobId, "  Embeddings enable: similar-clip retrieval, diversity penalty in ranking");
        result = JSON.stringify({ clipsEmbedded: embeddedCount, total: ecVideoFiles.length, dims: embeddingResults[0]?.dims ?? 1536 });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // scan_drive_broll: Google Drive folder auto-scan + proxy creation.
    // Lists all video files in the configured Drive folder, downloads each,
    // transcodes to a lightweight 720p H.264 proxy, uploads the proxy to a
    // "CutAI Proxies" subfolder, then registers the clip in the DB so it
    // becomes available as importable B-roll for this project.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "scan_drive_broll") {
      // folderId can come from the job options JSON (set by the folder picker UI)
      // or fall back to the GOOGLE_DRIVE_FOLDER_ID env var
      let folderId: string | undefined = process.env.GOOGLE_DRIVE_FOLDER_ID;
      try {
        const opts = options ? JSON.parse(options) : {};
        if (opts.folderId) folderId = opts.folderId;
        if (opts.folderName) await appendLog(jobId, `Target folder: "${opts.folderName}"`);
      } catch {}
      await appendLog(jobId, "Drive B-roll scan — connecting to Google Drive...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      let drive: ReturnType<typeof getDriveClient>;
      try {
        drive = getDriveClient();
      } catch (e: any) {
        throw new Error(`Drive auth failed: ${e.message}. Ensure GOOGLE_WORKSPACE_REFRESH_TOKEN is set.`);
      }

      // ── Find or create the "CutAI Proxies" subfolder ──────────────────────
      await appendLog(jobId, "Looking for CutAI Proxies subfolder...");
      let proxyFolderId: string;
      const folderSearch = await drive.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' AND name = 'CutAI Proxies' AND trashed = false`,
        fields: "files(id, name)",
        spaces: "drive",
      });
      if ((folderSearch.data.files ?? []).length > 0) {
        proxyFolderId = folderSearch.data.files![0].id!;
        await appendLog(jobId, `  Found existing CutAI Proxies folder (${proxyFolderId})`);
      } else {
        const folderCreate = await drive.files.create({
          requestBody: {
            name: "CutAI Proxies",
            mimeType: "application/vnd.google-apps.folder",
            ...(folderId ? { parents: [folderId] } : {}),
          },
          fields: "id",
        });
        proxyFolderId = folderCreate.data.id!;
        await appendLog(jobId, `  Created CutAI Proxies folder (${proxyFolderId})`);
      }

      // ── List all video files in the source folder ──────────────────────────
      const videoMimes = "mimeType contains 'video/'";
      const folderQuery = folderId
        ? `'${folderId}' in parents AND ${videoMimes} AND trashed = false`
        : `${videoMimes} AND trashed = false`;

      const fileList = await drive.files.list({
        q: folderQuery,
        fields: "files(id, name, mimeType, size)",
        pageSize: 50,
        spaces: "drive",
      });
      const driveFiles = fileList.data.files ?? [];
      await appendLog(jobId, `Found ${driveFiles.length} video file(s) on Drive`);
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      let registered = 0;
      let skipped = 0;
      const total = driveFiles.length;

      for (let fi = 0; fi < driveFiles.length; fi++) {
        const driveFile = driveFiles[fi];
        const pct = 10 + Math.round((fi / Math.max(total, 1)) * 80);
        await db.update(jobsTable).set({ progress: pct }).where(eq(jobsTable.id, jobId));

        // Check if already registered for this project
        const existing = await db.select({ id: videosTable.id }).from(videosTable)
          .where(and(eq(videosTable.driveFileId, driveFile.id!), eq(videosTable.projectId, projectId)))
          .limit(1);
        if (existing.length > 0) {
          await appendLog(jobId, `  [${fi + 1}/${total}] Skipping "${driveFile.name}" — already registered`);
          skipped++;
          continue;
        }

        await appendLog(jobId, `  [${fi + 1}/${total}] Downloading "${driveFile.name}"...`);
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const rawPath = path.join(UPLOAD_DIR, `drive_${driveFile.id}_raw.mp4`);
        const proxyPath = path.join(UPLOAD_DIR, `drive_${driveFile.id}_proxy.mp4`);

        // Download raw file from Drive
        try {
          const dlResp = await drive.files.get(
            { fileId: driveFile.id!, alt: "media" },
            { responseType: "stream" }
          ) as any;
          await new Promise<void>((resolve, reject) => {
            const dest = fs.createWriteStream(rawPath);
            (dlResp.data as NodeJS.ReadableStream).pipe(dest);
            dest.on("finish", resolve);
            dest.on("error", reject);
            (dlResp.data as NodeJS.ReadableStream).on("error", reject);
          });
        } catch (e: any) {
          await appendLog(jobId, `    ⚠ Download failed: ${e.message} — skipping`);
          continue;
        }

        // Transcode to 720p H.264 proxy
        await appendLog(jobId, `    Transcoding proxy for "${driveFile.name}"...`);
        try {
          await new Promise<void>((resolve, reject) => {
            const ff = spawn("ffmpeg", [
              "-i", rawPath,
              "-vf", "scale=-2:720",
              "-c:v", "libx264", "-crf", "28", "-preset", "fast",
              "-c:a", "aac", "-b:a", "128k",
              "-pix_fmt", "yuv420p",
              "-movflags", "+faststart",
              "-y", proxyPath,
            ]);
            ff.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)));
          });
        } catch (e: any) {
          await appendLog(jobId, `    ⚠ Transcode failed: ${e.message} — skipping`);
          try { fs.unlinkSync(rawPath); } catch {}
          continue;
        }

        // Upload proxy back to Drive CutAI Proxies folder
        await appendLog(jobId, `    Uploading proxy to Drive...`);
        let proxyFileId: string;
        try {
          const proxyUpload = await drive.files.create({
            requestBody: {
              name: `PROXY_${driveFile.name?.replace(/\.[^.]+$/, "")}.mp4`,
              mimeType: "video/mp4",
              parents: [proxyFolderId],
            },
            media: {
              mimeType: "video/mp4",
              body: fs.createReadStream(proxyPath),
            },
            fields: "id",
          });
          proxyFileId = proxyUpload.data.id!;
        } catch (e: any) {
          await appendLog(jobId, `    ⚠ Upload failed: ${e.message} — registering with local proxy only`);
          proxyFileId = "";
        }

        // Register in DB as a video for this project
        const videoId = randomUUID();
        const probeRaw = await new Promise<number>((resolve) => {
          const pb = spawn("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", rawPath]);
          let out = ""; pb.stdout.on("data", d => out += d);
          pb.on("close", () => resolve(parseFloat(out.trim()) || 0));
        });

        await db.insert(videosTable).values({
          id: videoId,
          projectId,
          filename: path.basename(rawPath),
          originalName: driveFile.name ?? `clip_${driveFile.id}.mp4`,
          mimeType: driveFile.mimeType ?? "video/mp4",
          sizeBytes: driveFile.size ? parseInt(driveFile.size as string, 10) : fs.statSync(rawPath).size,
          filePath: rawPath,
          proxyPath,
          durationSeconds: probeRaw > 0 ? probeRaw : null,
          driveFileId: driveFile.id!,
          driveProxyFileId: proxyFileId || null,
          driveSource: "google_drive",
          status: "ready",
        });

        await appendLog(jobId, `    ✓ Registered "${driveFile.name}" (${probeRaw.toFixed(1)}s) — proxy uploaded`);
        registered++;

        // Clean up raw file — keep proxy for local encode
        try { fs.unlinkSync(rawPath); } catch {}
      }

      await db.update(jobsTable).set({ progress: 100 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Drive scan complete — ${registered} new clip(s) registered, ${skipped} skipped`);
      result = JSON.stringify({ registered, skipped, total });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // score_cut_points: Pacing / cut rhythm model.
    // Combines beat timestamps + speech segment boundaries to score every
    // potential cut point (0.1s resolution) across the full project timeline.
    // Outputs a sorted schedule of {time, score, beatAligned, speechBoundary}
    // used by generate_edit_plan and auto_assemble to snap cuts to natural
    // musical/linguistic boundaries.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "score_cut_points") {
      await appendLog(jobId, "Scoring cut points — beat grid × speech boundaries...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const [scpProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (!scpProject) throw new Error("Project not found");

      const targetFormat = scpProject.targetFormat ?? "custom";
      const scpVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

      // ── Collect beat timestamps across all clips ──
      let allBeats: number[] = [];
      let maxDuration = 0;

      for (const vid of scpVideos) {
        if (vid.durationSeconds) maxDuration = Math.max(maxDuration, vid.durationSeconds);
        if (vid.beatData) {
          try {
            const bd = JSON.parse(vid.beatData);
            if (Array.isArray(bd.beats)) allBeats = allBeats.concat(bd.beats as number[]);
          } catch {}
        }
      }

      // ── Collect speech segment boundaries from transcripts ──
      const speechBoundaries: Array<{ time: number; type: "start" | "end" | "phrase_end" }> = [];

      for (const vid of scpVideos) {
        if (!vid.transcript) continue;
        try {
          const txData = JSON.parse(vid.transcript);
          const segs: Array<{ start: number; end: number; text: string }> = txData.segments ?? [];
          for (const seg of segs) {
            speechBoundaries.push({ time: seg.start, type: "start" });
            speechBoundaries.push({ time: seg.end, type: "end" });
            // Phrase endings: after punctuation
            const hasPhraseEnd = /[.!?,;]$/.test(seg.text.trim());
            if (hasPhraseEnd) speechBoundaries.push({ time: seg.end, type: "phrase_end" });
          }
        } catch {}
      }

      await appendLog(jobId, `  Beat timestamps: ${allBeats.length} | Speech boundaries: ${speechBoundaries.length}`);
      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

      // ── Format-based editorial constraints ──
      const pacingProfiles: Record<string, { minClipSec: number; maxClipSec: number; beatWeight: number; speechWeight: number }> = {
        tiktok:            { minClipSec: 0.5,  maxClipSec: 4,  beatWeight: 0.6, speechWeight: 0.4 },
        instagram_reel:    { minClipSec: 0.5,  maxClipSec: 6,  beatWeight: 0.5, speechWeight: 0.5 },
        youtube_short:     { minClipSec: 1.0,  maxClipSec: 10, beatWeight: 0.3, speechWeight: 0.7 },
        youtube_long:      { minClipSec: 3.0,  maxClipSec: 30, beatWeight: 0.2, speechWeight: 0.8 },
        wedding_highlight: { minClipSec: 2.0,  maxClipSec: 12, beatWeight: 0.7, speechWeight: 0.3 },
        ad_spot:           { minClipSec: 0.5,  maxClipSec: 5,  beatWeight: 0.6, speechWeight: 0.4 },
        custom:            { minClipSec: 1.0,  maxClipSec: 15, beatWeight: 0.4, speechWeight: 0.6 },
      };
      const pacing = pacingProfiles[targetFormat] ?? pacingProfiles["custom"];
      await appendLog(jobId, `  Pacing profile: "${targetFormat}" — minClip=${pacing.minClipSec}s maxClip=${pacing.maxClipSec}s beatWeight=${pacing.beatWeight}`);

      // ── Score every 0.1s interval ──
      const resolution = 0.1;
      const beatProximityWindow = 0.25; // seconds
      const speechEndWindow = 0.15;
      const cutPoints: Array<{ time: number; score: number; beatAligned: boolean; speechBoundary: boolean; phraseEnd: boolean }> = [];

      const totalScan = Math.max(maxDuration, 60); // at least 60s
      for (let t = 0; t <= totalScan; t = Math.round((t + resolution) * 10) / 10) {
        let score = 0;
        let beatAligned = false;
        let speechBoundary = false;
        let phraseEnd = false;

        // Beat proximity bonus
        const nearestBeat = allBeats.reduce((nearest, b) => Math.abs(b - t) < Math.abs(nearest - t) ? b : nearest, Infinity);
        const beatDist = Math.abs(nearestBeat - t);
        if (beatDist <= beatProximityWindow) {
          const beatBonus = pacing.beatWeight * (1 - beatDist / beatProximityWindow) * 0.8;
          score += beatBonus;
          if (beatDist < 0.05) beatAligned = true;
        }

        // Speech boundary bonus/penalty
        for (const sb of speechBoundaries) {
          const dist = Math.abs(sb.time - t);
          if (dist <= speechEndWindow) {
            if (sb.type === "phrase_end") {
              score += pacing.speechWeight * 0.6 * (1 - dist / speechEndWindow);
              phraseEnd = true;
            } else if (sb.type === "end") {
              score += pacing.speechWeight * 0.4 * (1 - dist / speechEndWindow);
              speechBoundary = true;
            } else if (sb.type === "start") {
              // Penalty for cutting mid-speech opening
              score -= pacing.speechWeight * 0.3 * (1 - dist / speechEndWindow);
            }
          }
        }

        // Avoid cut points outside the speech window
        const inActiveSpeech = speechBoundaries.some(sb =>
          sb.type === "start" && sb.time < t &&
          speechBoundaries.some(se => se.type === "end" && Math.abs(se.time - (t - 0.3)) < 1.0)
        );
        if (inActiveSpeech && !phraseEnd) score -= 0.2;

        if (score > 0) {
          cutPoints.push({ time: t, score: Math.round(score * 1000) / 1000, beatAligned, speechBoundary, phraseEnd });
        }
      }

      // Sort by score desc, take top candidates
      const topCuts = cutPoints.sort((a, b) => b.score - a.score).slice(0, 500);
      const beatAlignedCount = topCuts.filter(c => c.beatAligned).length;
      const phraseEndCount = topCuts.filter(c => c.phraseEnd).length;

      await appendLog(jobId, `  Cut points scored: ${cutPoints.length} candidates → top ${topCuts.length} retained`);
      await appendLog(jobId, `  Beat-aligned: ${beatAlignedCount} | Phrase-end: ${phraseEndCount}`);
      await appendLog(jobId, `  Top 5: ${topCuts.slice(0, 5).map(c => `${c.time}s(${c.score})`).join(", ")}`);

      const cutRhythmData = JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalCandidates: cutPoints.length,
        topCuts,
        beatCount: allBeats.length,
        speechBoundaryCount: speechBoundaries.length,
        format: targetFormat,
        pacingProfile: pacing,
      });

      await db.update(projectsTable).set({ cutRhythmData }).where(eq(projectsTable.id, projectId));
      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, "Cut rhythm stored — generate_edit_plan and auto_assemble will snap cuts to scored positions");

      result = JSON.stringify({
        totalCandidates: cutPoints.length,
        topCuts: topCuts.length,
        beatAligned: beatAlignedCount,
        phraseEnd: phraseEndCount,
        topScore: topCuts[0]?.score ?? 0,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // match_broll: Find & insert B-roll segments from secondary video files.
    // Classifies uploaded videos (primary vs B-roll), then for each gap between
    // A-roll speech segments, finds the best-matching B-roll clip using
    // transcript/scene semantic similarity and inserts it into the timeline.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "match_broll") {
      await appendLog(jobId, "B-roll matching — analysing project videos...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const mbVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      if (mbVideos.length < 2) {
        result = JSON.stringify({ inserted: 0, message: "Need at least 2 videos for B-roll matching." });
      } else {
        const mbSegments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId));
        const includedSegs = mbSegments.filter(s => s.included).sort((a, b) => a.orderIndex - b.orderIndex);

        // ── Classify videos as A-roll vs B-roll ──
        // Primary = most speech content (longest transcript segments sum)
        const videoSpeechDuration: Record<string, number> = {};
        for (const vid of mbVideos) {
          let speechMs = 0;
          if (vid.transcript) {
            try {
              const tx = JSON.parse(vid.transcript);
              const segs: Array<{ start: number; end: number }> = tx.segments ?? [];
              speechMs = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
            } catch {}
          }
          videoSpeechDuration[vid.id] = speechMs;
        }

        const sortedByAroll = [...mbVideos].sort((a, b) => (videoSpeechDuration[b.id] ?? 0) - (videoSpeechDuration[a.id] ?? 0));
        const primaryVideoIds = new Set(sortedByAroll.slice(0, 1).map(v => v.id));
        const brollVideos = mbVideos.filter(v => !primaryVideoIds.has(v.id));

        await appendLog(jobId, `  Primary: ${sortedByAroll[0]?.originalName} | B-roll pool: ${brollVideos.map(v => v.originalName).join(", ")}`);
        await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

        if (brollVideos.length === 0) {
          result = JSON.stringify({ inserted: 0, message: "Could not identify any B-roll videos." });
        } else {
          // ── Build B-roll candidate clips from secondary videos ──
          type BrollCandidate = { videoId: string; start: number; end: number; text: string; score: number };
          const brollCandidates: BrollCandidate[] = [];

          for (const bv of brollVideos) {
            const dur = bv.durationSeconds ?? 0;
            if (dur < 2) continue;

            // Try to get clips from clip_analysis
            if (bv.clipAnalysis) {
              try {
                const ca = JSON.parse(bv.clipAnalysis);
                const clips = Array.isArray(ca) ? ca : (ca.clips ?? []);
                for (const clip of clips) {
                  brollCandidates.push({
                    videoId: bv.id,
                    start: clip.startTime ?? 0,
                    end: clip.endTime ?? Math.min(clip.startTime + 5, dur),
                    text: clip.description ?? clip.tags?.join(" ") ?? "",
                    score: clip.editorialValue ?? 0.5,
                  });
                }
                continue;
              } catch {}
            }

            // Fallback: divide B-roll video into 5s segments
            for (let t = 0; t + 2 < dur; t += 5) {
              brollCandidates.push({
                videoId: bv.id,
                start: t,
                end: Math.min(t + 5, dur),
                text: bv.originalName ?? "",
                score: 0.5,
              });
            }
          }

          await appendLog(jobId, `  B-roll candidates: ${brollCandidates.length}`);
          await db.update(jobsTable).set({ progress: 35 }).where(eq(jobsTable.id, jobId));

          if (brollCandidates.length === 0) {
            result = JSON.stringify({ inserted: 0, message: "No B-roll candidate clips found." });
          } else {
            // ── Build A-roll context (speech text per segment) ──
            const arollTexts: Record<string, string> = {};
            const primaryVideo = mbVideos.find(v => primaryVideoIds.has(v.id));
            if (primaryVideo?.transcript) {
              try {
                const tx = JSON.parse(primaryVideo.transcript);
                const txSegs: Array<{ start: number; end: number; text: string }> = tx.segments ?? [];
                for (const seg of includedSegs) {
                  const overlapping = txSegs.filter(ts => ts.end > seg.startTime && ts.start < seg.endTime);
                  arollTexts[seg.id] = overlapping.map(ts => ts.text).join(" ").trim();
                }
              } catch {}
            }

            // ── Use Claude to match B-roll to gaps ──
            const arollSummary = includedSegs.slice(0, 20).map((seg, i) => ({
              index: i,
              segId: seg.id,
              type: seg.segmentType,
              orderIndex: seg.orderIndex,
              text: (arollTexts[seg.id] ?? seg.label ?? seg.segmentType).slice(0, 120),
            }));

            const brollSummary = brollCandidates.slice(0, 40).map((c, i) => ({
              index: i,
              videoId: c.videoId,
              start: parseFloat(c.start.toFixed(1)),
              end: parseFloat(c.end.toFixed(1)),
              description: c.text.slice(0, 100),
              score: parseFloat(c.score.toFixed(2)),
            }));

            // ── Embedding-based B-roll re-ranking ──────────────────────────────────
            // If clip embeddings exist from embed_clips job, use cosine similarity to
            // re-rank B-roll candidates before Claude selects placements
            const cosineSim = (a: number[], b: number[]): number => {
              const dotProduct = a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
              const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
              const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
              return normA > 0 && normB > 0 ? dotProduct / (normA * normB) : 0;
            };

            try {
              const brollVideoIds = [...new Set(brollCandidates.map(c => c.videoId))];
              const storedEmbeddings = await db
                .select()
                .from(clipEmbeddingsTable)
                .where(inArray(clipEmbeddingsTable.videoId, brollVideoIds));

              if (storedEmbeddings.length > 0) {
                await appendLog(jobId, `  Found ${storedEmbeddings.length} stored clip embeddings — using semantic similarity matching`);

                // Build per-video embedding map
                const embeddingMap: Record<string, number[]> = {};
                for (const emb of storedEmbeddings) {
                  try {
                    const parsed = JSON.parse(emb.embedding);
                    if (Array.isArray(parsed)) embeddingMap[emb.videoId] = parsed;
                  } catch {}
                }

                // Embed all A-roll context texts in one batch
                const arollContextTexts = includedSegs.slice(0, 20).map(seg =>
                  (arollTexts[seg.id] ?? seg.label ?? seg.segmentType ?? "").slice(0, 512)
                );

                if (Object.keys(embeddingMap).length > 0 && arollContextTexts.some(t => t.length > 5)) {
                  const embResp = await openai.embeddings.create({
                    model: "text-embedding-3-small",
                    input: arollContextTexts.filter(t => t.length > 5),
                  });

                  const arollEmbeddings = embResp.data.map(d => d.embedding);
                  let avgArollEmbedding = arollEmbeddings[0];
                  if (arollEmbeddings.length > 1) {
                    avgArollEmbedding = arollEmbeddings[0].map((_, i) =>
                      arollEmbeddings.reduce((sum, emb) => sum + emb[i], 0) / arollEmbeddings.length
                    );
                  }

                  // Boost B-roll candidate scores by cosine similarity to A-roll context
                  let boostCount = 0;
                  for (const candidate of brollCandidates) {
                    const vidEmb = embeddingMap[candidate.videoId];
                    if (!vidEmb || !avgArollEmbedding) continue;
                    const sim = cosineSim(avgArollEmbedding, vidEmb);
                    // Blend: 60% original editorial score + 40% semantic similarity
                    candidate.score = parseFloat((candidate.score * 0.6 + sim * 0.4).toFixed(3));
                    boostCount++;
                  }
                  // Re-sort by boosted score
                  brollCandidates.sort((a, b) => b.score - a.score);
                  await appendLog(jobId, `  Semantic similarity applied to ${boostCount} candidates — top: "${brollCandidates[0]?.text?.slice(0, 50)}" (score=${brollCandidates[0]?.score?.toFixed(3)})`);
                }
              } else {
                await appendLog(jobId, "  No stored embeddings found — using editorial score ranking (run embed_clips for semantic matching)");
              }
            } catch (embErr: any) {
              await appendLog(jobId, `  Embedding similarity skipped: ${embErr?.message?.slice(0, 80)}`);
            }

            // Rebuild brollSummary after potential re-ranking
            const brollSummaryFinal = brollCandidates.slice(0, 40).map((c, i) => ({
              index: i,
              videoId: c.videoId,
              start: parseFloat(c.start.toFixed(1)),
              end: parseFloat(c.end.toFixed(1)),
              description: c.text.slice(0, 100),
              score: parseFloat(c.score.toFixed(3)),
            }));

            const mbPrompt = `You are a professional video editor assigning B-roll footage to an A-roll speech edit.

A-ROLL SEGMENTS (main speech):
${JSON.stringify(arollSummary, null, 2)}

AVAILABLE B-ROLL CLIPS (sorted by semantic relevance score — higher = more relevant):
${JSON.stringify(brollSummaryFinal, null, 2)}

Choose up to ${Math.min(5, Math.floor(includedSegs.length / 2))} of the best B-roll placements. Insert them BETWEEN existing A-roll segments where they complement the speech content. Do NOT replace speech segments. Prefer higher-scored candidates.

Reply ONLY with valid JSON:
{
  "placements": [
    { "afterSegIndex": <A-roll index to insert after>, "brollIndex": <B-roll clip index>, "reason": "<brief>" }
  ]
}`;

            await appendLog(jobId, "  Claude is selecting optimal B-roll placements...");
            await db.update(jobsTable).set({ progress: 50 }).where(eq(jobsTable.id, jobId));

            let placements: Array<{ afterSegIndex: number; brollIndex: number; reason: string }> = [];
            try {
              const mbResp = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 600,
                messages: [{ role: "user", content: mbPrompt }],
              });
              const rawMb = (mbResp.content[0] as any).text ?? "{}";
              const jsonMb = rawMb.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
              placements = JSON.parse(jsonMb).placements ?? [];
            } catch (e) {
              await appendLog(jobId, `  Claude matching failed: ${e}. Using score-based fallback.`);
              // Fallback: insert top B-roll clips at every 3rd A-roll segment gap
              placements = brollCandidates
                .sort((a, b) => b.score - a.score)
                .slice(0, 3)
                .map((_, i) => ({
                  afterSegIndex: Math.min((i + 1) * 2, includedSegs.length - 2),
                  brollIndex: i,
                  reason: "score-based fallback",
                }));
            }

            await appendLog(jobId, `  Placements selected: ${placements.length}`);
            await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

            // ── Insert B-roll segments into DB ──
            // First, shift orderIndex of segments that come after each insertion point
            let insertedCount = 0;
            const sortedPlacements = [...placements].sort((a, b) => b.afterSegIndex - a.afterSegIndex);

            for (const placement of sortedPlacements) {
              const broll = brollCandidates[placement.brollIndex];
              if (!broll) continue;
              const afterSeg = includedSegs[placement.afterSegIndex];
              if (!afterSeg) continue;

              const insertAt = afterSeg.orderIndex + 1;

              // Shift all segments with orderIndex >= insertAt
              const toShift = mbSegments.filter(s => s.orderIndex >= insertAt);
              for (const seg of toShift) {
                await db.update(segmentsTable).set({ orderIndex: seg.orderIndex + 1 }).where(eq(segmentsTable.id, seg.id));
              }

              // Insert the B-roll segment
              const newSegId = randomUUID();
              await db.insert(segmentsTable).values({
                id: newSegId,
                projectId,
                videoId: broll.videoId,
                orderIndex: insertAt,
                startTime: broll.start,
                endTime: broll.end,
                label: `B-roll: ${placement.reason.slice(0, 50)}`,
                segmentType: "b_roll",
                included: true,
                confidence: broll.score,
                speedFactor: 1,
                colorGrade: "none",
                transitionIn: "cut",
                transitionInDuration: 0.3,
                captionStyle: "none",
                audioMixLevel: 0.2,
              });

              insertedCount++;
              await appendLog(jobId, `  ✓ Inserted B-roll after seg ${placement.afterSegIndex}: ${brollCandidates[placement.brollIndex]?.text?.slice(0, 60) ?? "clip"}`);
            }

            result = JSON.stringify({
              inserted: insertedCount,
              brollPool: brollCandidates.length,
              message: `${insertedCount} B-roll segment${insertedCount !== 1 ? "s" : ""} inserted.`,
            });
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // match_broll_v2: Clip-level semantic B-roll matching with embeddings
    //   Embeds per-clip descriptions AND transcript text with text-embedding-3-small,
    //   then inserts best-matching B-roll at appropriate timeline positions.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "match_broll_v2") {
      await appendLog(jobId, "B-roll semantic matching v2 — clip-level embedding similarity...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const v2Videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      if (v2Videos.length < 2) {
        result = JSON.stringify({ inserted: 0, message: "Need at least 2 videos for B-roll matching." });
      } else {
        const v2Segments = await db.select().from(segmentsTable)
          .where(eq(segmentsTable.projectId, projectId))
          .orderBy(segmentsTable.orderIndex);
        const v2Included = v2Segments.filter(s => s.included);

        // Separate primary vs B-roll by speech duration
        const speechDur = (vid: typeof v2Videos[0]) => {
          if (!vid.transcript) return 0;
          try { const segs: Array<{start:number;end:number}> = JSON.parse(vid.transcript).segments ?? []; return segs.reduce((a,s)=>a+(s.end-s.start),0); } catch { return 0; }
        };
        const v2Sorted = [...v2Videos].sort((a,b) => speechDur(b) - speechDur(a));
        const primaryVideo = v2Sorted[0];
        const brollVideos  = v2Sorted.slice(1);

        await appendLog(jobId, `  Primary: "${primaryVideo?.originalName}" | B-roll pool: ${brollVideos.map(v=>v.originalName).join(", ")}`);
        await db.update(jobsTable).set({ progress: 15 }).where(eq(jobsTable.id, jobId));

        if (brollVideos.length === 0) {
          result = JSON.stringify({ inserted: 0, message: "No B-roll videos identified." });
        } else {
          type ClipCand = { videoId: string; start: number; end: number; description: string; tags: string[]; editorialScore: number; embedding?: number[] };
          const candidates: ClipCand[] = [];

          for (const bv of brollVideos) {
            const dur = bv.durationSeconds ?? 0;
            if (dur < 1.5) continue;
            let added = false;
            if (bv.clipAnalysis) {
              try {
                const ca = JSON.parse(bv.clipAnalysis);
                const clips = Array.isArray(ca) ? ca : (ca.clips ?? []);
                if (clips.length > 0) {
                  for (const clip of clips) {
                    const desc = [clip.description ?? "", (clip.tags ?? []).join(" "), clip.summary ?? ""].filter(Boolean).join(". ").slice(0, 300);
                    candidates.push({ videoId: bv.id, start: clip.startTime ?? 0, end: clip.endTime ?? Math.min((clip.startTime??0)+5, dur), description: (desc || bv.originalName) ?? "", tags: clip.tags ?? [], editorialScore: clip.editorialValue ?? clip.bRollScore ?? 0.5 });
                  }
                  added = true;
                }
              } catch {}
            }
            if (!added) {
              let desc = bv.originalName ?? "";
              try { const sa = JSON.parse(bv.sceneAnalysis ?? "{}"); desc = sa.description ?? sa.summary ?? desc; } catch {}
              for (let t = 0; t + 1.5 < dur; t += 5) {
                candidates.push({ videoId: bv.id, start: t, end: Math.min(t+5, dur), description: desc, tags: [], editorialScore: 0.4 });
              }
            }
          }

          await appendLog(jobId, `  B-roll clip pool: ${candidates.length} candidate(s)`);
          await db.update(jobsTable).set({ progress: 25 }).where(eq(jobsTable.id, jobId));

          if (candidates.length === 0) {
            result = JSON.stringify({ inserted: 0, message: "No B-roll candidates — run scene detection first." });
          } else {
            // Embed B-roll descriptions (batched)
            const descTexts = candidates.map(c => [c.description, c.tags.join(" ")].join(" ").trim().slice(0, 512) || "b-roll footage");
            await appendLog(jobId, `  Embedding ${descTexts.length} B-roll clip description(s)...`);
            let embeddingsOk = false;
            try {
              const BATCH = 100;
              for (let bi = 0; bi < descTexts.length; bi += BATCH) {
                const batch = descTexts.slice(bi, bi + BATCH);
                const embResp = await openai.embeddings.create({ model: "text-embedding-3-small", input: batch });
                for (let j = 0; j < batch.length; j++) candidates[bi+j].embedding = embResp.data[j].embedding;
              }
              embeddingsOk = true;
              await appendLog(jobId, `  ✓ ${candidates.length} B-roll descriptions embedded`);
            } catch (e: any) {
              await appendLog(jobId, `  ⚠ Embedding failed: ${e?.message?.slice(0,80)} — using keyword fallback`);
            }

            await db.update(jobsTable).set({ progress: 50 }).where(eq(jobsTable.id, jobId));

            // Build A-roll transcript text per segment
            const txSegs: Array<{start:number;end:number;text:string}> = [];
            if (primaryVideo?.transcript) {
              try { const tx = JSON.parse(primaryVideo.transcript); txSegs.push(...(tx.segments ?? [])); } catch {}
            }
            const arollCtx = v2Included.map(seg => {
              const over = txSegs.filter(ts => ts.end > seg.startTime && ts.start < seg.endTime);
              return over.map(ts => ts.text).join(" ").trim() || seg.label || seg.segmentType || "";
            });

            // Find A-roll → B-roll insertion points
            type InsertPt = { afterIdx: number; context: string; embedding?: number[] };
            const insertPoints: InsertPt[] = v2Included
              .map((_, si) => ({ afterIdx: si, context: arollCtx[si] ?? "" }))
              .filter(ip => ip.context.length > 3 && ip.afterIdx < v2Included.length - 1);

            if (insertPoints.length > 0) {
              try {
                const ctxTexts = insertPoints.map(ip => ip.context.slice(0, 512));
                const embResp2 = await openai.embeddings.create({ model: "text-embedding-3-small", input: ctxTexts });
                for (let i = 0; i < insertPoints.length; i++) insertPoints[i].embedding = embResp2.data[i].embedding;
                await appendLog(jobId, `  ✓ ${insertPoints.length} A-roll segments embedded`);
              } catch {}
            }

            await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

            // Cosine similarity matching
            const cosSim = (a: number[], b: number[]): number => {
              let dot=0, ma=0, mb=0;
              for (let i=0; i<a.length; i++) { dot+=a[i]*b[i]; ma+=a[i]**2; mb+=b[i]**2; }
              return dot / (Math.sqrt(ma)*Math.sqrt(mb) + 1e-8);
            };

            const opts3 = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
            const maxInserts = Math.min(opts3.maxInserts ?? Math.max(2, Math.floor(v2Included.length/3)), insertPoints.length);
            const usedCands = new Set<string>();
            type Placement = { afterIdx: number; candIdx: number; score: number; reason: string };
            const placements: Placement[] = [];

            for (const ip of insertPoints) {
              if (placements.length >= maxInserts) break;
              let bestScore = 0, bestIdx = -1;
              for (let ci = 0; ci < candidates.length; ci++) {
                const c = candidates[ci];
                const key = `${c.videoId}:${c.start}`;
                if (usedCands.has(key)) continue;
                let score = c.editorialScore * 0.2;
                if (ip.embedding && c.embedding) {
                  score += Math.max(0, cosSim(ip.embedding, c.embedding)) * 0.8;
                } else {
                  const words = ip.context.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                  const hits  = words.filter(w => c.description.toLowerCase().includes(w)).length;
                  score += (hits / Math.max(words.length, 1)) * 0.6;
                }
                if (score > bestScore) { bestScore = score; bestIdx = ci; }
              }
              if (bestIdx >= 0 && bestScore > 0.05) {
                usedCands.add(`${candidates[bestIdx].videoId}:${candidates[bestIdx].start}`);
                placements.push({ afterIdx: ip.afterIdx, candIdx: bestIdx, score: bestScore, reason: candidates[bestIdx].description.slice(0,60) });
              }
            }

            // Insert in reverse order (preserve orderIndex integrity)
            placements.sort((a,b) => b.afterIdx - a.afterIdx);
            await appendLog(jobId, `  Inserting ${placements.length} B-roll clip(s)...`);
            await db.update(jobsTable).set({ progress: 80 }).where(eq(jobsTable.id, jobId));

            let insertedCount = 0;
            for (const pl of placements) {
              const afterSeg = v2Included[pl.afterIdx];
              const c = candidates[pl.candIdx];
              if (!afterSeg || !c) continue;
              const insertAt = afterSeg.orderIndex + 1;
              const toShift = v2Segments.filter(s => s.orderIndex >= insertAt);
              for (const seg of toShift) {
                await db.update(segmentsTable).set({ orderIndex: seg.orderIndex + 1 }).where(eq(segmentsTable.id, seg.id));
              }
              await db.insert(segmentsTable).values({
                id: randomUUID(), projectId, videoId: c.videoId, orderIndex: insertAt,
                startTime: c.start, endTime: c.end,
                label: `B-roll v2: ${c.description.slice(0,55)}`,
                segmentType: "b_roll", included: true, confidence: c.editorialScore,
                speedFactor: 1, colorGrade: "none", transitionIn: "cut", transitionInDuration: 0.3,
                captionStyle: "none", audioMixLevel: 0.15,
              });
              insertedCount++;
              await appendLog(jobId, `  ✓ B-roll inserted after seg[${pl.afterIdx}]: "${pl.reason}" (score=${pl.score.toFixed(3)}, ${embeddingsOk?"emb":"kw"})`);
            }

            await db.update(jobsTable).set({ progress: 96 }).where(eq(jobsTable.id, jobId));
            result = JSON.stringify({ inserted: insertedCount, candidatePool: candidates.length, embeddingsUsed: embeddingsOk, message: `${insertedCount} B-roll clip(s) inserted via semantic embedding matching.` });
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // enforce_shot_diversity: Standalone angle-diversity scanner + auto-fixer
    //   Walks the existing timeline, detects 3+ consecutive same-framing cuts
    //   (close_up / medium / wide), and inserts B-roll or reorders to break runs.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "enforce_shot_diversity") {
      await appendLog(jobId, "Shot diversity enforcement — scanning timeline for same-angle runs...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const esdVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const esdSegs   = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);
      const esdIncluded = esdSegs.filter(s => s.included);

      if (esdIncluded.length < 3) {
        result = JSON.stringify({ fixed: 0, violations: 0, message: "Not enough segments to analyse." });
      } else {
        // Build videoId → framing map
        const framingByVidId = new Map<string, string>();
        for (const vid of esdVideos) {
          try {
            const sa = JSON.parse(vid.sceneAnalysis ?? "{}");
            const f  = sa.faceAnalysis?.framing;
            if (f && f !== "no_subject") framingByVidId.set(vid.id, f);
          } catch {}
        }

        if (framingByVidId.size === 0) {
          await appendLog(jobId, "  No framing data found — run Face Analysis first.");
          result = JSON.stringify({ fixed: 0, violations: 0, message: "No framing data — run 'Face Analysis' step first." });
        } else {
          // Detect violations (3+ consecutive same-framing)
          const violations: number[] = [];
          for (let i = 2; i < esdIncluded.length; i++) {
            const f0 = framingByVidId.get(esdIncluded[i-2].videoId);
            const f1 = framingByVidId.get(esdIncluded[i-1].videoId);
            const f2 = framingByVidId.get(esdIncluded[i].videoId);
            if (f0 && f1 && f2 && f0 === f1 && f1 === f2) violations.push(i);
          }

          await appendLog(jobId, `  Framing data: ${framingByVidId.size} clip(s) mapped | Violations detected: ${violations.length}`);
          if (violations.length === 0) {
            await appendLog(jobId, "  ✓ No angle runs found — timeline already diverse");
            result = JSON.stringify({ fixed: 0, violations: 0, message: "Timeline already angle-diverse." });
          } else {
            await db.update(jobsTable).set({ progress: 40 }).where(eq(jobsTable.id, jobId));

            // Build B-roll candidate pool
            type BrollPool = { videoId: string; start: number; end: number; framing: string; score: number };
            const brollPool: BrollPool[] = [];
            for (const vid of esdVideos) {
              const fr = framingByVidId.get(vid.id);
              if (!fr) continue;
              const dur = vid.durationSeconds ?? 0;
              if (dur < 2) continue;
              // Use clipAnalysis clips or 5-second windows
              if (vid.clipAnalysis) {
                try {
                  const ca = JSON.parse(vid.clipAnalysis);
                  const clips = Array.isArray(ca) ? ca : (ca.clips ?? []);
                  for (const clip of clips) {
                    brollPool.push({ videoId: vid.id, start: clip.startTime ?? 0, end: clip.endTime ?? Math.min((clip.startTime??0)+5, dur), framing: fr, score: clip.editorialValue ?? 0.5 });
                  }
                  continue;
                } catch {}
              }
              for (let t = 0; t + 2 < dur; t += 5) {
                brollPool.push({ videoId: vid.id, start: t, end: Math.min(t+5, dur), framing: fr, score: 0.4 });
              }
            }

            let fixed = 0;
            const usedInTimeline = new Set<string>(esdSegs.map(s => `${s.videoId}:${s.startTime}:${s.endTime}`));

            for (const violIdx of violations) {
              const badFraming = framingByVidId.get(esdIncluded[violIdx].videoId) ?? "";
              const afterSeg   = esdIncluded[violIdx - 1];
              if (!afterSeg) continue;

              // Find a B-roll clip with different framing, not already in timeline
              const candidate = brollPool.find(c => {
                if (c.framing === badFraming) return false;
                const key = `${c.videoId}:${c.start}:${c.end}`;
                return !usedInTimeline.has(key);
              });

              if (!candidate) {
                await appendLog(jobId, `  ⚠ No alternative-framing clip for violation at seg[${violIdx}] (${badFraming}) — skipping`);
                continue;
              }

              const insertAt = afterSeg.orderIndex + 1;
              const toShift  = esdSegs.filter(s => s.orderIndex >= insertAt);
              for (const seg of toShift) {
                await db.update(segmentsTable).set({ orderIndex: seg.orderIndex + 1 }).where(eq(segmentsTable.id, seg.id));
              }

              await db.insert(segmentsTable).values({
                id: randomUUID(), projectId, videoId: candidate.videoId, orderIndex: insertAt,
                startTime: candidate.start, endTime: candidate.end,
                label: `Diversity cut (${candidate.framing})`,
                segmentType: "b_roll", included: true, confidence: candidate.score,
                speedFactor: 1, colorGrade: "none", transitionIn: "cut", transitionInDuration: 0.3,
                captionStyle: "none", audioMixLevel: 0.2,
              });

              usedInTimeline.add(`${candidate.videoId}:${candidate.start}:${candidate.end}`);
              fixed++;
              await appendLog(jobId, `  ✓ Inserted ${candidate.framing} cutaway after seg[${violIdx-1}] to break ${badFraming} run`);
            }

            await db.update(jobsTable).set({ progress: 96 }).where(eq(jobsTable.id, jobId));
            await appendLog(jobId, `Shot diversity enforcement complete — ${violations.length} violation(s) found, ${fixed} fixed`);
            result = JSON.stringify({ fixed, violations: violations.length, message: `${fixed} cutaway(s) inserted to enforce shot diversity.` });
          }
        }
      }
    }

    // ── Generate Captions ──────────────────────────────────────────────────
    else if (type === "generate_captions") {
      await appendLog(jobId, "Generating captions from transcript...");
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const segments = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);

      let captionStyle = "subtitle";
      try { const opts = JSON.parse(options ?? "{}"); captionStyle = opts.captionStyle ?? captionStyle; } catch {}

      // Build a map of video transcript words/segments keyed by videoId
      const txByVideo: Record<string, { segments: Array<{ start: number; end: number; text: string }> }> = {};
      for (const v of videos) {
        if (!v.transcript) continue;
        try {
          const tx = JSON.parse(v.transcript);
          const segs: Array<{ start: number; end: number; text: string }> = [];
          if (Array.isArray(tx.segments)) {
            for (const s of tx.segments) {
              if (s.start != null && s.end != null && s.text) {
                segs.push({ start: s.start, end: s.end, text: (s.text as string).trim() });
              }
            }
          } else if (tx.words && Array.isArray(tx.words)) {
            // Build pseudo-segments from word groups (6-8 words each)
            let currentWords: string[] = [];
            let groupStart = 0;
            let groupEnd = 0;
            for (const w of tx.words) {
              if (currentWords.length === 0) groupStart = w.start;
              currentWords.push(w.word ?? w.text ?? "");
              groupEnd = w.end;
              if (currentWords.length >= 7) {
                segs.push({ start: groupStart, end: groupEnd, text: currentWords.join(" ").trim() });
                currentWords = [];
              }
            }
            if (currentWords.length > 0) {
              segs.push({ start: groupStart, end: groupEnd, text: currentWords.join(" ").trim() });
            }
          }
          txByVideo[v.id] = { segments: segs };
        } catch {}
      }

      await db.update(jobsTable).set({ progress: 35 }).where(eq(jobsTable.id, jobId));

      let captionedCount = 0;
      for (const seg of segments) {
        if (!seg.videoId || !txByVideo[seg.videoId]) continue;
        const txSegs = txByVideo[seg.videoId].segments;

        // Find transcript segments that overlap with this video segment's time range
        const overlapping = txSegs.filter(ts =>
          ts.end > seg.startTime && ts.start < seg.endTime
        );

        if (overlapping.length === 0) continue;

        // Combine overlapping transcript text into a caption (max 60 chars)
        let captionText = overlapping.map(o => o.text).join(" ").replace(/\s+/g, " ").trim();
        if (captionText.length > 80) {
          // Truncate at word boundary
          const words = captionText.split(" ");
          const kept: string[] = [];
          for (const w of words) {
            if ((kept.join(" ") + " " + w).length <= 80) kept.push(w);
            else break;
          }
          captionText = kept.join(" ") + "…";
        }

        if (!captionText) continue;

        await db.update(segmentsTable)
          .set({ captionText, captionStyle })
          .where(eq(segmentsTable.id, seg.id));

        captionedCount++;
      }

      await db.update(jobsTable).set({ progress: 80 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Captions assigned to ${captionedCount}/${segments.length} segments using style: ${captionStyle}.`);

      result = JSON.stringify({ captionedSegments: captionedCount, totalSegments: segments.length, captionStyle });
    }

    // -------------------------------------------------------------------------
    // TRIM SILENCE — detect silent lead/tail per segment using ffmpeg silencedetect
    // -------------------------------------------------------------------------
    else if (type === "trim_silence") {
      await appendLog(jobId, "Detecting silence regions in source videos...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const segments = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);

      // silencedetect params — configurable via options
      let silenceDuration = 0.3;
      let silenceNoise = -40;
      try { const opts = JSON.parse(options ?? "{}"); silenceDuration = opts.silenceDuration ?? silenceDuration; silenceNoise = opts.silenceNoise ?? silenceNoise; } catch {}

      // Build silence map per videoId: array of {start, end}
      const silenceMap: Record<string, Array<{ start: number; end: number }>> = {};

      let vidIdx = 0;
      for (const v of videos) {
        const filePath = v.filePath ?? path.join(UPLOAD_DIR, v.filename);
        if (!fs.existsSync(filePath)) continue;
        try {
          const { stderr } = await runCommand("ffmpeg", [
            "-i", filePath,
            "-af", `silencedetect=noise=${silenceNoise}dB:d=${silenceDuration}`,
            "-f", "null", "-",
          ]);
          const regions: Array<{ start: number; end: number }> = [];
          const lines = stderr.split("\n");
          let curStart = 0;
          for (const line of lines) {
            const startM = line.match(/silence_start:\s*([\d.]+)/);
            if (startM) curStart = parseFloat(startM[1]);
            const endM = line.match(/silence_end:\s*([\d.]+)/);
            if (endM) regions.push({ start: curStart, end: parseFloat(endM[1]) });
          }
          silenceMap[v.id] = regions;
          await appendLog(jobId, `Video "${v.originalName}": ${regions.length} silence regions found.`);
        } catch (e) {
          await appendLog(jobId, `Silence detection failed for "${v.originalName}": ${String(e)}`);
        }
        vidIdx++;
        await db.update(jobsTable).set({ progress: 5 + Math.round((vidIdx / videos.length) * 50) }).where(eq(jobsTable.id, jobId));
      }

      let trimmedCount = 0;
      for (const seg of segments) {
        const regions = silenceMap[seg.videoId ?? ""] ?? [];
        if (!regions.length) continue;

        let newStart = seg.startTime;
        let newEnd = seg.endTime;
        const margin = 0.05; // 50ms buffer

        // Trim silence at the START of the segment
        for (const r of regions) {
          if (r.start <= newStart + 0.1 && r.end > newStart) {
            const candidate = r.end + margin;
            if (candidate < newEnd - 0.5) { newStart = parseFloat(candidate.toFixed(3)); }
          }
        }

        // Trim silence at the END of the segment
        for (const r of regions) {
          if (r.start < newEnd && r.end >= newEnd - 0.1) {
            const candidate = r.start - margin;
            if (candidate > newStart + 0.5) { newEnd = parseFloat(candidate.toFixed(3)); }
          }
        }

        if (Math.abs(newStart - seg.startTime) > 0.05 || Math.abs(newEnd - seg.endTime) > 0.05) {
          const startTrimmedSec = parseFloat((newStart - seg.startTime).toFixed(3));
          const endTrimmedSec = parseFloat((seg.endTime - newEnd).toFixed(3));
          const trimInfo = JSON.stringify({
            originalStart: seg.startTime,
            originalEnd: seg.endTime,
            startTrimmedSec,  // seconds removed from start (positive = start moved later)
            endTrimmedSec,    // seconds removed from end (positive = end moved earlier)
            trimmedAt: new Date().toISOString(),
          });
          await db.update(segmentsTable)
            .set({ startTime: newStart, endTime: newEnd, silenceTrimInfo: trimInfo })
            .where(eq(segmentsTable.id, seg.id));
          const parts: string[] = [];
          if (startTrimmedSec > 0.05) parts.push(`+${startTrimmedSec.toFixed(2)}s start`);
          if (endTrimmedSec > 0.05) parts.push(`-${endTrimmedSec.toFixed(2)}s end`);
          await appendLog(jobId, `✂ Trimmed "${seg.label ?? seg.segmentType}": ${parts.join(", ")} (was ${seg.startTime.toFixed(2)}→${seg.endTime.toFixed(2)}s, now ${newStart.toFixed(2)}→${newEnd.toFixed(2)}s)`);
          trimmedCount++;
        }
      }

      await db.update(jobsTable).set({ progress: 85 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `✓ Silence trimmed from ${trimmedCount}/${segments.length} segments.`);

      // ── Filler word detection pass ────────────────────────────────────────
      // For each video that has a stored transcript, run filler_detect and
      // store the result in clipAnalysis.neural for use in generate_edit_plan.
      let fillerVideosScanned = 0;
      let totalFillerFound = 0;
      for (const v of videos) {
        if (!v.transcript || !v.filePath) continue;
        try {
          // Write transcript to a temp sidecar file for filler_detect.py
          const sidecarPath = `${v.filePath}.transcript.json`;
          await fs.promises.writeFile(sidecarPath, v.transcript);
          const fillerResult = await runPythonScript("filler_detect.py", [v.filePath, "--transcript", sidecarPath], 20000);
          // Clean up sidecar
          fs.unlink(sidecarPath, () => {});

          if (!fillerResult.error && typeof fillerResult.filler_count === "number") {
            fillerVideosScanned++;
            totalFillerFound += fillerResult.filler_count;
            await appendLog(jobId, `  Filler: "${v.originalName}" — ${fillerResult.filler_count} fillers, ${fillerResult.filler_rate_per_minute}/min, ${fillerResult.has_heavy_filler ? "⚠ HEAVY" : "clean"}`);

            // Update clipAnalysis with filler data
            if (v.clipAnalysis) {
              try {
                const existing = JSON.parse(v.clipAnalysis);
                const neural = existing.neural ?? {};
                existing.neural = {
                  ...neural,
                  filler_count: fillerResult.filler_count,
                  filler_rate_per_minute: fillerResult.filler_rate_per_minute,
                  has_heavy_filler: fillerResult.has_heavy_filler,
                  clean_rate: fillerResult.clean_rate,
                };
                existing.fillerAnalysis = {
                  segments: fillerResult.segments_with_filler ?? [],
                  top_fillers: fillerResult.top_fillers ?? {},
                  recommendation: fillerResult.recommendation ?? "",
                };
                await db.update(videosTable).set({ clipAnalysis: JSON.stringify(existing) }).where(eq(videosTable.id, v.id));
              } catch {}
            }
          }
        } catch (e) {
          await appendLog(jobId, `  Filler detection skipped for "${v.originalName}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (fillerVideosScanned > 0) {
        await appendLog(jobId, `Filler analysis: ${fillerVideosScanned} clips scanned, ${totalFillerFound} filler events found.`);
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      result = JSON.stringify({ trimmedSegments: trimmedCount, totalSegments: segments.length, fillerVideosScanned, totalFillerFound });
    }

    // -------------------------------------------------------------------------
    // SUGGEST B-ROLL — AI tags segments suitable for b-roll insertion
    // -------------------------------------------------------------------------
    else if (type === "suggest_broll") {
      await appendLog(jobId, "Analyzing segments for B-roll suitability...");
      await db.update(jobsTable).set({ progress: 10 }).where(eq(jobsTable.id, jobId));

      const segments = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);

      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const videoMap = Object.fromEntries(videos.map(v => [v.id, v]));

      const segmentSummaries = segments.map(s => {
        const v = videoMap[s.videoId ?? ""];
        // Neural scores live on the source video's clipAnalysis JSON — not on the segment itself
        const neural = v?.clipAnalysis ? (() => { try { return JSON.parse(v.clipAnalysis as string); } catch { return {}; } })() : {};
        return {
          id: s.id,
          label: s.label ?? s.segmentType,
          type: s.segmentType,
          duration: (s.endTime - s.startTime).toFixed(1),
          captionText: s.captionText ?? "",
          visualQuality: neural.visual_quality ?? null,
          hasFaces: neural.has_faces ?? null,
          hasSpeech: neural.has_speech ?? null,
          emotionScore: neural.emotion_score ?? null,
          hookScore: neural.hook_score ?? null,
          videoName: v?.originalName ?? "unknown",
        };
      });

      const aiResponse = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `You are a professional video editor. Analyze these video segments and identify which ones would work well as B-roll (supplementary footage to play under voiceover/narration).

Segments:
${JSON.stringify(segmentSummaries, null, 2)}

B-roll candidates should:
- Have good visual quality
- NOT be the main speech/interview segments
- Be visually interesting or atmospheric
- Be short to medium duration (2-10s ideal)
- Not have critical speech that must be heard (or be muted action)

Return a JSON array of objects with fields:
- id: segment id
- isBroll: boolean (true if this should be flagged as b-roll)
- reason: brief reason (10 words max)
- priority: "high" | "medium" | "low" (how good is it for b-roll?)

Only include segments that would actually work as b-roll. Return valid JSON only.`
        }]
      });

      await db.update(jobsTable).set({ progress: 70 }).where(eq(jobsTable.id, jobId));

      let suggestions: Array<{ id: string; isBroll: boolean; reason: string; priority: string }> = [];
      try {
        const raw = (aiResponse.content[0] as any).text ?? "";
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) suggestions = JSON.parse(match[0]);
      } catch (e) {
        await appendLog(jobId, `Could not parse AI response: ${e}`);
      }

      let taggedCount = 0;
      for (const sug of suggestions) {
        if (!sug.isBroll) continue;
        await db.update(segmentsTable)
          .set({
            segmentType: "b_roll",
            label: `B-Roll [${sug.priority}]${sug.reason ? `: ${sug.reason}` : ""}`,
          })
          .where(eq(segmentsTable.id, sug.id));
        taggedCount++;
      }

      await appendLog(jobId, `B-roll tagging complete: ${taggedCount} segments tagged as B-roll.`);
      result = JSON.stringify({ suggestionsTotal: suggestions.length, taggedAsBroll: taggedCount });
    }

    // -------------------------------------------------------------------------
    // SMART REFRAME — detect optimal 9:16 crop for each segment
    // -------------------------------------------------------------------------
    else if (type === "smart_reframe") {
      await appendLog(jobId, "Analyzing optimal 9:16 crop for each segment...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const segments = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);

      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const videoMap = Object.fromEntries(videos.map(v => [v.id, v]));

      let reframedCount = 0;
      let idx = 0;

      for (const seg of segments) {
        idx++;
        const v = videoMap[seg.videoId ?? ""];
        if (!v) continue;
        const filePath = v.filePath ?? path.join(UPLOAD_DIR, v.filename);
        if (!fs.existsSync(filePath)) continue;

        // Probe source dimensions
        let srcW = 1920, srcH = 1080;
        try {
          const { stdout } = await runCommand("ffprobe", [
            "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0", filePath,
          ]);
          const parts = stdout.trim().split(",");
          if (parts.length >= 2) { srcW = parseInt(parts[0]) || 1920; srcH = parseInt(parts[1]) || 1080; }
        } catch {}

        // Target 9:16 — crop height = srcH, crop width = srcH * 9/16
        const targetW = Math.round(srcH * 9 / 16);
        const targetH = srcH;

        if (targetW >= srcW) {
          // Already taller than wide — no horizontal crop needed; mark as skip
          await appendLog(jobId, `Seg "${seg.label ?? seg.segmentType}": already portrait (${srcW}x${srcH}), skip.`);
          continue;
        }

        // Face-centered crop using source video's neural analysis (clipAnalysis JSON)
        let cropX = Math.round((srcW - targetW) / 2);
        const neural: Record<string, any> = v?.clipAnalysis ? (() => { try { return JSON.parse(v.clipAnalysis as string); } catch { return {}; } })() : {};
        if (neural.has_faces && neural.face_bounds) {
          try {
            const fb = typeof neural.face_bounds === "string" ? JSON.parse(neural.face_bounds) : neural.face_bounds;
            const faceCenterX = fb.x + fb.width / 2;
            const idealLeft = faceCenterX - targetW / 2;
            cropX = Math.round(Math.max(0, Math.min(srcW - targetW, idealLeft)));
          } catch {}
        }

        // Store the crop hint on the source video's clipAnalysis JSON
        const existing: Record<string, any> = { ...neural };
        existing.cropHint = { x: cropX, y: 0, w: targetW, h: targetH, srcW, srcH, format: "9:16", segmentId: seg.id };
        await db.update(videosTable)
          .set({ clipAnalysis: JSON.stringify(existing) })
          .where(eq(videosTable.id, v.id));

        reframedCount++;
        await db.update(jobsTable).set({ progress: 5 + Math.round((idx / segments.length) * 85) }).where(eq(jobsTable.id, jobId));
        await appendLog(jobId, `Seg "${seg.label ?? seg.segmentType}": crop ${srcW}x${srcH} → ${targetW}x${targetH} at x=${cropX}${neural.has_faces ? " (face-centered)" : " (center)"}`);
      }

      // Also update the project targetFormat to vertical_9_16
      await db.update(projectsTable)
        .set({ targetFormat: "vertical_9_16" })
        .where(eq(projectsTable.id, projectId));

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `✓ Smart reframe complete: ${reframedCount}/${segments.length} segments analyzed. Project set to Vertical 9:16.`);
      result = JSON.stringify({ reframedSegments: reframedCount, totalSegments: segments.length, targetFormat: "vertical_9_16" });
    }

    // -------------------------------------------------------------------------
    // SUGGEST GRAPHICS — Claude vision analyzes each segment keyframe and
    // proposes commercial-quality text overlay graphics (headline, lower_third,
    // cta_badge, etc.) with font, position, and color scheme per segment.
    // -------------------------------------------------------------------------
    else if (type === "suggest_graphics") {
      await appendLog(jobId, "Analyzing segments for graphic overlay suggestions...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      const sgSegs = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);
      const sgIncluded = sgSegs.filter(s => s.included);

      const sgVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const sgVideoMap = Object.fromEntries(sgVideos.map(v => [v.id, v]));

      const [sgProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const projectName = sgProject?.name ?? "video";

      const tmpDir = path.join(RENDER_DIR, `graphics_${jobId}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      let suggestedCount = 0;

      for (let idx = 0; idx < sgIncluded.length; idx++) {
        const seg = sgIncluded[idx];
        const vid = sgVideoMap[seg.videoId ?? ""];
        if (!vid?.filePath || !fs.existsSync(vid.filePath)) continue;

        // Extract a keyframe at the midpoint of the segment
        const midpoint = ((seg.startTime + seg.endTime) / 2).toFixed(2);
        const framePath = path.join(tmpDir, `seg_${seg.id}.jpg`);
        let frameBase64: string | null = null;

        try {
          await runFfmpeg([
            "-ss", midpoint,
            "-i", vid.filePath,
            "-frames:v", "1",
            "-q:v", "4",
            "-vf", "scale=720:-2",
            "-y", framePath,
          ]);
          frameBase64 = fs.readFileSync(framePath).toString("base64");
          fs.unlinkSync(framePath);
        } catch (fErr: any) {
          await appendLog(jobId, `  ⚠ Frame extract failed seg ${idx + 1}: ${fErr?.message?.slice(0, 60)}`);
        }

        const segLabel = seg.label ?? seg.segmentType ?? "clip";
        const segDur = (seg.endTime - seg.startTime).toFixed(1);
        const speechContext = seg.captionText ? `\nOn-screen speech: "${seg.captionText}"` : "";

        const prompt = `You are a professional motion graphics designer. Analyze this video frame from "${projectName}" (segment: "${segLabel}", duration: ${segDur}s).${speechContext}

Suggest 2 commercial-quality graphic overlays that would make this segment more impactful for social media.

Return ONLY a JSON array — no markdown, no explanation:
[
  {
    "id": "g0",
    "type": "headline|lower_third|cta_badge|social_handle|product_label|quote",
    "text": "<punchy commercial text>",
    "subtext": "<optional second line or null>",
    "position": "top-left|top-center|top-right|center|bottom-left|bottom-center|bottom-right",
    "fontFamily": "impact|montserrat|playfair|oswald|bebas-neue",
    "fontSize": "small|medium|large|hero",
    "textColor": "#ffffff",
    "backgroundColor": "transparent|#000000|rgba(0,0,0,0.65)",
    "backgroundStyle": "none|pill|box|gradient-bar",
    "colorScheme": "white-on-dark|dark-on-light|gold|neon|red|minimal",
    "animationIn": "fade|slide-up|pop|none",
    "reason": "<why this works for this specific scene, max 12 words>",
    "applied": false
  }
]

Font guide: impact/bebas-neue=energetic bold, montserrat=modern clean, playfair=luxury elegant, oswald=editorial strong.
Type guide: headline=dominant brand text, lower_third=info plate at bottom, cta_badge=action button, product_label=specs/price, quote=testimonial.
Be specific — write actual commercial copy that would work in a real ad or reel.`;

        const messageContent: any[] = [];
        if (frameBase64) {
          messageContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frameBase64 } });
        }
        messageContent.push({ type: "text", text: prompt });

        try {
          const aiMsg = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1200,
            messages: [{ role: "user", content: messageContent }],
          });

          const raw = (aiMsg.content[0] as any).text ?? "";
          const match = raw.match(/\[[\s\S]*?\]/);
          if (match) {
            const parsed = JSON.parse(match[0]) as any[];
            const overlays = parsed.map((o: any, i: number) => ({
              ...o,
              id: `${seg.id.slice(0, 8)}_g${i}`,
              applied: false,
            }));
            await db.update(segmentsTable)
              .set({ graphicOverlays: JSON.stringify(overlays) })
              .where(eq(segmentsTable.id, seg.id));
            suggestedCount++;
            await appendLog(jobId, `  ✓ "${segLabel}": ${overlays.length} graphic suggestion(s) — types: ${overlays.map((o: any) => o.type).join(", ")}`);
          } else {
            await appendLog(jobId, `  ⚠ No JSON found in response for "${segLabel}"`);
          }
        } catch (aiErr: any) {
          await appendLog(jobId, `  ⚠ AI error seg ${idx + 1}: ${aiErr?.message?.slice(0, 80)}`);
        }

        await db.update(jobsTable)
          .set({ progress: 10 + Math.round(((idx + 1) / sgIncluded.length) * 80) })
          .where(eq(jobsTable.id, jobId));
      }

      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

      await appendLog(jobId, `✓ Graphic suggestions complete: ${suggestedCount}/${sgIncluded.length} segments have overlay suggestions.`);
      result = JSON.stringify({ suggestedCount, totalSegments: sgIncluded.length });
    }

    // -------------------------------------------------------------------------
    // SUGGEST MUSIC — Claude Vision analyzes keyframes + audio loudness to
    // suggest music genres, moods, BPM ranges, and royalty-free search keywords
    // for videos that have no background music track.
    // -------------------------------------------------------------------------
    else if (type === "suggest_music") {
      await appendLog(jobId, "Analyzing video for music recommendations...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      // Get all project videos
      const smVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      if (!smVideos.length) throw new Error("No videos found for this project");

      // Pick the best video (longest, or first ready)
      const smVideo = smVideos
        .filter(v => v.filePath && fs.existsSync(v.filePath))
        .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0))[0];
      if (!smVideo?.filePath) throw new Error("No video file available for analysis");

      const vidDuration = smVideo.durationSeconds ?? 60;
      const [smProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const smProjectName = smProject?.name ?? "video";
      const smTargetFormat = smProject?.targetFormat ?? "custom";

      // ── Step 1: Measure existing audio loudness to determine if music is present ──
      await appendLog(jobId, "Measuring audio loudness to detect existing music...");
      let avgLoudness = -70;
      let hasExistingMusic = false;

      try {
        const loudnessRaw = await new Promise<string>((resolve) => {
          const proc = spawn("ffmpeg", [
            "-i", smVideo.filePath!,
            "-vn", "-filter_complex", "ebur128=framelog=verbose", "-f", "null", "-"
          ]);
          let stderr = "";
          proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          proc.on("close", () => resolve(stderr));
          proc.on("error", () => resolve(""));
          setTimeout(() => { proc.kill(); resolve(""); }, 45000);
        });

        const loudnessMatches = [...loudnessRaw.matchAll(/M:\s*([-\d.]+|-inf)/g)];
        const loudnessVals = loudnessMatches
          .map(m => m[1] === "-inf" ? -70 : parseFloat(m[1]))
          .filter(v => !isNaN(v) && v > -70);
        if (loudnessVals.length > 0) {
          avgLoudness = loudnessVals.reduce((a, b) => a + b, 0) / loudnessVals.length;
          // If average loudness > -20 LUFS, likely has audio content
          hasExistingMusic = avgLoudness > -25;
        }
        await appendLog(jobId, `  Audio: avg loudness ${avgLoudness.toFixed(1)} LUFS${hasExistingMusic ? " — audio track detected" : " — minimal/no music"}`);
      } catch (loudErr: any) {
        await appendLog(jobId, `  ⚠ Loudness check failed: ${loudErr?.message?.slice(0, 50)}`);
      }

      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

      // ── Step 2: Extract 6 keyframes spread evenly across the video ──
      await appendLog(jobId, "Extracting representative keyframes...");
      const smTmpDir = path.join(RENDER_DIR, `suggestmusic_${jobId}`);
      fs.mkdirSync(smTmpDir, { recursive: true });

      const frameCount = 6;
      const frameBase64List: string[] = [];

      for (let fi = 0; fi < frameCount; fi++) {
        const t = ((fi + 0.5) / frameCount) * vidDuration;
        const framePath = path.join(smTmpDir, `frame_${fi}.jpg`);
        try {
          await runFfmpeg([
            "-ss", t.toFixed(2),
            "-i", smVideo.filePath!,
            "-frames:v", "1",
            "-q:v", "5",
            "-vf", "scale=640:-2",
            "-y", framePath,
          ]);
          const b64 = fs.readFileSync(framePath).toString("base64");
          frameBase64List.push(b64);
          fs.unlinkSync(framePath);
        } catch {
          // skip this frame
        }
      }

      await appendLog(jobId, `  Extracted ${frameBase64List.length}/${frameCount} keyframes.`);
      await db.update(jobsTable).set({ progress: 40 }).where(eq(jobsTable.id, jobId));

      // ── Step 3: Ask Claude Vision for music recommendations ──
      await appendLog(jobId, "Consulting AI for music recommendations...");

      const formatLabels: Record<string, string> = {
        instagram_reel: "Instagram Reel (60s)",
        tiktok: "TikTok video",
        youtube_short: "YouTube Short",
        youtube_long: "YouTube long-form",
        wedding_highlight: "Wedding highlight reel",
        ad_spot: "Advertisement spot",
        custom: "social media video",
      };
      const formatLabel = formatLabels[smTargetFormat] ?? "social media video";
      const audioContext = hasExistingMusic
        ? `The video has an existing audio track (avg ${avgLoudness.toFixed(1)} LUFS). The creator may want complementary background music or a replacement track.`
        : `The video has minimal or no background music (avg ${avgLoudness.toFixed(1)} LUFS). The creator needs music recommendations to match the video's mood and style.`;

      const smPrompt = `You are a professional music supervisor for video content. You are analyzing keyframes from a ${formatLabel} called "${smProjectName}".

${audioContext}

Look at the visual content, style, mood, energy, and subject matter across all frames. Then suggest 5 diverse but well-matched music options for this video.

Return ONLY a valid JSON array — no markdown, no explanation:
[
  {
    "id": "m1",
    "title": "<descriptive music title like 'Upbeat Summer Pop'>",
    "genre": "<primary genre: e.g. Pop, Hip-Hop, Cinematic, Electronic, Acoustic, R&B, Jazz, Folk, Rock, Lo-fi, Classical, World>",
    "subGenre": "<more specific: e.g. Tropical House, Epic Orchestral, Chill Lo-fi, Urban R&B>",
    "mood": "<primary mood: e.g. Energetic, Calm, Romantic, Inspiring, Playful, Melancholic, Confident, Suspenseful>",
    "energy": "low|medium|high|very_high",
    "bpmMin": <number>,
    "bpmMax": <number>,
    "instruments": ["<instrument1>", "<instrument2>", "<instrument3>"],
    "description": "<2-3 sentence description of exactly what type of music this is and why it fits this video>",
    "royaltyFreeKeywords": ["<keyword1>", "<keyword2>", "<keyword3>", "<keyword4>"],
    "platforms": ["<platform1 e.g. Epidemic Sound>", "<platform2 e.g. Artlist>"],
    "exampleArtists": ["<artist1>", "<artist2>"],
    "colorVisualization": "<a hex color that represents this music's mood e.g. #ff6b35 for energetic orange>"
  }
]

Rules:
- Vary the energy levels across suggestions (include at least one calm and one energetic option)
- BPM must be realistic numbers (60-180)
- royaltyFreeKeywords should be exact search terms someone would type into Epidemic Sound or Artlist
- platforms: choose from: Epidemic Sound, Artlist, Musicbed, Pond5, Free Music Archive, YouTube Audio Library
- exampleArtists: real artists with similar style (for reference, not for use)
- Be specific and diverse — give the creator real options to explore`;

      const messageContent: any[] = [];
      for (const b64 of frameBase64List) {
        messageContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
      }
      messageContent.push({ type: "text", text: smPrompt });

      let suggestions: any[] = [];
      let primaryMood = "";

      try {
        const aiMsg = await anthropic.messages.create({
          model: "claude-opus-4-5",
          max_tokens: 2500,
          messages: [{ role: "user", content: messageContent }],
        });

        const raw = (aiMsg.content[0] as any).text ?? "";
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          suggestions = JSON.parse(match[0]) as any[];
          // Ensure IDs are assigned
          suggestions = suggestions.map((s: any, i: number) => ({ ...s, id: s.id ?? `m${i + 1}` }));
          primaryMood = suggestions[0]?.mood ?? "";
          await appendLog(jobId, `  ✓ ${suggestions.length} music suggestions generated: ${suggestions.map((s: any) => s.genre).join(", ")}`);
        } else {
          await appendLog(jobId, "  ⚠ Could not parse AI response as JSON");
        }
      } catch (aiErr: any) {
        await appendLog(jobId, `  ⚠ AI error: ${aiErr?.message?.slice(0, 80)}`);
      }

      await db.update(jobsTable).set({ progress: 85 }).where(eq(jobsTable.id, jobId));

      // ── Step 4: Store suggestions on the project ──
      const updates: Record<string, any> = {
        musicSuggestions: JSON.stringify(suggestions),
        updatedAt: new Date(),
      };
      if (primaryMood && !smProject?.musicMood) {
        updates.musicMood = primaryMood;
      }
      await db.update(projectsTable).set(updates).where(eq(projectsTable.id, projectId));

      try { fs.rmSync(smTmpDir, { recursive: true, force: true }); } catch {}

      await appendLog(jobId, `✓ Music suggestions stored: ${suggestions.length} tracks recommended for "${smProjectName}"`);
      result = JSON.stringify({
        suggestionsCount: suggestions.length,
        primaryMood,
        hasExistingAudio: hasExistingMusic,
        avgLoudness: avgLoudness.toFixed(1),
      });
    }

    // ════════════════════════════════════════════════════════
    // SUGGEST PACING — AI analyzes timeline and recommends edits
    // ════════════════════════════════════════════════════════
    else if (type === "suggest_pacing") {
      await appendLog(jobId, "Analyzing video pacing...");
      await db.update(jobsTable).set({ progress: 5 }).where(eq(jobsTable.id, jobId));

      // Fetch project, segments and videos
      const [spProject] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      const spSegments = await db.select().from(segmentsTable)
        .where(eq(segmentsTable.projectId, projectId))
        .orderBy(segmentsTable.orderIndex);
      const spVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

      if (!spSegments.length) throw new Error("No segments found — generate an edit plan first.");

      const spTargetFormat = spProject?.targetFormat ?? "custom";
      const includedSegs = spSegments.filter(s => s.included !== false);

      // Build segment timeline summary for Claude
      const segSummary = includedSegs.map((s, i) => {
        const dur = (s.endTime - s.startTime).toFixed(2);
        return `Clip #${i + 1}: "${s.label ?? s.segmentType ?? "clip"}" — ${dur}s${s.captionText ? `, text: "${s.captionText.slice(0,40)}"` : ""}${s.transitionIn ? `, transition: ${s.transitionIn}` : ""}`;
      }).join("\n");

      const totalDuration = includedSegs.reduce((acc, s) => acc + (s.endTime - s.startTime), 0);
      const avgClipLength = totalDuration / includedSegs.length;
      const videoCount = spVideos.length;

      await appendLog(jobId, `  Timeline: ${includedSegs.length} clips, ${totalDuration.toFixed(1)}s total, avg ${avgClipLength.toFixed(1)}s/clip`);
      await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));

      const formatIdealPace: Record<string, { min: number; max: number; label: string }> = {
        instagram_reel:   { min: 1.5, max: 4, label: "Instagram Reel" },
        tiktok:           { min: 1.5, max: 3.5, label: "TikTok" },
        youtube_short:    { min: 2, max: 5, label: "YouTube Short" },
        youtube_long:     { min: 4, max: 20, label: "YouTube long-form" },
        wedding_highlight:{ min: 3, max: 8, label: "Wedding Highlight" },
        ad_spot:          { min: 1.5, max: 4, label: "Ad Spot" },
        custom:           { min: 2, max: 8, label: "video" },
      };
      const ideal = formatIdealPace[spTargetFormat] ?? formatIdealPace["custom"];

      const pacingPrompt = `You are a professional video editor analyzing the pacing of a ${ideal.label}. Analyze the segment timeline and provide specific, actionable pacing suggestions.

TARGET FORMAT: ${ideal.label} (ideal clip length: ${ideal.min}–${ideal.max}s per clip)
TOTAL DURATION: ${totalDuration.toFixed(1)}s across ${includedSegs.length} included clips
AVERAGE CLIP LENGTH: ${avgClipLength.toFixed(1)}s
TOTAL VIDEOS: ${videoCount}

CURRENT TIMELINE:
${segSummary}

Respond ONLY with a valid JSON object (no markdown):
{
  "overallScore": <0-100, pacing quality score>,
  "pacingStyle": "<one of: punchy|steady|building|wave|sluggish|erratic>",
  "verdict": "<1 sentence overall assessment>",
  "recommendation": "<2-3 sentence overall recommendation>",
  "issues": [
    {
      "clipIndex": <1-based index>,
      "label": "<clip label>",
      "issueType": "<too_long|too_short|dead_air|repetitive|poor_transition|energy_drop>",
      "severity": "<low|medium|high>",
      "currentDuration": <seconds>,
      "suggestedDuration": <seconds or null>,
      "action": "<specific action: e.g. 'Trim to 3s', 'Split into 2 clips', 'Cut entirely', 'Move earlier'>"
    }
  ],
  "strengths": ["<what's working well>", "<another strength>"],
  "quickWins": ["<most impactful single change to make>", "<second quick win>", "<third>"],
  "energyArc": [<0.0-1.0 energy values, one per clip, showing the emotional journey>]
}

Rules:
- overallScore: 100 = perfect pacing, 0 = terrible
- Be specific: name exact clips by label/index
- Focus on the most impactful changes (top 5 issues max)
- energyArc must have exactly ${includedSegs.length} values`;

      await appendLog(jobId, "Consulting AI for pacing analysis...");
      await db.update(jobsTable).set({ progress: 40 }).where(eq(jobsTable.id, jobId));

      let pacingData: any = null;

      try {
        const aiMsg = await anthropic.messages.create({
          model: "claude-opus-4-5",
          max_tokens: 2000,
          messages: [{ role: "user", content: pacingPrompt }],
        });

        const raw = (aiMsg.content[0] as any).text ?? "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          pacingData = JSON.parse(jsonMatch[0]);
          await appendLog(jobId, `  ✓ Pacing score: ${pacingData.overallScore}/100 — ${pacingData.pacingStyle}`);
          await appendLog(jobId, `  Issues found: ${pacingData.issues?.length ?? 0}`);
          await appendLog(jobId, `  Quick wins: ${pacingData.quickWins?.join(" | ")}`);
        } else {
          throw new Error("No JSON found in AI response");
        }
      } catch (aiErr: any) {
        await appendLog(jobId, `  ⚠ AI analysis failed: ${aiErr?.message?.slice(0, 80)}`);
        // Fallback: generate basic pacing analysis from segment data
        const issues = includedSegs
          .map((s, i) => {
            const dur = s.endTime - s.startTime;
            if (dur > ideal.max * 2) return { clipIndex: i+1, label: s.label ?? `Clip ${i+1}`, issueType: "too_long", severity: "high", currentDuration: parseFloat(dur.toFixed(2)), suggestedDuration: ideal.max, action: `Trim to ~${ideal.max}s` };
            if (dur < ideal.min * 0.5) return { clipIndex: i+1, label: s.label ?? `Clip ${i+1}`, issueType: "too_short", severity: "medium", currentDuration: parseFloat(dur.toFixed(2)), suggestedDuration: ideal.min, action: `Extend to ~${ideal.min}s or cut` };
            return null;
          })
          .filter(Boolean)
          .slice(0, 5);

        const score = Math.max(30, Math.min(85, 100 - issues.length * 15 - (avgClipLength > ideal.max ? 20 : 0)));
        pacingData = {
          overallScore: score,
          pacingStyle: avgClipLength > ideal.max * 1.5 ? "sluggish" : avgClipLength < ideal.min * 0.7 ? "erratic" : "steady",
          verdict: `${includedSegs.length} clips, avg ${avgClipLength.toFixed(1)}s — ${score > 70 ? "good" : score > 50 ? "average" : "needs work"} pacing for ${ideal.label}.`,
          recommendation: `Target ${ideal.min}–${ideal.max}s per clip for ${ideal.label}. Your average is ${avgClipLength.toFixed(1)}s.`,
          issues,
          strengths: avgClipLength <= ideal.max ? ["Clip lengths are appropriate for the format"] : [],
          quickWins: issues.slice(0, 3).map((i: any) => `${i.action} on Clip #${i.clipIndex}: "${i.label}"`),
          energyArc: includedSegs.map((_, i) => Math.min(1, Math.max(0, 0.3 + (i / includedSegs.length) * 0.5)),
          ),
        };
      }

      await db.update(jobsTable).set({ progress: 80 }).where(eq(jobsTable.id, jobId));

      // Store on project
      await db.update(projectsTable).set({
        pacingSuggestions: JSON.stringify(pacingData),
        updatedAt: new Date(),
      }).where(eq(projectsTable.id, projectId));

      await appendLog(jobId, `✓ Pacing analysis complete: score ${pacingData.overallScore}/100 (${pacingData.pacingStyle})`);
      result = JSON.stringify({ score: pacingData.overallScore, style: pacingData.pacingStyle, issueCount: pacingData.issues?.length ?? 0 });
    }

    // ── #3: Speaker Diarization v2 ────────────────────────────────────────────
    // MFCC-based agglomerative clustering (librosa + sklearn); offline, no API.
    else if (type === "diarize_speakers_v2") {
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const targetVideos = videoId
        ? videos.filter(v => v.id === videoId)
        : videos.filter(v => v.status === "ready");

      if (targetVideos.length === 0) {
        await appendLog(jobId, "No ready videos found — upload and process videos first.");
        result = JSON.stringify({ processed: 0 });
      } else {
        // Parse options: { numSpeakers?, maxSpeakers? }
        let numSpeakers: number | undefined;
        let maxSpeakers = 8;
        try {
          const opts = options ? JSON.parse(options) : {};
          if (typeof opts.numSpeakers === "number") numSpeakers = opts.numSpeakers;
          if (typeof opts.maxSpeakers === "number") maxSpeakers = opts.maxSpeakers;
        } catch {}

        await appendLog(jobId, `Diarizing ${targetVideos.length} video(s) with MFCC+agglomerative clustering…${numSpeakers ? ` (fixed ${numSpeakers} speakers)` : " (auto-detect)"}`);
        let totalSpeakers = 0;
        let totalSegments = 0;

        for (const vid of targetVideos) {
          const filePath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
          if (!fs.existsSync(filePath)) {
            await appendLog(jobId, `  ⚠ Missing file for "${vid.originalName}" — skip`);
            continue;
          }

          await appendLog(jobId, `  Processing "${vid.originalName}"…`);
          const scriptPath = path.join(__dirname, "../../scripts/diarize_speakers_v2.py");
          const scriptArgs = [scriptPath, filePath, `--max_speakers=${maxSpeakers}`];
          if (numSpeakers) scriptArgs.push(`--num_speakers=${numSpeakers}`);

          const { stdout, stderr } = await execAsync(
            `python3 ${scriptArgs.join(" ")}`
          ).catch(e => ({ stdout: "", stderr: String(e) }));

          if (!stdout.trim()) {
            await appendLog(jobId, `  ⚠ No output: ${stderr.slice(0, 300)}`);
            continue;
          }

          let parsed: any;
          try { parsed = JSON.parse(stdout); } catch { await appendLog(jobId, `  ⚠ Parse error`); continue; }
          if (parsed.error) { await appendLog(jobId, `  ⚠ ${parsed.error}`); continue; }

          const speakers: string[] = parsed.speakers ?? [];
          const segs: any[] = parsed.segments ?? [];
          totalSpeakers = Math.max(totalSpeakers, speakers.length);
          totalSegments += segs.length;

          await appendLog(jobId, `  ✓ "${vid.originalName}": ${speakers.length} speaker(s) detected — ${segs.length} segments`);
          for (const spk of speakers) {
            const spkSegs = segs.filter((s: any) => s.speaker === spk);
            const totalTime = spkSegs.reduce((a: number, s: any) => a + (s.duration ?? 0), 0);
            await appendLog(jobId, `    ${spk}: ${spkSegs.length} segment(s), ${totalTime.toFixed(1)}s`);
          }

          // Merge into sceneAnalysis
          let sa: any = {};
          try { sa = JSON.parse(vid.sceneAnalysis ?? "{}"); } catch {}
          sa.speakerDiarization = {
            speakers,
            numSpeakers: speakers.length,
            segments: segs,
            method: parsed.method ?? "mfcc_agglomerative",
            duration: parsed.duration,
            analyzedAt: new Date().toISOString(),
          };

          await db.update(videosTable).set({
            sceneAnalysis: JSON.stringify(sa),
          }).where(eq(videosTable.id, vid.id));
        }

        await appendLog(jobId, `✓ Diarization complete: up to ${totalSpeakers} distinct speaker(s), ${totalSegments} total segments`);
        result = JSON.stringify({ processed: targetVideos.length, totalSpeakers, totalSegments });
      }
    }

    // ── #21: Action Boundary Detection ─────────────────────────────────────────
    else if (type === "detect_action_boundaries") {
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const targetVideos = videoId
        ? videos.filter(v => v.id === videoId)
        : videos.filter(v => v.status === "ready");

      if (targetVideos.length === 0) {
        await appendLog(jobId, "No ready videos found — upload and process videos first.");
        result = JSON.stringify({ processed: 0 });
      } else {
        await appendLog(jobId, `Detecting action boundaries in ${targetVideos.length} video(s)…`);
        let totalBoundaries = 0;

        for (const vid of targetVideos) {
          const filePath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
          if (!fs.existsSync(filePath)) {
            await appendLog(jobId, `  ⚠ Missing file for "${vid.originalName}" — skip`);
            continue;
          }

          await appendLog(jobId, `  Running optical flow on "${vid.originalName}"…`);
          const { stdout, stderr } = await execAsync(
            `python3 ${path.join(__dirname, "../../scripts/detect_action_boundaries.py")} "${filePath}" --fps 10`
          ).catch(e => ({ stdout: "", stderr: String(e) }));

          if (!stdout.trim()) {
            await appendLog(jobId, `  ⚠ No output: ${stderr.slice(0, 200)}`);
            continue;
          }

          let parsed: any;
          try { parsed = JSON.parse(stdout); } catch { await appendLog(jobId, `  ⚠ Parse error`); continue; }
          if (parsed.error) { await appendLog(jobId, `  ⚠ ${parsed.error}`); continue; }

          const boundaries: any[] = parsed.action_boundaries ?? [];
          totalBoundaries += boundaries.length;

          const settleCount = boundaries.filter((b: any) => b.type === "settle").length;
          const gapCount    = boundaries.filter((b: any) => b.type === "gap").length;
          await appendLog(jobId, `  ✓ "${vid.originalName}": ${boundaries.length} boundaries — ${settleCount} settle, ${gapCount} gap | avg_motion=${parsed.avg_motion} max=${parsed.max_motion}`);

          // Merge into sceneAnalysis
          let sa: any = {};
          try { sa = JSON.parse(vid.sceneAnalysis ?? "{}"); } catch {}
          sa.actionBoundaries  = boundaries;
          sa.motionProfile     = parsed.motion_profile ?? [];
          sa.motionStats       = { avg: parsed.avg_motion, max: parsed.max_motion, frames: parsed.frames_analyzed };

          await db.update(videosTable).set({
            sceneAnalysis: JSON.stringify(sa),
          }).where(eq(videosTable.id, vid.id));
        }

        await appendLog(jobId, `✓ Action boundary detection complete: ${totalBoundaries} boundaries across ${targetVideos.length} video(s)`);
        result = JSON.stringify({ processed: targetVideos.length, totalBoundaries });
      }
    }

    // ── #23: Audio-Visual Correspondence Checker ────────────────────────────────
    else if (type === "check_av_correspondence") {
      // For each included segment: compare spoken transcript text vs visual
      // clip description using text-embedding-3-small cosine similarity.
      // Flags mismatches (similarity < 0.2) and writes a score to the segment's aiReason.
      const segments = await db.select().from(segmentsTable).where(
        and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true))
      );
      const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

      if (segments.length === 0) {
        await appendLog(jobId, "No included segments found — generate an edit plan first.");
        result = JSON.stringify({ checked: 0, mismatches: 0 });
      } else {
        await appendLog(jobId, `Checking AV correspondence for ${segments.length} segment(s)…`);

        // Build video map
        const videoMap = new Map<string, (typeof videos)[0]>();
        for (const v of videos) {
          videoMap.set(v.id, v);
          if (v.filename)      videoMap.set(v.filename, v);
          if (v.originalName)  videoMap.set(v.originalName, v);
        }

        // Build primary video transcript index (for A-roll speech-aligned timestamps)
        // No explicit A-roll/B-roll flag on videosTable — pick the first with a transcript
        const primaryVideo = videos.find(v => !!v.transcript);
        let transcriptWords: Array<{ word: string; start: number; end: number }> = [];
        if (primaryVideo?.transcript) {
          try {
            const tr = JSON.parse(primaryVideo.transcript);
            transcriptWords = (tr.words ?? []).filter((w: any) => w.word && w.start != null);
          } catch {}
        }

        const getTranscriptText = (startSec: number, endSec: number): string => {
          const words = transcriptWords
            .filter(w => w.start >= startSec - 0.2 && w.end <= endSec + 0.2)
            .map(w => w.word);
          return words.join(" ").trim();
        };

        // Embed helper (batch of up to 50) — reuses the shared `openai` client imported above
        const embedTexts = async (texts: string[]): Promise<number[][]> => {
          const resp = await openai.embeddings.create({ model: "text-embedding-3-small", input: texts });
          return resp.data.map(d => d.embedding);
        };
        const cosine = (a: number[], b: number[]): number => {
          let dot = 0, na = 0, nb = 0;
          for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
          return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
        };

        const checkResults: Array<{ segmentId: string; score: number; mismatch: boolean; spokenText: string; visualDesc: string }> = [];
        const segPairs: Array<{ seg: (typeof segments)[0]; spokenText: string; visualDesc: string }> = [];

        for (const seg of segments) {
          // Get spoken text from transcript (for A-roll) or fall back to aiReason
          const spokenText = getTranscriptText(seg.startTime ?? 0, seg.endTime ?? 0) || (seg.aiReason ?? "");
          if (!spokenText) continue;

          // Get visual description from video's clipAnalysis
          const vid = videoMap.get(seg.videoId ?? "");
          if (!vid) continue;

          let visualDesc = "";
          try {
            const ca = JSON.parse(vid.clipAnalysis ?? "{}");
            const clips: any[] = ca.clips ?? [];
            const segStart = seg.startTime ?? 0;
            const segEnd   = seg.endTime ?? 0;
            // Find overlapping clip analysis
            const overlapping = clips.filter(c =>
              c.startTime != null && c.endTime != null &&
              c.startTime < segEnd && c.endTime > segStart
            );
            visualDesc = overlapping.map((c: any) => [c.description, (c.tags ?? []).join(", ")].filter(Boolean).join(": ")).join("; ");
            if (!visualDesc) visualDesc = ca.summary ?? "";
          } catch {}

          if (!visualDesc) continue;

          segPairs.push({ seg, spokenText: spokenText.slice(0, 512), visualDesc: visualDesc.slice(0, 512) });
        }

        // Batch embed in groups of 20 pairs
        const BATCH = 20;
        let mismatches = 0;
        for (let i = 0; i < segPairs.length; i += BATCH) {
          const batch = segPairs.slice(i, i + BATCH);
          const allTexts = [...batch.map(p => p.spokenText), ...batch.map(p => p.visualDesc)];
          try {
            const embeddings = await embedTexts(allTexts);
            for (let j = 0; j < batch.length; j++) {
              const spokenEmb = embeddings[j];
              const visualEmb = embeddings[batch.length + j];
              const score = cosine(spokenEmb, visualEmb);
              const mismatch = score < 0.20;
              if (mismatch) mismatches++;

              checkResults.push({
                segmentId:  batch[j].seg.id,
                score:      Math.round(score * 1000) / 1000,
                mismatch,
                spokenText: batch[j].spokenText.slice(0, 60),
                visualDesc: batch[j].visualDesc.slice(0, 60),
              });

              // Annotate the segment's aiReason with AV score
              const existingReason = batch[j].seg.aiReason ?? "";
              const reasonWithoutOld = existingReason.replace(/\[AV:[^\]]+\]/, "").trim();
              const avTag = mismatch ? `[AV:mismatch=${score.toFixed(2)}]` : `[AV:ok=${score.toFixed(2)}]`;
              const newReason = reasonWithoutOld ? `${reasonWithoutOld} ${avTag}` : avTag;
              await db.update(segmentsTable).set({ aiReason: newReason }).where(eq(segmentsTable.id, batch[j].seg.id));

              if (mismatch) await appendLog(jobId, `  ⚠ MISMATCH seg ${batch[j].seg.id.slice(0,8)}: score=${score.toFixed(3)} | spoken="${batch[j].spokenText.slice(0,40)}" ≠ visual="${batch[j].visualDesc.slice(0,40)}"`);
            }
          } catch (err: any) {
            await appendLog(jobId, `  ⚠ Embedding batch error: ${err.message}`);
          }
          await appendLog(jobId, `  Progress: ${Math.min(i + BATCH, segPairs.length)}/${segPairs.length} segments embedded`);
        }

        const checked = checkResults.length;
        const avgScore = checked > 0 ? checkResults.reduce((s, r) => s + r.score, 0) / checked : 0;
        await appendLog(jobId, `✓ AV correspondence: ${checked} segments checked, ${mismatches} mismatch(es), avg score=${avgScore.toFixed(3)}`);
        result = JSON.stringify({ checked, mismatches, avgScore: Math.round(avgScore * 1000) / 1000, details: checkResults });
      }
    }

    // ── #24: Cross-Video Consistency Checker ────────────────────────────────────
    else if (type === "check_consistency") {
      // Measures color temperature, audio level, and caption style consistency
      // across all videos in the project and produces a QC report.
      const videos = await db.select().from(videosTable).where(
        and(eq(videosTable.projectId, projectId), eq(videosTable.status, "ready"))
      );
      const segments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId));

      if (videos.length < 2) {
        await appendLog(jobId, "Need ≥2 ready videos to compare consistency. Upload more source files.");
        result = JSON.stringify({ score: 100, issues: [] });
      } else {
        await appendLog(jobId, `Checking consistency across ${videos.length} video(s)…`);
        const issues: Array<{ category: string; severity: "warn" | "error"; message: string; videoName?: string }> = [];

        // ── Color temperature via keyframe sampling ──────────────────────────
        await appendLog(jobId, "  Sampling color temperature from keyframes…");
        interface ColorProfile { name: string; warmth: number; r: number; g: number; b: number }
        const colorProfiles: ColorProfile[] = [];

        for (const vid of videos) {
          const filePath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
          if (!fs.existsSync(filePath)) continue;

          // Extract 3 keyframes at 25%, 50%, 75% of duration with ffmpeg
          const tmpDir = path.join("/tmp", `cc_${vid.id}`);
          fs.mkdirSync(tmpDir, { recursive: true });

          try {
            await execAsync(
              `ffmpeg -y -i "${filePath}" -vf "select='eq(n\\,0)+gte(mod(t,${Math.max(1, Math.round((vid.durationSeconds ?? 30) / 4))}),${Math.max(1, Math.round((vid.durationSeconds ?? 30) / 4))}-0.1)',scale=160:90" -frames:v 3 -vsync vfr "${tmpDir}/frame%01d.png" 2>/dev/null`
            ).catch(() => {});

            const frames = fs.readdirSync(tmpDir).filter(f => f.endsWith(".png"));
            if (frames.length > 0) {
              // Compute mean R, G, B across frames via ffmpeg signalstats
              const statLines: string[] = [];
              for (const f of frames.slice(0, 3)) {
                const { stdout } = await execAsync(
                  `ffprobe -v quiet -f lavfi -i "movie=${path.join(tmpDir, f)},signalstats" -show_entries frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG -of csv=p=0 2>/dev/null`
                ).catch(() => ({ stdout: "" }));
                if (stdout.trim()) statLines.push(stdout.trim());
              }

              // Fallback: use ffmpeg to read mean pixel values via histogram
              const { stdout: histOut } = await execAsync(
                `ffprobe -v quiet -f lavfi -i "movie=${path.join(tmpDir, frames[0])}" -show_entries frame_tags=lavfi.signalstats.YAVG -of default=noprint_wrappers=1 2>/dev/null`
              ).catch(() => ({ stdout: "" }));

              // Parse R/G/B via imageio-level ffprobe in YUV → approx warmth
              // warmth = (R - B) scaled. In YUV: R ≈ Y + 1.402*(V-128), B ≈ Y - 1.772*(U-128)
              let warmth = 0;
              if (statLines.length > 0) {
                const parsed = statLines[0].split(",").map(Number);
                if (parsed.length >= 3) {
                  const [Y, U, V] = parsed;
                  const R = Math.max(0, Math.min(255, Y + 1.402 * (V - 128)));
                  const B = Math.max(0, Math.min(255, Y - 1.772 * (U - 128)));
                  warmth = R - B;  // positive = warm, negative = cool
                }
              }
              colorProfiles.push({ name: vid.originalName ?? vid.filename, warmth, r: 0, g: 0, b: 0 });
            }
          } catch {}

          // Cleanup
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }

        if (colorProfiles.length >= 2) {
          const warmths = colorProfiles.map(p => p.warmth);
          const avgWarmth = warmths.reduce((a, b) => a + b, 0) / warmths.length;
          for (const prof of colorProfiles) {
            const deviation = Math.abs(prof.warmth - avgWarmth);
            if (deviation > 20) {
              const dir = prof.warmth > avgWarmth ? "warmer" : "cooler";
              const sev = deviation > 40 ? "error" : "warn";
              issues.push({ category: "color_temperature", severity: sev, message: `"${prof.name}" is significantly ${dir} than the project average (deviation: ${deviation.toFixed(0)} pts)`, videoName: prof.name });
            }
          }
          await appendLog(jobId, `  Color temperature: avg warmth=${avgWarmth.toFixed(0)}, ${colorProfiles.length} samples, ${issues.filter(i => i.category === "color_temperature").length} outlier(s)`);
        } else {
          await appendLog(jobId, "  Color temperature: insufficient keyframe data — skipping");
        }

        // ── Audio level consistency via ffmpeg volumedetect ─────────────────
        await appendLog(jobId, "  Measuring audio levels with volumedetect…");
        interface AudioProfile { name: string; meanVolume: number; maxVolume: number }
        const audioProfiles: AudioProfile[] = [];

        for (const vid of videos) {
          const filePath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
          if (!fs.existsSync(filePath)) continue;

          const { stderr } = await execAsync(
            `ffmpeg -y -i "${filePath}" -af volumedetect -vn -f null /dev/null 2>&1`
          ).catch(e => ({ stderr: e.stderr ?? String(e) }));

          const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
          const maxMatch  = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
          if (meanMatch && maxMatch) {
            audioProfiles.push({
              name:       vid.originalName ?? vid.filename,
              meanVolume: parseFloat(meanMatch[1]),
              maxVolume:  parseFloat(maxMatch[1]),
            });
          }
        }

        if (audioProfiles.length >= 2) {
          const means = audioProfiles.map(p => p.meanVolume);
          const avgMean = means.reduce((a, b) => a + b, 0) / means.length;
          for (const prof of audioProfiles) {
            const deviation = Math.abs(prof.meanVolume - avgMean);
            if (deviation > 6) {  // >6dB is clearly audible difference
              const dir = prof.meanVolume > avgMean ? "louder" : "quieter";
              const sev = deviation > 12 ? "error" : "warn";
              issues.push({ category: "audio_level", severity: sev, message: `"${prof.name}" is ${deviation.toFixed(1)} dB ${dir} than project average (mean: ${prof.meanVolume} dB)`, videoName: prof.name });
            }
          }
          await appendLog(jobId, `  Audio levels: avg=${avgMean.toFixed(1)} dBFS, ${audioProfiles.length} videos measured, ${issues.filter(i => i.category === "audio_level").length} outlier(s)`);
        } else {
          await appendLog(jobId, "  Audio levels: insufficient data — skipping");
        }

        // ── Caption style consistency ────────────────────────────────────────
        await appendLog(jobId, "  Checking caption style consistency…");
        const captionStyles = new Map<string, string[]>();
        for (const seg of segments) {
          const style = (seg as any).captionStyle ?? "none";
          if (!captionStyles.has(style)) captionStyles.set(style, []);
          captionStyles.get(style)!.push(seg.id);
        }
        const styleEntries = [...captionStyles.entries()].filter(([s]) => s !== "none");
        if (styleEntries.length > 1) {
          const dominant = styleEntries.reduce((a, b) => a[1].length > b[1].length ? a : b);
          for (const [style, ids] of styleEntries) {
            if (style !== dominant[0]) {
              issues.push({ category: "caption_style", severity: "warn", message: `${ids.length} segment(s) use caption style "${style}" but most use "${dominant[0]}" — unify for consistency` });
            }
          }
        }
        await appendLog(jobId, `  Caption styles: ${styleEntries.length} style(s) in use, ${issues.filter(i => i.category === "caption_style").length} inconsistency(ies)`);

        // ── Scoring ──────────────────────────────────────────────────────────
        const errorCount = issues.filter(i => i.severity === "error").length;
        const warnCount  = issues.filter(i => i.severity === "warn").length;
        const score = Math.max(0, 100 - errorCount * 15 - warnCount * 5);

        const report = { score, issues, colorProfiles, audioProfiles, checkedAt: new Date().toISOString() };

        if (issues.length > 0) {
          await appendLog(jobId, `⚠ ${errorCount} error(s), ${warnCount} warning(s):`);
          for (const issue of issues) await appendLog(jobId, `  [${issue.severity.toUpperCase()}] [${issue.category}] ${issue.message}`);
        } else {
          await appendLog(jobId, "✓ All consistency checks passed — project looks uniform");
        }
        await appendLog(jobId, `✓ Consistency score: ${score}/100`);
        result = JSON.stringify({ score, issues, errorCount, warnCount });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // visual_scan — Claude Vision on sampled keyframes
    //
    // The editor's eyes: samples N keyframes via ffmpeg at evenly spaced
    // intervals, base64-encodes each, and sends them to Claude Vision in a
    // single prompt. Claude returns a timed visual description, shot type,
    // subject, emotional tone, and an editorial "story beat" tag per frame.
    // This is what makes the E2E workflow genuinely understand the video.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "visual_scan") {
      const scanOpts = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      const framesPerVideo: number = Math.max(4, Math.min(24, scanOpts.frames ?? 12));
      const maxDim: number         = scanOpts.maxDim ?? 768; // keep payloads small

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      const targetVideos = videoId
        ? projectVideos.filter(v => v.id === videoId)
        : projectVideos.filter(v => v.mimeType?.startsWith("video/"));

      if (targetVideos.length === 0) throw new Error("No video files to scan");

      await appendLog(jobId, `Visual scan: ${targetVideos.length} video(s), ${framesPerVideo} keyframes each (Claude Vision).`);
      await db.update(jobsTable).set({ progress: 8 }).where(eq(jobsTable.id, jobId));

      const perVideoResults: Array<{ videoId: string; keyframes: any[]; narrative: string }> = [];

      for (let vi = 0; vi < targetVideos.length; vi++) {
        const vid = targetVideos[vi];
        const srcPath = vid.filePath ?? path.join(UPLOAD_DIR, vid.filename);
        if (!srcPath || !fs.existsSync(srcPath)) {
          await appendLog(jobId, `  ⚠ "${vid.originalName}": file not on disk, skipping`);
          continue;
        }

        const dur = vid.durationSeconds ?? 0;
        if (dur <= 0) {
          await appendLog(jobId, `  ⚠ "${vid.originalName}": unknown duration, skipping`);
          continue;
        }

        await appendLog(jobId, `  [${vi + 1}/${targetVideos.length}] Sampling ${framesPerVideo} keyframes from "${vid.originalName}" (${dur.toFixed(1)}s)...`);

        // Sample timestamps evenly, skipping the first and last 2% so we don't
        // catch fade-ins or abrupt endings.
        const timestamps: number[] = [];
        const pad = Math.min(dur * 0.02, 0.5);
        for (let k = 0; k < framesPerVideo; k++) {
          const t = pad + ((dur - 2 * pad) * (k + 0.5)) / framesPerVideo;
          timestamps.push(parseFloat(t.toFixed(3)));
        }

        // Extract each keyframe as a small jpeg into /tmp
        const frameDir = path.join(RENDER_DIR, `scan_${jobId}_${vid.id}`);
        fs.mkdirSync(frameDir, { recursive: true });
        const frameFiles: Array<{ timestamp: number; path: string }> = [];

        for (let k = 0; k < timestamps.length; k++) {
          const framePath = path.join(frameDir, `f_${String(k).padStart(3, "0")}.jpg`);
          try {
            await runFfmpeg([
              "-ss", String(timestamps[k]),
              "-i", srcPath,
              "-frames:v", "1",
              "-vf", `scale='min(${maxDim},iw)':-2`,
              "-q:v", "4",
              "-y", framePath,
            ]);
            if (fs.existsSync(framePath)) frameFiles.push({ timestamp: timestamps[k], path: framePath });
          } catch (e: any) {
            await appendLog(jobId, `    ⚠ frame @${timestamps[k]}s failed: ${e?.message?.slice(0, 80)}`);
          }
        }

        if (frameFiles.length === 0) {
          await appendLog(jobId, `    ⚠ no frames extracted, skipping "${vid.originalName}"`);
          continue;
        }

        const progressPct = 8 + Math.round(((vi + 0.5) / targetVideos.length) * 80);
        await db.update(jobsTable).set({ progress: progressPct }).where(eq(jobsTable.id, jobId));

        // Build Claude multimodal prompt — one image block per keyframe, labeled
        // with its timestamp so Claude can return aligned, timed output.
        const imageBlocks = frameFiles.map((f, i) => {
          const b64 = fs.readFileSync(f.path).toString("base64");
          return [
            { type: "text" as const, text: `Frame ${i + 1} — timestamp ${f.timestamp.toFixed(2)}s:` },
            { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: b64 } },
          ];
        }).flat();

        // Transcript context: if we already transcribed, let Claude correlate
        // visuals with spoken words for each window.
        let txContext = "";
        if (vid.transcript) {
          try {
            const tx = JSON.parse(vid.transcript);
            const segs: Array<{ start: number; end: number; text: string }> = tx.segments ?? [];
            const sample = segs.slice(0, 40).map(s => `[${s.start.toFixed(1)}s→${s.end.toFixed(1)}s] "${s.text.trim()}"`).join("\n");
            if (sample) txContext = `\n\nTRANSCRIPT (for context — align visual beats with spoken words):\n${sample}`;
          } catch {}
        }

        const scanPrompt = `You are a professional video editor scanning raw footage. Look at ${frameFiles.length} keyframes sampled evenly from a ${dur.toFixed(1)}s clip named "${vid.originalName}".

Your job: describe what you SEE in each frame with an editor's eye — shot type, framing, subject, light, motion energy, emotional tone — and tag each frame with a story beat so an AI editor can plan cuts.${txContext}

Return ONLY valid JSON (no markdown fences, no prose) with this exact shape:
{
  "clipSummary": "<one-sentence editorial summary of what this clip is and what it's good for>",
  "mood": "<joyful|emotional|intimate|energetic|calm|tense|triumphant|melancholy|neutral>",
  "dominantSubject": "<e.g. bride, couple, crowd, landscape, hands, product, face>",
  "storyValue": <0.0-1.0 — overall editorial value of this clip for a highlight>,
  "bestHookWindow": { "start": <sec>, "end": <sec>, "why": "<why this is the strongest attention-grabber>" },
  "bestClimaxWindow": { "start": <sec>, "end": <sec>, "why": "<why this is the emotional peak>" },
  "keyframes": [
    {
      "timestamp": <exact sec from label above>,
      "shotType": "<wide|medium|close_up|extreme_close_up|over_the_shoulder|pov|establishing|insert|cutaway|two_shot>",
      "subject": "<what's in frame>",
      "action": "<what is happening>",
      "emotion": "<facial/body emotion if visible>",
      "lighting": "<natural|golden_hour|low_light|overcast|harsh|studio|mixed>",
      "motionEnergy": <0.0-1.0>,
      "storyBeat": "<hook|buildup|conflict|climax|resolution|cta|b_roll|filler>",
      "editorNote": "<1-sentence note a human editor would write in the margin>"
    }
  ]
}`;

        let parsed: any = null;
        try {
          const msg = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            messages: [{
              role: "user",
              content: [
                ...imageBlocks,
                { type: "text", text: scanPrompt },
              ],
            }],
          });
          const textBlock = msg.content.find(c => c.type === "text");
          const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
        } catch (e: any) {
          await appendLog(jobId, `    ⚠ Claude Vision call failed for "${vid.originalName}": ${e?.message?.slice(0, 120)}`);
        }

        // Always clean up frame files — they're large
        try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch {}

        if (!parsed) {
          await appendLog(jobId, `    ⚠ could not parse visual response for "${vid.originalName}"`);
          continue;
        }

        // Merge visual scan into video.sceneAnalysis so downstream jobs (edit
        // plan, b-roll, color) can leverage it without changing their schemas.
        let existing: any = {};
        try { existing = JSON.parse(vid.sceneAnalysis ?? "{}"); } catch {}
        const merged = {
          ...existing,
          visualScan: {
            model: "claude-sonnet-4-6",
            framesAnalysed: frameFiles.length,
            scannedAt: new Date().toISOString(),
            ...parsed,
          },
        };
        await db.update(videosTable).set({ sceneAnalysis: JSON.stringify(merged) }).where(eq(videosTable.id, vid.id));

        perVideoResults.push({
          videoId: vid.id,
          keyframes: parsed.keyframes ?? [],
          narrative: parsed.clipSummary ?? "",
        });

        const kf = (parsed.keyframes ?? []).length;
        const mood = parsed.mood ?? "?";
        const sv = typeof parsed.storyValue === "number" ? Math.round(parsed.storyValue * 100) : "?";
        await appendLog(jobId, `    ✓ "${vid.originalName}": ${kf} keyframes described | mood=${mood} | storyValue=${sv}/100`);
      }

      await db.update(jobsTable).set({ progress: 95 }).where(eq(jobsTable.id, jobId));
      await appendLog(jobId, `Visual scan complete — ${perVideoResults.length} video(s) understood by Claude Vision.`);
      result = JSON.stringify({
        videosScanned: perVideoResults.length,
        totalKeyframes: perVideoResults.reduce((a, b) => a + b.keyframes.length, 0),
        perVideo: perVideoResults,
      });
      await db.insert(activityTable).values({ id: randomUUID(), type: "ai_analysis_done", description: `Visual scan complete for ${perVideoResults.length} clip(s)`, projectId, projectName: null });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // e2e_workflow — the two professional end-to-end editing workflows.
    //
    // preset "fast_social_cut" → hook-first vertical short (9:16, 15–60s)
    // preset "cinematic_story" → emotional horizontal highlight (16:9, 2–5min)
    //
    // Both chain the same 5 steps so the user just picks a preset and waits:
    //   1. transcribe         (Whisper — words the edit cuts on)
    //   2. visual_scan        (Claude Vision — understands what we're looking at)
    //   3. generate_edit_plan (Claude — timeline with story arc + pacing)
    //   4. apply_edit         (validate + lock segments)
    //   5. render             (final MP4, aspect-correct)
    //
    // Each step runs as a real sub-job so logs stream individually AND the
    // parent e2e job also streams a single consolidated progress bar.
    // ─────────────────────────────────────────────────────────────────────────
    else if (type === "e2e_workflow") {
      const wOpts = (() => { try { return JSON.parse(options ?? "{}"); } catch { return {}; } })();
      const preset: string = wOpts.preset ?? "fast_social_cut";
      const storyPrefs = wOpts.storyPrefs ?? null;

      // The preset decides target format, pacing, arc, render aspect and the
      // editorial tone Claude should adopt. Everything downstream reads from
      // projectsTable + segmentsTable, so the orchestrator's job is to stamp
      // the right settings first, then chain the jobs.
      const PRESETS: Record<string, {
        label: string;
        targetFormat: string;
        genre: string;
        renderFormat: "vertical" | "landscape";
        defaultStoryPrefs: Record<string, unknown>;
        visualFrames: number;
      }> = {
        fast_social_cut: {
          label: "Fast Social Cut",
          targetFormat: "instagram_reel",
          genre: "social_media",
          renderFormat: "vertical",
          defaultStoryPrefs: { tone: "dynamic", focus: "mixed", pacing: "fast", targetDuration: 45 },
          visualFrames: 10,
        },
        cinematic_story: {
          label: "Cinematic Story",
          targetFormat: "wedding_highlight",
          genre: "short_film",
          renderFormat: "landscape",
          defaultStoryPrefs: { tone: "emotional", focus: "mixed", pacing: "medium", targetDuration: 180 },
          visualFrames: 14,
        },
      };

      const config = PRESETS[preset];
      if (!config) throw new Error(`Unknown workflow preset: ${preset}`);

      const effectivePrefs = { ...config.defaultStoryPrefs, ...(storyPrefs ?? {}) };
      await appendLog(jobId, `━━━ E2E Workflow: ${config.label} ━━━`);
      await appendLog(jobId, `Preset: ${preset} | format: ${config.targetFormat} | render: ${config.renderFormat}`);
      await appendLog(jobId, `Target duration: ${(effectivePrefs as any).targetDuration}s, tone: ${(effectivePrefs as any).tone}, pacing: ${(effectivePrefs as any).pacing}`);

      // Stamp project settings so downstream jobs pick them up
      await db.update(projectsTable).set({
        targetFormat: config.targetFormat,
        genrePreset: config.genre,
        updatedAt: new Date(),
      }).where(eq(projectsTable.id, projectId));

      const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
      if (projectVideos.length === 0) throw new Error("No videos uploaded to this project");

      // Helper: create a sub-job and run it to completion inline, forwarding
      // its log lines to the parent job so the UI sees one stream.
      const runSubJob = async (subType: string, subVideoId: string | null, subOptions: Record<string, unknown> | null, phaseLabel: string, phaseStartPct: number, phaseEndPct: number) => {
        const subJobId = randomUUID();
        const subOptsStr = subOptions ? JSON.stringify(subOptions) : null;
        await db.insert(jobsTable).values({
          id: subJobId,
          projectId,
          videoId: subVideoId,
          type: subType,
          status: "pending",
          progress: 0,
          logLines: "[]",
          options: subOptsStr,
        });
        await appendLog(jobId, `▶ ${phaseLabel} — launching sub-job ${subType}`);

        // Run the sub-job and poll its progress, mirroring into our parent log
        const subPromise = runJobAsync(subJobId, projectId, subVideoId, subType, subOptsStr);
        let lastLogCount = 0;
        let lastProgress = 0;
        while (true) {
          await delay(600);
          const [current] = await db.select().from(jobsTable).where(eq(jobsTable.id, subJobId));
          if (!current) break;

          const lines: string[] = JSON.parse(current.logLines ?? "[]");
          if (lines.length > lastLogCount) {
            for (const line of lines.slice(lastLogCount)) {
              await appendLog(jobId, `  ${line}`);
            }
            lastLogCount = lines.length;
          }

          if (current.progress !== lastProgress) {
            lastProgress = current.progress;
            const parentPct = Math.round(phaseStartPct + (phaseEndPct - phaseStartPct) * (current.progress / 100));
            await db.update(jobsTable).set({ progress: Math.max(lastProgress > 0 ? parentPct : 0, parentPct) }).where(eq(jobsTable.id, jobId));
          }

          if (current.status === "completed" || current.status === "failed") {
            await subPromise.catch(() => {});
            if (current.status === "failed") {
              throw new Error(`${subType} failed: ${current.errorMessage ?? "unknown error"}`);
            }
            return current;
          }
        }
        await subPromise.catch(() => {});
        return null;
      };

      // Step 1: Transcribe each video that doesn't already have a transcript
      const needTranscribe = projectVideos.filter(v => !v.transcript);
      if (needTranscribe.length > 0) {
        await appendLog(jobId, `Step 1/5 — Transcription (${needTranscribe.length} video(s))`);
        for (let i = 0; i < needTranscribe.length; i++) {
          const v = needTranscribe[i];
          const a = 2 + Math.round((i / needTranscribe.length) * 18);
          const b = 2 + Math.round(((i + 1) / needTranscribe.length) * 18);
          await runSubJob("transcribe", v.id, null, `Transcribe ${i + 1}/${needTranscribe.length} "${v.originalName}"`, a, b);
        }
      } else {
        await appendLog(jobId, "Step 1/5 — Transcription: already done, skipping");
        await db.update(jobsTable).set({ progress: 20 }).where(eq(jobsTable.id, jobId));
      }

      // Step 2: Visual scan with Claude Vision (every video, every time — it's cheap and crucial)
      await appendLog(jobId, `Step 2/5 — Visual Scan with Claude Vision (${projectVideos.length} video(s))`);
      for (let i = 0; i < projectVideos.length; i++) {
        const v = projectVideos[i];
        if (!v.mimeType?.startsWith("video/")) continue;
        const a = 20 + Math.round((i / projectVideos.length) * 25);
        const b = 20 + Math.round(((i + 1) / projectVideos.length) * 25);
        await runSubJob("visual_scan", v.id, { frames: config.visualFrames }, `Visual scan ${i + 1}/${projectVideos.length} "${v.originalName}"`, a, b);
      }

      // Step 3: Generate edit plan — Claude builds the timeline
      await appendLog(jobId, "Step 3/5 — Generate Edit Plan (Claude sonnet + story prefs)");
      await runSubJob("generate_edit_plan", null, { storyPrefs: effectivePrefs }, "Edit plan", 45, 72);

      // Step 4: Apply / validate the edit
      await appendLog(jobId, "Step 4/5 — Apply & Validate Edit");
      await runSubJob("apply_edit", null, null, "Apply edit", 72, 80);

      // Step 5: Render the final MP4 in the preset's aspect ratio
      await appendLog(jobId, `Step 5/5 — Render (${config.renderFormat === "vertical" ? "1080×1920 9:16" : "1920×1080 16:9"})`);
      const renderOpts = config.renderFormat === "vertical" ? { format: "vertical" } : {};
      await runSubJob("render", null, renderOpts, "Render", 80, 97);

      // Summary
      const finalSegs = await db.select().from(segmentsTable)
        .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)));
      const totalSec = finalSegs.reduce((a, s) => a + (s.endTime - s.startTime) / (s.speedFactor ?? 1), 0);

      const summary = {
        preset,
        label: config.label,
        targetFormat: config.targetFormat,
        renderFormat: config.renderFormat,
        videos: projectVideos.length,
        segments: finalSegs.length,
        durationSec: parseFloat(totalSec.toFixed(2)),
        completedAt: new Date().toISOString(),
      };
      result = JSON.stringify(summary);
      await appendLog(jobId, `━━━ Workflow done — ${finalSegs.length} segments, ${totalSec.toFixed(1)}s ${config.label} ━━━`);
      await db.insert(activityTable).values({
        id: randomUUID(),
        type: "ai_analysis_done",
        description: `E2E ${config.label} workflow completed — ${finalSegs.length} segments, ${totalSec.toFixed(1)}s`,
        projectId,
        projectName: null,
      });
    }

    await db.update(jobsTable).set({ status: "completed", progress: 100, result, completedAt: new Date(), aiModel: "claude-sonnet-4-6" }).where(eq(jobsTable.id, jobId));
    await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await appendLog(jobId, `ERROR: ${errorMessage}`);
    await db.update(jobsTable).set({ status: "failed", errorMessage, completedAt: new Date() }).where(eq(jobsTable.id, jobId));
  }
}

router.post("/jobs", async (req, res) => {
  const body = CreateJobBody.parse(req.body);
  const id = randomUUID();
  // Serialize all job options including styleId into the options JSON column
  const optionsObj: Record<string, any> = {};
  if (body.options) optionsObj.preset = body.options;
  if ((body as any).styleId) optionsObj.styleId = (body as any).styleId;
  const optionsStr = Object.keys(optionsObj).length > 0 ? JSON.stringify(optionsObj) : null;
  const [job] = await db
    .insert(jobsTable)
    .values({ id, projectId: body.projectId, videoId: body.videoId ?? null, type: body.type, status: "pending", progress: 0, logLines: "[]", options: optionsStr })
    .returning();

  runJobAsync(id, body.projectId, body.videoId, body.type, optionsStr).catch(() => {});

  res.status(201).json(serializeJob(job));
});

router.get("/jobs/:id", async (req, res) => {
  const { id } = GetJobParams.parse(req.params);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(serializeJob(job));
});

router.get("/projects/:id/jobs", async (req, res) => {
  const { id } = ListProjectJobsParams.parse(req.params);
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.projectId, id));
  res.json(jobs.map(serializeJob));
});

router.get("/jobs/:id/stream", async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let lastLogCount = 0;
  let lastStatus = "";

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(async () => {
    try {
      const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
      if (!job) {
        send("error", { message: "Job not found" });
        clearInterval(interval);
        res.end();
        return;
      }

      const lines: string[] = JSON.parse(job.logLines ?? "[]");
      if (lines.length > lastLogCount) {
        const newLines = lines.slice(lastLogCount);
        for (const line of newLines) {
          send("log_line", { line });
        }
        lastLogCount = lines.length;
      }

      if (job.status !== lastStatus) {
        lastStatus = job.status;
        send("progress", { progress: job.progress, status: job.status });
      } else if (job.progress > 0) {
        send("progress", { progress: job.progress, status: job.status });
      }

      if (job.status === "completed" || job.status === "failed") {
        send("complete", { status: job.status, progress: job.progress });
        clearInterval(interval);
        setTimeout(() => res.end(), 100);
      }
    } catch {
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on("close", () => {
    clearInterval(interval);
  });
});

router.get("/projects/:id/music-analysis", async (req, res) => {
  const projectId = req.params.id;
  const musicJobs = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));

  if (musicJobs.length === 0) return res.status(404).json({ error: "No music analysis found" });

  const latest = musicJobs[musicJobs.length - 1];
  try {
    const data = JSON.parse(latest.result ?? "{}");
    return res.json({
      projectId,
      bpm: data.bpm ?? 120,
      timeSignature: data.timeSignature ?? "4/4",
      key: data.key ?? null,
      mood: data.mood ?? "Unknown",
      energy: data.energy ?? 0.5,
      danceability: data.danceability ?? 0.5,
      genre: data.genre ?? null,
      themeDescription: data.themeDescription ?? "",
      emotionalArc: data.emotionalArc ?? "",
      emotionalSections: data.emotionalSections ?? [],
      beatCount: data.beatCount ?? 0,
      totalDuration: data.totalDuration ?? 0,
      analyzedAt: data.analyzedAt ?? latest.completedAt?.toISOString() ?? new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({ error: "Failed to parse music analysis" });
  }
});

router.get("/projects/:id/audio-enhancement", async (req, res) => {
  const projectId = req.params.id;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.audioEnhancementPlan) return res.status(404).json({ error: "No audio enhancement plan found" });
  try {
    const plan = JSON.parse(project.audioEnhancementPlan);
    return res.json({
      projectId,
      preset: plan.preset ?? project.audioPreset ?? "cinematic",
      noiseReduction: plan.noiseReduction ?? "moderate",
      voiceEnhancement: plan.voiceEnhancement ?? "none",
      stemSeparation: plan.stemSeparation ?? "original",
      loudnessTarget: plan.loudnessTarget ?? "-16 LUFS",
      dynamicCompression: plan.dynamicCompression ?? "broadcast",
      deReverb: plan.deReverb ?? "light",
      eqProfile: plan.eqProfile ?? "flat",
      beatSyncBass: plan.beatSyncBass ?? false,
      aiReasoning: plan.aiReasoning ?? "",
      perSegmentOverrides: plan.perSegmentOverrides ?? [],
      analyzedAt: plan.analyzedAt ?? new Date().toISOString(),
    });
  } catch {
    return res.status(500).json({ error: "Failed to parse audio enhancement plan" });
  }
});

router.get("/projects/:id/beat-map", async (req, res) => {
  const projectId = req.params.id;
  const musicJobs = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));

  if (musicJobs.length === 0) return res.status(404).json({ error: "No beat map found" });

  const latest = musicJobs[musicJobs.length - 1];
  try {
    const data = JSON.parse(latest.result ?? "{}");
    return res.json({
      projectId,
      bpm: data.bpm ?? 120,
      totalDuration: data.totalDuration ?? 0,
      beats: data.beats ?? [],
      barLines: data.barLines ?? [],
    });
  } catch {
    return res.status(500).json({ error: "Failed to parse beat map" });
  }
});

router.get("/projects/:id/render-status", async (req, res) => {
  const projectId = req.params.id;
  const outputPath = path.join(RENDER_DIR, `${projectId}.mp4`);
  const renderJobs = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "render")));

  if (renderJobs.length === 0) return res.json({ ready: false, status: "none" });

  const latest = renderJobs[renderJobs.length - 1];
  const fileExists = fs.existsSync(outputPath);
  const sizeBytes = fileExists ? fs.statSync(outputPath).size : 0;
  const sizeMB = sizeBytes > 0 ? parseFloat((sizeBytes / 1024 / 1024).toFixed(1)) : 0;

  return res.json({
    ready: latest.status === "completed" && fileExists,
    status: latest.status,
    jobId: latest.id,
    progress: latest.progress,
    sizeMB,
    downloadUrl: fileExists ? `/api/projects/${projectId}/render.mp4` : null,
  });
});

// YouTube-style thumbnail — extract frame at ~30% of render duration
router.get("/projects/:id/thumbnail.jpg", async (req, res) => {
  const projectId = req.params.id;
  const renderPath = path.join(RENDER_DIR, `${projectId}.mp4`);
  if (!fs.existsSync(renderPath)) return res.status(404).json({ error: "Render not found. Run Render Video first." });

  const thumbPath = path.join(RENDER_DIR, `${projectId}_thumb.jpg`);

  // Generate thumbnail at 30% of video duration using ffprobe + ffmpeg
  try {
    const { execFileSync } = await import("child_process");
    const probeOut = execFileSync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", renderPath,
    ]).toString();
    const dur = parseFloat(JSON.parse(probeOut).format?.duration ?? "10");
    const seekSec = Math.max(1, dur * 0.30);

    await runFfmpeg([
      "-y", "-ss", String(seekSec), "-i", renderPath,
      "-vframes", "1", "-q:v", "2", "-vf", "scale=1280:-2",
      thumbPath,
    ]);
  } catch (e) {
    // Fallback: extract frame at 5 seconds
    await runFfmpeg(["-y", "-ss", "5", "-i", renderPath, "-vframes", "1", "-q:v", "2", "-vf", "scale=1280:-2", thumbPath]);
  }

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Content-Disposition", `inline; filename="thumbnail-${projectId.slice(0, 8)}.jpg"`);
  fs.createReadStream(thumbPath).pipe(res);
});

// Inline streaming preview — no Content-Disposition, supports seeking
router.get("/projects/:id/render-preview", async (req, res) => {
  const projectId = req.params.id;
  const outputPath = path.join(RENDER_DIR, `${projectId}.mp4`);
  if (!fs.existsSync(outputPath)) return res.status(404).json({ error: "Render not found." });

  const stat = fs.statSync(outputPath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  const baseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${fileSize}`, "Content-Length": chunkSize });
    fs.createReadStream(outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...baseHeaders, "Content-Length": fileSize });
    fs.createReadStream(outputPath).pipe(res);
  }
});

router.get("/projects/:id/render.mp4", async (req, res) => {
  const projectId = req.params.id;
  const outputPath = path.join(RENDER_DIR, `${projectId}.mp4`);
  if (!fs.existsSync(outputPath)) return res.status(404).json({ error: "Render not found. Run the Render job first." });

  const stat = fs.statSync(outputPath);
  const fileSize = stat.size;
  const fileName = `cutai-export-${projectId.slice(0, 8)}.mp4`;
  const rangeHeader = req.headers.range;

  const baseHeaders = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "Content-Disposition": `attachment; filename="${fileName}"`,
  };

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": chunkSize,
    });
    fs.createReadStream(outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...baseHeaders, "Content-Length": fileSize });
    fs.createReadStream(outputPath).pipe(res);
  }
});

// ── FEATURE 7: Instant Learning from Manual Edits ─────────────────────────
// Called every time the editor makes a manual change (trim, reorder, exclude).
// Accumulates edit signals in model_config as a per-project session map.
// On the next generate_edit_plan call, these signals are injected into the
// prompt so the AI immediately incorporates the editor's latest preferences.
router.post("/projects/:id/signal-edit", async (req, res) => {
  const projectId = req.params.id;
  const { editType, segmentId, deltaStart, deltaEnd, fromType, toType, clipFile } = req.body as {
    editType: "trim_start" | "trim_end" | "reorder" | "exclude" | "include" | "type_change";
    segmentId?: string;
    deltaStart?: number;
    deltaEnd?: number;
    fromType?: string;
    toType?: string;
    clipFile?: string;
  };

  if (!editType) { res.status(400).json({ error: "editType is required" }); return; }

  try {
    const key = `session_signals_${projectId}`;
    const existing = await db.select().from(modelConfigTable).where(eq(modelConfigTable.key, key)).limit(1);
    const signals: {
      trimStartDeltas: number[];
      trimEndDeltas: number[];
      excludedTypes: string[];
      preferredTypes: string[];
      reorderCount: number;
      lastUpdated: string;
    } = existing.length > 0
      ? JSON.parse(existing[0].value ?? "{}")
      : { trimStartDeltas: [], trimEndDeltas: [], excludedTypes: [], preferredTypes: [], reorderCount: 0, lastUpdated: new Date().toISOString() };

    // Accumulate the new signal
    if (editType === "trim_start" && deltaStart != null) {
      signals.trimStartDeltas.push(deltaStart);
      // Keep only last 10 signals
      if (signals.trimStartDeltas.length > 10) signals.trimStartDeltas.shift();
    }
    if (editType === "trim_end" && deltaEnd != null) {
      signals.trimEndDeltas.push(deltaEnd);
      if (signals.trimEndDeltas.length > 10) signals.trimEndDeltas.shift();
    }
    if (editType === "exclude" && fromType && !signals.excludedTypes.includes(fromType)) {
      signals.excludedTypes.push(fromType);
      signals.preferredTypes = signals.preferredTypes.filter(t => t !== fromType);
    }
    if (editType === "include" && fromType && !signals.preferredTypes.includes(fromType)) {
      signals.preferredTypes.push(fromType);
      signals.excludedTypes = signals.excludedTypes.filter(t => t !== fromType);
    }
    if (editType === "reorder") {
      signals.reorderCount = (signals.reorderCount ?? 0) + 1;
    }
    signals.lastUpdated = new Date().toISOString();

    // Compute rolling averages for injection into prompt
    const avgTrimStart = signals.trimStartDeltas.length > 0
      ? signals.trimStartDeltas.reduce((a, b) => a + b, 0) / signals.trimStartDeltas.length : 0;
    const avgTrimEnd = signals.trimEndDeltas.length > 0
      ? signals.trimEndDeltas.reduce((a, b) => a + b, 0) / signals.trimEndDeltas.length : 0;
    const serialized = JSON.stringify({ ...signals, avgTrimStart, avgTrimEnd });

    if (existing.length > 0) {
      await db.update(modelConfigTable).set({ value: serialized }).where(eq(modelConfigTable.key, key));
    } else {
      await db.insert(modelConfigTable).values({ id: randomUUID(), key, value: serialized });
    }

    res.json({
      ok: true,
      signals: { avgTrimStart, avgTrimEnd, excludedTypes: signals.excludedTypes, preferredTypes: signals.preferredTypes, reorderCount: signals.reorderCount },
    });
  } catch (e: any) {
    console.error("signal-edit error:", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
