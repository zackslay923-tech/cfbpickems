"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
admin.initializeApp();

// Normalize team names to the same key format your app uses ("away__home")
function norm(s) {
  if (!s || typeof s !== "string") return "";
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function toKey(away, home) {
  return `${norm(away)}__${norm(home)}`;
}

// Shape the CFBD /scoreboard items into the fields your Scorebug expects
function normalizeScoreboardItems(items) {
  const mapObj = {};
  if (!Array.isArray(items)) return mapObj;

  for (const it of items) {
    const home = it?.homeTeam || it?.home_team || "";
    const away = it?.awayTeam || it?.away_team || "";
    if (!home || !away) continue;

    const key = toKey(away, home);
    mapObj[key] = {
      id: it?.id ?? it?.gameId ?? it?.game_id ?? null,
      home: String(home),
      away: String(away),
      status: it?.status || null,
      period: (typeof it?.period === "number") ? it.period
              : (typeof it?.quarter === "number") ? it.quarter
              : null,
      clock: it?.clock ?? it?.timeRemaining ?? null,
      homePoints: Number.isFinite(it?.homePoints) ? it.homePoints
                 : Number.isFinite(it?.home_points) ? it.home_points
                 : null,
      awayPoints: Number.isFinite(it?.awayPoints) ? it.awayPoints
                 : Number.isFinite(it?.away_points) ? it.away_points
                 : null,
      possession: (it?.possession === "home" || it?.possession === "away") ? it.possession : null,
      startTime: it?.startTime ?? it?.start_time ?? null
    };
  }
  return mapObj;
}

// Read CFBD token from Firestore config/cfbd
async function readCfbdToken(db) {
  const snap = await db.doc("config/cfbd").get();
  const data = snap.exists ? snap.data() : {};
  const token = data?.token || data?.apiKey || data?.key || null;
  if (!token) throw new Error("CFBD API token not found in config/cfbd (fields checked: token, apiKey, key)");
  return token;
}

// Get ET "YYYY-MM-DD" for today (so we always fetch today's live slate)
function todayET() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  // en-CA gives YYYY-MM-DD
  return fmt.format(new Date());
}

// Node 20 has global fetch; poll once per minute via Cloud Scheduler
exports.publishLiveMap = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "America/New_York",
    region: "us-east4"  // adjust if you prefer another region
  },
  async () => {
    const db = admin.firestore();
    // Respect admin hard stop: only run when config/app.scoreboard.mode === "on"
    try {
      const appSnap = await db.doc("config/app").get();
      const app = appSnap.exists ? appSnap.data() : {};
      const sc = (app && app.scoreboard) ? app.scoreboard : {};
      const mode = (sc && sc.mode) ? String(sc.mode).toLowerCase() : "on";
      if (mode !== "on") {
        logger.info(`publishLiveMap skipped (scoreboard.mode=${mode})`);
        return;
      }
    } catch (e) {
      // If config/app is unreadable, fail closed (skip publishing)
      logger.warn("publishLiveMap: could not read config/app; skipping", e?.message || e);
      return;
    }

    let token;
    try {
      token = await readCfbdToken(db);
    } catch (err) {
      logger.error("CFBD token missing:", err?.message || err);
      return;
    }

    const date = todayET();
    const url = `https://api.collegefootballdata.com/scoreboard?groups=80&date=${encodeURIComponent(date)}`;

    try {
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn("CFBD non-2xx:", res.status, text?.slice(0, 200));
        return;
      }
      const json = await res.json();
      const mapObj = normalizeScoreboardItems(json);

      // Lightweight dedupe using a short hash of the payload
      const hash = JSON.stringify(mapObj).slice(0, 2048); // cheap hash proxy
      const ref = db.doc("config/liveMap");
      const prev = await ref.get();
      const prevHash = prev.exists ? (prev.get("hash") || "") : "";

      // Only write if changed
      if (hash !== prevHash) {
        await ref.set(
          {
            map: mapObj,
            hash,
            updatedAt: Date.now(),
            source: "cfbd-cron"
          },
          { merge: true }
        );
        logger.info("liveMap updated (changed)");
      } else {
        logger.info("liveMap unchanged; skipped write");
      }
    } catch (e) {
      logger.error("CFBD fetch/publish error:", e?.message || e);
    }
  }
);

