"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
admin.initializeApp();

// A token FCM reports as "not registered" belongs to a device that's gone
// for good (app deleted, browser data cleared, uninstalled, etc.) - safe to
// remove permanently. Any other error (network blip, rate limit, message too
// large) is left alone since it says nothing about the token's validity.
async function pruneUnregisteredTokens(tokens, responses) {
  const dead = [];
  responses.forEach((r, i) => {
    if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
      dead.push(tokens[i]);
    }
  });
  if (dead.length) {
    const batch = admin.firestore().batch();
    dead.forEach(t => batch.delete(admin.firestore().collection("pushTokens").doc(t)));
    await batch.commit();
    logger.info(`pruned ${dead.length} stale device(s): ${dead.map(t => t.slice(0, 10)).join(", ")}`);
  }
  return dead.length;
}

// Broadcast a push notification to every registered device that isn't
// individually blocked by an admin, optionally skipping a specific set of
// tokens too (e.g. people who've already submitted picks - see the reminder
// tiers below). Sent as a direct per-token multicast rather than a topic so
// blocking/exclusion can actually apply. Failures are logged and swallowed -
// a missed notification shouldn't break the automation that triggered it.
async function sendPush({ title, body }, { excludeTokens } = {}) {
  try {
    const exclude = excludeTokens || new Set();
    const snap = await admin.firestore().collection("pushTokens").get();
    const tokens = snap.docs
      .filter(d => d.data()?.blocked !== true && !exclude.has(d.id))
      .map(d => d.id);
    if (!tokens.length) {
      logger.info(`sendPush: no eligible recipients for "${title}"`);
      return;
    }
    // FCM multicast caps at 500 recipients per call
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({ tokens: batch, data: { title, body: body || "" } });
      logger.info(`sendPush: sent "${title}" to ${res.successCount}/${batch.length} device(s)`);
      await pruneUnregisteredTokens(batch, res.responses);
    }
  } catch (e) {
    logger.warn("sendPush failed:", e?.message || e);
  }
}

// Same as sendPush, but only to devices tagged isAdmin:true (set when
// someone enables notifications while actually signed in as admin - see
// enablePushNotifications in web/src/firebase.js). Used for internal alerts
// that shouldn't go out to the whole pool.
async function sendPushToAdmins({ title, body }) {
  try {
    const snap = await admin.firestore().collection("pushTokens").get();
    const tokens = snap.docs
      .filter(d => d.data()?.isAdmin === true && d.data()?.blocked !== true)
      .map(d => d.id);
    if (!tokens.length) {
      logger.info(`sendPushToAdmins: no admin devices registered for "${title}"`);
      return;
    }
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({ tokens: batch, data: { title, body: body || "" } });
      logger.info(`sendPushToAdmins: sent "${title}" to ${res.successCount}/${batch.length} admin device(s)`);
      await pruneUnregisteredTokens(batch, res.responses);
    }
  } catch (e) {
    logger.warn("sendPushToAdmins failed:", e?.message || e);
  }
}

// Kept deployed for backward compatibility (removing it would orphan the
// already-deployed function, same issue as updateScoreboard). No longer
// load-bearing: sendPush() now messages tokens directly instead of via this
// topic, so this subscription is unused but harmless.
const NOTIFICATION_TOPIC = "all-players";
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

// Known name variants that should resolve to the same person (e.g. a
// nickname or alternate spelling used on a different week's submission).
// Keep in sync with the identical map in App.jsx's personKey.
const NAME_ALIASES = {
  "jack_vardaramatos": "jacques_vardaramatos",
};

// Same normalization the web app uses (App.jsx's personKey) - kept in sync
// by hand since this is a separate Node module with no shared code.
function personKey(p) {
  const n = `${(p.firstName || "").trim().toLowerCase()}_${(p.lastName || "").trim().toLowerCase()}`;
  const key = n.replace(/^_+|_+$/g, "") || null;
  return key ? (NAME_ALIASES[key] || key) : null;
}
function deviceNameKey(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return personKey({ firstName: parts[0], lastName: parts.slice(1).join(" ") });
}

