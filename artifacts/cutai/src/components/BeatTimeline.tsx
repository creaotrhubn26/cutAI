import React, { useMemo } from 'react';
import { cn } from "@/lib/utils";
import { BeatMarker, EmotionalSection, Segment } from "@workspace/api-client-react";

interface BeatTimelineProps {
  duration: number;
  zoom: number;
  beats?: BeatMarker[];
  emotionalSections?: EmotionalSection[];
  segments?: Segment[];
  currentTime?: number;
  onSeek?: (time: number) => void;
  selectedSegmentId?: string | null;
  onSelectSegment?: (id: string | null) => void;
}

const GRADE_COLORS: Record<string, string> = {
  warm: "#f97316",
  cool: "#3b82f6",
  cinematic: "#92400e",
  bw: "#a1a1aa",
  vivid: "#10b981",
  muted: "#78716c",
  sunset: "#f43f5e",
  teal_orange: "#0d9488",
  desaturated: "#737373",
};

const TYPE_COLORS: Record<string, string> = {
  speech: "#3b82f6",
  interview: "#6366f1",
  narration: "#8b5cf6",
  a_roll: "#3b82f6",
  music: "#a855f7",
  music_only: "#a855f7",
  highlight: "#eab308",
  action: "#f97316",
  transition: "#14b8a6",
  silence: "#6b7280",
  establishing: "#22c55e",
  reaction: "#ec4899",
  b_roll: "#0ea5e9",
  resolution: "#6366f1",
  opening: "#10b981",
  climax: "#ef4444",
};

function getSegmentColor(type: string, included: boolean): string {
  if (!included) return 'rgba(80, 80, 80, 0.3)';
  return TYPE_COLORS[type] ?? '#3b82f6';
}

function getGradeOverlayColor(grade: string): string | null {
  return GRADE_COLORS[grade] ?? null;
}

