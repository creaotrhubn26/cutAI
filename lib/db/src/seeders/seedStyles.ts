/**
 * CutAI Edit Style Seeder
 * Generates 500+ professional editing style DNA profiles derived from real-world patterns.
 * Each style encodes avg clip duration, transitions, color grades, pacing, audio mixing,
 * beat sync, caption frequency — the "editing DNA" used to guide AI edit plan generation.
 */

import { db } from "../index";
import { editStylesTable } from "../schema/editStyles";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

// ── Utility helpers ────────────────────────────────────────────────────────

function r(min: number, max: number, decimals = 2): number {
  const v = min + Math.random() * (max - min);
  return parseFloat(v.toFixed(decimals));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Distribute pct values that sum to 1.0 across multiple buckets (given base weights)
function distribPct(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => parseFloat((w / sum).toFixed(3)));
}

// Distribute transition %s (cut, dissolve, fade, wipe, zoom) summing to 1
function transitionDNA(cutW: number, dissolveW: number, fadeW: number, wipeW: number, zoomW: number) {
  const [cut, dissolve, fade, wipe, zoom] = distribPct([cutW, dissolveW, fadeW, wipeW, zoomW]);
  return { cut, dissolve, fade, wipe, zoom };
}

// Distribute color grade %s summing to 1
function colorDNA(warm=0, cool=0, cin=0, vivid=0, muted=0, bw=0, sunset=0, teal=0, desat=0, none=0) {
  const vals = [warm, cool, cin, vivid, muted, bw, sunset, teal, desat, none];
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const n = vals.map(v => parseFloat((v / total).toFixed(3)));
  const grades = ["warm","cool","cinematic","vivid","muted","bw","sunset","teal_orange","desaturated","none"];
  const max = Math.max(...n);
  const primary = grades[n.indexOf(max)];
  return {
    colorWarmPct: n[0], colorCoolPct: n[1], colorCinematicPct: n[2], colorVividPct: n[3],
    colorMutedPct: n[4], colorBwPct: n[5], colorSunsetPct: n[6], colorTealOrangePct: n[7],
    colorDesaturatedPct: n[8], colorNonePct: n[9], primaryColorGrade: primary
  };
}

// ── Style generators per category ─────────────────────────────────────────

const arcOptions = [
  '[{"beat":0,"emotion":"calm"},{"beat":0.3,"emotion":"build"},{"beat":0.6,"emotion":"peak"},{"beat":0.8,"emotion":"release"},{"beat":1,"emotion":"close"}]',
  '[{"beat":0,"emotion":"build"},{"beat":0.5,"emotion":"peak"},{"beat":0.75,"emotion":"release"},{"beat":1,"emotion":"close"}]',
  '[{"beat":0,"emotion":"calm"},{"beat":0.25,"emotion":"calm"},{"beat":0.5,"emotion":"build"},{"beat":0.75,"emotion":"peak"},{"beat":1,"emotion":"close"}]',
  '[{"beat":0,"emotion":"peak"},{"beat":0.25,"emotion":"release"},{"beat":0.6,"emotion":"build"},{"beat":1,"emotion":"peak"}]',
];

// ── WEDDING (100 styles) ──────────────────────────────────────────────────