// Push tokens belonging to someone who's already submitted picks for the
// given week (used to skip reminder notifications for them). Prefers the
// exact pushToken tag on the picks doc, but that's only there if
// notifications were already enabled *before* they submitted - most people
// go the other order (especially anyone who hit the pushTokens registration
// bug) - so this also matches by name against every registered device, the
// same fallback the admin "Submitted" badge uses. Admin devices are never
// included here (even if the admin has personally submitted), so admins
// keep getting every reminder tier to verify the automation is firing.
async function getSubmittedTokensForWeek(db, year, week) {
  const [picksSnap, tokensSnap] = await Promise.all([
    db.collection("picks").where("year", "==", year).where("week", "==", week).get(),
    db.collection("pushTokens").get()
  ]);

  const adminTokens = new Set();
  tokensSnap.forEach(d => { if (d.data()?.isAdmin === true) adminTokens.add(d.id); });

  const tokens = new Set();
  const submittedNameKeys = new Set();
  picksSnap.forEach(d => {
    const p = d.data();
    const t = p?.pushToken; if (t && !adminTokens.has(t)) tokens.add(t);
    const nk = personKey(p); if (nk) submittedNameKeys.add(nk);
  });

  tokensSnap.forEach(d => {
    if (adminTokens.has(d.id)) return;
    const nk = deviceNameKey(d.data()?.name);
    if (nk && submittedNameKeys.has(nk)) tokens.add(d.id);
  });

  return tokens;
}

// Admin drops a {title, body} doc in notificationOutbox -> broadcast it (or,
// if targetToken is set, deliver to just that one device), then clean up.
exports.sendOutboxNotification = onDocumentCreated(
  { document: "notificationOutbox/{id}", region: "us-east4" },
  async (event) => {
    const data = event.data?.data() || {};
    if (!data.title) return;
    if (data.targetToken) {
      try {
        await admin.messaging().send({
          token: data.targetToken,
          data: { title: data.title, body: data.body || "" }
        });
        logger.info(`sendOutboxNotification: sent "${data.title}" to single device ${String(data.targetToken).slice(0, 12)}...`);
      } catch (e) {
        if (e?.code === "messaging/registration-token-not-registered") {
          await admin.firestore().collection("pushTokens").doc(data.targetToken).delete();
          logger.info(`pruned 1 stale device (targeted send failed): ${String(data.targetToken).slice(0, 10)}...`);
        }
        logger.warn("sendOutboxNotification (targeted) failed:", e?.message || e);
      }
    } else {
      await sendPush({ title: data.title, body: data.body || "" });
    }
    try { await event.data.ref.delete(); } catch (e) {}
  }
);

