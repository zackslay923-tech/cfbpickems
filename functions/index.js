"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
admin.initializeApp();

const NOTIFICATION_TOPIC = "all-players";

// Broadcast a push notification to every device that's subscribed. Failures
// are logged and swallowed - a missed notification shouldn't break the
// automation that triggered it.
async function sendPush({ title, body }) {
  try {
    await admin.messaging().send({
      topic: NOTIFICATION_TOPIC,
      notification: { title, body }
    });
    logger.info(`sendPush: sent "${title}"`);
  } catch (e) {
    logger.warn("sendPush failed:", e?.message || e);
  }
}

// New device registers a push token -> subscribe it to the broadcast topic.
exports.subscribePushToken = onDocumentCreated(
  { document: "pushTokens/{token}", region: "us-east4" },
  async (event) => {
    const token = event.params.token;
    try {
      await admin.messaging().subscribeToTopic([token], NOTIFICATION_TOPIC);
      logger.info(`subscribePushToken: subscribed ${token.slice(0, 12)}...`);
    } catch (e) {
      logger.warn("subscribePushToken failed:", e?.message || e);
    }
  }
);

// Admin drops a {title, body} doc in notificationOutbox -> broadcast it, then
// clean up the doc.
exports.sendOutboxNotification = onDocumentCreated(
  { document: "notificationOutbox/{id}", region: "us-east4" },
  async (event) => {
    const data = event.data?.data() || {};
    if (!data.title) return;
    await sendPush({ title: data.title, body: data.body || "" });
    try { await event.data.ref.delete(); } catch (e) {}
  }
);

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

function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "final" || s === "completed" || s === "postgame";
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

// Get current ET time as "HH:MM" (24h)
function nowTimeET() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  return fmt.format(new Date());
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Supports windows that wrap past midnight (e.g. "12:00" -> "02:00")
function isWithinWindow(nowET, startET, endET) {
  const now = toMinutes(nowET), start = toMinutes(startET), end = toMinutes(endET);
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

// Auto-write winners for any game the live map shows as final that doesn't
// already have a recorded result. Runs server-side (unlike the old client-only
// useAutoWinners hook) so it works regardless of whether an admin has the
// Leaderboard page open.
async function autoWriteWinners(db, mapObj) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return;

  const games = gamesSnap.docs.map(d => d.data()).filter(g => g.included !== false);
  const existing = await Promise.all(games.map(g => db.doc(`results/${g.id}`).get()));

  const batch = db.batch();
  let writes = 0;

  games.forEach((g, i) => {
    if (existing[i].exists && existing[i].data()?.winner) return; // already recorded

    const liveGame = mapObj[toKey(g.away, g.home)];
    if (!liveGame || !isFinalStatus(liveGame.status)) return;

    const hp = Number.isFinite(liveGame.homePoints) ? liveGame.homePoints : null;
    const ap = Number.isFinite(liveGame.awayPoints) ? liveGame.awayPoints : null;
    if (hp === null || ap === null || hp === ap) return; // incomplete or tied (shouldn't happen in CFB)

    const winner = hp > ap ? g.home : g.away;
    batch.set(db.doc(`results/${g.id}`), {
      winner,
      totalPoints: hp + ap,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "auto-cron"
    }, { merge: true });
    writes++;
  });

  if (writes > 0) {
    await batch.commit();
    logger.info(`autoWriteWinners: wrote ${writes} winner(s) for ${year}/W${week}`);
  }
}

function clockToSeconds(clock) {
  if (!clock || typeof clock !== "string") return null;
  const m = clock.match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// "Started" = clock has ticked below 15:00 in the 1st quarter, or the game
// has moved past the 1st quarter entirely.
function hasGameStarted(liveGame) {
  if (!liveGame) return false;
  const period = Number(liveGame.period);
  if (Number.isFinite(period) && period >= 2) return true;
  if (period === 1) {
    const secs = clockToSeconds(liveGame.clock);
    if (secs !== null && secs < 900) return true;
  }
  return false;
}

// Lock picks and open the leaderboard the instant the week's first game (by
// scheduled kickoff) actually starts. Reopening picks for the next week is
// always a manual admin action - this only ever locks, never unlocks picks.
async function autoLockAtKickoff(db, mapObj) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return;

  const games = gamesSnap.docs.map(d => d.data()).filter(g => g.included !== false && g.startTimeStr);
  if (!games.length) return;

  games.sort((a, b) => new Date(a.startTimeStr) - new Date(b.startTimeStr));
  const firstGame = games[0];

  if (!hasGameStarted(mapObj[toKey(firstGame.away, firstGame.home)])) return;

  const appSnap = await db.doc("config/app").get();
  const app = appSnap.exists ? appSnap.data() : {};
  const updates = {};
  if (app.picksLocked !== true) updates.picksLocked = true;
  if (app.leaderboardLocked !== false) updates.leaderboardLocked = false;
  if (app.leaderboardPicksPublic !== true) updates.leaderboardPicksPublic = true;

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db.doc("config/app").set(updates, { merge: true });
    logger.info(`autoLockAtKickoff: ${firstGame.away} @ ${firstGame.home} started - locked picks, opened leaderboard, made picks public for ${year}/W${week}`);
    if (app.notifications?.kickoffEnabled !== false) {
      await sendPush({
        title: "🔒 Picks are locked - leaderboard is live!",
        body: `${firstGame.away} @ ${firstGame.home} just kicked off. See where everyone landed.`
      });
      await db.doc("config/app").set(
        { notifications: { kickoffSentWeekKey: `${year}_W${week}` }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
  }
}

// Cheap check (Firestore only): current live week's "{year}_W{week}" key, or
// null if no live week is set. Used to record which week a notification was
// last sent for, so the Admin page can show an accurate sent/not-sent status.
async function getLiveWeekKey(db) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  return `${year}_W${week}`;
}

// Same-day ET calendar date string ("YYYY-MM-DD") for an arbitrary Date, used
// by the "morning of" reminder to know if today is game day.
function etDateStr(d) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

// "12:00 PM EDT" / "7:30 PM EST" - DST-aware kickoff time label for copy.
function etTimeLabel(ms) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return fmt.format(new Date(ms));
}

