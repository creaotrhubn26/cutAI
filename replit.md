# CutAI Workspace

## Overview
CutAI is an AI-powered video editor for social media content (weddings, ads, Reels, TikTok). It is built as a pnpm workspace monorepo using TypeScript. The project's vision is to automate and enhance video editing processes through advanced AI, offering a streamlined workflow for content creators and businesses.

## User Preferences
- I prefer iterative development.
- Ask before making major changes.
- Provide detailed explanations for complex AI decisions.
- All AI job logs should be streamed and accessible.
- I expect transparency in AI feature extraction formulas.
- I want to be able to fine-tune AI models based on my edits.
- The system should actively learn from my rating of edits.

## System Architecture

CutAI employs a 7-layer self-learning AI video editing architecture that integrates neural networks and large language models for comprehensive video analysis and assembly.

### AI System Architecture Layers
1.  **Ingest**: Handles video upload, transcoding, and thumbnail extraction.
2.  **Signal Analysis**: Uses `ffmpeg` for volume, blur, and bitrate detection, augmented by a Neural Computer Vision pipeline for shot detection and aesthetic analysis.
3.  **Semantic Understanding**: Employs Claude to score clips based on metrics like `hookScore`, `emotionScore`, `clarityScore`, and `bRollValue`, blended with neural ground-truth data.
4.  **Editorial Policy**: Applies format-specific rule matrices (e.g., `hookWeight`, `speechWeight`) injected into Claude prompts.
5.  **Self-Learning Ranking**: Utilizes `learned_clip_prefs` to apply selection rate bonuses from past edits, improving clip selection over time.
6.  **Timeline Assembly**: Generates edit plans using either Claude or a transcript-driven `auto_assemble` job powered by GPT-4o mini scoring.
7.  **Render + QC**: Renders the final video using FFmpeg, including audio ducking and loudness quality control.

### Core AI Pipelines
-   **Audio-Driven Pipeline**: Integrates Whisper for transcription, FFmpeg for speaker detection, PySceneDetect for scene detection, GPT-4o for video understanding and highlight scoring, and FFmpeg for rendering with music ducking. The `auto_assemble` job automates timeline creation by scoring and selecting transcript segments.
-   **Neural Analysis**: Python scripts (`shot_detect.py`, `beat_detect.py`, `aesthetic.py`, `emotion.py`, `speech_emotion.py`, `diversity.py`) leverage libraries like PySceneDetect, OpenCV, librosa, and HSEmotion ONNX to extract detailed visual and audio features. These neural scores are blended with Claude's semantic scores for a robust clip analysis.

### Self-Learning and Fine-tuning
-   **Training Data Loop (Self-Improving RL)**: Captures user edits and quality ratings (1-5 stars) to adjust `learned_clip_prefs.selectionRate` using an exponential moving average. This system actively penalizes poor edits and amplifies good ones.
-   **Explicit Feature Extraction**: Computes `clip_score` based on `hook_score`, `emotion_score`, `clarity_score`, and repetition penalties, storing a transparent `formulaBreakdown` for each clip.
-   **Training Data Loop (Fine-tuning)**: Records human overrides of AI decisions (`segment_edits`) and user-rated `training_examples`. This data can be exported for fine-tuning OpenAI models, with the active fine-tuned model ID stored in `model_config`.

