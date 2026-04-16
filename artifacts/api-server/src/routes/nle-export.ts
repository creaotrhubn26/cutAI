import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { projectsTable, segmentsTable, videosTable, jobsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

// ----- Format specs -----
const FORMAT_SPECS: Record<string, { width: number; height: number; fps: number; frameDuration: string; formatName: string; colorSpace: string }> = {
  instagram_reel:   { width: 1080, height: 1920, fps: 30, frameDuration: "1/30s",       formatName: "FFVideoFormat1080x1920p30",  colorSpace: "1-1-1 (Rec. 709)" },
  tiktok:           { width: 1080, height: 1920, fps: 30, frameDuration: "1/30s",       formatName: "FFVideoFormat1080x1920p30",  colorSpace: "1-1-1 (Rec. 709)" },
  youtube_short:    { width: 1080, height: 1920, fps: 30, frameDuration: "1/30s",       formatName: "FFVideoFormat1080x1920p30",  colorSpace: "1-1-1 (Rec. 709)" },
  youtube_long:     { width: 1920, height: 1080, fps: 25, frameDuration: "1/25s",       formatName: "FFVideoFormat1080p25",       colorSpace: "1-1-1 (Rec. 709)" },
  wedding_highlight:{ width: 1920, height: 1080, fps: 25, frameDuration: "1/25s",       formatName: "FFVideoFormat1080p25",       colorSpace: "1-1-1 (Rec. 709)" },
  ad_spot:          { width: 1920, height: 1080, fps: 25, frameDuration: "1/25s",       formatName: "FFVideoFormat1080p25",       colorSpace: "1-1-1 (Rec. 709)" },
  custom:           { width: 1920, height: 1080, fps: 25, frameDuration: "1/25s",       formatName: "FFVideoFormat1080p25",       colorSpace: "1-1-1 (Rec. 709)" },
};

// ----- Timing helpers -----
// FCPXML time is a rational fraction of seconds: Ns (whole) or N/Ds (fractional)
function toFcpTime(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  if (frames === 0) return "0s";
  if (frames % fps === 0) return `${Math.round(frames / fps)}s`;
  return `${frames}/${fps}s`;
}

function toTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.round(seconds * fps);
  const ff = totalFrames % fps;
  const ss = Math.floor(totalFrames / fps) % 60;
  const mm = Math.floor(totalFrames / fps / 60) % 60;
  const hh = Math.floor(totalFrames / fps / 3600);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// CDL (ASC Color Decision List) parameters per named grade
// Slope (gain), Offset (lift), Power (gamma), Saturation
const COLOR_CDL: Record<string, { slope: [number,number,number]; offset: [number,number,number]; power: [number,number,number]; saturation: number }> = {
  warm:        { slope:[1.05,0.98,0.92],  offset:[0.02,0.01,-0.02],  power:[1.0,1.0,1.0],   saturation:1.05 },
  cool:        { slope:[0.92,0.96,1.06],  offset:[-0.01,0.0,0.02],   power:[1.0,1.0,1.0],   saturation:0.95 },
  cinematic:   { slope:[0.96,0.95,0.93],  offset:[0.02,0.02,0.02],   power:[0.92,0.93,0.95],saturation:0.85 },
  bw:          { slope:[1.0,1.0,1.0],     offset:[0.0,0.0,0.0],      power:[1.0,1.0,1.0],   saturation:0.0  },
  vivid:       { slope:[1.05,1.05,1.02],  offset:[0.0,0.0,0.0],      power:[0.95,0.95,0.95],saturation:1.30 },
  muted:       { slope:[0.95,0.95,0.95],  offset:[0.02,0.02,0.02],   power:[1.05,1.05,1.05],saturation:0.70 },
  sunset:      { slope:[1.08,0.95,0.82],  offset:[0.03,0.01,-0.03],  power:[0.95,1.0,1.05], saturation:1.10 },
  teal_orange: { slope:[1.06,0.95,0.85],  offset:[-0.01,0.02,0.04],  power:[0.95,1.0,1.02], saturation:1.15 },
  desaturated: { slope:[0.97,0.97,0.97],  offset:[0.01,0.01,0.01],   power:[1.02,1.02,1.02],saturation:0.50 },
};

// Transition effect UIDs (real FCP built-in UIDs from Apple's effect library)
const TRANSITION_UIDS: Record<string, { uid: string; name: string }> = {
  dissolve: { uid: "FxPlug:4731E73A-3D22-4F54-8E34-B9C33A9CD9E5", name: "Cross Dissolve" },
  fade:     { uid: "FxPlug:4731E73A-3D22-4F54-8E34-B9C33A9CD9E5", name: "Cross Dissolve" },
  wipe:     { uid: "FxPlug:EDEA4F86-3225-44BA-9BA2-B52DE7DCB0CE", name: "Wipe" },
  zoom:     { uid: "FxPlug:6787823D-2B39-4BA7-8E3C-B62D88C7E67A", name: "Zoom" },
  slide:    { uid: "FxPlug:5A88E547-3BC4-4D21-9C3B-AE52A2C5BCC7", name: "Slide" },
  cut:      { uid: "", name: "Cut" },
  none:     { uid: "", name: "Cut" },
};

// ----- FCPXML export -----
router.get("/projects/:id/export.fcpxml", async (req, res) => {
  const projectId = req.params.id;
  // ?mediaRoot=/Volumes/MyDrive/Footage — the folder on the editor's machine where
  // the original source files live. DaVinci Resolve will look here to relink media.
  // If omitted, the FCPXML references the server's upload path (works when Resolve
  // and CutAI run on the same machine, or after copying files to the same path).
  const mediaRootOverride = (req.query.mediaRoot as string | undefined)?.trim() ?? null;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segments = await db
    .select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(segmentsTable.orderIndex);

  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

  const musicJobs = await db
    .select().from(jobsTable)
    .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));

  let beats: Array<{ timestamp: number; isDownbeat: boolean }> = [];
  let emotionalSections: Array<{ startTime: number; endTime: number; emotion: string; description: string }> = [];
  if (musicJobs.length > 0) {
    try {
      const data = JSON.parse(musicJobs[musicJobs.length - 1].result ?? "{}");
      beats = data.beats ?? [];
      emotionalSections = data.emotionalSections ?? [];
    } catch {}
  }

  // Parse manuscript analysis for chapter markers
  let manuscriptScenes: Array<{ sceneNumber: number; title: string; emotionalTone?: string }> = [];
  if (project.manuscriptAnalysis) {
    try {
      const msa = JSON.parse(project.manuscriptAnalysis);
      manuscriptScenes = msa.scenes ?? [];
    } catch {}
  }

  const spec = FORMAT_SPECS[project.targetFormat ?? "custom"] ?? FORMAT_SPECS.custom;
  const { width, height, fps } = spec;

  const includedSegs = segments.filter(s => s.included);
  const totalDuration = includedSegs.reduce((sum, s) => sum + ((s.endTime - s.startTime) / (s.speedFactor ?? 1.0)), 0);

  const videoAssets = videos.map((v, i) => ({ id: `r${i + 2}`, video: v }));
  const assetMap = new Map(videoAssets.map((a) => [a.video.id, a]));

  // Collect unique effect IDs needed
  const needsColorCorrection = includedSegs.some(s => s.colorGrade && s.colorGrade !== "none" && COLOR_CDL[s.colorGrade]);
  const needsTransitions = includedSegs.some(s => s.transitionIn && s.transitionIn !== "cut" && s.transitionIn !== "none" && TRANSITION_UIDS[s.transitionIn]?.uid);
  const needsCaptions = includedSegs.some(s => s.captionText);

  const transitionDuration = 0.5; // seconds — half-second cross dissolve
  const TRANSITION_HANDLE = transitionDuration / 2; // overlap per side

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<!DOCTYPE fcpxml>`);
  lines.push(`<fcpxml version="1.11">`);
  lines.push(``);
  lines.push(`  <!-- Generated by CutAI — ${new Date().toISOString()} -->`);
  lines.push(`  <!-- Project: ${xmlEscape(project.name)} | Format: ${project.targetFormat ?? "custom"} -->`);
  if (manuscriptScenes.length > 0) {
    lines.push(`  <!-- Script-driven edit: ${manuscriptScenes.length} scenes from manuscript -->`);
  }
  lines.push(``);

  // ── RESOURCES ──
  lines.push(`  <resources>`);
  lines.push(``);
  lines.push(`    <!-- Timeline format: ${width}x${height} @ ${fps}fps -->`);
  lines.push(`    <format id="r1" name="${spec.formatName}" frameDuration="${spec.frameDuration}" width="${width}" height="${height}" colorSpace="${spec.colorSpace}"/>`);
  lines.push(``);

  // Source media assets
  lines.push(`    <!-- Source media assets -->`);
  lines.push(`    <!-- mediaRoot: ${mediaRootOverride ?? "(server upload path — use ?mediaRoot=/your/footage/folder to relink on your machine)"} -->`);
  for (const asset of videoAssets) {
    const duration = asset.video.durationSeconds ?? 60;
    const originalName = asset.video.originalName ?? asset.video.filename;
    // Build file URI:
    //   - If caller passed ?mediaRoot=, combine with originalName so Resolve finds the file
    //     on the editor's workstation (e.g. /Volumes/Drive/Footage/MyClip.mp4)
    //   - Otherwise fall back to the server's absolute path (good when Resolve + CutAI share disk)
    let filePath: string;
    if (mediaRootOverride) {
      const root = mediaRootOverride.replace(/\/$/, ""); // strip trailing slash
      filePath = `${root}/${originalName}`;
    } else {
      filePath = asset.video.filePath ?? `/tmp/cutai-uploads/${asset.video.filename}`;
    }
    const fileUri = filePath.startsWith("file://") ? filePath : `file://${filePath}`;
    lines.push(`    <asset id="${asset.id}" name="${xmlEscape(originalName)}" uid="${asset.video.id}" start="0s" duration="${toFcpTime(duration, fps)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000">`);
    lines.push(`      <media-rep kind="original-media" src="${xmlEscape(fileUri)}"/>`);
    lines.push(`    </asset>`);
  }
  lines.push(``);

  // Color correction effect resource (FCP Color Board)
  if (needsColorCorrection) {
    lines.push(`    <!-- Color correction effect (FCP Color Board) -->`);
    lines.push(`    <effect id="r_cc" name="Color Correction" uid="FFColorCorrectionEffect"/>`);
    lines.push(``);
  }

  // Transition effect resources
  const usedTransitions = new Set<string>();
  for (const seg of includedSegs) {
    const t = seg.transitionIn ?? "cut";
    if (t !== "cut" && t !== "none" && TRANSITION_UIDS[t]?.uid) usedTransitions.add(t);
  }
  if (needsTransitions) {
    lines.push(`    <!-- Transition effects -->`);
    for (const tName of usedTransitions) {
      const t = TRANSITION_UIDS[tName];
      if (t?.uid) {
        lines.push(`    <effect id="r_tr_${tName}" name="${xmlEscape(t.name)}" uid="${t.uid}"/>`);
      }
    }
    lines.push(``);
  }

  // Caption title effect resource
  if (needsCaptions) {
    lines.push(`    <!-- Caption / title effect -->`);
    lines.push(`    <effect id="r_title" name="Basic Title" uid="com.apple.motion.template.generator.Basic Title"/>`);
    lines.push(`    <effect id="r_lowerthird" name="Lower Third" uid="com.apple.motion.template.generator.Lower Third"/>`);
    lines.push(``);
  }

  lines.push(`  </resources>`);
  lines.push(``);

  // ── LIBRARY → EVENT → PROJECT ──
  lines.push(`  <library location="file:///tmp/CutAI-Library.fcpbundle">`);
  lines.push(`    <event name="CutAI — ${xmlEscape(project.name)}">`);
  lines.push(`      <project name="${xmlEscape(project.name)}" uid="${projectId}">`);
  lines.push(``);

  // Sequence
  lines.push(`        <sequence duration="${toFcpTime(totalDuration, fps)}" format="r1" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`);
  lines.push(`          <spine>`);
  lines.push(``);

  // Build timeline — segments + transitions + chapter markers
  let timelineOffset = 0;
  let manuscriptSceneIdx = 0;

  for (let i = 0; i < includedSegs.length; i++) {
    const seg = includedSegs[i];
    const duration = seg.endTime - seg.startTime;
    const speedFactor = seg.speedFactor ?? 1.0;
    const isReversed = seg.reverse ?? false;
    const isFrozen = seg.freeze ?? false;
    const outputDuration = isFrozen ? duration : duration / speedFactor;

    const asset = seg.videoId ? assetMap.get(seg.videoId) : videoAssets[0];
    const ref = asset?.id ?? `r2`;
    const label = seg.label ?? seg.segmentType ?? `Clip ${i + 1}`;

    // Transition before this clip (if not first)
    const tName = seg.transitionIn ?? "cut";
    if (i > 0 && tName !== "cut" && tName !== "none" && TRANSITION_UIDS[tName]?.uid && timelineOffset >= TRANSITION_HANDLE) {
      const t = TRANSITION_UIDS[tName];
      const tOffset = timelineOffset - TRANSITION_HANDLE;
      lines.push(`            <!-- Transition: ${t.name} between clips ${i} and ${i+1} -->`);
      lines.push(`            <transition name="${xmlEscape(t.name)}" offset="${toFcpTime(tOffset, fps)}" duration="${toFcpTime(transitionDuration, fps)}">`);
      lines.push(`              <filter-video ref="r_tr_${tName}"/>`);
      lines.push(`              <filter-audio ref="r_tr_${tName}"/>`);
      lines.push(`            </transition>`);
      lines.push(``);
    }

    // Chapter marker if this segment matches a manuscript scene
    if (manuscriptScenes.length > 0 && manuscriptSceneIdx < manuscriptScenes.length) {
      const scene = manuscriptScenes[manuscriptSceneIdx];
      if (scene.sceneNumber === i + 1) {
        lines.push(`            <!-- 🎬 Chapter: ${xmlEscape(scene.title)} -->`);
        manuscriptSceneIdx++;
      }
    }

    // Asset clip
    lines.push(`            <asset-clip name="${xmlEscape(label)}" ref="${ref}" offset="${toFcpTime(timelineOffset, fps)}" duration="${toFcpTime(outputDuration, fps)}" start="${toFcpTime(seg.startTime, fps)}" tcFormat="NDF">`);

    // Clip note
    const noteparts: string[] = [`Type: ${seg.segmentType ?? "clip"}`];
    if (seg.aiReason) noteparts.push(seg.aiReason);
    if (speedFactor !== 1.0) noteparts.push(`Speed: ${speedFactor}x`);
    if (isReversed) noteparts.push("REVERSE");
    if (isFrozen) noteparts.push("FREEZE");
    if (seg.colorGrade && seg.colorGrade !== "none") noteparts.push(`Grade: ${seg.colorGrade}`);
    if ((seg as any).emotionalTone ?? (manuscriptScenes[i]?.emotionalTone)) noteparts.push(`Tone: ${(seg as any).emotionalTone ?? manuscriptScenes[i]?.emotionalTone ?? ""}`);
    lines.push(`              <note>${xmlEscape(noteparts.join(" | "))}</note>`);

    // Speed remap / timeMap
    if (speedFactor !== 1.0 || isReversed || isFrozen || seg.speedRampStart != null) {
      const hasRamp = seg.speedRampStart != null && seg.speedRampEnd != null;
      const interp = seg.speedCurve === "ease-in" ? "ease-in" : seg.speedCurve === "ease-out" ? "ease-out" : seg.speedCurve === "s-curve" ? "smooth" : "linear";
      lines.push(`              <timeMap>`);
      lines.push(`                <timept time="0s" value="0s" interp="${interp}"/>`);
      if (hasRamp) {
        const rampStart = (seg.speedRampStart! - seg.startTime) / outputDuration;
        const rampEnd = (seg.speedRampEnd! - seg.startTime) / outputDuration;
        lines.push(`                <timept time="${toFcpTime(rampStart * outputDuration, fps)}" value="${toFcpTime(rampStart * duration, fps)}" interp="${seg.speedCurve === "s-curve" ? "smooth" : "linear"}"/>`);
        lines.push(`                <timept time="${toFcpTime(rampEnd * outputDuration, fps)}" value="${toFcpTime(rampEnd * duration, fps)}" interp="${seg.speedCurve === "ease-out" ? "ease-out" : "linear"}"/>`);
      }
      const endValue = isReversed ? toFcpTime(-duration, fps) : isFrozen ? "0s" : toFcpTime(duration, fps);
      lines.push(`                <timept time="${toFcpTime(outputDuration, fps)}" value="${endValue}" interp="linear"/>`);
      lines.push(`              </timeMap>`);
    }

    // Color correction — CDL params via FCP Color Board
    const cdl = COLOR_CDL[seg.colorGrade ?? "none"];
    if (cdl) {
      lines.push(`              <!-- Color grade: ${seg.colorGrade} | CDL Slope/Offset/Power + Sat -->`);
      lines.push(`              <filter-video ref="r_cc">`);
      lines.push(`                <!-- CDL Slope (R G B): ${cdl.slope.join(" ")} -->`);
      lines.push(`                <param name="colorRed"   key="9999/10100/10101/1/100/101" value="${cdl.slope[0].toFixed(4)}"/>`);
      lines.push(`                <param name="colorGreen" key="9999/10100/10101/1/100/201" value="${cdl.slope[1].toFixed(4)}"/>`);
      lines.push(`                <param name="colorBlue"  key="9999/10100/10101/1/100/301" value="${cdl.slope[2].toFixed(4)}"/>`);
      lines.push(`                <!-- CDL Offset (R G B): ${cdl.offset.join(" ")} -->`);
      lines.push(`                <param name="shadowRed"   key="9999/10100/10101/2/100/101" value="${cdl.offset[0].toFixed(4)}"/>`);
      lines.push(`                <param name="shadowGreen" key="9999/10100/10101/2/100/201" value="${cdl.offset[1].toFixed(4)}"/>`);
      lines.push(`                <param name="shadowBlue"  key="9999/10100/10101/2/100/301" value="${cdl.offset[2].toFixed(4)}"/>`);
      lines.push(`                <!-- CDL Saturation: ${cdl.saturation} -->`);
      lines.push(`                <param name="saturation" key="9999/10100/10101/1/500/500" value="${cdl.saturation.toFixed(4)}"/>`);
      lines.push(`              </filter-video>`);
    }

    // Audio enhancement
    if (seg.audioEnhancement) {
      try {
        const ae = JSON.parse(seg.audioEnhancement) as Record<string, string>;
        lines.push(`              <filter-audio>`);
        lines.push(`                <param name="noiseReduction" value="${ae.noiseReduction ?? "moderate"}"/>`);
        lines.push(`                <param name="voiceBoost" value="${ae.voiceBoost ?? "0"}"/>`);
        lines.push(`              </filter-audio>`);
      } catch {}
    }

    // Caption / title (anchored lane above primary storyline)
    if (seg.captionText) {
      const captionStyleToEffect: Record<string, string> = {
        subtitle: "r_lowerthird",
        title: "r_title",
        lower_third: "r_lowerthird",
        kinetic: "r_title",
      };
      const effectRef = captionStyleToEffect[seg.captionStyle ?? "subtitle"] ?? "r_lowerthird";
      lines.push(`              <!-- Caption: "${xmlEscape(seg.captionText)}" -->`);
      lines.push(`              <title name="Caption: ${xmlEscape(seg.captionText.substring(0, 30))}" ref="${effectRef}" lane="1" offset="0s" duration="${toFcpTime(outputDuration, fps)}">`);
      lines.push(`                <text>`);
      lines.push(`                  <text-style>${xmlEscape(seg.captionText)}</text-style>`);
      lines.push(`                </text>`);
      lines.push(`                <text-style-def id="ts_${seg.id.substring(0, 8)}">`);
      lines.push(`                  <text-style font="Helvetica Neue" fontSize="48" fontFace="Bold" fontColor="1 1 1 1" shadowColor="0 0 0 0.8" shadowOffset="3 315"/>`);
      lines.push(`                </text-style-def>`);
      lines.push(`              </title>`);
    }

    // Beat markers from music analysis
    const clipBeats = beats.filter(b => b.timestamp >= seg.startTime && b.timestamp < seg.endTime);
    if (clipBeats.length > 0) {
      lines.push(`              <!-- Beat markers (${clipBeats.length} beats) -->`);
      for (const beat of clipBeats.slice(0, 32)) {
        const beatOffset = beat.timestamp - seg.startTime;
        const markerName = beat.isDownbeat ? "Downbeat" : "Beat";
        lines.push(`              <marker start="${toFcpTime(beatOffset / speedFactor, fps)}" duration="0s" value="${markerName}" completed="0"/>`);
      }
    }

    // Emotional section markers
    const segMidpoint = timelineOffset + outputDuration / 2;
    const emotionSection = emotionalSections.find(e => e.startTime <= segMidpoint && e.endTime > segMidpoint);
    if (emotionSection) {
      lines.push(`              <marker start="0s" duration="${toFcpTime(outputDuration, fps)}" value="${xmlEscape(emotionSection.emotion.toUpperCase())}" completed="0"/>`);
    }

    lines.push(`            </asset-clip>`);
    lines.push(``);

    timelineOffset += outputDuration;
  }

  // Chapter markers from manuscript (on the sequence spine, not individual clips)
  if (manuscriptScenes.length > 0) {
    lines.push(`            <!-- Chapter markers from manuscript analysis -->`);
    let chOffset = 0;
    for (let i = 0; i < includedSegs.length && i < manuscriptScenes.length; i++) {
      const scene = manuscriptScenes[i];
      const seg = includedSegs[i];
      if (!seg) break;
      const outputDuration = (seg.endTime - seg.startTime) / (seg.speedFactor ?? 1.0);
      lines.push(`            <chapter-marker start="${toFcpTime(chOffset, fps)}" duration="${toFcpTime(Math.min(outputDuration, 4), fps)}" value="${xmlEscape(scene.title)}" note="${xmlEscape(scene.emotionalTone ?? "")}" posterOffset="${toFcpTime(0.5, fps)}"/>`);
      chOffset += outputDuration;
    }
    lines.push(``);
  } else if (emotionalSections.length > 0) {
    // Fallback: emotional arc chapter markers
    lines.push(`            <!-- Emotional arc chapter markers -->`);
    let chOffset = 0;
    for (const section of emotionalSections) {
      if (chOffset >= totalDuration) break;
      const secLen = Math.min(section.endTime - section.startTime, totalDuration - chOffset);
      lines.push(`            <chapter-marker start="${toFcpTime(chOffset, fps)}" duration="${toFcpTime(secLen, fps)}" value="${xmlEscape(section.emotion.toUpperCase())}" note="${xmlEscape(section.description ?? "")}"/>`);
      chOffset += secLen;
    }
    lines.push(``);
  }

  lines.push(`          </spine>`);
  lines.push(`        </sequence>`);
  lines.push(`      </project>`);
  lines.push(`    </event>`);
  lines.push(`  </library>`);
  lines.push(`</fcpxml>`);

  const filename = `${project.name.replace(/[^a-z0-9]/gi, "_")}_CutAI.fcpxml`;
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
});