// Admin taps "Clean Up Devices Now" -> writes a trigger doc here -> dry-run a
// push to every registered token (FCM validates it without delivering
// anything to anyone) and prune whichever ones it reports as no longer
// registered, without waiting for a real notification to expose them.
exports.cleanupStaleDevices = onDocumentCreated(
  { document: "deviceCleanupRequests/{id}", region: "us-east4" },
  async (event) => {
    let removed = 0;
    try {
      const snap = await admin.firestore().collection("pushTokens").get();
      const tokens = snap.docs.map(d => d.id);
      for (let i = 0; i < tokens.length; i += 500) {
        const batch = tokens.slice(i, i + 500);
        const res = await admin.messaging().sendEachForMulticast(
          { tokens: batch, notification: { title: "Device check", body: "" } },
          true // dryRun - validates tokens without delivering anything
        );
        removed += await pruneUnregisteredTokens(batch, res.responses);
      }
      await admin.firestore().doc("config/deviceCleanup").set(
        { lastRunAt: admin.firestore.FieldValue.serverTimestamp(), removedCount: removed, checkedCount: tokens.length },
        { merge: true }
      );
      logger.info(`cleanupStaleDevices: removed ${removed} stale device(s) of ${tokens.length} checked`);
    } catch (e) {
      logger.warn("cleanupStaleDevices failed:", e?.message || e);
    } finally {
      try { await event.data.ref.delete(); } catch (e) {}
    }
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

// Look up a game in the live map by team names. Our own games collection
// stores short team names ("TCU"), while CFBD's /scoreboard endpoint
// returns full names with mascots ("TCU Horned Frogs") - an exact toKey()
// match between the two can never succeed, which silently broke
// autoLockAtKickoff and autoWriteWinners for every game (confirmed: a
// completed game's winner never got auto-written because this exact-match
// lookup always missed). Falls back to finding a live-map key that
// contains both normalized names as substrings, the same fallback the
// client already uses for the same reason.
function findLiveGame(mapObj, away, home) {
  const exact = mapObj[toKey(away, home)];
  if (exact) return exact;

  const awayKey = norm(away), homeKey = norm(home);
  if (!awayKey || !homeKey) return null;
  for (const key of Object.keys(mapObj)) {
    if (key.includes(awayKey) && key.includes(homeKey)) return mapObj[key];
  }
  return null;
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
    // CFBD's /scoreboard nests team info as objects ({name, points, ...}),
    // not flat strings like /games uses (home_team/away_team). norm()
    // silently returns "" for a non-string, so treating homeTeam/awayTeam
    // as if they were always strings collapsed every single game onto the
    // same "__" key here, overwriting all but the last one in the response -
    // meaning live tracking (kickoff detection, auto-winners) never actually
    // saw real per-game data. Handle both shapes.
    const homeRaw = it?.homeTeam ?? it?.home_team;
    const awayRaw = it?.awayTeam ?? it?.away_team;
    const home = typeof homeRaw === "string" ? homeRaw : (homeRaw?.name || "");
    const away = typeof awayRaw === "string" ? awayRaw : (awayRaw?.name || "");
    if (!home || !away) continue;

    const homePointsNested = (homeRaw && typeof homeRaw === "object") ? homeRaw.points : undefined;
    const awayPointsNested = (awayRaw && typeof awayRaw === "object") ? awayRaw.points : undefined;

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
      homePoints: Number.isFinite(homePointsNested) ? homePointsNested
                 : Number.isFinite(it?.homePoints) ? it.homePoints
                 : Number.isFinite(it?.home_points) ? it.home_points
                 : null,
      awayPoints: Number.isFinite(awayPointsNested) ? awayPointsNested
                 : Number.isFinite(it?.awayPoints) ? it.awayPoints
                 : Number.isFinite(it?.away_points) ? it.away_points
                 : null,
      possession: (it?.possession === "home" || it?.possession === "away") ? it.possession : null,
      startTime: it?.startTime ?? it?.start_time ?? null
    };
  }
  return mapObj;
}

// ESPN's public scoreboard - no API key needed, same one that powers
// espn.com/the ESPN app. Promoted to the PRIMARY live-status source after
// CFBD's own /scoreboard feed was repeatedly observed reporting live games
// as still "scheduled" (confirmed side-by-side against ESPN showing the
// same games correctly in progress, on more than one occasion on a real
// game day). CFBD is kept as the fallback for any game ESPN doesn't carry.
function normalizeEspnStatus(typeName, completed) {
  if (completed) return "completed";
  const s = String(typeName || "").toLowerCase();
  if (s.includes("final")) return "completed";
  // Kept distinct from "in_progress" (rather than folded in) so the
  // Scorebug can show "DELAYED" instead of a stale/frozen quarter and
  // clock - it already has a display case for any status matching
  // /delay|suspend|cancel/, it just never received this value before.
  if (s.includes("delayed")) return "delayed";
  if (s.includes("in_progress") || s.includes("halftime") || s.includes("end_period")) return "in_progress";
  return "scheduled";
}

