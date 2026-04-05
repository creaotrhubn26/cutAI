import { Router, type IRouter } from "express";

const router: IRouter = Router();

const JAMENDO_CLIENT_ID = process.env["JAMENDO_CLIENT_ID"] ?? "b6747d04";
const JAMENDO_BASE = "https://api.jamendo.com/v3.0";

interface JamendoTrack {
  id: string;
  name: string;
  duration: number;
  artist_name: string;
  album_name: string;
  audio: string;
  audiodownload: string;
  shareurl: string;
  image: string;
  musicinfo?: {
    vocalinstrumental?: string;
    lang?: string;
    gender?: string;
    acousticelectric?: string;
    speed?: string;
    tags?: {
      genres?: string[];
      vartags?: string[];
    };
  };
}

router.get("/music/search", async (req, res) => {
  try {
    const { query = "", tags = "", bpmMin, bpmMax, limit = "5" } = req.query as Record<string, string>;

    const params = new URLSearchParams({
      client_id: JAMENDO_CLIENT_ID,
      format: "json",
      limit: String(Math.min(parseInt(limit) || 5, 10)),
      audioformat: "mp32",
      include: "musicinfo",
      fuzzytags: "1",
    });

    if (query) params.set("search", query);
    if (tags) params.set("tags", tags.split(",").slice(0, 3).join("+"));
    if (bpmMin) params.set("bpm_from", bpmMin);
    if (bpmMax) params.set("bpm_to", bpmMax);

    const url = `${JAMENDO_BASE}/tracks/?${params.toString()}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!resp.ok) {
      return res.status(502).json({ error: "Jamendo API error", status: resp.status });
    }

    const data = await resp.json() as { results: JamendoTrack[]; headers?: { results_count: number } };

    const tracks = (data.results ?? []).map((t: JamendoTrack) => ({
      id: t.id,
      name: t.name,
      artist: t.artist_name,
      album: t.album_name,
      duration: t.duration,
      previewUrl: t.audio,
      downloadUrl: t.audiodownload,
      shareUrl: t.shareurl,
      imageUrl: t.image,
      genres: t.musicinfo?.tags?.genres ?? [],
      tags: t.musicinfo?.tags?.vartags ?? [],
      speed: t.musicinfo?.speed ?? null,
    }));

    return res.json({ tracks, total: data.headers?.results_count ?? tracks.length });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Music search failed" });
  }
});

export default router;