### Key Features
-   **Project Management**: Create projects with target formats (Instagram Reel, TikTok, YouTube Short, YouTube Long, Wedding Highlight, Ad Spot).
-   **AI Jobs**: Transcribe speech (Whisper), detect beats, analyze music, analyze scenes, and generate beat-synced edit plans.
-   **NLE-style Workspace**: Features an AI log console, Music Intelligence card, SVG beat timeline, and live job log streaming.
-   **Beat Timeline**: Visualizes beat markers, emotional sections, clip blocks, and provides zoom/playhead controls.
-   **Music Intelligence**: Displays BPM, key, time signature, mood, energy, and emotional arc.
-   **XML Style Learning System**: Allows users to upload FCPXML to extract and apply editing "DNA" (pacing, transitions, color grades, beat sync, audio ducking, caption style) to new projects. Over 500 built-in styles are available.
-   **Audio Balancing**: Per-segment `audioMixLevel` and `musicDuckLevel` for precise audio control, with auto-ducking for speech segments.
-   **Quality Check System**: Performs 6 sequential `ffprobe`/`ffmpeg` checks (codec compliance, resolution, frame rate, bitrate, frozen/black frames, audio continuity, loudness) to generate a quality score (0-100, A-F grade).
-   **Story Preferences Modal**: Allows users to set tone, focus, pacing, target duration, and speaker focus for AI prompt injection.
-   **Story Script Panel**: A paper-edit review panel for approving/rejecting clips based on emotional intensity, with "Why this clip?" reasoning.
-   **Manual Editing UX**: Includes keyboard shortcuts, drag-to-reorder clips, undo/redo, split clip functionality, and an AI Refine Edit feature.
-   **Segment Properties**: Detailed per-clip properties such as `speedFactor`, `speedRamp`, `reverse`, `freeze`, `audioEnhancement`, `audioMixLevel`, and `musicDuckLevel`.

### Technology Stack
-   **Monorepo**: pnpm workspaces
-   **Node.js**: 24
-   **TypeScript**: 5.9
-   **API Framework**: Express 5
-   **Database**: PostgreSQL + Drizzle ORM
-   **Validation**: Zod (`zod/v4`), `drizzle-zod`
-   **API Codegen**: Orval (from OpenAPI spec)
-   **Build**: esbuild
-   **Frontend**: React + Vite

### Database Schema
The database comprises 12 tables, including `projects`, `videos`, `segments`, `jobs`, `exports`, `activity`, `edit_styles`, `training_examples`, `clip_signals`, `learned_clip_prefs`, `segment_edits`, and `model_config`. `edit_styles` contains over 40 columns encoding detailed editing DNA.

## External Dependencies
-   **AI Services**:
    -   Anthropic Claude (via `@workspace/integrations-anthropic-ai`) for semantic understanding and edit plan generation.
    -   OpenAI Whisper `gpt-4o-mini-transcribe` (via `@workspace/integrations-openai-ai-server`) for speech-to-text transcription.
    -   GPT-4o via `analyze_scenes` and `analyze_clips` jobs.
-   **File Management**: `multer` for file uploads.
-   **Video/Audio Processing**: `ffmpeg` and `ffprobe` are extensively used for media analysis, transcoding, rendering, and quality checks.
-   **Python Libraries**: PySceneDetect, OpenCV, librosa, HSEmotion ONNX for neural vision and audio analysis.

## Recent Additions (Color + Social + Export)

### Color Pipeline Tab (`/color` route → `color-tools.ts`)
- **LUT Import & Apply**: Upload `.cube`/`.3dl` LUT files; store in `/tmp/cutai-uploads/luts/`; apply via FFmpeg `lut3d` filter per segment (`segments.lutFile`)
- **Auto White Balance**: Detect neutral gray regions via `ffprobe signalstats`, apply `colorbalance` correction (stored in `segments.wbCorrection`)
- **Exposure Normalization**: Measure luma per clip, apply `eq` brightness offset to normalize to target (128 default); stored in `segments.exposureNorm`
- **Skin Tone Protection**: Apply color corrections while protecting hue range 0°–50° (skin tones) via selective hue exclusion
- **Shot Matching**: Analyze reference clip's RGB levels + luma, generate correction to match all other clips
- **Horizon Leveling**: Claude Vision detects tilt angle; FFmpeg `rotate` corrects; stored in `segments.horizonAngle`
- **Frame Interpolation**: Set target FPS (24/25/30/50/60/120) for all clips; uses FFmpeg `minterpolate` filter; stored in `segments.frameInterpFps`