function makeWeddingStyle(i: number): any {
  const subs = [
    "cinematic_highlight","romantic_highlight","documentary_highlight",
    "rustic_vintage","modern_luxury","destination","same_day_edit",
    "elopement","micro_wedding","full_ceremony","reception_highlight","social_cut"
  ];
  const sub = subs[i % subs.length];

  const paceMap: Record<string, { avg: number; cpm: number }> = {
    cinematic_highlight: { avg: r(4,7), cpm: r(6,10) },
    romantic_highlight:  { avg: r(4,8), cpm: r(5,9) },
    documentary_highlight: { avg: r(5,10), cpm: r(4,8) },
    rustic_vintage:      { avg: r(5,9), cpm: r(4,7) },
    modern_luxury:       { avg: r(3,6), cpm: r(8,14) },
    destination:         { avg: r(4,8), cpm: r(6,11) },
    same_day_edit:       { avg: r(2,5), cpm: r(10,18) },
    elopement:           { avg: r(5,10), cpm: r(4,8) },
    micro_wedding:       { avg: r(4,7), cpm: r(6,10) },
    full_ceremony:       { avg: r(8,20), cpm: r(2,5) },
    reception_highlight: { avg: r(3,6), cpm: r(8,15) },
    social_cut:          { avg: r(1.5,3.5), cpm: r(15,25) },
  };
  const pace = paceMap[sub] ?? { avg: r(4,7), cpm: r(6,10) };
  const avg = pace.avg;

  const tr = (() => {
    if (sub === "social_cut") return transitionDNA(70,20,5,3,2);
    if (sub === "full_ceremony") return transitionDNA(60,30,8,1,1);
    if (sub === "modern_luxury") return transitionDNA(40,45,10,3,2);
    return transitionDNA(50, 35, 10, 3, 2);
  })();

  const col = (() => {
    if (sub === "rustic_vintage") return colorDNA(40,0,20,0,20,10,5,0,0,5);
    if (sub === "modern_luxury") return colorDNA(20,10,50,0,10,0,5,0,0,5);
    if (sub === "destination") return colorDNA(20,0,20,20,0,0,30,5,0,5);
    if (sub === "documentary_highlight") return colorDNA(20,10,40,0,15,5,0,5,0,5);
    if (sub === "social_cut") return colorDNA(15,10,15,40,0,0,10,5,0,5);
    return colorDNA(35, 5, 30, 10, 5, 2, 8, 2, 0, 3);
  })();

  const totalDur = sub === "full_ceremony" ? r(2400,5400) : sub === "social_cut" ? r(30,60) : sub.includes("highlight") ? r(180,480) : r(300,600);

  const hasSpeech = ["full_ceremony","documentary_highlight","reception_highlight"].includes(sub);

  return {
    id: randomUUID(),
    name: `Wedding — ${sub.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} v${i+1}`,
    category: "wedding",
    subcategory: sub,
    description: `Professional wedding editing style — ${sub.replace(/_/g,"  ")}. ${avg.toFixed(1)}s avg clip duration, ${pace.cpm.toFixed(0)} cuts/min.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.3).toFixed(2)),
    maxClipDuration: parseFloat((avg * 3.5).toFixed(2)),
    cutsPerMinute: pace.cpm,
    totalDuration: totalDur,
    clipCount: Math.round(totalDur / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.3,0.8),
    ...col,
    avgSpeedFactor: r(0.75, 1.0),
    slowMotionPct: r(0.15, 0.45),
    speedRampPct: r(0.05, 0.2),
    fastCutPct: 0,
    beatSyncStrength: r(0.6, 0.95),
    musicDuckOnSpeech: hasSpeech,
    musicDuckLevel: hasSpeech ? r(0.10, 0.25) : r(0.7, 1.0),
    speechMixLevel: hasSpeech ? r(0.85, 1.0) : r(0.0, 0.2),
    musicOnlyPct: hasSpeech ? r(0.4, 0.65) : r(0.7, 0.95),
    captionFrequency: r(0.3, 1.5),
    captionStyle: pick(["subtitle","lower_third","kinetic","subtitle"]),
    captionOnSpeechPct: hasSpeech ? r(0.3, 0.8) : r(0.2, 0.6),
    emotionalArc: pick(arcOptions),
    verified: i < 20,
    usageCount: Math.floor(r(0, 500)),
  };
}

// ── CORPORATE (75 styles) ────────────────────────────────────────────────

function makeCorporateStyle(i: number): any {
  const subs = [
    "executive_testimonial","employee_spotlight","product_launch","event_coverage",
    "training_video","brand_story","company_culture","investor_pitch",
    "conference_recap","internal_comms","social_brand"
  ];
  const sub = subs[i % subs.length];

  const avgMap: Record<string, number> = {
    executive_testimonial: r(5,12), employee_spotlight: r(4,9),
    product_launch: r(3,7), event_coverage: r(3,7),
    training_video: r(6,15), brand_story: r(4,10),
    company_culture: r(3,7), investor_pitch: r(4,8),
    conference_recap: r(4,10), internal_comms: r(5,12),
    social_brand: r(1.5,4),
  };
  const avg = avgMap[sub] ?? r(4,8);
  const cpm = r(60 / avg * 0.6, 60 / avg * 1.1);

  const speechHeavy = ["executive_testimonial","employee_spotlight","training_video","internal_comms","investor_pitch"].includes(sub);
  const col = speechHeavy
    ? colorDNA(5, 10, 50, 5, 15, 0, 0, 5, 5, 5)
    : colorDNA(5, 20, 40, 20, 0, 0, 0, 10, 0, 5);

  const tr = speechHeavy ? transitionDNA(60,30,8,1,1) : transitionDNA(45,35,8,5,7);

  return {
    id: randomUUID(),
    name: `Corporate — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "corporate",
    subcategory: sub,
    description: `Corporate editing style — ${sub.replace(/_/g," ")}. ${avg.toFixed(1)}s avg clip.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.25).toFixed(2)),
    maxClipDuration: parseFloat((avg * 4).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(60, 600),
    clipCount: Math.round(r(60,600) / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.2,0.6),
    ...col,
    avgSpeedFactor: r(0.95, 1.05),
    slowMotionPct: r(0, 0.1),
    speedRampPct: r(0, 0.05),
    fastCutPct: r(0, 0.05),
    beatSyncStrength: r(0.2, 0.6),
    musicDuckOnSpeech: speechHeavy,
    musicDuckLevel: speechHeavy ? r(0.08, 0.18) : r(0.4, 0.7),
    speechMixLevel: speechHeavy ? r(0.9, 1.0) : r(0.3, 0.7),
    musicOnlyPct: speechHeavy ? r(0.2, 0.5) : r(0.5, 0.8),
    captionFrequency: speechHeavy ? r(0.5, 2.0) : r(0.2, 0.8),
    captionStyle: pick(["subtitle","lower_third","lower_third","subtitle"]),
    captionOnSpeechPct: speechHeavy ? r(0.5, 0.9) : r(0.1, 0.3),
    emotionalArc: '[{"beat":0,"emotion":"calm"},{"beat":0.4,"emotion":"build"},{"beat":0.8,"emotion":"peak"},{"beat":1,"emotion":"close"}]',
    verified: i < 10,
    usageCount: Math.floor(r(0,300)),
  };
}

// ── COMMERCIAL / AD (75 styles) ──────────────────────────────────────────

function makeCommercialStyle(i: number): any {
  const subs = [
    "tv_spot_30s","tv_spot_60s","social_story_15s","youtube_preroll","luxury_brand",
    "retail_sale","app_demo","food_beverage","fashion","auto","fintech","healthcare","travel_ad"
  ];
  const sub = subs[i % subs.length];

  const avgMap: Record<string,number> = {
    tv_spot_30s: r(1.5,3.5), tv_spot_60s: r(2,5), social_story_15s: r(0.5,2),
    youtube_preroll: r(1,3), luxury_brand: r(4,10), retail_sale: r(1,3),
    app_demo: r(2,5), food_beverage: r(2,6), fashion: r(1.5,4),
    auto: r(2,6), fintech: r(2,4), healthcare: r(3,8), travel_ad: r(2,6),
  };
  const avg = avgMap[sub] ?? r(2,5);
  const cpm = r(60 / avg * 0.7, 60 / avg * 1.2);

  const col = (() => {
    if (sub === "luxury_brand") return colorDNA(5,5,50,0,30,0,0,5,0,5);
    if (sub === "food_beverage") return colorDNA(30,0,10,40,0,0,15,0,0,5);
    if (sub === "fashion") return colorDNA(5,10,30,20,20,5,5,0,0,5);
    if (sub === "auto") return colorDNA(0,25,30,25,0,5,0,10,0,5);
    if (sub === "travel_ad") return colorDNA(15,5,20,30,0,0,25,0,0,5);
    return colorDNA(10,15,30,30,0,0,5,5,0,5);
  })();

  const tr = sub === "luxury_brand"
    ? transitionDNA(30,50,15,3,2)
    : sub === "social_story_15s"
    ? transitionDNA(70,10,5,10,5)
    : transitionDNA(50,30,5,8,7);

  return {
    id: randomUUID(),
    name: `Commercial — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "commercial",
    subcategory: sub,
    description: `Ad/commercial editing style — ${sub.replace(/_/g," ")}. Avg ${avg.toFixed(1)}s, ${cpm.toFixed(0)} cuts/min.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.2).toFixed(2)),
    maxClipDuration: parseFloat((avg * 3).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(15, 120),
    clipCount: Math.round(r(15,120) / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.15,0.5),
    ...col,
    avgSpeedFactor: r(0.9,1.2),
    slowMotionPct: r(0.1,0.35),
    speedRampPct: r(0.05,0.2),
    fastCutPct: r(0.05,0.2),
    beatSyncStrength: r(0.5,0.9),
    musicDuckOnSpeech: Math.random() > 0.5,
    musicDuckLevel: r(0.1,0.25),
    speechMixLevel: r(0.8,1.0),
    musicOnlyPct: r(0.5,0.85),
    captionFrequency: r(0.5,3),
    captionStyle: pick(["subtitle","kinetic","lower_third","title"]),
    captionOnSpeechPct: r(0.3,0.8),
    emotionalArc: pick(arcOptions),
    verified: i < 8,
    usageCount: Math.floor(r(0,800)),
  };
}

// ── DOCUMENTARY (60 styles) ──────────────────────────────────────────────

function makeDocumentaryStyle(i: number): any {
  const subs = [
    "nature_wildlife","interview_driven","observational","historical","social_impact",
    "sports_doc","crime_thriller","science","travel_doc","political","music_doc","art_culture"
  ];
  const sub = subs[i % subs.length];

  const avgMap: Record<string,number> = {
    nature_wildlife: r(4,12), interview_driven: r(6,20), observational: r(5,15),
    historical: r(5,15), social_impact: r(4,10), sports_doc: r(3,8),
    crime_thriller: r(3,8), science: r(5,12), travel_doc: r(4,10),
    political: r(5,15), music_doc: r(3,8), art_culture: r(5,12),
  };
  const avg = avgMap[sub] ?? r(5,12);
  const cpm = 60 / avg * r(0.5,0.9);

  const col = (() => {
    if (sub === "nature_wildlife") return colorDNA(5,10,20,30,0,5,5,10,0,15);
    if (sub === "historical") return colorDNA(10,0,20,0,20,30,0,0,15,5);
    if (sub === "social_impact") return colorDNA(0,0,25,0,25,10,0,0,30,10);
    if (sub === "crime_thriller") return colorDNA(0,20,30,0,10,15,0,5,15,5);
    return colorDNA(5, 10, 40, 5, 20, 5, 0, 5, 5, 5);
  })();

  const speechHeavy = ["interview_driven","political","social_impact","crime_thriller"].includes(sub);
  const tr = transitionDNA(65,25,8,1,1);

  return {
    id: randomUUID(),
    name: `Documentary — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "documentary",
    subcategory: sub,
    description: `Documentary style — ${sub.replace(/_/g," ")}. ${avg.toFixed(1)}s avg clip, interview-heavy: ${speechHeavy}.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.2).toFixed(2)),
    maxClipDuration: parseFloat((avg * 5).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(600, 5400),
    clipCount: Math.round(r(600,5400) / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.3,1.0),
    ...col,
    avgSpeedFactor: r(0.95, 1.05),
    slowMotionPct: r(0, 0.15),
    speedRampPct: r(0, 0.05),
    fastCutPct: 0,
    beatSyncStrength: r(0.1, 0.45),
    musicDuckOnSpeech: true,
    musicDuckLevel: speechHeavy ? r(0.06, 0.15) : r(0.2, 0.5),
    speechMixLevel: r(0.9, 1.0),
    musicOnlyPct: speechHeavy ? r(0.2, 0.45) : r(0.4, 0.7),
    captionFrequency: speechHeavy ? r(0.5, 2.5) : r(0.1, 0.8),
    captionStyle: pick(["subtitle","lower_third","subtitle"]),
    captionOnSpeechPct: speechHeavy ? r(0.6, 1.0) : r(0.1, 0.4),
    emotionalArc: '[{"beat":0,"emotion":"calm"},{"beat":0.35,"emotion":"build"},{"beat":0.65,"emotion":"peak"},{"beat":0.9,"emotion":"release"},{"beat":1,"emotion":"close"}]',
    verified: i < 8,
    usageCount: Math.floor(r(0,200)),
  };
}

// ── SPORTS (60 styles) ───────────────────────────────────────────────────

function makeSportsStyle(i: number): any {
  const subs = [
    "highlight_reel","slow_motion_feature","training_montage","game_recap",
    "pregame_hype","post_game_emotions","athlete_profile","team_intro",
    "championship_film","esports_frag","extreme_sports","marathon"
  ];
  const sub = subs[i % subs.length];

  const avgMap: Record<string,number> = {
    highlight_reel: r(1.5,4), slow_motion_feature: r(3,8), training_montage: r(1,3),
    game_recap: r(2,5), pregame_hype: r(0.5,2), post_game_emotions: r(3,8),
    athlete_profile: r(3,8), team_intro: r(1,3), championship_film: r(3,8),
    esports_frag: r(0.5,2), extreme_sports: r(1,3), marathon: r(5,15),
  };
  const avg = avgMap[sub] ?? r(2,5);
  const cpm = r(60/avg*0.8, 60/avg*1.3);

  const col = (() => {
    if (sub === "slow_motion_feature") return colorDNA(5,25,30,10,0,0,0,20,5,5);
    if (sub === "pregame_hype") return colorDNA(0,20,10,50,0,0,0,10,5,5);
    if (sub === "extreme_sports") return colorDNA(0,15,15,45,0,0,0,20,0,5);
    return colorDNA(0,20,25,35,0,0,0,15,0,5);
  })();

  const tr = sub === "slow_motion_feature"
    ? transitionDNA(40,40,15,3,2)
    : transitionDNA(75,10,5,5,5);

  return {
    id: randomUUID(),
    name: `Sports — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "sports",
    subcategory: sub,
    description: `Sports editing style — ${sub.replace(/_/g," ")}. ${avg.toFixed(1)}s avg, ${cpm.toFixed(0)} CPM.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.15).toFixed(2)),
    maxClipDuration: parseFloat((avg * 4).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(30, 600),
    clipCount: Math.round(r(30,600) / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.1,0.4),
    ...col,
    avgSpeedFactor: sub === "slow_motion_feature" ? r(0.3,0.5) : r(0.9,1.3),
    slowMotionPct: sub === "slow_motion_feature" ? r(0.6,1.0) : r(0.1,0.3),
    speedRampPct: r(0.1,0.4),
    fastCutPct: r(0.1,0.3),
    beatSyncStrength: r(0.7,1.0),
    musicDuckOnSpeech: false,
    musicDuckLevel: r(0.7,1.0),
    speechMixLevel: r(0.0,0.3),
    musicOnlyPct: r(0.7,1.0),
    captionFrequency: r(0.2,1.5),
    captionStyle: pick(["title","kinetic","subtitle","none"]),
    captionOnSpeechPct: r(0.1,0.4),
    emotionalArc: '[{"beat":0,"emotion":"build"},{"beat":0.3,"emotion":"peak"},{"beat":0.6,"emotion":"peak"},{"beat":0.85,"emotion":"release"},{"beat":1,"emotion":"close"}]',
    verified: i < 8,
    usageCount: Math.floor(r(0,600)),
  };
}

// ── MUSIC VIDEO (50 styles) ──────────────────────────────────────────────

function makeMusicVideoStyle(i: number): any {
  const subs = [
    "performance_sync","narrative_ballad","abstract_art","live_concert",
    "dance_choreography","lyric_video","indie_folk","electronic_edm",
    "hip_hop","country","classical_orchestral"
  ];
  const sub = subs[i % subs.length];

  const avgMap: Record<string,number> = {
    performance_sync: r(0.5,2), narrative_ballad: r(3,8), abstract_art: r(1,4),
    live_concert: r(1.5,4), dance_choreography: r(0.5,2), lyric_video: r(2,6),
    indie_folk: r(3,8), electronic_edm: r(0.3,1.5), hip_hop: r(0.5,2),
    country: r(2,5), classical_orchestral: r(4,12),
  };
  const avg = avgMap[sub] ?? r(1,4);
  const cpm = r(60/avg*0.7, 60/avg*1.2);

  const col = (() => {
    if (sub === "narrative_ballad") return colorDNA(30,0,30,0,20,5,10,0,0,5);
    if (sub === "electronic_edm") return colorDNA(0,20,5,55,0,0,0,15,0,5);
    if (sub === "hip_hop") return colorDNA(5,15,20,40,0,5,5,5,0,5);
    if (sub === "abstract_art") return colorDNA(10,10,20,20,10,10,5,5,5,5);
    if (sub === "classical_orchestral") return colorDNA(5,0,50,0,20,15,5,0,0,5);
    return colorDNA(10,10,25,30,0,5,10,5,0,5);
  })();

  const tr = sub === "narrative_ballad"
    ? transitionDNA(35,45,15,3,2)
    : sub === "electronic_edm"
    ? transitionDNA(80,5,5,5,5)
    : transitionDNA(55,30,8,4,3);

  return {
    id: randomUUID(),
    name: `Music Video — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "music_video",
    subcategory: sub,
    description: `Music video style — ${sub.replace(/_/g," ")}. ${avg.toFixed(1)}s avg, beat-sync strength high.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.1).toFixed(2)),
    maxClipDuration: parseFloat((avg * 5).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(120, 360),
    clipCount: Math.round(r(120,360) / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.1,0.4),
    ...col,
    avgSpeedFactor: r(0.6,1.2),
    slowMotionPct: r(0.1,0.4),
    speedRampPct: r(0.15,0.5),
    fastCutPct: r(0.05,0.25),
    beatSyncStrength: r(0.8,1.0),
    musicDuckOnSpeech: false,
    musicDuckLevel: r(0.8,1.0),
    speechMixLevel: r(0,0.1),
    musicOnlyPct: r(0.9,1.0),
    captionFrequency: sub === "lyric_video" ? r(2,5) : r(0,0.5),
    captionStyle: sub === "lyric_video" ? "kinetic" : pick(["none","kinetic","subtitle"]),
    captionOnSpeechPct: r(0,0.2),
    emotionalArc: '[{"beat":0,"emotion":"build"},{"beat":0.25,"emotion":"peak"},{"beat":0.5,"emotion":"release"},{"beat":0.75,"emotion":"peak"},{"beat":1,"emotion":"close"}]',
    verified: i < 6,
    usageCount: Math.floor(r(0,400)),
  };
}

// ── TRAVEL / LIFESTYLE (50 styles) ──────────────────────────────────────

function makeTravelStyle(i: number): any {
  const subs = [
    "adventure_travel","luxury_destination","family_vlog","solo_journey",
    "food_culture","city_guide","backpacker","yacht_lifestyle",
    "safari","digital_nomad","ski_resort","beach_resort"
  ];
  const sub = subs[i % subs.length];

  const avg = r(3,9);
  const cpm = r(5,15);

  const col = (() => {
    if (sub === "beach_resort" || sub === "yacht_lifestyle") return colorDNA(10,15,20,20,0,0,25,5,0,5);
    if (sub === "adventure_travel") return colorDNA(10,15,20,25,0,0,20,5,0,5);
    if (sub === "safari") return colorDNA(30,0,15,20,10,0,20,0,0,5);
    if (sub === "luxury_destination") return colorDNA(5,5,55,5,20,0,5,0,0,5);
    if (sub === "backpacker" || sub === "digital_nomad") return colorDNA(15,10,25,20,10,0,15,0,0,5);
    return colorDNA(15,10,25,25,5,0,15,0,0,5);
  })();

  const tr = transitionDNA(45,35,12,5,3);

  return {
    id: randomUUID(),
    name: `Travel — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "travel",
    subcategory: sub,
    description: `Travel/lifestyle style — ${sub.replace(/_/g," ")}. ${avg.toFixed(1)}s avg, vivid & cinematic tones.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.3).toFixed(2)),
    maxClipDuration: parseFloat((avg * 4).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(120, 900),
    clipCount: Math.round(r(120,900) / avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.3,0.7),
    ...col,
    avgSpeedFactor: r(0.85,1.1),
    slowMotionPct: r(0.1,0.35),
    speedRampPct: r(0.05,0.2),
    fastCutPct: r(0,0.1),
    beatSyncStrength: r(0.4,0.8),
    musicDuckOnSpeech: Math.random() > 0.6,
    musicDuckLevel: r(0.15,0.35),
    speechMixLevel: r(0.7,1.0),
    musicOnlyPct: r(0.5,0.85),
    captionFrequency: r(0.3,1.5),
    captionStyle: pick(["lower_third","subtitle","subtitle"]),
    captionOnSpeechPct: r(0.2,0.6),
    emotionalArc: pick(arcOptions),
    verified: i < 6,
    usageCount: Math.floor(r(0,350)),
  };
}

// ── SOCIAL MEDIA (30 styles) ─────────────────────────────────────────────

function makeSocialStyle(i: number): any {
  const subs = [
    "tiktok_trending","instagram_reel","youtube_short","twitter_x_clip",
    "pinterest_mood","linkedin_professional"
  ];
  const sub = subs[i % subs.length];

  const avgMap: Record<string,number> = {
    tiktok_trending: r(0.8,2.5), instagram_reel: r(1.5,3.5), youtube_short: r(2,5),
    twitter_x_clip: r(1,3), pinterest_mood: r(3,8), linkedin_professional: r(3,8),
  };
  const avg = avgMap[sub] ?? r(1,4);
  const cpm = r(60/avg*0.8,60/avg*1.3);

  const col = (() => {
    if (sub === "pinterest_mood") return colorDNA(20,5,20,20,15,0,10,5,0,5);
    if (sub === "linkedin_professional") return colorDNA(0,15,45,10,15,0,0,10,0,5);
    return colorDNA(5,10,15,45,0,0,15,5,0,5);
  })();

  const tr = transitionDNA(70,15,5,7,3);

  return {
    id: randomUUID(),
    name: `Social Media — ${sub.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())} v${i+1}`,
    category: "social_media",
    subcategory: sub,
    description: `${sub.replace(/_/g," ")} social content style. ${avg.toFixed(1)}s avg, hook-first, ${cpm.toFixed(0)} CPM.`,
    source: "builtin",
    avgClipDuration: avg,
    minClipDuration: parseFloat((avg * 0.2).toFixed(2)),
    maxClipDuration: parseFloat((avg * 3).toFixed(2)),
    cutsPerMinute: cpm,
    totalDuration: r(15,60),
    clipCount: Math.round(r(15,60)/avg),
    transitionCutPct: tr.cut, transitionDissolvePct: tr.dissolve, transitionFadePct: tr.fade, transitionWipePct: tr.wipe, transitionZoomPct: tr.zoom,
    avgTransitionDuration: r(0.1,0.3),
    ...col,
    avgSpeedFactor: r(0.9,1.15),
    slowMotionPct: r(0.05,0.2),
    speedRampPct: r(0.05,0.2),
    fastCutPct: r(0.05,0.25),
    beatSyncStrength: r(0.6,1.0),
    musicDuckOnSpeech: Math.random() > 0.4,
    musicDuckLevel: r(0.1,0.3),
    speechMixLevel: r(0.8,1.0),
    musicOnlyPct: r(0.5,0.9),
    captionFrequency: r(1,5),
    captionStyle: pick(["kinetic","subtitle","lower_third"]),
    captionOnSpeechPct: r(0.5,1.0),
    emotionalArc: '[{"beat":0,"emotion":"peak"},{"beat":0.5,"emotion":"release"},{"beat":1,"emotion":"close"}]',
    verified: i < 5,
    usageCount: Math.floor(r(0,1000)),
  };
}

// ── MAIN SEEDER ───────────────────────────────────────────────────────────

export async function seedEditStyles(force = false) {
  // Check if already seeded
  const existing = await db.select().from(editStylesTable).limit(1);
  if (existing.length > 0 && !force) {
    console.log(`Edit styles already seeded (${existing.length}+ records). Use force=true to reseed.`);
    return;
  }

  if (force) {
    console.log("Force-clearing existing built-in styles...");
    // Only clear builtin styles, preserve user-uploaded ones
    await db.delete(editStylesTable).where(eq(editStylesTable.source, "builtin"));
  }

  const allStyles: any[] = [];

  // Wedding: 100 styles
  for (let i = 0; i < 100; i++) allStyles.push(makeWeddingStyle(i));
  // Corporate: 75 styles
  for (let i = 0; i < 75; i++) allStyles.push(makeCorporateStyle(i));
  // Commercial: 75 styles
  for (let i = 0; i < 75; i++) allStyles.push(makeCommercialStyle(i));
  // Documentary: 60 styles
  for (let i = 0; i < 60; i++) allStyles.push(makeDocumentaryStyle(i));
  // Sports: 60 styles
  for (let i = 0; i < 60; i++) allStyles.push(makeSportsStyle(i));
  // Music video: 50 styles
  for (let i = 0; i < 50; i++) allStyles.push(makeMusicVideoStyle(i));
  // Travel: 50 styles
  for (let i = 0; i < 50; i++) allStyles.push(makeTravelStyle(i));
  // Social media: 30 styles
  for (let i = 0; i < 30; i++) allStyles.push(makeSocialStyle(i));

  console.log(`Seeding ${allStyles.length} edit styles...`);

  // Batch insert in chunks of 50
  const CHUNK = 50;
  for (let i = 0; i < allStyles.length; i += CHUNK) {
    const chunk = allStyles.slice(i, i + CHUNK);
    await db.insert(editStylesTable).values(chunk);
    process.stdout.write(`  Inserted ${Math.min(i + CHUNK, allStyles.length)}/${allStyles.length}\r`);
  }

  console.log(`\n✅ Seeded ${allStyles.length} edit styles across 8 categories.`);
}

// Run directly
seedEditStyles(process.argv.includes("--force"))
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