function normalizeEspnItems(events) {
  const mapObj = {};
  if (!Array.isArray(events)) return mapObj;

  for (const e of events) {
    const comp = e?.competitions?.[0];
    if (!comp) continue;
    const competitors = comp.competitors || [];
    const homeC = competitors.find(c => c.homeAway === "home");
    const awayC = competitors.find(c => c.homeAway === "away");
    const home = homeC?.team?.displayName || "";
    const away = awayC?.team?.displayName || "";
    if (!home || !away) continue;

    const statusType = e?.status?.type || {};
    const status = normalizeEspnStatus(statusType.name, statusType.completed);

    const possessionTeamId = comp?.situation?.possession;
    let possession = null;
    if (possessionTeamId) {
      if (homeC?.team?.id === possessionTeamId) possession = "home";
      else if (awayC?.team?.id === possessionTeamId) possession = "away";
    }

    // ESPN reports score:"0" for every game that hasn't kicked off yet, not
    // an absent/null score - taking that at face value showed a real "0-0"
    // on the Scorebug for scheduled games instead of the usual "–" dashes.
    // A pregame score is meaningless, so force it to null until the game
    // has actually started.
    const homePoints = (status === "scheduled") ? NaN : Number(homeC?.score);
    const awayPoints = (status === "scheduled") ? NaN : Number(awayC?.score);

    mapObj[toKey(away, home)] = {
      id: e?.id ?? null,
      home: String(home),
      away: String(away),
      status,
      period: (typeof e?.status?.period === "number") ? e.status.period : null,
      clock: e?.status?.displayClock || null,
      homePoints: Number.isFinite(homePoints) ? homePoints : null,
      awayPoints: Number.isFinite(awayPoints) ? awayPoints : null,
      possession,
      startTime: e?.date || null
    };
  }
  return mapObj;
}

async function fetchEspnScoreboard(year, week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}&seasontype=2&groups=80`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.events) ? json.events : [];
}

// ESPN is primary: its entry wins for any game it covers. CFBD's entry is
// kept only as a fallback for games ESPN doesn't carry (e.g. an FCS
// opponent CFBD's groups=80 filter still returns but ESPN's group=80
// scoreboard omits).
function mergeEspnPrimary(cfbdMap, espnMap) {
  const merged = { ...cfbdMap };
  for (const [key, espnItem] of Object.entries(espnMap)) {
    merged[key] = espnItem;
  }
  return merged;
}

// Read CFBD token from Firestore config/cfbd
async function readCfbdToken(db) {
  const snap = await db.doc("config/cfbd").get();
  const data = snap.exists ? snap.data() : {};
  const token = data?.token || data?.apiKey || data?.key || null;
  if (!token) throw new Error("CFBD API token not found in config/cfbd (fields checked: token, apiKey, key)");
  return token;
}

// How long CFBD fetches need to be failing in a row before alerting the
// admin (bad/expired API key, CFBD outage, etc.) rather than a single
// transient blip.
const CFBD_FAILURE_ALERT_MINUTES = 30;

// Tracks whether the most recent CFBD fetch attempts are succeeding or
// failing. On the first failure after a success, starts a timer; once
// that's been failing continuously for CFBD_FAILURE_ALERT_MINUTES+, alerts
// the admin's device once. Resets as soon as a fetch succeeds again, so a
// later failure streak can alert fresh.
async function recordCfbdResult(db, ok) {
  try {
    const appSnap = await db.doc("config/app").get();
    const app = appSnap.exists ? appSnap.data() : {};
    const notif = app.notifications || {};

    if (ok) {
      if (notif.cfbdFailureSince || notif.cfbdFailureAlertSent) {
        await db.doc("config/app").set(
          { notifications: { cfbdFailureSince: null, cfbdFailureAlertSent: false } },
          { merge: true }
        );
      }
      return;
    }

    const now = Date.now();
    let since = notif.cfbdFailureSince;
    if (!since) {
      since = now;
      await db.doc("config/app").set({ notifications: { cfbdFailureSince: now } }, { merge: true });
    }

    const failingMinutes = (now - since) / 60000;
    if (failingMinutes >= CFBD_FAILURE_ALERT_MINUTES && !notif.cfbdFailureAlertSent) {
      await sendPushToAdmins({
        title: "⚠️ CFBD fallback isn't working",
        body: `CFBD fetches have been failing for ${CFBD_FAILURE_ALERT_MINUTES}+ minutes. ESPN is the primary live-score source now, so this only matters if ESPN also has an outage - check the API key in config/cfbd, or CFBD's own status, when convenient.`
      });
      await db.doc("config/app").set({ notifications: { cfbdFailureAlertSent: true } }, { merge: true });
    }
  } catch (e) {
    logger.warn("recordCfbdResult failed:", e?.message || e);
  }
}