// ----- EDL (CMX 3600) export -----
router.get("/projects/:id/export.edl", async (req, res) => {
  const projectId = req.params.id;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segments = await db
    .select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(segmentsTable.orderIndex);

  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
  const videoMap = new Map(videos.map((v) => [v.id, v]));

  const spec = FORMAT_SPECS[project.targetFormat ?? "custom"] ?? FORMAT_SPECS.custom;
  const { fps } = spec;

  const lines: string[] = [];
  lines.push(`TITLE: ${project.name} (CutAI Export)`);
  lines.push(`FCM: NON-DROP FRAME`);
  lines.push(`* FORMAT: CMX 3600 | FPS: ${fps} | GENERATED: ${new Date().toISOString()}`);
  if (project.targetFormat) lines.push(`* TARGET FORMAT: ${project.targetFormat.toUpperCase()}`);
  lines.push(``);

  let timelineOffset = 0;
  let eventNum = 1;
  segments.forEach((seg) => {
    const video = seg.videoId ? videoMap.get(seg.videoId) : videos[0];
    const reelName = (video?.originalName ?? "AX")
      .replace(/\.[^.]+$/, "")
      .substring(0, 8)
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toUpperCase()
      .padEnd(8);
    const duration = (seg.endTime - seg.startTime) / (seg.speedFactor ?? 1.0);
    const srcIn = toTimecode(seg.startTime, fps);
    const srcOut = toTimecode(seg.endTime, fps);
    const recIn = toTimecode(timelineOffset, fps);
    const recOut = toTimecode(timelineOffset + duration, fps);

    // CMX 3600 event line: NNN  RRRRRRRR  A/V  C/D  SRC_IN SRC_OUT REC_IN REC_OUT
    lines.push(`${String(eventNum).padStart(3, "0")}  ${reelName}  AV  C  ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    if (video?.originalName) lines.push(`* FROM CLIP NAME: ${video.originalName}`);
    if (seg.label) lines.push(`* COMMENT: ${seg.label}${seg.aiReason ? ` — ${seg.aiReason}` : ""}`);
    if (seg.colorGrade && seg.colorGrade !== "none") lines.push(`* COLOR GRADE: ${seg.colorGrade.toUpperCase()}`);
    if (seg.captionText) lines.push(`* CAPTION: ${seg.captionText}`);
    if ((seg.speedFactor ?? 1.0) !== 1.0) lines.push(`* SPEED: ${seg.speedFactor}x`);
    lines.push(``);

    timelineOffset += duration;
    eventNum++;
  });

  // Append CDL (Color Decision List) sidecar at bottom — DaVinci Resolve reads this
  const colorSegs = segments.filter(s => s.colorGrade && s.colorGrade !== "none" && COLOR_CDL[s.colorGrade]);
  if (colorSegs.length > 0) {
    lines.push(`* === ASC CDL COLOR DECISIONS ===`);
    colorSegs.forEach((seg, idx) => {
      const cdl = COLOR_CDL[seg.colorGrade!];
      if (!cdl) return;
      lines.push(`* CLIP ${String(idx + 1).padStart(3, "0")} | GRADE: ${seg.colorGrade}`);
      lines.push(`* CDL_ASC_SOP: (${cdl.slope.join(" ")}) (${cdl.offset.join(" ")}) (${cdl.power.join(" ")})`);
      lines.push(`* CDL_ASC_SAT: ${cdl.saturation.toFixed(4)}`);
    });
    lines.push(``);
  }

  const filename = `${project.name.replace(/[^a-z0-9]/gi, "_")}_CutAI.edl`;
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
});

// ----- JSON export (rich structured data) -----
router.get("/projects/:id/export.json", async (req, res) => {
  const projectId = req.params.id;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segments = await db
    .select().from(segmentsTable)
    .where(eq(segmentsTable.projectId, projectId))
    .orderBy(segmentsTable.orderIndex);

  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

  const musicJobs = await db
    .select().from(jobsTable)
    .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "analyze_music"), eq(jobsTable.status, "completed")));

  let musicAnalysis = null;
  if (musicJobs.length > 0) {
    try { musicAnalysis = JSON.parse(musicJobs[musicJobs.length - 1].result ?? "null"); } catch {}
  }

  let manuscriptAnalysis = null;
  if (project.manuscriptAnalysis) {
    try { manuscriptAnalysis = JSON.parse(project.manuscriptAnalysis); } catch {}
  }

  const videoMap = new Map(videos.map((v) => [v.id, v]));
  const spec = FORMAT_SPECS[project.targetFormat ?? "custom"] ?? FORMAT_SPECS.custom;

  let timelineOffset = 0;
  const clips = segments.map((s, i) => {
    const outputDuration = (s.endTime - s.startTime) / (s.speedFactor ?? 1.0);
    const clip = {
      id: s.id,
      orderIndex: s.orderIndex,
      label: s.label,
      type: s.segmentType,
      included: s.included,
      sourceFile: s.videoId ? videoMap.get(s.videoId)?.originalName ?? null : null,
      sourceIn: s.startTime,
      sourceOut: s.endTime,
      sourceDuration: s.endTime - s.startTime,
      outputDuration,
      timelineIn: timelineOffset,
      timelineOut: timelineOffset + outputDuration,
      confidence: s.confidence,
      aiReason: s.aiReason,
      colorGrade: s.colorGrade,
      cdl: COLOR_CDL[s.colorGrade ?? ""] ?? null,
      captionText: s.captionText,
      captionStyle: s.captionStyle,
      speedFactor: s.speedFactor,
      transitionIn: s.transitionIn,
      emotionalTone: (s as any).emotionalTone ?? null,
    };
    timelineOffset += outputDuration;
    return clip;
  });

  const payload = {
    exportVersion: "2.0",
    generator: "CutAI",
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      format: project.targetFormat,
      status: project.status,
      resolution: { width: spec.width, height: spec.height },
      fps: spec.fps,
      frameDuration: spec.frameDuration,
      colorSpace: spec.colorSpace,
    },
    timeline: {
      totalDuration: clips.filter(c => c.included).reduce((s, c) => s + c.outputDuration, 0),
      clipCount: clips.filter(c => c.included).length,
      clips,
    },
    musicAnalysis,
    manuscriptAnalysis,
    sourceFiles: videos.map((v) => ({
      id: v.id,
      name: v.originalName,
      duration: v.durationSeconds,
      status: v.status,
    })),
  };

  const filename = `${project.name.replace(/[^a-z0-9]/gi, "_")}_CutAI.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.json(payload);
});

// ----- SRT subtitle export (from segment captions + timing) -----
router.get("/projects/:id/export.srt", async (req, res) => {
  const projectId = req.params.id;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segments = await db
    .select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(segmentsTable.orderIndex);

  // Build SRT content from caption text and timeline positions
  let timelineOffset = 0;
  let subtitleIndex = 1;
  const lines: string[] = [];

  function toSrtTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  }

  for (const seg of segments) {
    const segDuration = (seg.endTime - seg.startTime) / (seg.speedFactor ?? 1.0);
    const captionText = seg.captionText?.trim();

    if (captionText) {
      const startSrt = timelineOffset;
      const endSrt = timelineOffset + segDuration;
      lines.push(`${subtitleIndex}`);
      lines.push(`${toSrtTime(startSrt)} --> ${toSrtTime(endSrt)}`);
      lines.push(captionText);
      lines.push("");
      subtitleIndex++;
    }

    timelineOffset += segDuration;
  }

  if (lines.length === 0) {
    // No captions — generate chapter markers from segment labels
    timelineOffset = 0;
    for (const seg of segments) {
      const segDuration = (seg.endTime - seg.startTime) / (seg.speedFactor ?? 1.0);
      const label = seg.label ?? seg.segmentType;
      lines.push(`${subtitleIndex}`);
      lines.push(`${toSrtTime(timelineOffset)} --> ${toSrtTime(timelineOffset + Math.min(segDuration, 3))}`);
      lines.push(label);
      lines.push("");
      subtitleIndex++;
      timelineOffset += segDuration;
    }
  }

  const filename = `${project.name.replace(/[^a-z0-9]/gi, "_")}_CutAI.srt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
});

// ----- Final Cut Pro 7 XML (xmeml) — DaVinci Resolve's native "Import XML" -----
// DaVinci Resolve, Premiere Pro, and Avid all read this format via
// File → Import Timeline → XML.  This is the most universally supported
// timeline interchange format across all professional NLEs.
router.get("/projects/:id/export-resolve.xml", async (req, res) => {
  const projectId = req.params.id;
  const mediaRootOverride = (req.query.mediaRoot as string | undefined)?.trim() ?? null;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segments = await db
    .select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(segmentsTable.orderIndex);

  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
  const videoMap = new Map(videos.map((v) => [v.id, v]));

  const spec = FORMAT_SPECS[project.targetFormat ?? "custom"] ?? FORMAT_SPECS.custom;
  const { width, height, fps } = spec;
  const timebase = fps; // frames per second as integer string
  const isNtsc = fps === 29.97 || fps === 23.976;

  const includedSegs = segments.filter(s => s.included);
  const totalFrames = Math.round(includedSegs.reduce((sum, s) => sum + (s.endTime - s.startTime) * fps / (s.speedFactor ?? 1), 0));

  // Collect unique file references
  const fileRefs = new Map<string, { fileId: string; video: typeof videos[0] }>();
  let fileCounter = 1;
  for (const seg of includedSegs) {
    const v = seg.videoId ? videoMap.get(seg.videoId) : null;
    if (v && !fileRefs.has(v.id)) {
      fileRefs.set(v.id, { fileId: `file-${fileCounter++}`, video: v });
    }
  }

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<!DOCTYPE xmeml>`);
  lines.push(`<xmeml version="5">`);
  lines.push(`  <!-- Generated by CutAI — ${new Date().toISOString()} -->`);
  lines.push(`  <!-- Project: ${xmlEscape(project.name)} | ${width}x${height} @ ${fps}fps -->`);
  lines.push(`  <!-- Open in DaVinci Resolve: File > Import Timeline > Import AAF, EDL, XML -->`);
  lines.push(`  <!-- Open in Premiere Pro:   File > Import > select this file -->`);
  lines.push(``);
  lines.push(`  <sequence id="sequence-1">`);
  lines.push(`    <name>${xmlEscape(project.name)}</name>`);
  lines.push(`    <duration>${totalFrames}</duration>`);
  lines.push(`    <rate>`);
  lines.push(`      <timebase>${Math.round(timebase)}</timebase>`);
  lines.push(`      <ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc>`);
  lines.push(`    </rate>`);
  lines.push(`    <timecode>`);
  lines.push(`      <rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate>`);
  lines.push(`      <string>00:00:00:00</string>`);
  lines.push(`      <frame>0</frame>`);
  lines.push(`      <displayformat>NDF</displayformat>`);
  lines.push(`    </timecode>`);
  lines.push(`    <media>`);
  lines.push(`      <video>`);
  lines.push(`        <format>`);
  lines.push(`          <samplecharacteristics>`);
  lines.push(`            <rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate>`);
  lines.push(`            <width>${width}</width>`);
  lines.push(`            <height>${height}</height>`);
  lines.push(`            <pixelaspectratio>square</pixelaspectratio>`);
  lines.push(`            <fielddominance>none</fielddominance>`);
  lines.push(`            <colordepth>32</colordepth>`);
  lines.push(`          </samplecharacteristics>`);
  lines.push(`        </format>`);
  lines.push(`        <track>`);

  let timelineFrame = 0;
  let clipItemCounter = 1;

  for (let i = 0; i < includedSegs.length; i++) {
    const seg = includedSegs[i];
    const v = seg.videoId ? videoMap.get(seg.videoId) : null;
    const ref = v ? fileRefs.get(v.id) : null;
    const speedFactor = seg.speedFactor ?? 1.0;
    const inFrame = Math.round(seg.startTime * fps);
    const outFrame = Math.round(seg.endTime * fps);
    const srcDuration = outFrame - inFrame;
    const outTimeline = Math.round(timelineFrame + srcDuration / speedFactor);
    const label = xmlEscape(seg.label ?? seg.segmentType ?? `Clip ${i + 1}`);
    const clipId = `clipitem-${clipItemCounter++}`;

    lines.push(`          <clipitem id="${clipId}">`);
    lines.push(`            <name>${label}</name>`);
    lines.push(`            <duration>${Math.round((v?.durationSeconds ?? 60) * fps)}</duration>`);
    lines.push(`            <rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate>`);
    lines.push(`            <start>${timelineFrame}</start>`);
    lines.push(`            <end>${outTimeline}</end>`);
    lines.push(`            <in>${inFrame}</in>`);
    lines.push(`            <out>${outFrame}</out>`);
    if (seg.aiReason) lines.push(`            <comments><mastercomment1>${xmlEscape(seg.aiReason.slice(0, 200))}</mastercomment1></comments>`);

    // Color grade as FCP7 color correction filter
    const cdl = COLOR_CDL[seg.colorGrade ?? "none"];
    if (cdl) {
      lines.push(`            <filters>`);
      lines.push(`              <filter>`);
      lines.push(`                <effect>`);
      lines.push(`                  <name>Color Corrector</name>`);
      lines.push(`                  <effectid>colorCorrectionFilter</effectid>`);
      lines.push(`                  <effectcategory>motion</effectcategory>`);
      lines.push(`                  <effecttype>filter</effecttype>`);
      lines.push(`                  <mediatype>video</mediatype>`);
      lines.push(`                  <parameter><parameterid>slope-r</parameterid><value>${cdl.slope[0]}</value></parameter>`);
      lines.push(`                  <parameter><parameterid>slope-g</parameterid><value>${cdl.slope[1]}</value></parameter>`);
      lines.push(`                  <parameter><parameterid>slope-b</parameterid><value>${cdl.slope[2]}</value></parameter>`);
      lines.push(`                  <parameter><parameterid>sat</parameterid><value>${cdl.saturation}</value></parameter>`);
      lines.push(`                </effect>`);
      lines.push(`              </filter>`);
      lines.push(`            </filters>`);
    }

    // Speed remap
    if (speedFactor !== 1.0) {
      lines.push(`            <timeremapping>`);
      lines.push(`              <enabled>TRUE</enabled>`);
      lines.push(`              <speed>${Math.round(speedFactor * 100)}</speed>`);
      lines.push(`              <reverse>${seg.reverse ? "TRUE" : "FALSE"}</reverse>`);
      lines.push(`            </timeremapping>`);
    }

    if (ref) {
      const originalName = ref.video.originalName ?? ref.video.filename;
      let filePath: string;
      if (mediaRootOverride) {
        filePath = `${mediaRootOverride.replace(/\/$/, "")}/${originalName}`;
      } else {
        filePath = ref.video.filePath ?? `/tmp/cutai-uploads/${ref.video.filename}`;
      }
      const fileUri = filePath.startsWith("file://") ? filePath : `file://${filePath}`;
      const fileDurFrames = Math.round((ref.video.durationSeconds ?? 60) * fps);
      lines.push(`            <file id="${ref.fileId}">`);
      lines.push(`              <name>${xmlEscape(originalName)}</name>`);
      lines.push(`              <pathurl>${xmlEscape(fileUri)}</pathurl>`);
      lines.push(`              <rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate>`);
      lines.push(`              <duration>${fileDurFrames}</duration>`);
      lines.push(`              <timecode><rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`);
      lines.push(`              <media>`);
      lines.push(`                <video><samplecharacteristics>`);
      lines.push(`                  <rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate>`);
      lines.push(`                  <width>${ref.video.width ?? width}</width>`);
      lines.push(`                  <height>${ref.video.height ?? height}</height>`);
      lines.push(`                </samplecharacteristics></video>`);
      lines.push(`                <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`);
      lines.push(`              </media>`);
      lines.push(`            </file>`);
    }

    lines.push(`          </clipitem>`);
    lines.push(``);

    timelineFrame = outTimeline;
  }

  lines.push(`        </track>`);
  lines.push(`      </video>`);

  // Audio track (mirrors video)
  lines.push(`      <audio>`);
  lines.push(`        <numOutputChannels>2</numOutputChannels>`);
  lines.push(`        <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>`);
  lines.push(`        <outputs><group><index>1</index><numchannels>2</numchannels><downmix>0</downmix><channel><index>1</index></channel><channel><index>2</index></channel></group></outputs>`);
  lines.push(`        <track>`);

  timelineFrame = 0;
  clipItemCounter = 1;
  for (let i = 0; i < includedSegs.length; i++) {
    const seg = includedSegs[i];
    const v = seg.videoId ? videoMap.get(seg.videoId) : null;
    const ref = v ? fileRefs.get(v.id) : null;
    const speedFactor = seg.speedFactor ?? 1.0;
    const inFrame = Math.round(seg.startTime * fps);
    const outFrame = Math.round(seg.endTime * fps);
    const srcDuration = outFrame - inFrame;
    const outTimeline = Math.round(timelineFrame + srcDuration / speedFactor);
    const audioMix = seg.audioMixLevel ?? 1.0;
    const audioDb = audioMix === 0 ? -96 : Math.round(20 * Math.log10(audioMix) * 10) / 10;

    lines.push(`          <clipitem id="clipitem-audio-${clipItemCounter}">`);
    lines.push(`            <name>${xmlEscape(seg.label ?? `Clip ${i + 1} Audio`)}</name>`);
    lines.push(`            <duration>${Math.round((v?.durationSeconds ?? 60) * fps)}</duration>`);
    lines.push(`            <rate><timebase>${Math.round(timebase)}</timebase><ntsc>${isNtsc ? "TRUE" : "FALSE"}</ntsc></rate>`);
    lines.push(`            <start>${timelineFrame}</start>`);
    lines.push(`            <end>${outTimeline}</end>`);
    lines.push(`            <in>${inFrame}</in>`);
    lines.push(`            <out>${outFrame}</out>`);
    lines.push(`            <file id="${ref?.fileId ?? "file-1"}"/>`);
    lines.push(`            <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>`);
    lines.push(`            <filters>`);
    lines.push(`              <filter><effect>`);
    lines.push(`                <name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>motion</effectcategory>`);
    lines.push(`                <effecttype>filter</effecttype><mediatype>audio</mediatype>`);
    lines.push(`                <parameter><parameterid>level</parameterid><name>Level</name><value>${audioDb}</value></parameter>`);
    lines.push(`              </effect></filter>`);
    lines.push(`            </filters>`);
    lines.push(`          </clipitem>`);

    timelineFrame = outTimeline;
    clipItemCounter++;
  }

  lines.push(`        </track>`);
  lines.push(`      </audio>`);
  lines.push(`    </media>`);
  lines.push(`  </sequence>`);
  lines.push(`</xmeml>`);

  const filename = `${project.name.replace(/[^a-z0-9]/gi, "_")}_CutAI_Resolve.xml`;
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
});

export default router;