export const BeatTimeline: React.FC<BeatTimelineProps> = ({
  duration,
  zoom,
  beats = [],
  emotionalSections = [],
  segments = [],
  currentTime = 0,
  onSeek,
  selectedSegmentId,
  onSelectSegment,
}) => {
  const pxPerSec = 100 * zoom;
  const width = duration * pxPerSec;
  const TRACK_Y = 32;
  const TRACK_H = 72;
  const BEAT_Y = 10;
  const BEAT_H = 20;
  const EMOTION_Y = 0;
  const EMOTION_H = 10;
  const SVG_H = TRACK_Y + TRACK_H + 8;

  const timeMarkers = useMemo(() => {
    const markers = [];
    const step = zoom > 4 ? 1 : zoom > 2 ? 2 : zoom > 1 ? 5 : 10;
    for (let i = 0; i <= duration; i += step) {
      markers.push(i);
    }
    return markers;
  }, [duration, zoom]);

  const sortedSegs = useMemo(() =>
    [...segments].sort((a, b) => a.orderIndex - b.orderIndex),
    [segments]
  );

  return (
    <div className="relative overflow-x-auto overflow-y-hidden h-full bg-[#0d0d0d] select-none scrollbar-hide">
      <svg
        width={width}
        height={SVG_H}
        className="block"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          onSeek?.(x / pxPerSec);
        }}
      >
        {/* Time Grid + Labels */}
        {timeMarkers.map((t) => (
          <g key={t} transform={`translate(${t * pxPerSec}, 0)`}>
            <line x1="0" y1={BEAT_Y} x2="0" y2={SVG_H} stroke="#222" strokeWidth="1" />
            <text
              x="3"
              y={BEAT_Y + 10}
              fill="#444"
              fontSize="9"
              fontFamily="monospace"
            >
              {Math.floor(t / 60)}:{(t % 60).toString().padStart(2, '0')}
            </text>
          </g>
        ))}

        {/* Emotional Sections */}
        {emotionalSections.map((section, i) => {
          const e = section.emotion.toLowerCase();
          const fill = e.includes('joy') || e.includes('happy') || e.includes('euphoric') || e.includes('uplifting')
            ? 'rgba(234,179,8,0.14)'
            : e.includes('melanchol') || e.includes('sad') || e.includes('nostalgic')
            ? 'rgba(99,102,241,0.18)'
            : e.includes('intense') || e.includes('dramatic') || e.includes('tense')
            ? 'rgba(239,68,68,0.18)'
            : e.includes('calm') || e.includes('peaceful') || e.includes('serene')
            ? 'rgba(52,211,153,0.14)'
            : e.includes('building') || e.includes('rising') || e.includes('anticipat')
            ? 'rgba(249,115,22,0.14)'
            : e.includes('triumph') || e.includes('epic') || e.includes('climax')
            ? 'rgba(168,85,247,0.18)'
            : 'rgba(100,116,139,0.1)';
          const segW = (section.endTime - section.startTime) * pxPerSec;
          return (
            <g key={i}>
              <rect
                x={section.startTime * pxPerSec}
                y={EMOTION_Y}
                width={segW}
                height={EMOTION_H}
                fill={fill}
              />
              {segW > 60 && (
                <text
                  x={section.startTime * pxPerSec + 3}
                  y={EMOTION_Y + EMOTION_H - 2}
                  fill="rgba(255,255,255,0.3)"
                  fontSize="7"
                  fontFamily="monospace"
                  className="pointer-events-none"
                >
                  {section.emotion}
                </text>
              )}
            </g>
          );
        })}

        {/* Beat markers */}
        {beats.map((beat, i) => (
          <line
            key={i}
            x1={beat.timestamp * pxPerSec}
            y1={BEAT_Y}
            x2={beat.timestamp * pxPerSec}
            y2={BEAT_Y + BEAT_H * (beat.isDownbeat ? 1 : 0.55)}
            stroke={beat.isDownbeat ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)"}
            strokeWidth={beat.isDownbeat ? "1.5" : "1"}
          />
        ))}

        {/* Segment Track Background */}
        <rect x="0" y={TRACK_Y} width={width} height={TRACK_H} fill="rgba(0,0,0,0.5)" />

        {/* Segments */}
        {sortedSegs.map((segment, idx) => {
          const isSelected = selectedSegmentId === segment.id;
          const segW = Math.max(2, (segment.endTime - segment.startTime) * pxPerSec);
          const segX = segment.startTime * pxPerSec;
          const hasCaption = !!(segment as any).captionText;
          const colorGrade = (segment as any).colorGrade;
          const hasGrade = colorGrade && colorGrade !== "none";
          const gradeColor = hasGrade ? getGradeOverlayColor(colorGrade) : null;
          const color = getSegmentColor(segment.segmentType, segment.included);
          const label = (segment as any).label ?? segment.segmentType;

          return (
            <g
              key={segment.id}
              onClick={(e) => {
                e.stopPropagation();
                onSelectSegment?.(isSelected ? null : segment.id);
              }}
              className="cursor-pointer"
            >
              {/* Main clip block */}
              <rect
                x={segX + 1}
                y={TRACK_Y + 3}
                width={Math.max(1, segW - 2)}
                height={TRACK_H - 6}
                fill={color}
                rx="3"
                opacity={segment.included ? 0.9 : 0.25}
                stroke={isSelected ? "white" : "rgba(0,0,0,0.4)"}
                strokeWidth={isSelected ? "1.5" : "0.5"}
              />

              {/* Color grade stripe at top of clip */}
              {hasGrade && gradeColor && segW > 8 && (
                <rect
                  x={segX + 1}
                  y={TRACK_Y + 3}
                  width={Math.max(1, segW - 2)}
                  height={5}
                  fill={gradeColor}
                  rx="3"
                  opacity={0.8}
                />
              )}

              {/* Clip index number */}
              {segW > 18 && (
                <text
                  x={segX + 5}
                  y={TRACK_Y + 16}
                  fill="rgba(255,255,255,0.45)"
                  fontSize="8"
                  fontFamily="monospace"
                  className="pointer-events-none"
                >
                  {idx + 1}
                </text>
              )}

              {/* Label text (AI-generated name) */}
              {segW > 44 && (
                <text
                  x={segX + (segW > 28 ? 16 : 5)}
                  y={TRACK_Y + 16}
                  fill="rgba(255,255,255,0.9)"
                  fontSize="9"
                  fontWeight="500"
                  className="pointer-events-none"
                  clipPath={`url(#clip-${segment.id})`}
                >
                  {label}
                </text>
              )}

              {/* Duration / timecode */}
              {segW > 50 && (
                <text
                  x={segX + 5}
                  y={TRACK_Y + TRACK_H - 10}
                  fill="rgba(255,255,255,0.4)"
                  fontSize="8"
                  fontFamily="monospace"
                  className="pointer-events-none"
                >
                  {segment.startTime.toFixed(1)}→{segment.endTime.toFixed(1)}s
                </text>
              )}

              {/* Caption dot */}
              {hasCaption && segW > 12 && (
                <circle
                  cx={segX + segW - 7}
                  cy={TRACK_Y + 10}
                  r={3}
                  fill="#facc15"
                  opacity={0.9}
                />
              )}

              {/* Clip text clip-path */}
              <defs>
                <clipPath id={`clip-${segment.id}`}>
                  <rect x={segX + 16} y={TRACK_Y} width={Math.max(0, segW - 24)} height={TRACK_H} />
                </clipPath>
              </defs>
            </g>
          );
        })}

        {/* Playhead */}
        <line
          x1={currentTime * pxPerSec}
          y1={0}
          x2={currentTime * pxPerSec}
          y2={SVG_H}
          stroke="#60a5fa"
          strokeWidth="1.5"
          className="pointer-events-none"
        />
        <polygon
          points={`${currentTime * pxPerSec - 5},0 ${currentTime * pxPerSec + 5},0 ${currentTime * pxPerSec},8`}
          fill="#60a5fa"
          className="pointer-events-none"
        />
      </svg>
    </div>
  );
};