// Get ET "YYYY-MM-DD" for today (so we always fetch today's live slate)
function todayET() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  // en-CA gives YYYY-MM-DD
  return fmt.format(new Date());
}

// Get current ET time as "HH:MM" (24h). hourCycle: "h23" is used instead of
// hour12: false - on some ICU builds the latter reports midnight as "24:00"
// instead of "00:00", which silently inflated every minutes-since-midnight
// check by a full day (this is what caused the game-day-morning reminder,
// gated on nowTimeET() >= 9:00 AM, to fire right at midnight instead).
function nowTimeET() {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  return fmt.format(new Date());
}

function toMinutes(hhmm) {
  let [h, m] = String(hhmm || "0:0").split(":").map(Number);
  h = (h || 0) % 24; // defensive: never let a stray "24" leak through as +1 day
  return h * 60 + (m || 0);
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

    const liveGame = findLiveGame(mapObj, g.away, g.home);
    if (!liveGame || !isFinalStatus(liveGame.status)) return;

    const hp = Number.isFinite(liveGame.homePoints) ? liveGame.homePoints : null;
    const ap = Number.isFinite(liveGame.awayPoints) ? liveGame.awayPoints : null;
    if (hp === null || ap === null || hp === ap) return; // incomplete or tied (shouldn't happen in CFB)

    const winner = hp > ap ? g.home : g.away;
    batch.set(db.doc(`results/${g.id}`), {
      winner,
      totalPoints: hp + ap,
      homePoints: hp,
      awayPoints: ap,
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

  if (!hasGameStarted(findLiveGame(mapObj, firstGame.away, firstGame.home))) return;

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

  const excludeTokens = await getSubmittedTokensForWeek(db, year, week);
  await sendPush({
    title: typeof title === "function" ? title(firstGame, kickoffMs) : title,
    body: body(firstGame, kickoffMs)
  }, { excludeTokens });
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
    enabledField: "reminder1dEnabled", sentField: "reminder1dSentWeekKey",
    title: "📅 Games are 1 day away",
    body: (g) => `${g.away} @ ${g.home} kicks off in about 24 hours - get your picks in when you're ready.`,
    shouldFire: ({ minsUntil }) => minsUntil <= 1440 && minsUntil > 0
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

// How long past a game's scheduled kickoff to wait before treating a
// still-missing winner as "stuck" (CFBD name mismatch, API hiccup, etc.)
// rather than just a long or weather-delayed game. Generous on purpose - a
// real game, even badly delayed, should essentially never take this long.
const STUCK_GAME_HOURS = 8;

// Cheap check (Firestore only, no CFBD call): is there an included game in
// the current live week whose scheduled kickoff has already passed but
// doesn't have a recorded winner yet? If so, Live Scores should be running
// to track it - whether that's the very first game of the week, or a later
// one after a gap (e.g. Thursday/Friday games finish, nothing happening
// until Saturday's slate kicks off). Games stuck past STUCK_GAME_HOURS are
// excluded here (see maybeAlertStuckGames) so one bad game can't keep Live
// Scores running for the rest of the week.
async function hasGameNeedingTracking(db) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return false;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return false;

  const games = gamesSnap.docs.map(d => d.data()).filter(g => g.included !== false && g.startTimeStr);
  if (!games.length) return false;

  const now = Date.now();
  const stuckCutoffMs = STUCK_GAME_HOURS * 60 * 60 * 1000;
  const pending = games.filter(g => {
    const t = new Date(g.startTimeStr).getTime();
    return Number.isFinite(t) && now >= t && (now - t) < stuckCutoffMs;
  });
  if (!pending.length) return false;

  const results = await Promise.all(pending.map(g => db.doc(`results/${g.id}`).get()));
  return results.some(r => !(r.exists && r.data()?.winner));
}

// Once, the first time a game crosses STUCK_GAME_HOURS past its scheduled
// kickoff with no recorded winner, alert the admin's device (not the whole
// pool) so it can be checked and set manually if needed.
async function maybeAlertStuckGames(db) {
  const liveSnap = await db.doc("config/live").get();
  const liveCfg = liveSnap.exists ? liveSnap.data() : {};
  const year = Number(liveCfg?.year), week = Number(liveCfg?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return;

  const gamesSnap = await db.collection("games")
    .where("year", "==", year)
    .where("week", "==", week)
    .get();
  if (gamesSnap.empty) return;

  const now = Date.now();
  const stuckCutoffMs = STUCK_GAME_HOURS * 60 * 60 * 1000;

  for (const d of gamesSnap.docs) {
    const g = d.data();
    if (g.included === false || !g.startTimeStr || g.stuckAlertSent) continue;
    const kickoffMs = new Date(g.startTimeStr).getTime();
    if (!Number.isFinite(kickoffMs) || (now - kickoffMs) < stuckCutoffMs) continue;

    const resultSnap = await db.doc(`results/${d.id}`).get();
    if (resultSnap.exists && resultSnap.data()?.winner) continue;

    await sendPushToAdmins({
      title: "⚠️ Game still missing a winner",
      body: `${g.away} @ ${g.home} still has no recorded winner ${STUCK_GAME_HOURS}+ hours after kickoff. Set it manually on the Leaderboard page if needed.`
    });
    await d.ref.set({ stuckAlertSent: true }, { merge: true });
  }
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

    // Cheap checks (Firestore only, run regardless of hard-stop state): send
    // the pre-kickoff reminder pushes, and flag any game that's gone stuck
    // (no recorded winner well past its scheduled kickoff) to the admin.
    try {
      await maybeSendReminders(db);
    } catch (e) {
      logger.warn("publishLiveMap: kickoff reminder check failed", e?.message || e);
    }
    try {
      await maybeAlertStuckGames(db);
    } catch (e) {
      logger.warn("publishLiveMap: stuck-game check failed", e?.message || e);
    }

    // Respect the Live Scores hard stop (config/app.scoreboard.mode !== "on" /
    // hardStop === true). Before giving up, do a cheap Firestore-only check
    // (no CFBD call) for whether any included game needs tracking right now -
    // if so, auto-disengage the hard stop so live polling can start on its
    // own. This also covers turning back on for a later game (e.g. Saturday's
    // slate) after an earlier gap where nothing was happening.
    const mode = scoreboardCfg.mode ? String(scoreboardCfg.mode).toLowerCase() : "on";
    const hardStopped = scoreboardCfg.hardStop === true || mode !== "on";
    if (hardStopped) {
      let needsPolling = false;
      try {
        needsPolling = await hasGameNeedingTracking(db);
      } catch (e) {
        logger.warn("publishLiveMap: game-tracking check failed", e?.message || e);
      }
      if (!needsPolling) {
        logger.info("publishLiveMap skipped (Live Scores off, nothing to track)");
        return;
      }
      await db.doc("config/app").set(
        { scoreboard: { hardStop: false, mode: "on" }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      scoreboardCfg = { ...scoreboardCfg, hardStop: false, mode: "on" };
      logger.info("publishLiveMap: a game needs tracking - auto-enabled Live Scores");
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

    try {
    // Live-score refresh, once per scheduled minute. ESPN is the primary
    // source: no API key, and proven far more reliable for live in-progress
    // status than CFBD's own feed (confirmed side-by-side more than once on
    // a real game day - CFBD repeatedly reported games as still "scheduled"
    // well after kickoff while ESPN had them correct). CFBD is only fetched
    // at all if ESPN's response is missing an included game we still need.
    const liveSnap = await db.doc("config/live").get();
    const liveCfg = liveSnap.exists ? liveSnap.data() : {};
    const liveYear = Number(liveCfg?.year), liveWeek = Number(liveCfg?.week);

    let expectedKeys = [];
    if (Number.isFinite(liveYear) && Number.isFinite(liveWeek)) {
      try {
        const gamesSnap = await db.collection("games")
          .where("year", "==", liveYear)
          .where("week", "==", liveWeek)
          .get();
        expectedKeys = gamesSnap.docs
          .map(d => d.data())
          .filter(g => g.included !== false)
          .map(g => toKey(g.away, g.home));
      } catch (e) {
        logger.warn("publishLiveMap: could not load games for ESPN gap-check", e?.message || e);
      }
    }

    let cachedCfbdMap = null;
    let cfbdToken;
    let cfbdTokenTried = false;
    async function fetchCfbdMapOnce() {
      if (cachedCfbdMap) return cachedCfbdMap;
      try {
        if (!cfbdTokenTried) { cfbdTokenTried = true; cfbdToken = await readCfbdToken(db); }
        if (!cfbdToken) return {};
        // No explicit `date` param on purpose - CFBD's own "current games"
        // default reflects in-progress status better than pinning a date.
        const res = await fetch(`https://api.collegefootballdata.com/scoreboard?groups=80`, {
          headers: { "Authorization": `Bearer ${cfbdToken}` }
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          logger.warn("CFBD fallback non-2xx:", res.status, text?.slice(0, 200));
          await recordCfbdResult(db, false);
          return {};
        }
        const json = await res.json();
        await recordCfbdResult(db, true);
        cachedCfbdMap = normalizeScoreboardItems(json);
        return cachedCfbdMap;
      } catch (e) {
        logger.warn("publishLiveMap: CFBD fallback fetch failed", e?.message || e);
        await recordCfbdResult(db, false).catch(() => {});
        return {};
      }
    }

    const ref = db.doc("config/liveMap");
    const prevDoc = await ref.get();
    const priorMap = prevDoc.exists ? (prevDoc.get("map") || {}) : {};
    const priorHash = prevDoc.exists ? (prevDoc.get("hash") || "") : "";

    let espnMap = {};
    let espnOk = false;
    try {
      if (Number.isFinite(liveYear) && Number.isFinite(liveWeek)) {
        const espnEvents = await fetchEspnScoreboard(liveYear, liveWeek);
        espnMap = normalizeEspnItems(espnEvents);
        espnOk = true;
      }
    } catch (e) {
      logger.warn("publishLiveMap: ESPN fetch failed", e?.message || e);
    }

    const missing = expectedKeys.filter(k => !espnMap[k]);
    let cfbdMap = {};
    let usedCfbd = false;
    if (!espnOk || missing.length > 0) {
      cfbdMap = await fetchCfbdMapOnce();
      usedCfbd = Object.keys(cfbdMap).length > 0;
    }

    let mapObj = espnOk
      ? mergeEspnPrimary(cfbdMap, espnMap)
      : (usedCfbd ? cfbdMap : priorMap);

    // Guard against a bad clock reading: a live feed occasionally reports
    // a stale/glitched clock that's HIGHER than what we last saw for the
    // same game in the same period - impossible for a real countdown,
    // since the clock only ever counts down within a period. When that
    // happens, hold the previous clock/period for exactly one cycle
    // instead of letting the displayed time jump backward.
    //
    // Only one cycle: if we held last time (prior._clockHeld) and the new
    // reading STILL looks like an increase relative to that same held
    // value, trust the new reading anyway and clear the hold. Comparing
    // forever against one frozen anchor is exactly what caused a real
    // incident - CFBD legitimately counted a game down (2:00 -> 1:55 ->
    // 1:38, all genuine, all lower than the previous real reading) while
    // every one of those got rejected because each was still numerically
    // higher than a single stale value from minutes earlier, freezing the
    // displayed clock for the rest of the game. One held cycle catches a
    // true one-off glitch (which self-corrects on the very next poll);
    // never un-sticking after that is a worse bug than the one this
    // exists to prevent.
    for (const key of Object.keys(mapObj)) {
      const cur = mapObj[key];
      const prior = priorMap[key];
      if (!prior || cur.status !== "in_progress" || prior.period !== cur.period) continue;
      if (prior._clockHeld) continue; // already held once - accept this reading unconditionally
      const curSecs = clockToSeconds(cur.clock);
      const priorSecs = clockToSeconds(prior.clock);
      if (curSecs !== null && priorSecs !== null && curSecs > priorSecs) {
        logger.warn(`Holding implausible clock for one cycle on ${key}: ${cur.clock} > previous ${prior.clock} in same period`);
        cur.clock = prior.clock;
        cur.period = prior.period;
        cur._clockHeld = true;
      }
    }

    const source = espnOk ? (usedCfbd ? "espn+cfbd" : "espn") : (usedCfbd ? "cfbd-only" : "stale");

    // Dedupe using the full serialized payload. A truncated slice() here
    // previously only looked at the first ~2048 characters of the JSON -
    // with 200+ games in the map, most games' data fell past that cutoff
    // and their changes were invisible to this comparison, so genuinely
    // updated scores could get silently treated as "unchanged" and never
    // written to the public doc, leaving non-admins stuck on stale data
    // indefinitely even though the fetch itself was working correctly.
    const hash = JSON.stringify(mapObj);
    if (hash !== priorHash) {
      await ref.set(
        { map: mapObj, hash, updatedAt: Date.now(), source, espnGameCount: Object.keys(espnMap).length },
        { merge: true }
      );
      logger.info("liveMap updated (changed)");
    } else {
      await ref.set({ updatedAt: Date.now(), source }, { merge: true });
      logger.info("liveMap unchanged; refreshed updatedAt only");
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

      // Once no included game currently needs tracking (either the whole
      // week is done, or there's just a gap - e.g. Thursday/Friday games
      // finished and Saturday's slate hasn't kicked off yet), re-engage the
      // hard stop so we're not polling CFBD for no reason. It'll auto-turn
      // back on above once the next kickoff arrives.
      if (!scoreboardCfg.hardStop) {
        try {
          if (!(await hasGameNeedingTracking(db))) {
            await db.doc("config/app").set(
              { scoreboard: { hardStop: true, mode: "off" }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
            logger.info("publishLiveMap: no games currently need tracking - auto re-engaged Live Scores hard stop");

            // Only announce final standings once the *entire* week is done,
            // not just a mid-week gap between games.
            if (await isWeekComplete(db)) {
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
          }
        } catch (e) {
          logger.warn("publishLiveMap: game-tracking re-check failed", e?.message || e);
        }
      }
    } catch (e) {
      logger.error("publishLiveMap: live-score publish error:", e?.message || e);
    }
  }
);

// Keep a public, names-free tally of the two "quick survey" poll questions
// (game-night preference and games-per-week) in config/pollResults, so the
// Leaderboard can show aggregate results to everyone without exposing the
// individual pollVotes docs (which carry names) to non-admins. Recomputes
// from scratch on every vote write - the collection is small (one doc per
// voter per question) so this is cheap.
const PUBLIC_POLL_IDS = ["tf_games", "games_per_week"];
exports.updatePollResults = onDocumentWritten(
  { document: "pollVotes/{voteId}", region: "us-east4" },
  async () => {
    const db = admin.firestore();
    const snap = await db.collection("pollVotes").get();

    const result = {};
    for (const pollId of PUBLIC_POLL_IDS) {
      const counts = {};
      let voters = 0;
      snap.forEach((d) => {
        const v = d.data();
        if (v.pollId !== pollId || !v.choice) return;
        counts[v.choice] = (counts[v.choice] || 0) + 1;
        voters++;
      });
      result[pollId] = { counts, voters };
    }

    await db.doc("config/pollResults").set(
      { ...result, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
);
