import { setGlobalOptions } from "firebase-functions/v2/options";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

setGlobalOptions({ region: "us-central1", timeoutSeconds: 60, memory: "256MiB" });

// Initialize Admin SDK (modular)
if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

type ScoreItem = {
  status: string | null;
  period: number | null;
  clock: string | null;
  homePoints: number | null;
  awayPoints: number | null;
  possession: "home" | "away" | null;
  startTime: string | null;
};
type ScoreMap = Record<string, ScoreItem>;

function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeScoreboardItems(items: any[]): ScoreMap {
  const out: ScoreMap = {};
  for (const it of Array.isArray(items) ? items : []) {
    const awayId = it.awayTeam ?? it.away ?? (it as any).away_team ?? "";
    const homeId = it.homeTeam ?? it.home ?? (it as any).home_team ?? "";
    const key = norm(awayId) + "__" + norm(homeId);
    out[key] = {
      status: it.status ?? (it as any).gameStatus ?? null,
      period:
        typeof it.period === "number"
          ? it.period
          : typeof (it as any).quarter === "number"
          ? (it as any).quarter
          : null,
      clock: it.clock ?? (it as any).timeRemaining ?? null,
      homePoints: Number.isFinite(it.homePoints)
        ? it.homePoints
        : Number.isFinite((it as any).home_points)
        ? (it as any).home_points
        : null,
      awayPoints: Number.isFinite(it.awayPoints)
        ? it.awayPoints
        : Number.isFinite((it as any).away_points)
        ? (it as any).away_points
        : null,
      possession:
        it.possession === "home" || it.possession === "away"
          ? it.possession
          : null,
      startTime: it.startTime ?? (it as any).start_time ?? null,
    };
  }
  return out;
}

async function getCfbdToken(): Promise<string | null> {
  try {
    const snap = await db.doc("config/cfbd").get();
    const d = snap.exists ? (snap.data() as Record<string, unknown>) : {};
    const candidates = [d?.token, d?.apiKey, d?.key].map((v) =>
      typeof v === "string" ? v.trim() : "",
    );
    const tok = candidates.find((v) => v && v.length >= 20) ?? "";
    return tok || null;
  } catch {
    return null;
  }
}

async function fetchCfbdScoreboard(token: string): Promise<any[]> {
  const url = new URL("https://api.collegefootballdata.com/scoreboard");
  url.searchParams.set("groups", String(80)); // FBS
  const res = await fetch(url.toString(), {
    headers: { Authorization: "Bearer " + token },
  } as any);
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

/**
 * Writes to: public/scoreboard (public-read doc)
 * {
 *   lastUpdated: server timestamp,
 *   source: "cfbd" | "none",
 *   map: { "<away__home>": ScoreItem, ... }
 * }
 */
export const updateScoreboard = onSchedule("every 1 minutes", async () => {
  const token = await getCfbdToken();
  if (!token) {
    await db.doc("public/scoreboard").set(
      {
        lastUpdated: FieldValue.serverTimestamp(),
        source: "none",
        map: {},
      },
      { merge: true },
    );
    return;
  }

  let items: any[] = [];
  try {
    items = await fetchCfbdScoreboard(token);
  } catch {
    items = [];
  }
  const map = normalizeScoreboardItems(items);
  await db.doc("public/scoreboard").set(
    {
      lastUpdated: FieldValue.serverTimestamp(),
      source: "cfbd",
      map,
    },
    { merge: true },
  );
});