// Shared plumbing for a single reminder tier: look up the current live
// week's first scheduled kickoff, check shouldFire({minsUntil, kickoffMs,
// now}), and if so send + record it (deduped per week, per tier, and
// skippable via its own config/app.notifications.<enabledField> flag).
async function maybeSendReminderTier(db, { enabledField, sentField, title, body, shouldFire }) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return;

  const games = gamesSnap.docs.map(d => d.data()).filter(g => g.included !== false && g.startTimeStr);
  if (!games.length) return;

  games.sort((a, b) => new Date(a.startTimeStr) - new Date(b.startTimeStr));
  const firstGame = games[0];
  const kickoffMs = new Date(firstGame.startTimeStr).getTime();
  if (!Number.isFinite(kickoffMs)) return;

  const now = Date.now();
  const minsUntil = (kickoffMs - now) / 60000;
  if (!shouldFire({ minsUntil, kickoffMs, now })) return;

  const appSnap = await db.doc("config/app").get();
  const app = appSnap.exists ? appSnap.data() : {};
  if (app.notifications?.[enabledField] === false) return;

  const weekKey = `${year}_W${week}`;
  if (app?.notifications?.[sentField] === weekKey) return;

  await sendPush({
    title: typeof title === "function" ? title(firstGame, kickoffMs) : title,
    body: body(firstGame, kickoffMs)
  });
  await db.doc("config/app").set(
    { notifications: { [sentField]: weekKey }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// Cheap checks (Firestore only, no CFBD call): four reminder checkpoints
// counting down to the current live week's first scheduled kickoff.
async function maybeSendReminders(db) {
  await maybeSendReminderTier(db, {
    enabledField: "reminder2dEnabled", sentField: "reminder2dSentWeekKey",
    title: "📅 Games are 2 days away",
    body: (g) => `${g.away} @ ${g.home} kicks off in about 2 days - get your picks in when you're ready.`,
    shouldFire: ({ minsUntil }) => minsUntil <= 2880 && minsUntil > 0
  });
  await maybeSendReminderTier(db, {
    enabledField: "reminderMorningEnabled", sentField: "reminderMorningSentWeekKey",
    title: (g, kickoffMs) => `⏰ Picks are due today at ${etTimeLabel(kickoffMs)}`,
    body: (g) => `${g.away} @ ${g.home} kicks off then - get your picks in.`,
    shouldFire: ({ kickoffMs, now }) => {
      if (now >= kickoffMs) return false;
      if (etDateStr(new Date(kickoffMs)) !== etDateStr(new Date(now))) return false;
      return toMinutes(nowTimeET()) >= 9 * 60; // 9:00 AM ET or later
    }
  });
  await maybeSendReminderTier(db, {
    enabledField: "reminder2hEnabled", sentField: "reminder2hSentWeekKey",
    title: "⏰ Picks close in about 2 hours",
    body: (g) => `${g.away} @ ${g.home} kicks off soon - last call to get your picks in!`,
    shouldFire: ({ minsUntil }) => minsUntil <= 120 && minsUntil > 0
  });
  await maybeSendReminderTier(db, {
    enabledField: "reminderEnabled", sentField: "reminderSentWeekKey",
    title: "⏰ Picks close in about an hour",
    body: (g) => `${g.away} @ ${g.home} kicks off soon - get your picks in!`,
    shouldFire: ({ minsUntil }) => minsUntil <= 60 && minsUntil > 0
  });
}

// Cheap check (Firestore only, no CFBD call): has the current live week's
// first game reached its scheduled kickoff time? Used to auto-disengage the
// scoreboard hard stop without needing to poll CFBD while stopped.
async function isPastScheduledKickoff(db) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return false;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return false;

  const startTimes = gamesSnap.docs
    .map(d => d.data())
    .filter(g => g.included !== false && g.startTimeStr)
    .map(g => new Date(g.startTimeStr).getTime())
    .filter(Number.isFinite);
  if (!startTimes.length) return false;

  return Date.now() >= Math.min(...startTimes);
}

// Has every included game in the current live week been recorded with a
// winner? Used to auto-re-engage the hard stop once the week wraps up.
async function isWeekComplete(db) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return false;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return false;

  const games = gamesSnap.docs.map(d => d.data()).filter(g => g.included !== false);
  if (!games.length) return false;

  const results = await Promise.all(games.map(g => db.doc(`results/${g.id}`).get()));
  return results.every(r => r.exists && r.data()?.winner);
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
    let scoreboardCfg = {};
    let notifCfg = {};

    try {
      const appSnap = await db.doc("config/app").get();
      const app = appSnap.exists ? appSnap.data() : {};
      scoreboardCfg = (app && app.scoreboard) ? app.scoreboard : {};
      notifCfg = (app && app.notifications) ? app.notifications : {};
    } catch (e) {
      // If config/app is unreadable, fail closed (skip publishing)
      logger.warn("publishLiveMap: could not read config/app; skipping", e?.message || e);
      return;
    }

    // Cheap check (Firestore only, runs regardless of hard-stop state): send
    // the pre-kickoff reminder push if we're within the window for it.
    try {
      await maybeSendReminders(db);
    } catch (e) {
      logger.warn("publishLiveMap: kickoff reminder check failed", e?.message || e);
    }

    // Respect admin hard stop (config/app.scoreboard.mode !== "on" / hardStop === true).
    // Before giving up, do a cheap Firestore-only check (no CFBD call) for
    // whether we've reached the current week's scheduled kickoff - if so,
    // auto-disengage the hard stop so live polling can start on its own.
    const mode = scoreboardCfg.mode ? String(scoreboardCfg.mode).toLowerCase() : "on";
    const hardStopped = scoreboardCfg.hardStop === true || mode !== "on";
    if (hardStopped) {
      let pastKickoff = false;
      try {
        pastKickoff = await isPastScheduledKickoff(db);
      } catch (e) {
        logger.warn("publishLiveMap: scheduled-kickoff check failed", e?.message || e);
      }
      if (!pastKickoff) {
        logger.info("publishLiveMap skipped (scoreboard hard-stopped)");
        return;
      }
      await db.doc("config/app").set(
        { scoreboard: { hardStop: false, mode: "on" }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      scoreboardCfg = { ...scoreboardCfg, hardStop: false, mode: "on" };
      logger.info("publishLiveMap: reached scheduled kickoff - auto-disengaged hard stop");
    }

    // Only poll during actual game hours (default noon-2am ET; configurable via
    // config/app.scoreboard.window). Cuts unnecessary CFBD calls the rest of the week.
    const win = scoreboardCfg.window || {};
    const startET = win.startET || "12:00";
    const endET = win.endET || "02:00";
    if (!isWithinWindow(nowTimeET(), startET, endET)) {
      logger.info(`publishLiveMap skipped (outside game window ${startET}-${endET} ET)`);
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

      // Auto-write winners for any newly-final games (default on; disable via
      // config/app.scoreboard.autoWriteWinners = false)
      if (scoreboardCfg.autoWriteWinners !== false) {
        await autoWriteWinners(db, mapObj);
      }

      // Lock picks + open the leaderboard the instant the week's first game
      // starts (default on; disable via config/app.scoreboard.autoLockPicks = false)
      if (scoreboardCfg.autoLockPicks !== false) {
        await autoLockAtKickoff(db, mapObj);
      }

      // Once every game in the week has a recorded winner, re-engage the hard
      // stop so we stop polling CFBD until the next game week begins.
      if (!scoreboardCfg.hardStop) {
        try {
          if (await isWeekComplete(db)) {
            await db.doc("config/app").set(
              { scoreboard: { hardStop: true, mode: "off" }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
            logger.info("publishLiveMap: week complete - auto re-engaged hard stop");
            if (notifCfg.resultsEnabled !== false) {
              await sendPush({
                title: "🏆 Final standings are in",
                body: "This week's games are all final - check the leaderboard for results."
              });
              const weekKey = await getLiveWeekKey(db);
              if (weekKey) {
                await db.doc("config/app").set(
                  { notifications: { resultsSentWeekKey: weekKey }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
                  { merge: true }
                );
              }
            }
          }
        } catch (e) {
          logger.warn("publishLiveMap: week-complete check failed", e?.message || e);
        }
      }
    } catch (e) {
      logger.error("CFBD fetch/publish error:", e?.message || e);
    }
  }
);