### Social Intelligence Tab (`/social` route → `social-intelligence.ts`)
- **Hook Analyzer**: Score first 3 seconds against 8 viral patterns (question, shock, value, story, curiosity gap, FOMO, social proof, transformation); Claude grades A–F with rewrite suggestions
- **Optimal Length**: Recommend ideal duration per platform (TikTok 15–60s, YouTube 8–15min, etc.); compare against current duration
- **Caption Hook Generator**: Generate 5 hook variants (EN + NO 🇳🇴) per platform with emoji suggestions and recommended index
- **Post Timing Recommender**: Return best/good posting windows per platform (data-driven + timezone-aware)

### Export Tools Tab (part of Social → `export-tools.ts`)
- **Batch Export**: Export 16:9, 9:16, 1:1 simultaneously from rendered MP4; stored in `/tmp/cutai-renders/batch/{projectId}/`
- **Mezzanine Export (ProRes 422 HQ)**: Re-encode rendered MP4 to ProRes `.mov` archive; stored in `/tmp/cutai-renders/mezzanine/`
- **YouTube Metadata + Upload**: AI-generate title/description/tags from transcript; upload via Google OAuth to YouTube as private draft

### Recent Additions (NLE Features + Social Upload)
- **Zoom-to-selection (CMD+=)**: Press Cmd+= or use Z-sel button to zoom timeline to the selected clip and center it
- **Color-coded timeline lanes**: Toggle "Lanes" button to separate clips into Dialogue / B-Roll / Music / Graphics rows
- **TikTok direct upload**: `POST /api/projects/:id/upload-to-tiktok` via TikTok Content Posting API v2 (chunk upload)
- **Instagram Reels upload**: `POST /api/projects/:id/upload-to-instagram` via Meta Graph API v18 (container + poll + publish)
- **LinkedIn video post**: `POST /api/projects/:id/upload-to-linkedin` via LinkedIn UGC Posts API v2 (register + upload + post)
- **Render download endpoint**: `GET /api/projects/:id/download-render` — serves rendered MP4 publicly (used by Instagram)

---

## PENDING SETUP — MÅ GJØRES

### Sosiale medier API-nøkler (kreves for direkte upload)

Følgende hemmeligheter må legges til under **Settings → Secrets** i Replit for at direkte upload skal fungere:

#### TikTok
| Secret | Beskrivelse |
|--------|-------------|
| `TIKTOK_ACCESS_TOKEN` | OAuth 2.0 access token fra TikTok Developer Portal |

**Slik får du det:**
1. Gå til [TikTok Developer Portal](https://developers.tiktok.com/)
2. Opprett en app og aktiver **Content Posting API**
3. Gjennomfør OAuth 2.0-flyten for å få `access_token`

---

#### Instagram Reels
| Secret | Beskrivelse |
|--------|-------------|
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived Page Access Token |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | Instagram Business Account ID |

**Slik får du det:**
1. Gå til [Meta Business Manager](https://business.facebook.com/)
2. Koble Instagram Professional Account til en Facebook-side
3. Generer en long-lived Page Token via [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
4. Finn Instagram Business Account ID via `GET /me/accounts` → hent `instagram_business_account.id`

---

#### LinkedIn Video
| Secret | Beskrivelse |
|--------|-------------|
| `LINKEDIN_ACCESS_TOKEN` | OAuth 2.0 access token med `w_member_social` scope |
| `LINKEDIN_PERSON_URN` | Personens URN, f.eks. `urn:li:person:ABCDEF123` |

**Slik får du det:**
1. Gå til [LinkedIn Developer Portal](https://www.linkedin.com/developers/)
2. Opprett en app og be om `w_member_social` tilgang
3. Gjennomfør OAuth 2.0-flyten
4. Hent `LINKEDIN_PERSON_URN` via `GET https://api.linkedin.com/v2/me`

---

### Critical Model Constraint
ONLY use: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`. Old IDs (e.g. `claude-3-5-haiku-20241022`) cause 400 errors.