import teamColors from "./lib/teamColors.json";

/* === School color helpers === */
const normalizeName = (s) => String(s||"")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "");

const SCHOOL_COLORS = new Map(
  Object.entries(teamColors).map(([k,v]) => [normalizeName(k), String(v).toUpperCase()])
);

function textColorFor(bg) {
  try {
    const hex = String(bg||"").replace("#","");
    const full = hex.length===3 ? hex.split("").map(c=>c+c).join("") : hex;
    const r=parseInt(full.slice(0,2),16), g=parseInt(full.slice(2,4),16), b=parseInt(full.slice(4,6),16);
    const yiq=(r*299+g*587+b*114)/1000;
    return yiq >= 140 ? "#111" : "#fff";
  } catch(e) { return "#fff"; }
}
const schoolBg = (name) => (name ? (SCHOOL_COLORS.get(normalizeName(name)) || null) : null);

/* Winners row style (pure fn so we can call it from JSX) */
const winnerCellStyleFn = (results, cell, g) => {
  const COL_W = 140;
  const base = {
    ...cell,
    fontWeight: 700,
    fontSize: "15px",
    textAlign: "center",
    width: COL_W,
    minWidth: COL_W,
  };
  const w = results?.[g?.id]?.winner;
  if (!w) return base;
  const bg = schoolBg(w);
  if (!bg) return base;
  return { ...base, background: bg, color: textColorFor(bg) };
};
/* === end helpers === */
import "./index.css";
import "./App.css";
import { mergeEspnWeek } from "./lib/espnWeek";
import React, { useEffect, useState, useRef , useMemo } from "react";
import TeamLogo from "./components/TeamLogo";
import Scorebug from "./components/Scorebug"; // SCOREBUG import
import useScoreboard from "./lib/useScoreboard"; 
import useAutoWinners from "./lib/useAutoWinners";// SCOREBOARD hook
import AdminPicksPage from "./components/AdminPicksPage";
import BulkImportPicksPreview from "./components/BulkImportPicksPreview";
import { db, googleLogin, logout, onAuth } from "./firebase";

import { onSnapshot, collection, doc, getDoc, getDocs, setDoc, serverTimestamp, writeBatch, query, where , runTransaction } from "firebase/firestore";


/* === Fit font helper (for header + winners) === */
const fitFontByLen = (len) => (len <= 28 ? 15 : len <= 34 ? 14 : len <= 40 ? 13 : len <= 46 ? 12 : 11);
/* === end fit font === */

// ---------- small UI helpers ----------
function Row({ children, style }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", ...style }}>{children}</div>;
}
function Card({ children, style }) {
  return <div style={{
    background: "#121a2b", border: "1px solid #1f2a44",
    borderRadius: 16, padding: 16, boxShadow: "0 10px 24px rgba(0,0,0,.25)"
  , ...style}}>{children}</div>;
}
function Container({ children, maxWidth = 720 }) { return <div style={{ maxWidth: maxWidth, margin: "0 auto", padding: 24 }}>{children}</div>; }
function Header({ user, isAdmin, setPage }) {

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>CFB Pick'em</h1>
      <nav style={{ display: "flex", gap: 8 }}>
        <a href="#" onClick={(e)=>{e.preventDefault();

    history.pushState(null, "", "/picks"); setPage("picks");}}>Picks</a>
        <a href="#" onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/leader"); setPage("leader");}}>Leaderboard</a>
        {isAdmin && <a href="#" onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/admin"); setPage("admin");}}>Admin</a>}
        {!user && <a href="#" onClick={(e)=>{e.preventDefault(); googleLogin();}}>Admin Login</a>}
        {user && <a href="#" onClick={(e)=>{e.preventDefault(); logout();}}>Sign out</a>}
      </nav>
    </div>
  );
}
function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>{label}{children}</label>;
}
const inputStyle = { background:"#0c1426", color:"#fff", border:"1px solid #1f2a44", padding:"10px 12px", borderRadius:10 };

// Renders "#7 Team" if rank is 1..25, else just "Team"
function teamLabel(name, rank) {
  const n = Number(rank);
  return n && n > 0 && n <= 25 ? `#${n} ${name}` : name;
}

// ---------- shared helpers ----------
const norm = (s) => String(s || "")
  .normalize("NFD")               // split letters + diacritics
  .replace(/[\u0300-\u036f]/g, "")// strip diacritics (?? -> e)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");     // keep only a??"z, 0??"9

// ---------- auth/admin state ----------
function useAuthAdmin() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => onAuth(async u => {
    setUser(u || null);
    if (u) {
      const email = (u.email || "").toLowerCase();
      let isAdm = false;
      try {
        const s1 = await getDoc(doc(db, "admins", u.uid || ""));
        if (s1.exists()) isAdm = true;
      } catch (e) {}
      if (!isAdm) {
        try {
          const s2 = await getDoc(doc(db, "admins", email));
          if (s2.exists()) isAdm = true;
        } catch (e) {}
      }
      setIsAdmin(isAdm);
    } else {
      setIsAdmin(false);
    }
  }), []);
  return { user, isAdmin };
}

// ---------- Firestore helpers ----------
async function listGames({ year, week, includedOnly }) {
  const col = collection(db, "games");
  const baseQ = query(col, where("year","==", year), where("week","==", week));
  const q = includedOnly
    ? query(col, where("year","==", year), where("week","==", week), where("included","==", true))
    : baseQ;

  const snap = await getDocs(q);
  const items = [];
  snap.forEach(d => items.push({ id: d.id, ...d.data() }));

  const _etDay = new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" });
  items.sort((a,b)=>{
    const da = a.startTimeStr ? new Date(a.startTimeStr) : null;
    const db = b.startTimeStr ? new Date(b.startTimeStr) : null;
    const ka = (da && !isNaN(+da)) ? _etDay.format(da) : "9999-12-31";
    const kb = (db && !isNaN(+db)) ? _etDay.format(db) : "9999-12-31";
    if (ka !== kb) return ka.localeCompare(kb);         // day (ET)
    const oa = (a.orderDay ?? 1e9), ob = (b.orderDay ?? 1e9);
    if (oa !== ob) return oa - ob;                      // ESPN per-day
    const wa = (a.order ?? 1e9), wb = (b.order ?? 1e9);
    if (wa !== wb) return wa - wb;                      // ESPN week (fallback)
    return String(a.away||"").localeCompare(String(b.away||"")); // stable tie-break
  });
  return items;
}
async function setGameIncluded(gameId, included) {
  await setDoc(doc(db, "games", gameId), { included: !!included }, { merge: true });
}


async function setGameGameday(year, week, gameId) {
  const q = query(collection(db, "games"), where("year","==",year), where("week","==",week));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.forEach(d => {
    batch.set(d.ref, { gameday: d.id === gameId }, { merge: true });
  });
  await batch.commit();
}
async function setResult(gameId, winner, totalPoints) {
  const payload = { winner: String(winner), updatedAt: serverTimestamp() };
  if (totalPoints !== undefined && totalPoints !== null && totalPoints !== "") {
    payload.totalPoints = Number(totalPoints);
  }
  await setDoc(doc(db, "results", gameId), payload, { merge: true });
}
async function getResultsMap(gameIds) {
  const map = {};
  await Promise.all(gameIds.map(async id => {
    const s = await getDoc(doc(db, "results", id));
    if (s.exists()) map[id] = s.data();
  }));
  return map;
}

async function getWeekResultsMap(year, week, games) {
  // Prefer the weekly results doc: results/{year}_W{week}.games -> { [gameId]: result }
  try {
    const s = await getDoc(doc(db, "results", `${year}_W${week}`));
    if (!s.exists()) return null;
    const weekData = s.data() || {};
    const gamesMap = weekData.games || {};
    // Normalize team names to CFBD weekly key: "away__home"
    const normalizeKey = (name) => {
      if (!name) return "";
      let out = String(name).toLowerCase();
      out = out.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
      out = out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
      if (out === "texasam" || out === "texasa&m") out = "texasam";
      return out;
    };
    const keyFrom = (home, away) => `${normalizeKey(away)}__${normalizeKey(home)}`;

    const map = {};
    for (const g of games) {
      const home = g.home || g.homeTeam || "";
      const away = g.away || g.awayTeam || "";
      const k = keyFrom(home, away);
      const r = gamesMap[k];
      if (r) {
      // Recase winner to the exact team label when possible
      const nh = normalizeKey(home);
      const na = normalizeKey(away);
      let winner = r.winner;
      if (winner) {
        const nw = normalizeKey(String(winner));
        if (nw === "tie") { winner = null; } else if (nw === nh) winner = home;
        else if (nw === na) winner = away;
        else winner = String(winner).toUpperCase();
      }
      map[g.id] = { ...r, winner };
    }
    }
    return map;
  } catch (e) {
    console.warn("[getWeekResultsMap] failed", e);
    return null;
  }
}
function picksDocId(year, week, email) {
  return `${year}_W${week}_${(email||"").toLowerCase()}`.replace(/[^\w\-@.]+/g, "_");
}
async function getPicksForWeek(year, week) {
  const y = Number(year), w = Number(week);
  // Try numeric fields first
  let snap = await getDocs(query(collection(db, "picks"), where("year","==", y), where("week","==", w)));
  let out = [];
  snap.forEach(d => out.push(d.data()));

  // Fallback to string-typed fields (legacy/edge docs)
  if (!Array.isArray(out) || out.length === 0) {
    const snap2 = await getDocs(query(collection(db, "picks"), where("year","==", String(y)), where("week","==", String(w))));
    const out2 = [];
    snap2.forEach(d => out2.push(d.data()));
    if (out2.length) out = out2;
  }
  return out;
}// ---------- Import helpers (CFBD + ESPN with CORS fallback) ----------
const FBS_CONF = new Set([
  "ACC","American Athletic","American","Big 12","Big Ten",
  "Conference USA","CUSA","Mid-American","MAC","Mountain West","Pac-12","SEC","Sun Belt",
  "FBS Independents","Independent","Independents"
]);

async function getCfbdKey() {
  const s = await getDoc(doc(db, "config", "cfbd"));
  return s.exists() ? String(s.data().apiKey || "") : "";
}
async function setCfbdKey(apiKey) {
  await setDoc(doc(db, "config", "cfbd"), { apiKey: String(apiKey) }, { merge: true });
}

async function fetchJson(url, options) {
  try {
    const r = await fetch(url, options);
    if (!r.ok) return { ok: false, status: r.status, data: null };
    const data = await r.json();
    return { ok: true, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}

async function buildFbsNameSet(apiKey, year) {
  const add = (set, t) => {
    const fields = [t.school, t.name, t.team, t.display_name, t.abbreviation, t.alt_name1, t.alt_name2, t.alt_name3];
    for (const f of fields) { const n = norm(f); if (n) set.add(n); }
  };
  const base = "https://api.collegefootballdata.com";
  const endpoints = [
    `/teams/fbs?year=${encodeURIComponent(year)}`,
    `/teams?year=${encodeURIComponent(year)}&division=fbs`,
    `/teams?year=${encodeURIComponent(year)}&classification=fbs`
  ];
  const set = new Set();
  for (const ep of endpoints) {
    const res = await fetchJson(base + ep, { headers: { Authorization: "Bearer " + apiKey }});
    if (res.ok && Array.isArray(res.data)) {
      for (const t of res.data) add(set, t);
      if (set.size) break;
    }
  }
  return set;
}

function getRankFromCompetitor(c) {
  const r1 = c?.curatedRank?.current;
  const r2 = c?.rank;
  const r3 = c?.team?.rank;
  const candidates = [r1, r2, r3];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

function mapEspnEventsToGames(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const ev of events) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const teams = comp.competitors || [];
    const home = teams.find(t => (t.homeAway || t.home_away) === "home");
    const away = teams.find(t => (t.homeAway || t.home_away) === "away");
    const homeName = home?.team?.location || home?.team?.displayName || home?.team?.name || home?.team?.shortDisplayName || "";
const awayName = away?.team?.location || away?.team?.displayName || away?.team?.name || away?.team?.shortDisplayName || "";
    const homeAbbr = home?.team?.abbreviation || "";
    const awayAbbr = away?.team?.abbreviation || "";

    if (homeName && awayName) {
      const homeRank = getRankFromCompetitor(home);
      const awayRank = getRankFromCompetitor(away);
      out.push({
        home: homeName, away: awayName,
        homeAbbr, awayAbbr,
        homeRank, awayRank,
        startTimeStr: ev.date || ""
      });
    }
  }
  return out;
}

async function importWeek({ year, week }) {
  const debug = { sourceTried: [], cfbdGames: 0, fbsTeamNames: 0, espnDirect: 0, espnProxy: 0, includedFbs: 0, writtenTotal: 0 };
  const batch = writeBatch(db);
  const keepIds = new Set();

  // --- Try CFBD first
  const apiKey = await getCfbdKey();
  let games = [];
  if (apiKey) {
    debug.sourceTried.push("CFBD");
    const gamesUrl = `https://api.collegefootballdata.com/games?year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}&seasonType=regular`;
    const resGames = await fetchJson(gamesUrl, { headers: { Authorization: "Bearer " + apiKey }});
    if (resGames.ok && Array.isArray(resGames.data)) {
      debug.cfbdGames = resGames.data.length;
      const fbsSet = await buildFbsNameSet(apiKey, year);
      debug.fbsTeamNames = fbsSet.size;
      for (const g of resGames.data) {
        const homeN = norm(g.home_team), awayN = norm(g.away_team);
        const isFbsByTeam = fbsSet.has(homeN) || fbsSet.has(awayN);
        const isFbsByConf = FBS_CONF.has(g.home_conference || "") || FBS_CONF.has(g.away_conference || "");
        const included = isFbsByTeam || isFbsByConf;
        if (included) debug.includedFbs++;
        games.push({
          home: g.home_team || "", away: g.away_team || "",
          homeAbbr: null, awayAbbr: null,
          homeRank: null, awayRank: null,
          startTimeStr: g.start_date || "", included
        });
      }
    }
  }

  // --- If still nothing included, try ESPN (FBS only, groups=80)
  if (!games.length || games.every(g => !g.included)) {
    debug.sourceTried.push("ESPN");
    games = [];
    const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?year=${year}&week=${week}&seasontype=2&groups=80`;
    let res = await fetchJson(espnUrl);
    if (res.ok && res.data) {
      const ev = res.data.events || [];
      debug.espnDirect = ev.length;
      const mapped = mapEspnEventsToGames(ev);
      for (const m of mapped) games.push({ ...m, included: true }); // ESPN FBS only
      debug.includedFbs += mapped.length;
    } else {
      debug.sourceTried.push("ESPN(proxy)");
      const prox = `https://r.jina.ai/http://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?year=${year}&week=${week}&seasontype=2&groups=80`;
      res = await fetchJson(prox);
      if (res.ok && res.data) {
        const ev = res.data.events || [];
        debug.espnProxy = ev.length;
        const mapped = mapEspnEventsToGames(ev);
        for (const m of mapped) games.push({ ...m, included: true });
        debug.includedFbs += mapped.length;
      }
    }
  }

  // --- Merge ESPN week (FBS) to fill gaps
  await mergeEspnWeek({ year, week, games, debug, fetchJson });
// --- Write what we have (don't delete old docs unless we wrote something)
  // --- Ensure ESPN week merge + debug before write
  await mergeEspnWeek({ year, week, games, debug, fetchJson });
  console.info("[Pickems] import debug", {
    sourceTried: debug.sourceTried, cfbdGames: debug.cfbdGames,
    espnDirect: debug.espnDirect, espnProxy: debug.espnProxy,
    includedFbs: debug.includedFbs, preWriteCount: games.length
  });
  window._importDebug = { debug, games };
  // Stamp persistent ESPN order index on each game
    // Stamp ESPN order per WEEK and per DAY (ET)
  {
    const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
    const perDay = new Map(); // "YYYY-MM-DD" (ET) -> next index (1-based)
    games.forEach((g, i) => {
      g.order = i + 1; // ESPN week order
      // prefer helper-provided per-day index, else compute
      if (Number.isFinite(g._orderDay)) {
        g.orderDay = g._orderDay;
      } else {
        const d = g.startTimeStr ? new Date(g.startTimeStr) : null;
        const key = (d && !Number.isNaN(+d)) ? fmt.format(d) : "tbd";
        const next = (perDay.get(key) || 0) + 1;
        perDay.set(key, next);
        g.orderDay = next;
      }
    });
  }
  for (const g of games) {
    const id = `${year}_W${week}_${g.away}_at_${g.home}`.replace(/[^\w\-@.]+/g, "_");
    keepIds.add(id);
    batch.set(doc(db, "games", id), {
      id, year, week,
      away: g.away, home: g.home,
      awayAbbr: g.awayAbbr ?? null, homeAbbr: g.homeAbbr ?? null,
      awayRank: g.awayRank ?? null, homeRank: g.homeRank ?? null,
      included: (g.included ?? true),
      startTimeStr: g.startTimeStr ?? null,
      order: (g.order ?? g._order ?? null),
      orderDay: (g.orderDay ?? null),
    }, { merge: true });
  }
  if (games.length > 0) {
    const existingSnap = await getDocs(query(collection(db, "games"),
      where("year","==",year), where("week","==",week)));
    existingSnap.forEach(d => { if (!keepIds.has(d.id)) batch.delete(d.ref); });
  }
  await batch.commit();

  debug.writtenTotal = games.length;
  return debug;
}

// ---------- pages ----------

// ---- helpers: strip mascot from team name ----
function stripMascot(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  if (parts.length <= 2) return s;

  const keepers = new Set(["State","Tech","A&M","&","University","College","Institute"]);
  const adj = new Set(["Tar","Nittany","Fighting","Ragin'","Mean","Golden","Black","Blue","Green","Crimson","Scarlet","Red","Orange","Rainbow","War","Great","Lady"]);

  let removed = 0;
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (keepers.has(last) || /\)/.test(last)) break;
    parts.pop(); removed++;
    while (parts.length > 1 && adj.has(parts[parts.length - 1])) { parts.pop(); removed++; }
    if (removed > 0 && parts.length <= 2) break;
  }
  return parts.join(" ");
}

function teamLabelNoMascot(name, rank) { if (String(rank) === "99" || Number(rank) === 99) rank = null; 
  const base = stripMascot(name);

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return (rank ? `#${rank} ` : "") + base;
}
// ---- end helpers ----
function PicksPage({ user, isAdmin, setPage }) {
  // --- Subscribe to live week (config/live) and mirror into local state ---

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      setLive(d);
    });

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return () => unsub();


  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);
  // One-time copy of live {year,week} to local state (prevents flicker)

  const [live, setLive] = useState({ year: null, week: null });
  const initFromLiveRef = useRef(false);
  useEffect(() => {
    if (!initFromLiveRef.current && live?.year && live?.week) {
      setYear(live.year);
      setWeek(live.week);
      initFromLiveRef.current = true;
    }
  }, [live]);
  // Default Admin to live Year/Week exactly once
  const liveSyncedRef = useRef(false);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
const pot = useMemo(() => (pickCount * 5), [pickCount]);

useEffect(() => {
  (async () => {
    try {
      if (Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0) {
        const arr = await getPicksForWeek(year, week);
        setPickCount(Array.isArray(arr) ? arr.length : 0);
      } else {
        setPickCount(0);
      }
    } catch {
      setPickCount(0);
    }
  })();
}, [year, week]);
// INITIAL_LIVE_AUTOLOAD: on first mount, load games for the live week (config/live)
  useEffect(() => {
        try {
      const ref = doc(db, "config", "live");
      // Subscribe once, then auto-unsub after we apply the first live week load
      const unsub = onSnapshot(ref, async (s) => {
        const d = s.data() || {};
        const y = Number(d.year), w = Number(d.week);
        setLive({ year: y, week: w });
        if (!y || !w) { return; }

        // Keep Admin controls consistent, but the important part is we load the live week now:
        setYear(y);
        setWeek(w);

        try {
          const gs = await listGames({ year: y, week: w, includedOnly: false });
          setGames(gs);
        } catch (e) {
          console.error(e);
        } finally {
          // We only need this once on entry; further changes can be manual
          unsub();
        }
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.error(e);
    }
  }, []);
const [form, setForm] = useState({ firstName:"", lastName:"", email:"", phone:"", venmo:"", venmoConfirmed:false })
  const [errors, setErrors] = useState({});
  const [touchedSubmit, setTouchedSubmit] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [pending, setPending] = useState(null);
  const [receipt, setReceipt] = useState(null);;
  const [picks, setPicks] = useState({});
  useEffect(() => { window._picks = picks; window._setPicks = setPicks; }, [picks]);
  const [msg, setMsg] = useState("");
  // Submissions lock (config/app.picksLocked)
  const [picksLocked, setPicksLocked] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
    });
    return () => unsub && unsub();
  }, []);

// Weeks dropdown: populate from games in the selected year
const [weeksForYear, setWeeksForYear] = useState([]);
useEffect(() => {
  (async () => {
    try {
      const q = query(collection(db, "games"), where("year", "==", Number(year)));
      const snap = await getDocs(q);
      const uniq = new Set();
      snap.forEach(d => {
        const w = d.data()?.week;
        if (Number.isFinite(+w)) uniq.add(Number(w));
      });
      setWeeksForYear([...uniq].sort((a,b)=>a-b));
    } catch (err) {
      console.error("weeksForYear load failed", err);
      setWeeksForYear([]);
    }
  })();
}, [year]);const [tiebreaker, setTiebreaker] = useState({ gameId: null, total: "" });

    // Put College GameDay at the end of the list
  const gameday = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
  const displayGames = gameday ? [...games.filter(x => x && x.id !== gameday.id), gameday] : games;
  const pickGroups = useMemo(
    () => groupGamesByDate(displayGames || [], { timeZone: "America/New_York" }),
    [displayGames]
  );
  // Earliest included kickoff (for deadline label on Picks)
  const earliestGame = useMemo(() => {
    const arr = (displayGames || [])
      .map(g => ({ g, d: kickoffDate(g) }))
      .filter(x => x.d instanceof Date && !isNaN(x.d));
    arr.sort((a,b) => a.d - b.d);
    return arr[0]?.g || null;
  }, [displayGames]);
  // Mobile-only layout flag for small view tweaks
  const [isMobile, setIsMobile] = useState(() => (typeof window !== "undefined" ? window.innerWidth <= 560 : false));
  useEffect(() => {
    const onResize = () => setIsMobile(typeof window !== "undefined" ? window.innerWidth <= 560 : false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const badgeSize  = isMobile ? 40 : 72;
  const badgeTop   = isMobile ? 4  : 6;
  const badgeRight = isMobile ? 4  : 6;
const [code, setCode] = useState("");
  const [loadCode, setLoadCode] = useState("");
  const [loadLastName, setLoadLastName] = useState("");
  const [editing, setEditing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);


  const email = (user?.email || "").toLowerCase();

  const load = async () => {
    setMsg("Loading games...");
    let items; try { items = await listGames({ year, week, includedOnly: true }); } catch (e) { console.error("listGames failed:", e); setMsg("Failed to load games: " + (e?.message || e)); return; }
    setGames(items);
    window._logoGames = items; // temp: expose games for the logo audit
    setMsg(items.length ? "" : "No games yet for that week.");
    if (email) {
      const s = await getDoc(doc(db, "picks", picksDocId(year, week, email)));
      if (s.exists()) {
        const d = s.data();
        setForm({ firstName: d.firstName||"", lastName: d.lastName||"", email: (d.email || "").toLowerCase(), phone: d.phone || "", venmo: d.venmo || "" });
        setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      } else {
        setPicks({}); setTiebreaker({ gameId: null, total: "" });
      }
    }
  };

  useEffect(() => {
  if (!(Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0)) return;
  load();
  /* eslint-disable-next-line */
}, [year, week, email]);

    // --- Step 4: validation & submit gating (Pickems Coach) ---
  const validatePicks = (opts = {}) => {
    const errs = {};
    const needIncludedFlag = games.some(g => Object.prototype.hasOwnProperty.call(g, "included"));
    const requiredGames = needIncludedFlag ? games.filter(g => !!g.included) : games;

    if (!String(form.firstName || "").trim()) errs.firstName = "First name is required";
    if (!String(form.lastName  || "").trim()) errs.lastName  = "Last name is required";
    if (!String(form.phone     || "").trim()) errs.phone     = "Phone is required";
    if (!String(form.venmo     || "").trim()) errs.venmo     = "Venmo is required";
    if (!form.venmoConfirmed) errs.venmoConfirmed = "Please confirm your Venmo is correct";

    const missingGames = [];
    for (const g of requiredGames) {
      const pick = picks && picks[g.id];
      if (!(pick === g.home || pick === g.away)) missingGames.push(g);
    }
    if (missingGames.length) {
      errs.picks = missingGames.length + " game" + (missingGames.length>1?"s":"") + " not selected";
    }

    const ok = Object.keys(errs).length === 0;
    const parts = [];
    if (errs.firstName) parts.push("first name");
    if (errs.lastName) parts.push("last name");
    if (errs.phone) parts.push("phone");
    if (errs.venmo) parts.push("venmo");
    if (errs.venmoConfirmed) parts.push("venmo confirmation");
    if (missingGames.length) parts.push(missingGames.length + " game picks");
    const message = ok ? "" : (parts.join(", ") + " required.");

    if (!opts.silent && typeof setErrors === "function") setErrors(errs);

    const focus = () => {
      try {
        if (errs.firstName) { var el = document.querySelector('input[name="firstName" aria-invalid={touchedSubmit && !!errors.firstName}]'); if (el) el.focus(); return; }
        if (errs.lastName)  { var el2 = document.querySelector('input[name="lastName" aria-invalid={touchedSubmit && !!errors.lastName}]'); if (el2) el2.focus(); return; }
        if (errs.phone)     { var el3 = document.querySelector('input[name="phone" aria-invalid={touchedSubmit && !!errors.phone}]'); if (el3) el3.focus(); return; }
        if (errs.venmo)     { var el4 = document.querySelector('input[name="venmo" aria-invalid={touchedSubmit && !!errors.venmo}]'); if (el4) el4.focus(); return; }
        if (errs.venmoConfirmed) { var el5 = document.querySelector('input[aria-label="venmo"]'); if (el5) el5.focus(); return; }
        if (missingGames[0]) {
          var firstId = missingGames[0].id;
          var card = document.querySelector('[data-game-id="' + firstId + '"]');
          if (card) { try { card.scrollIntoView({behavior:"smooth", block:"center"}); } catch (e) { card.scrollIntoView(true); } }
        }
      } catch (e) {}
    };
    return { ok, errors: errs, message, missingGames, focus };
  };

  const isValid = useMemo(function(){ return validatePicks({ silent: true }).ok; }, [form, picks, games]);

    // Keep validation errors updated after a submit attempt
  useEffect(() => {
    if (touchedSubmit) {
      const r = validatePicks({ silent: true });
      if (typeof setErrors === "function") setErrors(r.errors);
    }
  }, [form, picks, games, touchedSubmit]);
const normEmail = (s) => String(s||"").trim().toLowerCase();
const normPhone = (s) => String(s||"").replace(/[^0-9]/g, "");
const normVenmo = (s) => String(s||"").trim().toLowerCase().replace(/^@+/, "");const confirmAndSubmit = async () => { if (picksLocked) { if (typeof setMsg==="function") setMsg("Submissions are locked right now."); return; }
  if (!pending) return;
  setMsg("Saving...");
  try {
    const year = pending.year;
    const week = pending.week;
    const form = pending.form;
    const picks = pending.picks;
    const code = pending.code;
    const id = year + "_W" + week + "_" + code;

        const gd = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
    const payload = {
      id, year, week, code,
      // keep your existing identity fields:
      firstName: form.firstName,
      lastName: form.lastName,
      lastNameLower: (form.lastName || "").toLowerCase().trim(),
      phone: form.phone || "",
      venmo: form.venmo || "",
      email: (form.email || "").toLowerCase(),
      venmoConfirmed: !!form.venmoConfirmed,
      // picks & timestamps:
      picks,
      updatedAt: serverTimestamp()
    };
    if (gd) {
      if (!tiebreaker || tiebreaker.total === "" || isNaN(Number(tiebreaker.total))) {
        setMsg("Enter total points for the College GameDay tiebreaker.");
        return;
      }
      payload.tiebreaker = { gameId: gd.id, total: Number(tiebreaker.total) };
    }
    try {
  await runTransaction(db, async (tx) => {
    const locks = [];
    const eKey = normEmail(form.email);
    const pKey = normPhone(form.phone);
    const vKey = normVenmo(form.venmo);
    if (eKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_email_${eKey}`), type: "email", value: eKey });
    if (pKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_phone_${pKey}`), type: "phone", value: pKey });
    if (vKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_venmo_${vKey}`), type: "venmo", value: vKey });

    // If any lock exists and points to a different submission, block
    for (const l of locks) {
      const s = await tx.get(l.ref);
      const existing = s.exists() ? s.data() : null;
      if (existing && existing.picksId !== id) {
        throw new Error("DUPLICATE_LOCK");
      }
    }

    // Create/update locks for this submission, then write the picks
    for (const l of locks) {
      tx.set(l.ref, { year, week, type: l.type, value: l.value, picksId: id, code, createdAt: serverTimestamp() }, { merge: true });
    }
    tx.set(doc(db, "picks", id), payload, { merge: true });
  });
} catch (e2) {
  const msg = String((e2 && e2.message) || e2 || "");
  if (msg === "DUPLICATE_LOCK") {
    setMsg("this email/number/venmo is already associated with a submission, if you feel this was reached in error contact zslay@live.com");
    return;
  }
  throw e2;
}// show SUCCESS in the same style box (receipt overlay)
    setReceipt({ year: year, week: week, code: code, form: form, picks: picks });
    setShowConfirm(false);     // close the review popup
    setMsg("");                // clear page toast
  } catch (e) {
    setMsg("Save failed: " + (e?.message || String(e)));
  }
};
const onSubmitPicks = function(e){ e.preventDefault(); if (picksLocked) { if (typeof setMsg==="function") setMsg("Submissions are locked right now."); return; }
    const result = validatePicks();
    if (!result.ok) { 
      if (typeof setMsg === "function") setMsg(result.message || "Please complete all required fields and picks.");
      if (result.focus) result.focus();
      return;
    }
    // Reuse 6-digit code when editing; otherwise generate
  const nextCode = (editing && typeof code === "string" && /^\d{6}$/.test(code))
    ? code
    : String(Math.floor(100000 + Math.random() * 900000));
  if (typeof setCode === "function") setCode(nextCode);

  const p = {
    year, week,
    form: { ...form, lastNameLower: (form.lastName || "").toLowerCase().trim() },
    picks,
    code: nextCode,
    editing: !!editing
  };
  try { if (typeof tiebreaker !== "undefined") { p.tiebreaker = tiebreaker; } localStorage.setItem("pending", JSON.stringify(p)); } catch (_){}
if (typeof setPage === "function") setPage("confirm");
if (typeof window !== "undefined") window.history.pushState(null, "", "/confirm");
  setMsg("");
  return; // no write here; Confirm button will write
};
const save = async (e) => {
    e.preventDefault();
    
    if (!form.firstName || !form.lastName) { setMsg("Enter first and last name."); return; }
    let nextCode = (code && /^[0-9]{6}$/.test(code)) ? code : String(Math.floor(100000 + Math.random() * 900000));
setCode(nextCode);
const id = `${year}_W${week}_${nextCode}`;
    const gd = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
    const payload = {
      id, year, week, code: nextCode,
      // keep your existing identity fields:
      firstName: form.firstName,
      lastName: form.lastName,
      lastNameLower: (form.lastName || "").toLowerCase().trim(),
      phone: form.phone || "",
      venmo: form.venmo || "",
      email: (form.email || "").toLowerCase(),
      venmoConfirmed: !!form.venmoConfirmed,
      // picks & timestamps:
      picks,
      updatedAt: serverTimestamp()
    };
    if (gd) {
      if (!tiebreaker || tiebreaker.total === "" || isNaN(Number(tiebreaker.total))) {
        setMsg("Enter total points for the College GameDay tiebreaker.");
        return;
      }
      payload.tiebreaker = { gameId: gd.id, total: Number(tiebreaker.total) };
    }
    try {
  await runTransaction(db, async (tx) => {
    const locks = [];
    const eKey = normEmail(form.email);
    const pKey = normPhone(form.phone);
    const vKey = normVenmo(form.venmo);
    if (eKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_email_${eKey}`), type: "email", value: eKey });
    if (pKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_phone_${pKey}`), type: "phone", value: pKey });
    if (vKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_venmo_${vKey}`), type: "venmo", value: vKey });

    // If any lock exists and points to a different submission, block
    for (const l of locks) {
      const s = await tx.get(l.ref);
      const existing = s.exists() ? s.data() : null;
      if (existing && existing.picksId !== id) {
        throw new Error("DUPLICATE_LOCK");
      }
    }

    // Create/update locks for this submission, then write the picks
    for (const l of locks) {
      tx.set(l.ref, { year, week, type: l.type, value: l.value, picksId: id, code, createdAt: serverTimestamp() }, { merge: true });
    }
    tx.set(doc(db, "picks", id), payload, { merge: true });
  });
} catch (e2) {
  const msg = String((e2 && e2.message) || e2 || "");
  if (msg === "DUPLICATE_LOCK") {
    setMsg("this email/number/venmo is already associated with a submission, if you feel this was reached in error contact zslay@live.com");
    return;
  }
  throw e2;
}setMsg("Saved! Your edit code is " + nextCode + ". You can update any time before kickoff.");
  };

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  return (<Container>
<Header user={user} isAdmin={isAdmin} setPage={setPage} />
      <Card style={{ background:"#121a2b" , position:"relative" }}>
        <div style={{ position:"absolute", top:8, left:8, zIndex:2 }}>
    <div style={{ fontSize:"0.95rem", fontWeight:600 }}>Current Pot</div>
    <div style={{ fontSize:"1.5rem", fontWeight:800, lineHeight:1 }}>
      ${pot.toLocaleString()} 💰
    </div>
  </div><div style={{ position:"absolute", top:8, right:8, zIndex:2 }}>
    <button onClick={()=>setShowRules(true)} type="button">Rules</button>
  </div>
<Row style={{ justifyContent: "space-between" }}>
  <div style={{ margin:"20px 0 2px", lineHeight:1.25, textAlign:"center", padding:"20px 16px", width:"100%" , position:"relative", paddingBottom:0  }}>
<div style={{ minHeight: 40 }}>
  <div style={{ fontWeight:800, fontSize:30, textDecoration:"underline", opacity:(week==null?0:1), transition:"opacity 150ms ease" }}>
    {week == null ? "" : ("Welcome to Week " + week + "!")}
  </div>
</div>
      <div style={{ marginTop:0, marginBottom:8, textAlign:"center", opacity:.85 }}>(Share with your friends!)</div>
<div style={{ opacity:.85 }}>
      Deadline to submit: {earliestGame ? kickoffLabel(earliestGame, { timeZone: "America/New_York" }) : "TBD"}
    </div>
    <div style={{ marginTop:10, display:"grid", rowGap: 0, justifyItems:"center", width:"100%", marginBottom: 0 }}>
  <div style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
    <span style={{ opacity:.85, fontStyle:"italic", fontSize:13 }}>Already submitted for this week?</span>
    <button onClick={()=>setShowLoad(v=>!v)} style={{ background:"transparent", border:"none", padding:0, height:"auto", width:"auto", fontSize:14, textDecoration:"underline", color:"inherit", cursor:"pointer" }}>Edit here</button>
  </div>
</div>
    <div style={{ marginTop:8, display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap" }}>
      </div>
  </div>
          <div style={{ display:"flex", alignItems:"baseline", gap:12 }}></div>
          
        </Row>

        {showLoad && (
  <>
    <Row style={{ marginBottom: 14, gap: 14, alignItems:"stretch" }}>
      <div style={{ fontWeight:600, flexBasis:"100%" }}>Load by code</div>

      <Field label="Code" style={{ justifyContent:"flex-end" }}>
        <input
          style={inputStyle}
          name="loadCode"
          value={loadCode}
          onChange={e=>setLoadCode(e.target.value)}
          maxLength={6}
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="123456"
        />
      </Field>

      <Field label="Last name" style={{ justifyContent:"flex-end" }}>
        <input
          style={inputStyle}
          name="loadLastName"
          value={loadLastName}
          onChange={e=>setLoadLastName(e.target.value)}
          placeholder="Smith"
        />
      </Field>

      <button
        type="button"
        onClick={loadByCode} style={{top:-14, position:"relative", alignSelf:"flex-end",  padding:"8px 10px", fontSize:12, borderRadius:8, width:72, marginLeft:8}}
      >
        Load
      </button>
    </Row>

    {editing && (
      <div style={{marginBottom:8,fontSize:13,color:"#64748b"}}>
        Editing mode ? code <b>{code}</b>
        <button
          type="button"
          style={{marginLeft:8}}
          onClick={()=>{
            setEditing(false);
            setCode("");
            setLoadCode("");
            setLoadLastName("");
            setShowLoad(false);
            setMsg("");
          }}
        >Clear</button>
      </div>
    )}
  </>
)}
<div role="status" aria-live="polite" style={{ 
  marginTop: 8, marginBottom: 10, padding: "8px 12px", borderRadius: 8, fontWeight: 600, 
  display: "flex", alignItems: "center", gap: 8,
  background: picksLocked ? "#fee2e2" : "#dcfce7",
  color: picksLocked ? "#7f1d1d" : "#14532d",
  border: "1px solid rgba(0,0,0,0.08)"
}}>
  <span style={{ 
    display:"inline-block",
    width:10, height:10, borderRadius:"9999px", 
    background: picksLocked ? "#ef4444" : "#22c55e" 
  }} />
  <span>{picksLocked ? "Submissions CLOSED" : "Submissions OPEN"}</span>
</div>
<form onSubmit={onSubmitPicks} style={{ marginTop: 12 }}>
          <Row style={{ marginBottom: 14 }}>
  <Field label="First name"><input style={inputStyle} name="firstName" value={form.firstName} onChange={e=>setForm({...form, firstName:e.target.value})} required/></Field>
  <Field label="Last name"><input style={inputStyle} name="lastName" value={form.lastName} onChange={e=>setForm({...form, lastName:e.target.value})} required/></Field>
</Row>
          <Row style={{ marginBottom: 14 }}>
            <Field label="Email">
  <input style={inputStyle} name="email" value={form.email || ""} onChange={e=>setForm({...form, email:e.target.value})} placeholder="you@example.com"/>
</Field>
            <Field label="Phone">
              <input style={inputStyle} name="phone" value={form.phone} onChange={e=>setForm({...form, phone:e.target.value})} placeholder="555-555-5555"/>
            </Field>
            <Field label="Venmo">
              <input style={inputStyle} name="venmo" value={form.venmo} onChange={e=>setForm({...form, venmo:e.target.value})} placeholder="@username"/>
            </Field>
          </Row>

          <div style={{ margintop:-4, display:"flex", flexDirection:"column", alignItems:"center" }}>
            {pickGroups.map(grp => (
              <section key={grp.key} style={{ margin: "24px 0 6px", width: "100%" }}>
                <div style={{ fontWeight:700, fontSize:16, opacity:.85, margin:"12px 0 8px" }}>{grp.header}</div>
                {grp.items.map(g => (

              <div key={g.id} data-game-id={g.id} style={{ position:"relative",  border:"1px dashed #1f2a44", padding:12, borderRadius:12, margin:"10px auto", maxWidth: 720, width:"100%", marginBottom: 0 }}>
          {g.gameday && (
  <>
    <img src="/logos/collegegameday.png" alt="College GameDay" style={{ position:"absolute", top:6, left:6, width:badgeSize, height:badgeSize, opacity:0.95, pointerEvents:"none" }} />
    <img src="/logos/collegegameday.png" alt="" aria-hidden="true" style={{ position:"absolute", top:badgeTop, right:badgeRight, width:badgeSize, height:badgeSize, opacity:0.95, pointerEvents:"none" }} />
  </>
)}
                <div style={{ order:1, flex:1 }} />
                                    <Row role="radiogroup" style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap: 16, justifyItems:"center", alignItems:"center", justifyContent:"center" }} aria-label={'Pick winner for ' + teamLabel(g.away, g.awayRank) + ' at ' + teamLabel(g.home, g.homeRank)}>
                    <label role="radio" aria-checked={(picks[g.id]===g.away)} onClick={() => setPicks({ ...picks, [g.id]: g.away })} tabIndex={0} onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setPicks({...picks, [g.id]: g.away}); }}} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, justifySelf:"end" }}>
                      <input type="radio" style={{position:"absolute",opacity:0,width:0,height:0}} name={g.id} checked={picks[g.id]===g.away} onChange={()=>setPicks({...picks, [g.id]: g.away})}/>
                      <div className="logoBox" style={{ width:96, height:96, outline: (picks[g.id]===g.away) ? "4px solid #3b82f6" : undefined, outlineOffset:2, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center" }}><TeamLogo school={g.away} size={96}/></div>
                      <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div>
                    </label><div aria-hidden="true" style={{ gridColumn:"2", alignSelf:"center", justifySelf:"center", fontWeight:800, color:"#fff", fontSize:28, lineHeight:"1", margin:"0 6px", pointerEvents:"none" }}>@</div>

                    <label role="radio" aria-checked={(picks[g.id]===g.home)} onClick={() => setPicks({ ...picks, [g.id]: g.home })} tabIndex={0} onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setPicks({...picks, [g.id]: g.home}); }}} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, justifySelf:"start" }}>
                      <input type="radio" style={{position:"absolute",opacity:0,width:0,height:0}} name={g.id} checked={picks[g.id]===g.home} onChange={()=>setPicks({...picks, [g.id]: g.home})}/>
                      <div className="logoBox" style={{ width:96, height:96, outline: (picks[g.id]===g.home) ? "4px solid #3b82f6" : undefined, outlineOffset:2, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center" }}><TeamLogo school={g.home} size={96}/></div>
                      <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>
                    </label>
                  </Row>                  {g.gameday && (
                    <div style={{ marginTop: 16, border:"1px solid #2b3a5c", borderRadius:12, padding:12, background:"#0e1524" }}>
                      <div style={{ fontWeight:700, letterSpacing:0.5, marginBottom:6 }}>College GameDay TIEBREAKER</div>
                      <label style={{ display:"block" }}>
                        {"Total Points Scored in the "}
                        <strong>{teamLabelNoMascot(g.away, g.awayRank)} @ {teamLabelNoMascot(g.home, g.homeRank)}</strong>
                        {" Game? (Whole number)"}
                        <input
                          type="number"
                          inputMode="numeric"
                          step="1"
                          min="0"
                          style={{ ...inputStyle, width:220, marginLeft:8, marginTop:8 }}
                          value={tiebreaker.total}
                          onChange={(e)=> setTiebreaker({ gameId: g.id, total: (e.target.value || "").replace(/[^\d]/g,"") })}
                        />
                      </label>
                    </div>
                  )}
              </div>
            
                ))}
              </section>
            ))}
          </div>

          <Row style={{ justifyContent: "flex-end", marginTop: 12 }}><div style={{ marginRight:"auto", display:"flex", alignItems:"center", gap:12 }}><input type="checkbox" aria-label="venmo" checked={form.venmoConfirmed} onChange={e=>setForm({...form, venmoConfirmed:e.target.checked})} /><span style={{ fontSize:12 }}>By checking this box, I confirm I have sent $5 to @ZackSlay on Venmo</span></div>
            <div style={{color:"#c0392b",fontSize:12,margin:"8px 0"}} role="alert">{touchedSubmit && !isValid && (errors.picks || "Please complete all required fields and picks.")}</div>
<button type="submit" disabled={!isValid || picksLocked}>Submit / Update Picks</button>
          <div style={{ color:'#9aa4c7', margintop:-4, fontSize:13 }}>{msg}</div>
          </Row>
        </form>
{showConfirm && pending && (
  <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999}}>
    <div style={{ background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16, padding:16, maxWidth:720, width:"90%", boxShadow:"0 10px 24px rgba(0,0,0,.35)" }}>
      <h3 style={{ marginTop:0, marginBottom:8 }}>Confirm Your Picks ? Week {pending.week}</h3>

      <div style={{ marginBottom:12 }}>
        <span style={{ fontWeight:700, marginRight:8 }}>Your edit code:</span>
        <code style={{ fontSize:18 }}>{pending.code}</code>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
        <div><div style={{ opacity:.7, fontSize:12 }}>First</div><div>{pending.form.firstName}</div></div>
        <div><div style={{ opacity:.7, fontSize:12 }}>Last</div><div>{pending.form.lastName}</div></div>
        <div><div style={{ opacity:.7, fontSize:12 }}>Email</div><div>{pending.form.email || "-"}</div></div>
        <div><div style={{ opacity:.7, fontSize:12 }}>Phone</div><div>{pending.form.phone}</div></div>
        <div><div style={{ opacity:.7, fontSize:12 }}>Venmo</div><div>{pending.form.venmo}</div></div>
        <div><div style={{ opacity:.7, fontSize:12 }}>Venmo'd @ZackSlay?</div><div>{pending.form.venmoConfirmed ? "Yes" : "No"}</div></div>
      </div>

      <div style={{ fontWeight:600, marginBottom:6 }}>Your Picks</div>
            <div style={{ display:"grid", gap:6, maxHeight:280, overflow:"auto", paddingRight:4 }}>
        {(() => {
  const tz = "America/New_York";
  const fmtDay = new Intl.DateTimeFormat("en-US",{ weekday:"long", timeZone: tz });
  const fmtTime = new Intl.DateTimeFormat("en-US",{ hour:"numeric", minute:"2-digit", hour12:true, timeZone: tz });

  // Robust GameDay detection: allow flag on the game OR a live config id match if present
  const isGameDay = (g) => {
  const id = String(g?.id ?? "");
  const liveId = String((live && (live.gameDayId ?? live.gamedayId)) ?? "");
  if (liveId) return id === liveId; // single source of truth when provided
  return g?.gameday === true || g?.isGameDay === true || g?.gameDay === true;
};

  // Local date extraction (donâ€™t depend on external helpers here)
  const dateOf = (g) => {
    try {
      let s = g?.startTimeStr ?? g?.start ?? g?.start_time ?? g?.kickoff ?? g?.date;
      if (!s) return null;
      if (typeof s === "object" && typeof s.toDate === "function") return s.toDate();
      if (typeof s === "object" && typeof s.seconds === "number") return new Date(s.seconds * 1000);
      if (typeof s === "number") return new Date(s < 1e12 ? s * 1000 : s);
      if (typeof s === "string") return new Date(s);
    } catch (_) {}
    return null;
  };

  // Label rules: non-Sat -> "<Day> Night Games"; Sat 12:00 PM -> "Noon Games"; else "<h:mm AM/PM> Kickoff"; fallback "TBD"
  const labelFor = (g) => {
    const d = dateOf(g);
    if (!d || isNaN(+d)) return "TBD";
    const weekday = fmtDay.format(d);
    if (weekday !== "Saturday") return `${weekday} Night Games`;
    const time = fmtTime.format(d);
    if (time === "12:00 PM") return "Noon Games";
    return `${time} Kickoff`;
  };

  // Build spans across ALL games; insert a standalone cell wherever GameDay appears
  const spans = [];
  let i = 0;
// Force GameDay to the end for grouping labels only (does not reorder table columns)
const seq = [
  ...games.filter(g => !(g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId))),
  ...games.filter(g =>  (g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId)))
];
while (i < seq.length) {
    const g = seq[i];
    if (g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId)) {
      spans.push({ type: "gameday", span: 1 });
      i++;
      continue;
    }
    const lbl = labelFor(g);
    let span = 1; i++;
    while (i < seq.length && !(seq[i]?.gameday || (live?.gamedayGameId && seq[i]?.id === live?.gamedayGameId)) && labelFor(seq[i]) === lbl) { span++; i++; }
    spans.push({ type: "group", label: lbl, span });
  }

  return <>
    {spans.map((sp, idx) => sp.type === "group" ? (
      <th key={"grp-"+idx}
          colSpan={sp.span}
          style={{ ...headerCell, textAlign:"center", fontSize:11, padding:"1px 4px", lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", background:"rgba(0,0,0,0.04)" }}>
        {sp.label}
      </th>
    ) : (
      <th key={"grp-gameday-"+idx}
          style={{ ...headerCell, textAlign:"center", fontSize:11, padding:"1px 4px", lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", background:"rgba(0,0,0,0.04)" }} colSpan={2}>
        College GameDay
      </th>
    ))}
  </>;
})()}
      </div><div style={{ display:"flex", justifyContent:"space-between", marginTop:16, gap:12, alignItems:"center" }}>
        <button type="button" onClick={() => setShowConfirm(false)}>Back to Edit</button>
        <div style={{ color:"#9aa4c7", fontSize:13, flex:1, textAlign:"center" }}>{msg}</div>
        <button type="button" onClick={confirmAndSubmit} disabled={!!(picksLocked)}>Confirm & Submit</button>
      </div>
    </div>
  </div>
)}

        
      {showRules && (
  <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999}}>
    <div style={{ background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16, padding:16, maxWidth:720, width:"90%", boxShadow:"0 10px 24px rgba(0,0,0,.35)" }}>
      <h3 style={{ marginTop:0, marginBottom:8 }}>Rules</h3>
      <div style={{ lineHeight: 1.6 }}>
  <h4 style={{ marginTop: 0 }}>Welcome to the 2026 Season!</h4>
  <ul style={{ paddingLeft: "1.25rem", margin: 0 }}>
    <li><strong>Weekly Picks:</strong> Each week you'll pick winners from a curated slate — marquee matchups, AP Top 25 games, all Florida FBS teams, plus a few randoms to keep it interesting.</li>
    <li><strong>Tiebreaker:</strong> Closest to the actual total combined points (over or under) wins. If still tied, the pot is split.</li>
    <li><strong>One Entry:</strong> Only one form per person per week. Need to change a pick before the deadline? Click <em>Edit here</em> and enter your code.</li>
    <li><strong>Canceled/Postponed Games:</strong> If a listed game is canceled or postponed and not completed within the scoring window, it's a <em>push</em> (no points awarded).</li>
    <li><strong>Deadline:</strong> Picks lock at <strong>kickoff of the first game</strong> on the slate.</li>
    <li><strong>Payment:</strong> Venmo <strong>$5</strong> each week to <strong>@ZackSlay</strong> (Zack Slay).</li>
    <li><strong>Payout:</strong> <strong>Winner-take-all.</strong> The highest score wins the entire pot. If there's a tie on points, the tiebreaker decides; if still tied, the pot is split.</li>
  </ul>
</div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:16 }}>
        <button type="button" onClick={()=>setShowRules(false)}>Close</button>
      </div>
    </div>
  </div>
)}{receipt && (
  <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999}}>
    <div style={{ background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16, padding:16, maxWidth:720, width:"90%", boxShadow:"0 10px 24px rgba(0,0,0,.35)" }}>
      <h3 style={{ marginTop:0, marginBottom:8 }}>Picks Submitted for Week {receipt.week}<span style={{ fontWeight:400 }}> (*SCREENSHOT THIS*)</span></h3>
      <p style={{ marginTop:0 }}>
        If you need to change or edit your picks before kickoff your code is <b>{receipt.code}</b>.
      </p>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:16 }}>
        <button type="button" onClick={()=>{ setReceipt(null); }}>Done</button>
      </div>
    </div>
  </div>
)}
</Card>
    </Container>
  );
}

// -------- LEADERBOARD (sticky first two columns, logos in headers + winners row) --------
function LeaderboardPage({ user, isAdmin, setPage }) {  // DEV: CFBD diagnostics — verify token retrieval/log (no CFBD API calls)
  useEffect(() => { if (!isAdmin) return; if (import.meta && import.meta.env && import.meta.env.DEV) {
      getCfbdKey()
        .then(k => console.debug("[cfbd:diag] token present:", !!k))
        .catch(err => console.warn("[cfbd:diag] token check error:", err?.message || err));
    }
  }, []);
  // SCOREBUG MOUNT flags
  const [showScorebug, setShowScorebug] = useState(() => { try { const v = localStorage.getItem("showScorebug"); return v ? (v === "1") : true; } catch { return true; } });
useEffect(() => { try { localStorage.setItem("showScorebug", showScorebug ? "1" : "0"); } catch {} }, [showScorebug]);
// SCOREBOARD HOOK v3 (config-driven fixture)
  // CFBD token subscriber (read-only; never logged)
  const [cfbdTok, setCfbdTok] = useState(null);
  useEffect(() => { if (!isAdmin) return; const unsub = onSnapshot(doc(db, "config", "cfbd"), (s) => {
      try {
        const d = s && typeof s.data === "function" ? s.data() : null;
        const t = d ? (d.key || d.token || d.apiKey || d.cfbdKey) : null; // support common field names
        setCfbdTok(t || null);
        if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) {
          console.debug("[scoreboard:cfbd] token loaded:", t ? "(present)" : "(missing)");
        }
      } catch {
        setCfbdTok(null);
      }
    });
    return () => unsub && unsub();
  }, []);
  const sbCfg = ((typeof appCfg !== "undefined" && appCfg && appCfg.scoreboard) || {});
  const [sbHardStopGlobal, setSbHardStopGlobal] = useState(null);
  // DEV probe: watch config/app for scoreboard.hardStop (no behavior change)
  useEffect(() => {
    try {
      const ref = doc(db, "config", "app");
      const unsub = onSnapshot(ref, (s) => {
        const d = (s && typeof s.data === "function") ? (s.data() || {}) : {};
        try { window.__APP_CFG = d; } catch {}
        const h =
          !!(d.scoreboard && (
            typeof d.scoreboard.hardStop !== "undefined" ? d.scoreboard.hardStop :
            typeof d.scoreboard.hardstop !== "undefined" ? d.scoreboard.hardstop : false
          ));
        try { setSbHardStopGlobal(h); } catch {}
        if (import.meta?.env?.DEV) console.debug("[global HS] Firestore config/app scoreboard.hardStop =", h, d);
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[global HS] probe failed:", e?.message || e);
    }
  }, []);
  const [sbHardStop, setSbHardStop] = useState(() => { try { const v = localStorage.getItem("sbHardStop"); return v === "1"; } catch { return false; } }); // ADMIN: Hard Stop (default ON; persisted)
useEffect(() => { try { localStorage.setItem("sbHardStop", sbHardStop ? "1" : "0"); } catch {} }, [sbHardStop]);
const [sbLocalFixture, setSbLocalFixture] = useState(() => {
  try { const v = localStorage.getItem("sbLocalFixture"); return v ? (v === "1") : false; } catch { return false; }
}); // ADMIN: Fixture mode (persisted)
useEffect(() => { try { localStorage.setItem("sbLocalFixture", sbLocalFixture ? "1" : "0"); } catch {} }, [sbLocalFixture]);

const hasToken = !!cfbdTok;
const cfg = sbCfg ?? {};
const cfgEmpty = !cfg || (Object.keys(cfg).length === 0 && cfg.constructor === Object);

const sbSourceRaw = (cfg?.mode === "off" ? "none" : "cfbd");
const sbSource = ((sbHardStopGlobal === null ? sbHardStop : sbHardStopGlobal) ? "none" : sbSourceRaw);
if (typeof console !== "undefined" && import.meta && import.meta.env && import.meta.env.DEV) {
    }

  // CFBD PARAMS — memoized to avoid polling effect resets
  const cfbdParams = React.useMemo(() => {
    // merge any config-provided params; keep groups:80 as default
    const base = (sbCfg && sbCfg.cfbdParams) || {};
    return { groups: 80, ...base };
  }, [JSON.stringify((sbCfg && sbCfg.cfbdParams) || {})]);

  const sbOpts = React.useMemo(() => ({
cfbdToken: cfbdTok,
token: cfbdTok,
  source: sbSource,
  fixturePath: (sbCfg && sbCfg.fixturePath) || "/dev/scoreboard-demo.json",
  intervalSec: sbCfg && sbCfg.testMode
    ? Math.max(5, Math.min(60, Number(sbCfg.testIntervalSec || 10)))
    : Math.max(60, Math.min(180, Number(sbCfg.intervalSec || 60))),
  pauseWhenHidden: true,
  cfbd: { token: cfbdTok, params: (sbCfg && sbCfg.cfbdParams) || {} }
}), [cfbdTok, sbSource, sbCfg?.fixturePath, sbCfg?.testMode, sbCfg?.testIntervalSec, sbCfg?.intervalSec, cfbdParams]);
  const sbNorm = (s) => String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/g, "");
  const { map: sbMap, lastUpdatedEt: sbUpdated, isPaused: sbPaused, refresh: sbRefresh } = useScoreboard(sbOpts);

  const [publicSbMap, setPublicSbMap] = useState(new Map());
// Everyone subscribes to a published scoreboard map for public/live viewing
useEffect(() => {
  try {
    const unsub = onSnapshot(doc(db, "config", "liveMap"), (s) => {
      try {
        const d = s?.data() || {};
        const obj = (d && d.map) ? d.map : {};
        // Convert plain object -> Map
        setPublicSbMap(new Map(Object.entries(obj || {})));
      } catch {}
    });
    return () => { try { unsub(); } catch {} };
  } catch {}
}, []);

// Admin relay: when admin is live on CFBD, publish a trimmed map for the public
useEffect(() => {
  try {
    if (isAdmin && sbSource === "cfbd" && sbMap && typeof sbMap.size === "number" && sbMap.size > 0) {
      const obj = Object.fromEntries(Array.from(sbMap.entries()));
      const json = JSON.stringify(obj);
      const now = Date.now();
      const last = lastPublishRef.current || { t: 0, h: "" };
      const changed = json !== last.h;
      const due = (now - last.t) >= 20000; // 20s min interval
      if (changed || due) {
        setDoc(doc(db, "config", "liveMap"), { map: obj, updatedAt: now }, { merge: true });
        lastPublishRef.current = { t: now, h: json };
      }
    }
  } catch {}
}, [isAdmin, sbSource, sbMap]);
  const scoreMap = sbMap;

  // Public liveMap (read-only): used when user is NOT admin
  const [publicLiveMap, setPublicLiveMap] = React.useState(null);

  React.useEffect(() => {
    if (isAdmin) return; // admins use direct CFBD map
    try {
      const ref = doc(db, "config", "liveMap");
      const unsub = onSnapshot(ref, (snap) => {
        const data = snap.data?.() ?? snap.data();
        const items = Array.isArray(data?.items) ? data.items : [];
        const m = new Map(items.map(it => [it.key ?? `${it.awayTeam}_at_${it.homeTeam}`, it]));
        setPublicLiveMap(m);
        if (import.meta?.env?.DEV) console.debug("[liveMap] received items:", items.length); try { window._liveMap = m; window._uiScoreMap = m; } catch {}
        // Expose for quick console checks
        try { window._liveMap = m; } catch {}
      });
      return () => unsub && unsub();
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[liveMap] listener failed", e);
    }
  }, [isAdmin]);

  // For future rendering swap: prefer public map when not admin
  const uiScoreMap = isAdmin ? sbMap : (publicLiveMap ?? new Map());
  try { window._uiScoreMap = uiScoreMap; } catch {}

useEffect(() => {
  try {
    window._lbDebug = window._lbDebug || {};
    window._lbDebug.liveMap = () => {
      const toKeys = (m) => (m && typeof m.size === "number" && m.size > 0) ? Array.from(m.keys()) : [];
      const out = {
        isAdmin: !!isAdmin,
        sbSource,
        sbMapSize: (sbMap && sbMap.size) || 0,
        publicLiveMapSize: (publicLiveMap && publicLiveMap.size) || 0,
        publicSbMapSize: (publicSbMap && publicSbMap.size) || 0,
        uiScoreMapSize: (uiScoreMap && uiScoreMap.size) || 0,
        sampleUiKeys: toKeys(uiScoreMap).slice(0, 5),
      };
      console.log("[lb] liveMap diag", out);
      return out;
    };
  } catch {}
}, [isAdmin, sbSource, sbMap, publicLiveMap, publicSbMap, uiScoreMap]);

  // Publish minimal, public-friendly live map for the Leaderboard
  useEffect(() => { try {
      const items = [];
      for (const [key, v] of (sbMap ? Array.from(sbMap.entries()) : [])) {
        items.push({ key, awayTeam: v?.awayTeam ?? v?.away ?? null,
          homeTeam: v?.homeTeam ?? v?.home ?? null,
          status: v?.status ?? null,
          period: Number.isFinite(+v?.period) ? +v.period : null,
          clock: typeof v?.clock === "string" ? v.clock : null,
          awayPoints: Number.isFinite(+v?.awayPoints) ? +v.awayPoints : null,
          homePoints: Number.isFinite(+v?.homePoints) ? +v.homePoints : null,
          possession: (v?.possession === "home" || v?.possession === "away") ? v.possession : null,
          startTime: v?.startTime ?? null,
        });
      }
      if (items.length > 0) {
        setDoc(doc(db, "config", "liveMap"), { items, updatedAt: serverTimestamp() }, { merge: true });
        if (import.meta?.env?.DEV) console.debug("[liveMap] published items:", items.length);
      }
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[liveMap] publish failed", e);
    }
  }, [isAdmin, sbMap]);
  // Instant fetch when ready (one-shot): as soon as source is "cfbd" and token exists
  const __sbInstantOnce = useRef(false);
  useEffect(() => {
    if (__sbInstantOnce.current) return;
    if (sbSource === "cfbd" && cfbdTok && typeof sbRefresh === "function") {
      __sbInstantOnce.current = true;
      // microtask to ensure hook is fully settled
      Promise.resolve().then(() => { try { sbRefresh(); } catch {} });
    }
  }, [sbSource, cfbdTok]);
  // Instant fetch when ready: as soon as we’re allowed to poll, fetch once so scores appear immediately
  useEffect(() => {
    try {
      if (sbSource === "cfbd" && cfbdTok) {
        if (typeof sbRefresh === "function") sbRefresh();
      }
    } catch (_) {}
  }, [sbSource, cfbdTok]);useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      setLive(d);
    });

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return () => unsub();


  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);
  // One-time copy of live {year,week} to local state (prevents flicker)

  const [live, setLive] = useState({ year: null, week: null });
  const initFromLiveRef = useRef(false);
  useEffect(() => {
    if (!initFromLiveRef.current && live?.year && live?.week) {
      setYear(live.year);
      setWeek(live.week);
      initFromLiveRef.current = true;
    }
  }, [live]);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
const pot = useMemo(() => (pickCount * 5), [pickCount]);

useEffect(() => {
  (async () => {
    try {
      if (Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0) {
        const arr = await getPicksForWeek(year, week);
        setPickCount(Array.isArray(arr) ? arr.length : 0);
      } else {
        setPickCount(0);
      }
    } catch {
      setPickCount(0);
    }
  })();
}, [year, week]);
// INITIAL_LIVE_AUTOLOAD: on first mount, load games for the live week (config/live)
  useEffect(() => {
        try {
      const ref = doc(db, "config", "live");
      // Subscribe once, then auto-unsub after we apply the first live week load
      const unsub = onSnapshot(ref, async (s) => {
        const d = s.data() || {};
        const y = Number(d.year), w = Number(d.week);
        setLive({ year: y, week: w });
        if (!y || !w) { return; }

        // Keep Admin controls consistent, but the important part is we load the live week now:
        setYear(y);
        setWeek(w);

        try {
          const gs = await listGames({ year: y, week: w, includedOnly: false });
          setGames(gs);
        } catch (e) {
          console.error(e);
        } finally {
          // We only need this once on entry; further changes can be manual
          unsub();
        }
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Put College GameDay at the end of the list (Leaderboard)
  const gameday = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
  const displayGames = gameday ? [...games.filter(x => x && x.id !== gameday.id), gameday] : games;
  const [results, setResults] = useState({});
  useAutoWinners({ isAdmin, year, week, games, resultsMap: results, liveMap: sbMap, setResultFn: setResult });
  const [players, setPlayers] = useState([]); 
  // Pickems Coach: public picks flag (read-only)
  const [lbPicksPublic, setLbPicksPublic] = useState(null);
  
  const [cfgLoaded, setCfgLoaded] = useState(false);useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s?.data?.() || {};
      setLbPicksPublic(!!d.leaderboardPicksPublic); setCfgLoaded(true);
    });
    return () => unsub();
  }, []);// [{name,email,points,picks:{gameId:choice}}]
  const [msg, setMsg] = useState("");
  // Submissions lock (config/app.picksLocked)
  const [picksLocked, setPicksLocked] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
    });
    return () => unsub && unsub();
  }, []);

// Weeks dropdown: populate from games in the selected year
const [weeksForYear, setWeeksForYear] = useState([]);
useEffect(() => {
  (async () => {
    try {
      const q = query(collection(db, "games"), where("year", "==", Number(year)));
      const snap = await getDocs(q);
      const uniq = new Set();
      snap.forEach(d => {
        const w = d.data()?.week;
        if (Number.isFinite(+w)) uniq.add(Number(w));
      });
      setWeeksForYear([...uniq].sort((a,b)=>a-b));
    } catch (err) {
      console.error("weeksForYear load failed", err);
      setWeeksForYear([]);
    }
  })();
}, [year]);const [loadCode, setLoadCode] = useState("");
  const [loadLastName, setLoadLastName] = useState("");
  const [editing, setEditing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);


  // Compact widths (tweak here as you like)
  const NAME_COL_W = 130;
  const POINTS_COL_W = 60;

  
const GAME_COL_W = 140;
const loadAll = async () => { try { console.debug("[lb] loadAll:start", { year, week }); } catch {}
  if (!(Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0)) { return; }if (!(Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0)) { return; }setMsg("Loading..."); console.debug(`[lb] start y=${year} w=${week}`);
    let g = await listGames({ year, week, includedOnly: true });
    if (!Array.isArray(g) || g.length === 0) { g = await listGames({ year, week, includedOnly: false }); }
    setGames(g);
    const ids = g.map(x => x.id);
const [rFromWeek, rFromGames] = await Promise.all([
  getWeekResultsMap(year, week, g),
  getResultsMap(ids)
]);
// Merge both result sources (both keyed by game id): per-game docs (written by
// "Set Winner" and the auto-winner hook) win over the bulk weekly snapshot
// (written by "Write Winners (CFBD)") when both exist for the same game.
const r = { ...(rFromWeek || {}), ...(rFromGames || {}) };
    setResults(r);
    let picks = [];
try {
  // Unconditional fetch for debugging; we will re-tighten after it works.
  picks = await getPicksForWeek(year, week);

  // Fallback: if zero results, try string-typed fields (some legacy docs may store year/week as strings)
  if (!Array.isArray(picks) || picks.length === 0) {
    const snap2 = await getDocs(query(collection(db, "picks"), where("year","==", String(year)), where("week","==", String(week))));
    picks = snap2.docs.map(d => d.data());
  }
} catch (e) {
  setMsg("Picks load failed: " + (e?.message || String(e)));
  picks = [];
}

    // compute points for each player
    const rows = picks.map(p => {
      let correct = 0;
      for (const id of ids) {
        const w = r[id]?.winner;
        const pick = p.picks?.[id];
        if (w && pick && w === pick) correct++;
      }
      const name = `${p.firstName||""} ${p.lastName||""}`.trim() || p.email;
      const tbVal = (p?.tiebreaker?.total ?? p?.tieBreaker ?? p?.tiebreak ?? p?.tb ?? null);
      return { name, email: p.email, points: correct, picks: p.picks || {}, tb: (tbVal === null || tbVal === "" ? null : Number(tbVal)) };
    }).sort((a,b)=> (b.points - a.points) || a.name.localeCompare(b.name));

    setPlayers(rows); console.debug(`[lb] done games=${Array.isArray(g)?g.length:0} players=${Array.isArray(rows)?rows.length:0}`); try { console.debug("[lb] loadAll:done", { games: g?.length ?? 0, players: rows?.length ?? 0 }); } catch {}
    const played = ids.filter(id => !!r[id]?.winner).length;
    setMsg(`Week ${week}  -  Included games: ${g.length}  -  Finished: ${played}`);
  };

  useEffect(() => {
  if (!(Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0)) return;
  loadAll();
  /* eslint-disable-next-line */
}, [year, week]);
// INITIAL_KICK: ensure one load after mount (handles first-open race) — with short poll until year/week are finite
useEffect(() => {
  let tries = 0;
  const t = setInterval(() => {
    if (Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0) {
      try { loadAll(); } catch (e) { console.error("init loadAll failed", e); }
      clearInterval(t);
    } else if (++tries >= 20) { // ~3 seconds max (20 * 150ms)
      clearInterval(t);
    }
  }, 150);
  return () => clearInterval(t);
  /* eslint-disable-next-line */
}, []);// Step 8.2 ? Admin lock override
  const [lbLocked, setLbLocked] = useState(null);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setLbLocked(!!d.leaderboardLocked);
    });
    return () => unsub();
  }, []);

  if (false /* mask disabled */ && Number(year) === Number(live?.year) && Number(week) === Number(live?.week)) {
      // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  return (<Container maxWidth={1200}>
        <Header user={user} isAdmin={isAdmin} setPage={setPage} />
        <Card>
          <h2 style={{ margin: 0 }}>CFB Pick'Ems Week {week}</h2>
<Field label="Previous weeks">
  <select value={(week ?? '')} onChange={e => setWeek(Number(e.target.value))} style={inputStyle}>
    {(weeksForYear.length ? weeksForYear : Array.from({ length: 20 }, (_, i) => i + 1)).map(w => (
      <option key={w} value={w}>Week {w}</option>
    ))}
  </select>
</Field>
          <div style={{ marginTop: 8, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700 }}>Leaderboard locked for Week {week}</div>
            <div>Leaderboard will be activated when the first game kicks off</div>
            <div>To submit or edit picks, visit the Picks page</div>
          </div>
        </Card>
      </Container>
    );
  }

  const sticky1 = (extra = {}) => ({
  position: "sticky",
  left: 0,
  zIndex: 5,
  background: "#0b1220",
  width: NAME_COL_W,
  minWidth: NAME_COL_W,
  borderRight: "none",
  boxShadow: "inset -1px 0 0 0 #1f2a44",
  ...extra
});
  const sticky2 = (extra = {}) => ({
  position: "sticky",
  left: NAME_COL_W,
  zIndex: 4,
  background: "#0b1220",
  width: POINTS_COL_W,
  minWidth: POINTS_COL_W,
  borderRight: "none",
  boxShadow: "inset -1px 0 0 0 #1f2a44",
  ...extra
});

  const cell = { lineHeight:"1.15", border:"1px solid #1f2a44", padding:"4px 6px", whiteSpace:"nowrap", fontSize:11 };
  const headerCell = { ...cell, textAlign:"center", paddingTop: 12, paddingBottom: 12, lineHeight: 1.25, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontSize: "clamp(10px, 0.95vw, 12px)" };


  const pickCellBase = { ...cell, textAlign:"center", width: GAME_COL_W, minWidth: GAME_COL_W, maxWidth: GAME_COL_W };
  const pickCellStyle = (gameId, choice) => { const base = { ...cell, textAlign:"center", width: 140, minWidth: 140 };
  const w = results[gameId]?.winner;
  if (!w || !choice) return base;
  if (choice === w) return { ...base, background: "#00ff00", color: "#111" };
  return { ...base, background: "#ea9999", color: "#111" };
};

  // Winner cell with tiny logo
  const winnerCell = (g) => {
    const w = results[g.id]?.winner;
    if (!w) return "";
    const isHome = w === g.home;
    const rank = isHome ? g.homeRank : g.awayRank;

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return (
      <span style={{ display:"inline-flex", flexWrap:"wrap", justifyContent:"center", alignItems:"center", width:"100%", textAlign:"center", rowGap:"0", lineHeight: 1.24, fontWeight:700, fontSize: fitFontByLen(((teamLabelNoMascot(g.away,g.awayRank)||"").length + (teamLabelNoMascot(g.home,g.homeRank)||"").length)), gap: 8 }}>
        
        <span>{teamLabel(w, rank)}</span>
      </span>
    );
  };

  const playedCount = games.filter(g => !!results[g.id]?.winner).length;

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  return (<Container maxWidth={1200}>
      <Header user={user} isAdmin={isAdmin} setPage={setPage} />
      <Card>
        <Row style={{ justifyContent:"space-between", alignItems:"flex-end" }}>
          <h2 style={{ margin: 0 }}>CFB Pick'Ems Week {week}</h2>
<Field label="Previous weeks">
  <select value={(week ?? '')} onChange={e => setWeek(Number(e.target.value))} style={inputStyle}>
    {(weeksForYear.length ? weeksForYear : Array.from({ length: 20 }, (_, i) => i + 1)).map(w => (
      <option key={w} value={w}>Week {w}</option>
    ))}
  </select>
</Field>
          

                    <div style={{ order:1, flex:1 }} /><div id="lbTopScroll" style={{  overflowX:"auto", height:10, marginBottom:0, width:"100%"  }} onMouseEnter={(e) => { const b = document.getElementById("lbGrid"); const s = document.getElementById("lbTopSpacer"); if (b && s) { const w = b.scrollWidth; if (s.style.width !== (w + "px")) s.style.width = (w + "px"); } }} onScroll={(e) => {
       const b = document.getElementById('lbGrid');
       if (b && b.scrollLeft !== e.currentTarget.scrollLeft) b.scrollLeft = e.currentTarget.scrollLeft;
     }}>
  <div id="lbTopSpacer" style={{ height:1 }} />
</div>
<div id="lbGrid" style={{ marginTop:0, overflowX:"auto", border:"1px solid #1f2a44", borderRadius:12 }}
     onScroll={(e) => {
       const t = document.getElementById('lbTopScroll');
       if (t && t.scrollLeft !== e.currentTarget.scrollLeft) t.scrollLeft = e.currentTarget.scrollLeft;
       const s = document.getElementById('lbTopSpacer');
       const w = e.currentTarget.scrollWidth;
       if (s && s.style.width !== (w + 'px')) s.style.width = w + 'px';
     }}>
{isAdmin && (
  <div className="scoreboard-admin-strip" /* SCOREBOARD ADMIN STRIP v1 */
       style={{ display:"flex", gap:12, alignItems:"center", fontSize:12, margin:"8px 0",
                padding:"6px 10px", borderRadius:8, background:"rgba(16,20,28,.6)", color:"#fff" }}>
<button
  onClick={async (e) => {
    e.preventDefault();
    try {
      const { setDoc, doc, serverTimestamp, getDoc } = await import("firebase/firestore");
      const appSnap = await getDoc(doc(db,"config","app"));
      const appData = appSnap.exists() ? appSnap.data() : {};
      let y = appData?.currentYear;
      let w = appData?.currentWeek;
      const tok = cfbdTok;
      // --- prompt override so the button respects the week you choose ---
      try {
        const defStr = (y && w) ? `${y}-W${w}` : "";
        const resp = prompt("Write Winners (CFBD) for which Year-Week? (use YYYY-W#)", defStr);
        if (!resp) return;
        const m = resp.match(/^(\d{4})\s*-\s*W\s*(\d{1,2})$/i);
        if (!m) { alert("Invalid format. Use YYYY-W# (e.g., 2025-W2)."); return; }
        y = Number(m[1]); 
        w = Number(m[2]);
      } catch {}

      if (!tok) { alert("CFBD token missing (config/cfbd)."); return; }
      if (!y || !w) { alert("currentYear/currentWeek missing (config/app)."); return; }

      const normalizeKey = (name) => {
        if (!name) return "";
        let s = String(name).toLowerCase();
        s = s.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
        s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
        if (s === "texasam" || s === "texasa&m") s = "texasam";
        return s;
      };
      const gameIdFrom = (home, away) => `${normalizeKey(away)}__${normalizeKey(home)}`;

      const qs = new URLSearchParams({ year: String(y), week: String(w), seasonType: "regular", division: "fbs" });
      const url = `https://api.collegefootballdata.com/games?${qs}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) throw new Error(`CFBD HTTP ${res.status}`);
      const arr = await res.json();

      const results = {};
      for (const g of (Array.isArray(arr) ? arr : [])) {
        const home = g.home_team ?? g.homeTeam ?? g.home ?? "";
        const away = g.away_team ?? g.awayTeam ?? g.away ?? "";
        const hp = Number.isFinite(+g.home_points) ? +g.home_points : (Number.isFinite(+g.homePoints) ? +g.homePoints : null);
        const ap = Number.isFinite(+g.away_points) ? +g.away_points : (Number.isFinite(+g.awayPoints) ? +g.awayPoints : null);
        const status = g.status ?? g.gameStatus ?? null;
        const period = typeof g.period === "number" ? g.period : null;
        let winner = null;
        if (hp != null && ap != null) {
          winner = hp > ap ? normalizeKey(home) : (ap > hp ? normalizeKey(away) : "tie");
        }
        const id = gameIdFrom(home, away);
        results[id] = {
          winner, homePoints: hp, awayPoints: ap,
          status: status || null,
          period: period ?? null, source: "cfbd",
          finalizedAt: winner ? new Date().toISOString() : null
        };
      }

      const rid = `${y}_W${w}`;
      await setDoc(doc(db, "results", rid), {
        id: rid, year: y, week: w,
        updatedAt: serverTimestamp(),
        source: "cfbd",
        games: results
      }, { merge: true });

      alert(`Winners written for week ${w}, ${y}.`);
    } catch (err) {
      console.error("[Write Winners (CFBD)] failed", err);
      alert("Write failed: " + (err?.message || err));
    }
  }}
  style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background:"transparent", color:"#fff", cursor:"pointer", marginLeft:6 }}
>
  Write Winners (CFBD)
</button> <button onClick={(e)=>{ e.preventDefault(); try { makeLiveDemoFromGames(games||[]); } catch(e){ console.error(e); } }} style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background:"transparent", color:"#fff", cursor:"pointer", marginLeft:6 }}>Make Live Demo</button>
    <span style={{opacity:.8}}>Scoreboard:</span>
    <strong>{(() => { const m = String(sbSource||"none").toLowerCase(); return m === "fixture" ? "Demo" : m === "cfbd" ? "Live" : "Off"; })()}</strong>
    <span style={{opacity:.8}}>Last updated:</span>
    <span>{sbUpdated || "—"}</span>
    <span style={{opacity:.8}}>Status:</span>
    <span>{(sbSource === "none" ? "Paused" : (sbPaused ? "Paused" : "Running"))}</span>
    <span style={{opacity:.8, marginLeft:12}}>Hard Stop:</span>
    <button
      onClick={async (e) => { e.preventDefault(); const next = !(sbHardStopGlobal ?? sbHardStop); try { await setDoc(doc(db,"config","app"), { scoreboard: { hardStop: next, mode: next ? "off" : "on" } }, { merge:true }); } catch (err) { console.error("[hardStop] update failed", err); } }}
      style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background: (sbHardStopGlobal ?? sbHardStop) ? "#B91C1C" : "#065F46", color:"#fff", fontWeight:600 }}
      title="Master kill switch for scoreboard polling"
    >
      {(sbHardStopGlobal ?? sbHardStop) ? "ON" : "OFF"}
    </button>
    <span style={{opacity:.8, marginLeft:12}}>Scorebug:</span>
    <button
      onClick={(e) => { e.preventDefault(); setShowScorebug(v => !v); }}
      style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background: showScorebug ? "#065F46" : "#B91C1C", color:"#fff", fontWeight:600 }}
      title="Toggle the scorebug row">
      {showScorebug ? "ON" : "OFF"}
    </button>
    <span style={{opacity:.8, marginLeft:12}}>Fixture:</span>
<button
  onClick={(e) => { e.preventDefault(); setSbLocalFixture(v => !v); }}
  style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background: sbLocalFixture ? "#1D4ED8" : "transparent", color:"#fff", fontWeight:600 }}
  title="Force local fixture JSON; disables CFBD calls for safe testing"
>
  {sbLocalFixture ? "ON" : "OFF"}
</button><button onClick={(e) => { e.preventDefault(); sbRefresh && sbRefresh(); }}
            style={{ marginLeft:"auto", padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.25)",
                     background:"transparent", color:"#fff", cursor:"pointer" }}>
      Refresh
    </button>
  
    
</div>
)}
          <table style={{ tableLayout:"auto", borderCollapse:"separate", borderSpacing:0, width:"max-content", minWidth:"auto" }}>
            <thead>
              <tr>
                <th style={{ ...headerCell, ...sticky1(), padding:"1px 4px", fontSize:11, lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}></th>
                <th style={{ ...headerCell, ...sticky2(), padding:"1px 4px", fontSize:11, lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}></th>
                {(() => {
  const tz = "America/New_York";
  const fmtDay = new Intl.DateTimeFormat("en-US",{ weekday:"long", timeZone: tz });
  const fmtTime = new Intl.DateTimeFormat("en-US",{ hour:"numeric", minute:"2-digit", hour12:true, timeZone: tz });

  // Robust GameDay detection: allow flag on the game OR a live config id match if present
  const isGameDay = (g) => {
  const id = String(g?.id ?? "");
  const liveId = String((live && (live.gameDayId ?? live.gamedayId)) ?? "");
  if (liveId) return id === liveId; // single source of truth when provided
  return g?.gameday === true || g?.isGameDay === true || g?.gameDay === true;
};

  // Local date extraction (donâ€™t depend on external helpers here)
  const dateOf = (g) => {
    try {
      let s = g?.startTimeStr ?? g?.start ?? g?.start_time ?? g?.kickoff ?? g?.date;
      if (!s) return null;
      if (typeof s === "object" && typeof s.toDate === "function") return s.toDate();
      if (typeof s === "object" && typeof s.seconds === "number") return new Date(s.seconds * 1000);
      if (typeof s === "number") return new Date(s < 1e12 ? s * 1000 : s);
      if (typeof s === "string") return new Date(s);
    } catch (_) {}
    return null;
  };

  // Label rules: non-Sat -> "<Day> Night Games"; Sat 12:00 PM -> "Noon Games"; else "<h:mm AM/PM> Kickoff"; fallback "TBD"
  const labelFor = (g) => {
    const d = dateOf(g);
    if (!d || isNaN(+d)) return "TBD";
    const weekday = fmtDay.format(d);
    if (weekday !== "Saturday") return `${weekday} Night Games`;
    const time = fmtTime.format(d);
    if (time === "12:00 PM") return "Noon Games";
    return `${time} Kickoff`;
  };

  // Build spans across ALL games; insert a standalone cell wherever GameDay appears
  const spans = [];
  let i = 0;
// Force GameDay to the end for grouping labels only (does not reorder table columns)
const seq = [
  ...games.filter(g => !(g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId))),
  ...games.filter(g =>  (g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId)))
];
while (i < seq.length) {
    const g = seq[i];
    if (g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId)) {
      spans.push({ type: "gameday", span: 1 });
      i++;
      continue;
    }
    const lbl = labelFor(g);
    let span = 1; i++;
    while (i < seq.length && !(seq[i]?.gameday || (live?.gamedayGameId && seq[i]?.id === live?.gamedayGameId)) && labelFor(seq[i]) === lbl) { span++; i++; }
    spans.push({ type: "group", label: lbl, span });
  }

  return <>
    {spans.map((sp, idx) => sp.type === "group" ? (
      <th key={"grp-"+idx}
          colSpan={sp.span}
          style={{ ...headerCell, textAlign:"center", fontSize:11, padding:"1px 4px", lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", background:"rgba(0,0,0,0.04)" }}>
        {sp.label}
      </th>
    ) : (
      <th key={"grp-gameday-"+idx}
          style={{ ...headerCell, textAlign:"center", fontSize:11, padding:"1px 4px", lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", background:"rgba(0,0,0,0.04)" }} colSpan={2}>
        College GameDay
      </th>
    ))}
  </>;
})()}
              </tr>
              <tr>
                <th style={{ ...headerCell, ...sticky1() }}></th>
                <th style={{ ...headerCell, ...sticky2() }}></th>
                {displayGames.map(g => (

                  <th key={g.id} data-game-id={g.id} style={{ ...headerCell, textAlign: "center" }}><div style={{ display:"block", width:"100%", textAlign:"center", lineHeight: 1.24 }}>
  <div style={{
    whiteSpace:"nowrap",
    fontWeight:700,
    fontSize: fitFontByLen(Math.max(((teamLabelNoMascot(g.away,g.awayRank)||"").length + 2), (teamLabelNoMascot(g.home,g.homeRank)||"").length))
  }}>
    {teamLabelNoMascot(g.away,g.awayRank)} <span aria-hidden="true" style={{ color:"#fff", padding: 0, margin: "0 0 0 2px" }}>@</span>
  </div>
  <div style={{
    whiteSpace:"nowrap",
    fontWeight:700,
    fontSize: fitFontByLen(Math.max(((teamLabelNoMascot(g.away,g.awayRank)||"").length + 2), (teamLabelNoMascot(g.home,g.homeRank)||"").length))
  }}>
    {teamLabelNoMascot(g.home,g.homeRank)}
  </div>
</div></th>
                
                ))}{gameday ? (<th key="tb" style={{ ...headerCell, textAlign:"center" }}><div style={{ display:"block", width:"100%", textAlign:"center", lineHeight: 1.24 }}>
  <div style={{ whiteSpace:"nowrap" }}>College GameDay</div>
  <div style={{ whiteSpace:"nowrap" }}>Tiebreaker</div>
</div></th>) : null}
              </tr>
{showScorebug && (
  <tr className="scorebug-row"> {/* SCOREBUG ROW v1 (disabled by flag) */}
    <td style={{ ...cell, ...sticky1() }}>
  <div style={{ fontSize:"0.95rem", fontWeight:600 }}>
    This Week&apos;s Pot:
  </div>
  <div style={{ fontSize:"1.5rem", fontWeight:800, lineHeight:1 }}>
    ${pot.toLocaleString()} 💰</div>
</td>
    <td style={{ ...cell, ...sticky2({ textAlign: "center", fontWeight: 600 }) }} />
    {displayGames.map(g => (
      <td key={"sb-" + g.id} style={{ ...cell, textAlign: "center" }}>
        <Scorebug
            awayId={g.away}
            homeId={g.home}
            kickoffLabel={kickoffLabel(g, { timeZone: "America/New_York" })}
            live={(() => {
              // winners map for this week (already loaded into `results`)
              const r = results?.[g?.id] || null;
              const fromWinners = r ? {
                status: r.status || (r.winner ? "final" : null),
                period: (typeof r.period === "number" ? r.period : (r.status === "final" ? 4 : null)),
                clock: null,
                homePoints: (typeof r.homePoints === "number" ? r.homePoints : null),
                awayPoints: (typeof r.awayPoints === "number" ? r.awayPoints : null),
                possession: null
              } : null;

              // If this is NOT the current live week, always show winners (finals) for past weeks
              const isCurrent = Number(year) === Number(live?.year) && Number(week) === Number(live?.week);
              if (!isCurrent) return fromWinners;

              // For the current week, prefer live scoreboard; fallback to winners if missing/final only
              const norm = (s) => {
                if (!s) return "";
                let t = String(s).toLowerCase();
                t = t.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
                t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ");
                const squish = t.replace(/\s+/g,"");
                return squish;
              };
              const awayKey = norm(g?.away);
const homeKey = norm(g?.home);
const key = awayKey + "__" + homeKey;
// Prefer CFBD map when active; otherwise use the published public map
const uiMap = (() => {
  try {
    if (sbMap && typeof sbMap.size === "number" && sbMap.size > 0) return sbMap;
  } catch {}
  try {
    if (publicLiveMap && typeof publicLiveMap.size === "number" && publicLiveMap.size > 0) return publicLiveMap;
  } catch {}
  try {
    if (publicSbMap && typeof publicSbMap.size === "number" && publicSbMap.size > 0) return publicSbMap;
  } catch {}
  return new Map();
})();
let liveItem = (uiMap && uiMap.get) ? uiMap.get(key) : null;
if (!liveItem && uiMap && uiMap.size) {
  try {
    // Fallback: find any key that contains both normalized tokens (covers school-only vs mascot)
    const keys = Array.from(uiMap.keys());
    const guess = keys.find(k => k.indexOf(awayKey) !== -1 && k.indexOf(homeKey) !== -1);
    if (guess) liveItem = uiMap.get(guess);
  } catch {}
}
return liveItem || fromWinners;
            })()}
          />
      </td>
    ))}
  </tr>
)}
              <tr>
                <td style={{ ...cell, ...sticky1({ fontStyle:"italic" }) }}></td>
                <td style={{ ...cell, ...sticky2({ textAlign:"center", fontWeight:600 }) }}>{playedCount}</td>
                {displayGames.map(g => (

                  <td key={g.id} data-game-id={g.id} style={{ ...winnerCellStyleFn(results, cell, g), width: 140, minwidth: 140, fontStyle:"italic", fontSize: fitFontByLen(String(results[g.id]?.winner||"").length) }}>{winnerCell(g)}</td>
                
                ))}{gameday ? (<td key="tb_win" style={{ ...cell, textAlign:"center", fontStyle:"italic", width: 140, minwidth: 140 }}></td>) : null}
              </tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr key={p.id || p.code || p.email || p.name}>
                  <td style={{ ...cell, ...sticky1() }}>{p.name}</td>
                  <td style={{ ...cell, ...sticky2({ textAlign:"center", fontWeight:700 }) }}>{p.points}</td>
                  {displayGames.map(g => {
                    const choice = p.picks?.[g.id];
                    const label =
                      choice === g.home ? teamLabel(g.home, g.homeRank) :
                      choice === g.away ? teamLabel(g.away, g.awayRank) :
                      (choice || "-");

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return (
                      <td key={g.id} data-game-id={g.id} style={{ ...pickCellStyle(g.id, choice), width: 140, minwidth: 140 }}><div style={{display:"flex",justifyContent:"center"}}>{label}</div></td>
                    );
                  })}
                {gameday ? (
  <td key={"tb_"+(p.email||p.name||p.code||p.id)}
      style={{ ...cell, textAlign:"center", width: 140, minwidth: 140 }}>
    {(p.tb ?? (p.tiebreaker?.total ?? p.tiebreaker ?? p.tieBreaker ?? p.tiebreak ?? p.tb ?? ""))}
  </td>
) : null}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Row>
      
</Card>
    </Container>
  );
}

/** kickoff helpers (ignore start_time_tbd if we have a real datetime) */
const kickoffDate = (g) => {
  if (!g) return null;
  // consider many possible fields
  const cand = [
    g.kickoff, g.start, g.startTime, g.start_time,
    g.startDate, g.start_date, g.date, g.startTimeStr
  ].find(v => v != null);

  let d = null;
  try {
    const s = cand;
    if (!s) return null;

    if (typeof s === "object") {
      if (typeof s.toDate === "function") {
        d = s.toDate();                           // Firestore Timestamp
      } else if (typeof s.seconds === "number") {
        d = new Date(s.seconds * 1000);           // {seconds, nanoseconds}
      }
    } else if (typeof s === "number") {
      d = new Date(s < 1e12 ? s * 1000 : s);      // seconds or ms
    } else if (typeof s === "string") {
      const trimmed = s.trim();
      // Support "YYYY-MM-DD HH:MM" by normalizing to ISO
      if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(trimmed)) {
        d = new Date(trimmed.replace(" ", "T") + (g.tz || g.timezone || "Z"));
      } else {
        d = new Date(trimmed);                    // ISO or RFC string
      }
    }

    if (!d && g.date && g.time) {
      d = new Date(g.date + "T" + g.time + (g.tz || g.timezone || "Z"));
    }
  } catch (_) {}

  return d && isFinite(d.getTime()) ? d : null;
};

const kickoffLabel = (g, opts = {}) => {
  const d = kickoffDate(g);
  if (!d) return "TBD";
  const tz =
    (opts && opts.timeZone) ||
    (Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "America/New_York";
  try {
    // Use explicit fields (widely supported) + weekday at the start.
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz
    }).format(d);
  } catch (_e) {
    // Fallbacks if some options are not supported
    try {
      return d.toLocaleString("en-US", { weekday: "short" });
    } catch {
      return d.toString();
    }
  }
};

const isKickoffTbd = (g) => !kickoffDate(g);function AdminPage({ user, isAdmin, setPage }) {
  const [live, setLive] = useState({ year: null, week: null });
  // --- Subscribe to live week (config/live) for display ---

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => { const d = s.data() || {}; setLive(d); });

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return () => unsub();


  }, []);
  const [year, setYear] = useState(null);
  const [week, setWeek] = useState(null);
  // Mirror config/live into Admin controls (defaults to live week)
  useEffect(() => {
    if (live && live.year) setYear(Number(live.year));
    if (live && live.week) setWeek(Number(live.week));
  }, [live]);
  // [removed duplicate auto-load ï¿½ keep only seq-safe loader]

  // Mirror live {year,week} into Admin controls (default to live week)
  useEffect(() => {
    if (live && live.year) setYear(Number(live.year));
    if (live && live.week) setWeek(Number(live.week));
  }, [live.year, live.week]);  
  // One-time sync from config/live ? Admin year/week
  const [syncedFromLive, setSyncedFromLive] = useState(false);  
  
  // Primitive derivations so effects re-run reliably when live changes
  const liveYear = (live && Number(live.year)) || null;
  const liveWeek = (live && Number(live.week)) || null;
// Default Admin to live Year/Week exactly once when config/live arrives
  useEffect(() => {
    try {
      if (!syncedFromLive && live && Number(live.year) && Number(live.week)) {
        setYear(Number(live.year));
        setWeek(Number(live.week));
        setSyncedFromLive(true); setMsg("Synced to live " + liveYear + "/W" + liveWeek + "."); }
    } catch (e) { /* no-op */ }
  }, [liveYear, liveWeek, syncedFromLive]);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
const pot = useMemo(() => (pickCount * 5), [pickCount]);

useEffect(() => {
  (async () => {
    try {
      if (Number.isFinite(Number(year)) && Number.isFinite(Number(week)) && Number(week) > 0) {
        const arr = await getPicksForWeek(year, week);
        setPickCount(Array.isArray(arr) ? arr.length : 0);
      } else {
        setPickCount(0);
      }
    } catch {
      setPickCount(0);
    }
  })();
}, [year, week]);
// [removed ADMIN_LIVE_ONLY_LOAD ï¿½ prevent duplicate loads]
  // CONVERGE_ADMIN_GRID_TO_LIVE: if grid's week != live week, fetch and show live week
  const liveY = live && Number(live.year) || 0;
  const liveW = live && Number(live.week) || 0;

  const gridWeek = useMemo(() => {
    if (!games || !games.length) return 0;
    const w = games.find(g => g && g.week)?.week;
    return Number(w) || 0;
  }, [games]);

  // Sequence guard so stale loads cannot overwrite newer ones
  const __adminSeq = useRef(0);

  useEffect(() => {
    if (!isAdmin) return;
    if (!liveY || !liveW) return;

    // If what we're showing isn't the live week, pull the live week now.
    if (gridWeek !== liveW) {
      const seq = ++__adminSeq.current;
      (async () => {
        try {
          const gs = await listGames({ year: liveY, week: liveW, includedOnly: false });
          if (__adminSeq.current === seq) setGames(gs);
        } catch (e) { console.error(e); }
      })();
    }
  }, [isAdmin, liveY, liveW, gridWeek]);

  // AUTOLOAD_FROM_LIVE: always load the live week's games (config/live) regardless of controls
  useEffect(() => {
    const y = live && Number(live.year);
    const w = live && Number(live.week);
    if (!isAdmin || !y || !w) return;
    let cancelled = false;
    (async () => {
      try {
        const gs = await listGames({ year: y, week: w, includedOnly: false });
        if (!cancelled) setGames(gs);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, live && live.year, live && live.week]);

  // INITIAL_LIVE_AUTOLOAD: on first mount, load games for the live week (config/live)
  useEffect(() => {
        try {
      const ref = doc(db, "config", "live");
      // Subscribe once, then auto-unsub after we apply the first live week load
      const unsub = onSnapshot(ref, async (s) => {
        const d = s.data() || {};
        const y = Number(d.year), w = Number(d.week);
        setLive({ year: y, week: w });
        if (!y || !w) { return; }

        // Keep Admin controls consistent, but the important part is we load the live week now:
        setYear(y);
        setWeek(w);

        try {
          const gs = await listGames({ year: y, week: w, includedOnly: false });
          setGames(gs);
        } catch (e) {
          console.error(e);
        } finally {
          // We only need this once on entry; further changes can be manual
          unsub();
        }
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.error(e);
    }
  }, []);
  const _liveSeq = useRef(0);
  // LIVE_SUB_LOAD_ADMIN: subscribe to config/live and always load live week's games
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      const y = Number(d.year), w = Number(d.week);
      setLive({ year: y, week: w });
      if (!y || !w) return;

      // keep controls consistent (even if you ignore them)
      setYear(y);
      setWeek(w);

      // race-proof fetch: only apply the latest live result
      const seq = ++_liveSeq.current;
      (async () => {
        try {
          const gs = await listGames({ year: y, week: w, includedOnly: false });
          if (_liveSeq.current === seq) setGames(gs);
        } catch (e) {
          console.error(e);
        }
      })();
    });
    return () => unsub();
  }, []);


  // sequence guard for autoload
  const _autoSeq = useRef(0);  // helper: race-proof fetch for selected week
  async function _autoLoadGames(y, w) {
    const seq = ++_autoSeq.current;
    try {
      const gs = await listGames({ year: Number(y), week: Number(w), includedOnly: false });
      if (seq !== _autoSeq.current) { return; } // stale result; ignore
      setGames(gs);
    } catch (e) {
      console.error(e);
    }
  }  // AUTOLOAD_ADMIN_FIX: load games when (isAdmin, year, week) change
  useEffect(() => {
    if (!isAdmin) return;
    const y = Number(year), w = Number(week);
    if (!y || !w) return;
    _autoLoadGames(y, w);
  }, [isAdmin, year, week]);

  // AUTOLOAD_ADMIN_WEEK: load games whenever (isAdmin, year, week) change
  useEffect(() => {
    if (typeof isAdmin !== "undefined" && !isAdmin) return;
    const y = Number(year);
    const w = Number(week);
    if (!y || !w) return;
    let cancelled = false;
    (async () => {
      try {
        const gs = await listGames({ year: y, week: w, includedOnly: false });
        if (!cancelled) setGames(gs);
      } catch (e) { console.error(e); }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, year, week]);

  // AUTOLOAD: Admin load games on year/week change
  useEffect(() => {
    if (typeof isAdmin !== "undefined" && !isAdmin) return;
    const y = Number(year);
    const w = Number(week);
    if (!y || !w) return;
    let cancelled = false;
    (async () => {
      try {
        const gs = await listGames({ year: y, week: w, includedOnly: false });
        if (!cancelled) setGames(gs);
      } catch (e) {
        console.error(e);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, year, week]);

const [msg, setMsg] = useState("");
  // Submissions lock (config/app.picksLocked)
  const [picksLocked, setPicksLocked] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
    });
    return () => unsub && unsub();
  }, []);

// Weeks dropdown: populate from games in the selected year
const [weeksForYear, setWeeksForYear] = useState([]);
useEffect(() => {
  (async () => {
    try {
      const q = query(collection(db, "games"), where("year", "==", Number(year)));
      const snap = await getDocs(q);
      const uniq = new Set();
      snap.forEach(d => {
        const w = d.data()?.week;
        if (Number.isFinite(+w)) uniq.add(Number(w));
      });
      setWeeksForYear([...uniq].sort((a,b)=>a-b));
    } catch (err) {
      console.error("weeksForYear load failed", err);
      setWeeksForYear([]);
    }
  })();
}, [year]);const [loadCode, setLoadCode] = useState("");
  const [loadLastName, setLoadLastName] = useState("");
  const [editing, setEditing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);

  const [apiKey, setApiKey] = useState("");

// One-time default: pull live {year,week} once on mount (no ongoing subscription),
// so Admin can freely change the controls without snapping back.
useEffect(() => {
  if (!isAdmin) return;
  (async () => {
    try {
      const s = await getDoc(doc(db, "config", "live"));
      const d = s.exists() ? s.data() : {};
      const y = Number(d.year), w = Number(d.week);
      setLive({ year: y, week: w });
      if (y && w) {
        setYear(y);
        setWeek(w);
      }
    } catch (e) {
      console.error(e);
    }
  })();
  // no subscription here; we only seed the defaults once
}, [isAdmin]);// One-time init to avoid flicker: prefer live {year,week} if available, else fallback
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    const hasLive = live && Number.isInteger(live.year) && Number.isInteger(live.week);
    const y = hasLive ? live.year : new Date().getFullYear();
    const w = hasLive ? live.week : 1;
    setYear(y);
    setWeek(w);
    initRef.current = true;
  }, [live]);
  // Initialize year/week from live exactly once to avoid flicker

  const initFromLiveRef = useRef(false);
  useEffect(() => {
    if (!initFromLiveRef.current && live?.year && live?.week) {
      setYear(live.year);
      setWeek(live.week);
      initFromLiveRef.current = true;
    }
  }, [live]);  
  // Step 8.2 ? Admin toggle for Leaderboard lock (writes config/app.leaderboardLocked)
  const [appCfg, setAppCfg] = useState({ leaderboardLocked: false, leaderboardPicksPublic: false, picksLocked: false });

// SCOREBOARD config subscriber v1 (read-only; safe defaults; no UI impact)
useEffect(() => {
  const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
    const d = s.data?.() ? s.data() : (s.data || (()=>({})))(); console.debug("[config/app] raw", d); // support both function & direct for safety
    const defSb = {
      mode: "off",
      intervalSec: 60,
      window: { startET: "12:00", endET: "02:00" },
      testMode: false,
      testIntervalSec: 10,
      nowEtOverride: null,
      testSource: "fixture",
      fixturePath: "/dev/scoreboard-demo.json",
      autoWriteWinners: true,
      writeGuardConfirm: true
    };
    const sb = { ...defSb, ...(d && d.scoreboard ? d.scoreboard : {}) };
    // merge into existing appCfg without disturbing other fields
    setAppCfg((prev) => ({ ...prev, scoreboard: sb }));
    if (import.meta && import.meta.env && import.meta.env.DEV) { console.debug("[scoreboard:config] loaded", sb); }
  });
  return () => unsub && unsub();
}, []);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setAppCfg(prev => ({ ...prev, leaderboardLocked: !!d.leaderboardLocked, leaderboardPicksPublic: !!d.leaderboardPicksPublic, picksLocked: !!d.picksLocked }));
    });
    return () => unsub();
  }, []);
  const toggleLeaderboardLock = async () => {
    try {
      await setDoc(doc(db, "config", "app"), { leaderboardLocked: !appCfg.leaderboardLocked, updatedAt: serverTimestamp() }, { merge: true });
      setMsg("Saved leaderboard setting.");
    } catch (e) {
      setMsg("Failed to save: " + (e?.message || String(e)));
    }
  };

  const toggleLeaderboardPicks = async () => {
    try {
      await setDoc(
        doc(db, "config", "app"),
        { leaderboardPicksPublic: !appCfg.leaderboardPicksPublic, updatedAt: serverTimestamp() },
        { merge: true }
      );
      setMsg("Saved picks visibility.");
    } catch (e) {
      setMsg("Failed to save: " + (e?.message || String(e)));
    }
  };


  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      setApiKey(await getCfbdKey());
      setGames(await listGames({ year, week, includedOnly: false }));
    })();
  }, [isAdmin, year, week]);

  if (!user) return <Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>Please sign in with Google.</p></Card></Container>;
  if (!isAdmin) return <Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>This account is not an admin.</p></Card></Container>;

  const saveKey = async () => {
    await setCfbdKey(apiKey);
    setMsg("Saved CFBD key.");
  };
  const doImport = async () => {
    setMsg("Importing...");
    try {
      const d = await importWeek({ year, week });
      const all = await listGames({ year, week, includedOnly: false });
      const includedDb = all.filter(x => x.included).length;

      setMsg(
        `Imported ${d.writtenTotal} game(s). Included (FBS): ${includedDb}. ` +
        `[debug: tried=${d.sourceTried.join("??'") || "none"}, cfbdWeek=${d.cfbdGames}, fbsNames=${d.fbsTeamNames}, espnDirect=${d.espnDirect}, espnProxy=${d.espnProxy}]`
      );
      setGames(all);
    } catch (e) {
      setMsg(e.message || String(e));
    }
  };
  const toggle = async (g, v) => {
    await setGameIncluded(g.id, v);
    setGames(await listGames({ year, week, includedOnly: false }));
  };
  const chooseWinner = async (g) => {
  // Force an exact winner string that will match picks/leaderboard comparisons
  const choice = window.prompt(
    `Set winner:
HOME: ${g.home}
AWAY: ${g.away}

Type "home" or "away".`,
    "home"
  );
  if (!choice) return;
  const val = String(choice).trim().toLowerCase();
  let w = null;
  if (val === "home" || val === g.home.toLowerCase()) w = g.home;
  else if (val === "away" || val === g.away.toLowerCase()) w = g.away;
  else { setMsg('Cancelled: type "home" or "away" (or the full team name).'); return; }
  await setResult(g.id, w);
  setMsg("Saved result. Refresh Leaderboard to update.");
};

  // Deselect all included games (batch)
  const deselectAll = async () => {
    const selected = games.filter(x => x.included);
    if (selected.length === 0) { setMsg("No games are selected."); return; }
    if (!window.confirm(`Deselect all ${selected.length} game(s)?`)) return;
    const batch = writeBatch(db);
    for (const g of selected) {
      batch.update(doc(db, "games", g.id), { included: false, updatedAt: serverTimestamp() });
    }
    await batch.commit();
    setGames(await listGames({ year, week, includedOnly: false }));
  };

  // ---------- Dummy Week helpers ----------
  const createDummyWeek = async () => {
    setMsg("Creating dummy week...");
    const Y = 2099, W = 1;
    const batch = writeBatch(db);

    const dummyGames = [
  { away:"Notre Dame",      awayRank:9,  home:"Texas A&M",     homeRank:6,  startTimeStr:"2099-08-26T23:00:00Z" },
  { away:"Miami",           awayRank:24, home:"Florida",       homeRank:17, startTimeStr:"2099-08-31T23:00:00Z" },
  { away:"Clemson",         awayRank:18, home:"Georgia",       homeRank:7,  startTimeStr:"2099-09-01T00:00:00Z" },
  { away:"Boise State",     awayRank:null,home:"Oregon",       homeRank:12, startTimeStr:"2099-09-01T00:30:00Z" },
  { away:"Texas",           awayRank:5,  home:"Michigan",      homeRank:3,  startTimeStr:"2099-09-01T01:00:00Z" },
  { away:"Florida State",   awayRank:11, home:"LSU",           homeRank:10, startTimeStr:"2099-09-01T01:30:00Z" },

  { away:"Alabama",         awayRank:2,  home:"Oklahoma",      homeRank:14, startTimeStr:"2099-09-01T02:00:00Z" },
  { away:"USC",             awayRank:20, home:"Washington",    homeRank:8,  startTimeStr:"2099-09-01T02:30:00Z" },
  { away:"Penn State",      awayRank:13, home:"Ohio State",    homeRank:4,  startTimeStr:"2099-09-01T03:00:00Z" },
  { away:"Tennessee",       awayRank:15, home:"North Carolina",homeRank:19, startTimeStr:"2099-09-01T03:30:00Z" },

  { away:"Utah",            awayRank:16, home:"TCU",           homeRank:21, startTimeStr:"2099-09-01T04:00:00Z" },
  { away:"Nebraska",        awayRank:null,home:"Iowa",         homeRank:25, startTimeStr:"2099-09-01T04:30:00Z" },
  { away:"Wisconsin",       awayRank:null,home:"Minnesota",    homeRank:null,startTimeStr:"2099-09-01T05:00:00Z" },
  { away:"Ole Miss",        awayRank:22, home:"Auburn",        homeRank:null,startTimeStr:"2099-09-01T05:30:00Z" },

  { away:"Kansas State",    awayRank:23, home:"Kansas",        homeRank:null,startTimeStr:"2099-09-01T06:00:00Z" },
  { away:"UCF",             awayRank:null,home:"West Virginia",homeRank:null,startTimeStr:"2099-09-01T06:30:00Z" },
  { away:"Duke",            awayRank:null,home:"NC State",     homeRank:null,startTimeStr:"2099-09-01T07:00:00Z" },
  { away:"Arizona",         awayRank:null,home:"Arizona State",homeRank:null,startTimeStr:"2099-09-01T07:30:00Z" },
  { away:"BYU",             awayRank:null,home:"Utah State",   homeRank:null,startTimeStr:"2099-09-01T08:00:00Z" },
  { away:"Army",            awayRank:null,home:"Navy",         homeRank:null,startTimeStr:"2099-09-01T08:30:00Z" }
];

    const keepIds = new Set();
    const ids = [];
    for (const g of dummyGames) {
      const id = `${Y}_W${W}_${g.away}_at_${g.home}`.replace(/[^\w\-@.]+/g, "_");
      keepIds.add(id); ids.push({ id, g });
      batch.set(doc(db, "games", id), {
        id, year: Y, week: W,
        away: g.away, home: g.home,
        awayAbbr: null, homeAbbr: null,
        awayRank: g.awayRank ?? null, homeRank: g.homeRank ?? null,
      included: (g.included ?? true),
      startTimeStr: g.startTimeStr ?? null,
      order: (g.order ?? g._order ?? null),
      orderDay: (g.orderDay ?? null),
      }, { merge: true });
    }

    const existing = await getDocs(query(collection(db, "games"), where("year","==",Y), where("week","==",W)));
    existing.forEach(d => { if (!keepIds.has(d.id)) batch.delete(d.ref); });

    const winnersById = {};
    winnersById[ids[0].id] = ids[0].g.home; // Texas A&M
    winnersById[ids[1].id] = ids[1].g.home; // Florida
    winnersById[ids[2].id] = ids[2].g.home; // Georgia

    for (const { id } of ids) {
      const w = winnersById[id];
      if (w) batch.set(doc(db, "results", id), { winner: w, updatedAt: serverTimestamp() }, { merge: true });
    }

    await batch.commit();

    // Seed picks
    let seeded = 0;
    const samples = (() => {
  const names = [
    "Alex Smith","Jordan Lee","Taylor Kim","Casey Nguyen","Morgan Patel","Riley Johnson","Cameron Brooks",
    "Avery Martinez","Quinn Davis","Harper Wilson","Jamie Clark","Parker Lewis","Emery Thompson","Drew Rivera",
    "Kendall Wright","Rowan Hall","Reese Young","Sawyer King","Skyler Scott","Charlie Green","Elliot Adams",
    "Sasha Baker","Devon Carter","Shawn Perez","Blake Turner","Leslie Torres","Hayden Flores","Sidney Howard",
    "Micah Ward","Noel Butler","Angel Price","Jules Stewart","Phoenix Bell","River Cooper","Sloan Reed"
  ];
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const parts = names[i].split(" ");
    const firstName = parts[0];
    const lastName  = parts.slice(1).join(" ") || "";
    const email = (firstName.toLowerCase() + "." + (lastName.toLowerCase().replace(/\s+/g,"")) + "@example.com");
    const picks = {};
    ids.forEach(({ id, g }, j) => {
      // Simple variety: some users slightly favor home teams, others away; alternates by game index.
      const bias = (i % 5);              // 0..4
      const favorHome = (bias === 0 || bias === 3);
      const pick = ((j + (favorHome ? 1 : 0)) % 2 === 0) ? g.away : g.home;
      picks[id] = pick;
    });
    out.push({ firstName, lastName, email, picks });
  }
  return out;
})();
    if (user?.email) {
      samples.push({
        firstName: (user.displayName || user.email).split(" ")[0] || "You",
        lastName: "",
        email: user.email,
        picks: {
          [ids[0].id]: ids[0].g.home,
          [ids[1].id]: ids[1].g.home,
          [ids[2].id]: ids[2].g.home,
        }
      });
    }
    for (const s of samples) {
      try {
        await setDoc(doc(db, "picks", picksDocId(Y, W, s.email)), {
          id: picksDocId(Y, W, s.email),
          year: Y, week: W, email: s.email,
          firstName: s.firstName, lastName: s.lastName,
          phone: "", venmo: "",
          picks: s.picks, updatedAt: serverTimestamp()
        }, { merge: true });
        seeded++;
      } catch (_) {}
    }

    setMsg(`Dummy week created (Year ${Y}, Week ${W})  -  Games: ${ids.length}  -  Winners set: ${Object.keys(winnersById).length}  -  Sample players seeded: ${seeded}`);
  };

  // Clear Dummy Week
  const clearDummyWeek = async () => {
  const t0 = Date.now();
  try {
    const Y = 2099, W = 1;
    setMsg("Clearing dummy week...");

    // Query targets
    const qGames = query(collection(db, "games"), where("year","==",Y), where("week","==",W));
    const qPicks = query(collection(db, "picks"), where("year","==",Y), where("week","==",W));

    const gsSnap  = await getDocs(qGames);
    const gameIds = gsSnap.docs.map(d => d.id);
    const psSnap  = await getDocs(qPicks);

    // Results are keyed by game id; derive from gameIds
    const resultsToDelete = gameIds.length;

    setMsg("Deleting " + gsSnap.size + " games, " + resultsToDelete + " results, " + psSnap.size + " picks...");

    const batch = writeBatch(db);
    gsSnap.forEach(d => batch.delete(d.ref));
    gameIds.forEach(id => batch.delete(doc(db, "results", id)));
    psSnap.forEach(d => batch.delete(d.ref));

    await batch.commit();

    // Quick verify
    const leftGames = (await getDocs(qGames)).size;
    const leftPicks = (await getDocs(qPicks)).size;

    const ms = Date.now() - t0;

    // Refresh Admin data + final message
    setGames(await listGames({ year: Y, week: W, includedOnly: false }));
    setMsg("Dummy week cleared (Year " + Y + ", Week " + W + ") - Deleted: Games " + gsSnap.size + " -> " + leftGames + ", Results " + resultsToDelete + ", Picks " + psSnap.size + " -> " + leftPicks + " - " + ms + "ms");
  } catch (err) {
    console.error("clearDummyWeek failed:", err);
    setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
  }
};

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  if (year == null || week == null) { return (<Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>Loading live weekï¿½</p></Card></Container>); }
  return (<Container maxWidth={720}>
      <Header user={user} isAdmin={isAdmin} setPage={setPage} />
      <Card style={{ maxWidth: 1200 }}>
        <h2>Admin</h2>
        <Row style={{ margin: "8px 0" }}><button onClick={() => { window.history.pushState(null, "", "/admin/picks"); setPage("adminpicks"); }}>Open Picks Management</button></Row>
        <Row style={{ margin: "8px 0" }}>
          <Field label="Year"><input style={{...inputStyle, width:"6rem"}} type="number" value={(year ?? '')} onChange={e=>setYear(Number(e.target.value))}/></Field>
          <Field label="Week"><input style={{...inputStyle, width:"4rem"}} type="number" value={(week ?? '')} onChange={e=>setWeek(Number(e.target.value))}/></Field>
          <button onClick={async()=>setGames(await listGames({ year, week, includedOnly: false }))}>Load</button>
          <button onClick={async()=>{ try { await setDoc(doc(db,"config","live"), { year, week }, { merge:true });
await setDoc(doc(db,"config","app"), { currentYear: year, currentWeek: week, updatedAt: serverTimestamp() }, { merge:true }); setMsg(`Live week set to ${year} / W${week} (config/live + config/app)`); } catch(e) { console.error(e); setMsg("Failed to set live week"); } }}>Set Live Week</button>
          <button onClick={async()=>{ 
            try { 
              const gs = await listGames({ year, week, includedOnly: false });
              const gd = (gs || []).filter(g => g && g.gameday);
              if (gd.length !== 1) { 
                setMsg(gd.length === 0 ? "No GameDay game flagged for this week." : "Multiple GameDay games flagged ï¿½ fix in Games.");
                return; 
              }
              await setDoc(doc(db, "config", "live"), { gamedayGameId: gd[0].id, gamedayHome: gd[0].home }, { merge: true });
              setMsg("Synced live GameDay to " + (gd[0].away || "Away") + " @ " + (gd[0].home || "Home") + ".");
            } catch (e) { 
              console.error(e); 
              setMsg("Failed to sync live GameDay");
            } 
          }}>Sync Live GameDay</button>
          <div style={{ marginLeft: 12, fontSize: 13, color:"#9aa4c7" }}>Current Week: {live?.week ?? "-"}</div>
        </Row>

        <BulkImportPicksPreview year={year} week={week} />
        <h3 style={{ marginTop: 16 }}>Submissions</h3>
        <Row style={{ marginTop: 6, marginBottom: 6 }}>
          <button onClick={async ()=>{ try {
            await setDoc(doc(db, "config", "app"), { picksLocked: true, updatedAt: serverTimestamp() }, { merge: true });
            setMsg("Submissions locked.");
          } catch (e) {
            setMsg("Failed: " + (e?.message || String(e)));
          } }}>
            Lock Submissions
          </button>
          <button onClick={async ()=>{ try {
            await setDoc(doc(db, "config", "app"), { picksLocked: false, updatedAt: serverTimestamp() }, { merge: true });
            setMsg("Submissions unlocked.");
          } catch (e) {
            setMsg("Failed: " + (e?.message || String(e)));
          } }}>
            Unlock Submissions
          </button>
        </Row>
        <h3 style={{ marginTop: 16 }}>Leaderboard</h3>
        <Row style={{ marginTop: 6, marginBottom: 6 }}>
          <button onClick={toggleLeaderboardLock}>
            {appCfg.leaderboardLocked ? "Unlock Leaderboard" : "Lock Leaderboard (current week)"}
          </button>
          <div style={{ color:"#9aa4c7", fontSize:13, marginLeft:8 }}>
            Status: {appCfg.leaderboardLocked ? "Locked (current week)" : "Unlocked"}
          </div>
        </Row>
        <Row style={{ marginTop: 6, marginBottom: 6 }}>
          <button onClick={toggleLeaderboardPicks}>
            {appCfg.leaderboardPicksPublic ? "Switch to Admin-Only Picks" : "Switch to Public Picks"}
          </button>
          <div style={{ color:"#9aa4c7", fontSize:13, marginLeft:8 }}>
            Picks Visibility: {appCfg.leaderboardPicksPublic ? "Public (everyone can see picks)" : "Admin-Only"}
          </div>
        </Row>
        <div style={{ color:"#9aa4c7", margintop:-4, fontSize:13 }}>{msg}</div>
        

        <Row style={{ marginBottom: 14 }}>
          <button onClick={createDummyWeek}>Create Dummy Week (2099 / W1)</button>
          <button onClick={clearDummyWeek}>Clear Dummy Week (2099 / W1)</button>
          <button onClick={clearWeekIfNoPicks}>Clear Week (if no picks)</button>
        </Row>
        <h3>Scoreboard Controls</h3>
<Row>
  <button onClick={async()=>{ 
    try { 
      await setDoc(doc(db, "config", "app"), { 
        scoreboard: {
          testMode: true, 
          mode: "off", 
          fixturePath: "/dev/scoreboard-demo.json"
        },
        updatedAt: serverTimestamp()
      }, { merge: true });
      setMsg("Scoreboard set to DEMO (fixture) via config/app.");
    } catch(e) { 
      console.error(e); 
      setMsg("Failed to set scoreboard to DEMO"); 
    } 
  }}>
    Use Demo (Fixture)
  </button>

  <button onClick={async()=>{ 
    try { 
      await setDoc(doc(db, "config", "app"), { 
        scoreboard: {
          testMode: false, 
          mode: "on"
        },
        updatedAt: serverTimestamp()
      }, { merge: true });
      setMsg("Scoreboard set to CFBD LIVE via config/app.");
    } catch(e) { 
      console.error(e); 
      setMsg("Failed to set scoreboard to LIVE"); 
    } 
  }}>
    Use CFBD Live
  </button>

  <button onClick={() => {
    try {
      localStorage.setItem("sbLocalFixture","0");
      alert("Fixture override set to OFF.\nIf the Leaderboard is already open, toggle its Fixture button OFF once.");
    } catch(_) {}
  }}>
    Disable Fixture Override
  </button>
</Row>

<h3>Schedule import</h3>
        <Row style={{ marginBottom: 14 }}>
          <Field label="CFBD API key (stored admin-only in Firestore)">
            <input style={{...inputStyle, width:"28rem"}} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="Bearer key from collegefootballdata.com"/>
          </Field>
          <button onClick={saveKey}>Save key</button>
          <button onClick={doImport}>Import week</button>
        </Row>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:16 }}>
  <h3 style={{ margin: 0 }}>Games</h3>
  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
    <div style={{ fontSize: 12, opacity: 0.8 }}>
      Selected: {games.filter(x => x.included).length} / {games.length}
    </div>
    <button
      type="button"
      onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); deselectAll(); }}
      style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer" }}
      aria-label="Deselect all games"
      title="Deselect all games"
    >
      Deselect All
    </button>
  </div>
</div>
{renderGamesGroupedByDate(games, {
  timeZone: "America/New_York",
  renderRow: (g, i, { kickoffLabel }) => (
    <div
      key={g.id} data-game-id={g.id}
      role="switch"
      aria-checked={!!g.included}
      tabIndex={0}
      onClick={(e)=>toggle(g, !g.included)}
      onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggle(g, !g.included);} }}
      style={{
        display:"flex", alignItems:"center", gap:12, flexWrap:"nowrap",
        border: g.included ? "1px solid #2ecc71" : "1px dashed #1f2a44",
        padding:12, borderRadius:12, margin:"10px auto",
        maxWidth: 1200, width:"100%", cursor:"pointer",
        boxShadow: g.included ? "0 0 0 2px #2ecc71 inset" : "none",
        background: g.included ? "rgba(46,204,113,0.08)" : "transparent",
        transition:"box-shadow 120ms ease, background 120ms ease, border-color 120ms ease"
      }}
    >
      <div style={{ marginBottom: 16, textAlign:"left", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", minWidth:0 }}>
        <strong style={{ display:"inline-flex", flexWrap:"wrap", justifyContent:"center", alignItems:"center", width:"100%", textAlign:"center", rowGap:"0", lineHeight: 1.24, fontWeight:700, fontSize: fitFontByLen(((teamLabelNoMascot(g.away,g.awayRank)||"").length + (teamLabelNoMascot(g.home,g.homeRank)||"").length)), gap:6 }}>
          <TeamLogo school={g.away} size={48} /> <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div> @ <TeamLogo school={g.home} size={48} /> <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>
        </strong>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginLeft:"auto" }}>
  <span style={{ whiteSpace:"nowrap", opacity: 0.8 }}>{timeLabelOnly(g,{ timeZone:"America/New_York" })}</span>
    <button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); setGameGameday(g.year, g.week, g.id).then(async ()=>{ setGames(await listGames({ year, week, includedOnly: false })); setMsg("Set College GameDay to " + teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank)); }); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); setGameGameday(g.year, g.week, g.id).then(async ()=>{ setGames(await listGames({ year, week, includedOnly: false })); setMsg("Set College GameDay to " + teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank)); }); }}}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer", color:"#fff", marginRight:8, background: g.gameday ? "rgba(241,196,15,0.1)" : "transparent", boxShadow: g.gameday ? "0 0 0 2px #f1c40f inset" : "none" }}
    aria-label={"Set College GameDay for " + teamLabelNoMascot(g.away, g.awayRank) + " at " + teamLabelNoMascot(g.home, g.homeRank)}
    title={g.gameday ? "College GameDay (selected)" : "Set as College GameDay"}
  >
    {"?"}
  </button><button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); chooseWinner(g); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); chooseWinner(g);} }}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer" }}
    aria-label={`Set winner for $<div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div> at $<div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>`}
  >
    Set Winner
  </button>
</div>
    </div>
  )
})}</Card>
</Container>
  );
}

function ConfirmPage({ setPage }) {
  const [picksLocked, setPicksLocked] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
    });
    return () => unsub && unsub();
  }, []);
  const [pending, setPending] = React.useState(null);
  const [games, setGames] = React.useState([]);
  const [msg, setMsg] = React.useState("");

  React.useEffect(() => {
  (async () => {
    try {
      const p = JSON.parse(localStorage.getItem("pending") || "null");
      if (!p || !p.year || !p.week) { setPage("picks"); return; }
      setPending(p);

      // Use the same fetch + sort as PicksPage
      let items = await listGames({ year: p.year, week: p.week, includedOnly: true });

      // Put College GameDay at the end (same presentation as Picks)
      const gd = Array.isArray(items) ? items.find(x => x && x.gameday) : null;
      items = gd ? [...items.filter(x => x && x.id !== gd.id), gd] : items;

      setGames(items);
    } catch (e) {
      setPage("picks");
    }
  })();
}, [setPage]);

  const normEmail = (s) => String(s||"").trim().toLowerCase();
const normPhone = (s) => String(s||"").replace(/[^0-9]/g, "");
const normVenmo = (s) => String(s||"").trim().toLowerCase().replace(/^@+/, "");const confirmAndSubmit = async () => { if (picksLocked) { if (typeof setMsg==="function") setMsg("Submissions are locked right now."); return; }
    if (!pending) return;
    setMsg("Saving...");
    try {
      const { year, week, form, picks, code, tiebreaker } = pending;
      // ---- Front-end validations (required fields & all picks) ----
      const phoneDigits = String((form && form.phone) || "").replace(/[^0-9]/g, "");
      const venmoTrim   = String((form && form.venmo) || "").trim();
      const firstTrim   = String((form && form.firstName) || "").trim();
      const lastTrim    = String((form && form.lastName) || "").trim();

      // Required: first & last name
      if (!firstTrim || !lastTrim) { setMsg("Enter your first and last name."); return; }

      // Required: phone (any digits; Firestore rules may be stricter)
      if (!phoneDigits) { setMsg("Enter your phone number."); return; }

      // Required: Venmo + confirmation checkbox
      if (!venmoTrim) { setMsg("Enter your Venmo username."); return; }
      if (!form?.venmoConfirmed) { setMsg("Please confirm your Venmo is correct."); return; }

      // Required: a pick for every included game
      const missingPick = (Array.isArray(games) ? games : [])
        .filter(g => (typeof g?.included === "boolean" ? g.included : true))
        .find(g => (picks == null || picks[g.id] == null));
      if (missingPick) { setMsg("Make a pick for every listed game."); return; }
      const id = `${year}_W${week}_${code}`;
      const gd = games.find(x => x && x.gameday);

      const payload = {
        id, year, week, code,
        firstName: form.firstName,
        lastName: form.lastName,
        lastNameLower: (form.lastName || "").toLowerCase().trim(),
        phone: form.phone || "",
        venmo: form.venmo || "",
        email: (form.email || "").toLowerCase(),
        venmoConfirmed: !!form.venmoConfirmed,
        picks,
        updatedAt: serverTimestamp()
      };

      if (gd) {
        const tbTotal = tiebreaker && tiebreaker.total !== "" ? Number(tiebreaker.total) : NaN;
        if (Number.isNaN(tbTotal)) { setMsg("Enter total points for the College GameDay tiebreaker."); return; }
        payload.tiebreaker = { gameId: gd.id, total: tbTotal };
      }

      try {
  await runTransaction(db, async (tx) => {
    const locks = [];
    const eKey = normEmail(form.email);
    const pKey = normPhone(form.phone);
    const vKey = normVenmo(form.venmo);
    if (eKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_email_${eKey}`), type: "email", value: eKey });
    if (pKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_phone_${pKey}`), type: "phone", value: pKey });
    if (vKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_venmo_${vKey}`), type: "venmo", value: vKey });

    // If any lock exists and points to a different submission, block
    for (const l of locks) {
      const s = await tx.get(l.ref);
      const existing = s.exists() ? s.data() : null;
      if (existing && existing.picksId !== id) {
        throw new Error("DUPLICATE_LOCK");
      }
    }

    // Create/update locks for this submission, then write the picks
    for (const l of locks) {
      tx.set(l.ref, { year, week, type: l.type, value: l.value, picksId: id, code, createdAt: serverTimestamp() }, { merge: true });
    }
    tx.set(doc(db, "picks", id), payload, { merge: true });
  });
} catch (e2) {
  const msg = String((e2 && e2.message) || e2 || "");
  if (msg === "DUPLICATE_LOCK") {
    setMsg("this email/number/venmo is already associated with a submission, if you feel this was reached in error contact zslay@live.com");
    return;
  }
  throw e2;
}localStorage.setItem("receipt", JSON.stringify({ year, week, code, form, picks, tiebreaker: payload.tiebreaker || null }));
      setMsg("");
      setPage("receipt");
      window.history.pushState(null, "", "/receipt");
    } catch (e) {
      setMsg("Save failed: " + (e && e.message ? e.message : e));
    }
  };

  const included = Array.isArray(games) ? games.filter(g => (typeof g.included === "boolean" ? g.included : true)) : [];
  const gd = included.find(x => x && x.gameday);
  const list = gd ? [...included.filter(x => x && x.id !== gd.id), gd] : included;

  const pickLabel = (g) => {
    const t = pending?.picks?.[g.id];
    if (t == null) return "(no pick)";
    if (t === g.home) return teamLabel(g.home, g.homeRank);
    if (t === g.away) return teamLabel(g.away, g.awayRank);
    return String(t);
  };

  if (!pending) return null;

  return (
    <Container maxWidth={720}>
      <Card style={{ maxWidth: 900 }}>
        <h2 style={{ marginTop: 0 }}>Confirm Your Picks — Week {pending.week}</h2>
        <div style={{ marginBottom:12 }}>
          <span style={{ fontWeight:700, marginRight:8 }}>Your edit code:</span>
          <code style={{ fontSize:18 }}>{pending.code}</code>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:12 }}>
          {list.map(g => {
            const matchup = teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank);
            return (
              <div key={g.id} style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:12, alignItems:"center" }}>
                <div style={{ fontSize:12 }}>{matchup}{g.gameday ? "  ???" : ""}</div>
                <div style={{ fontSize:13, fontWeight:600 }}>{pickLabel(g)}</div>
              </div>
            );
          })}
        </div>

        {gd && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize:12, opacity:.8 }}>College GameDay Tiebreaker</div>
            <div style={{ fontSize:13, fontWeight:600 }}>
              Total: {pending?.tiebreaker?.total === "" || pending?.tiebreaker?.total == null ? "(not set)" : Number(pending.tiebreaker.total)}
            </div>
          </div>
        )}

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:16 }}>
          <button type="button" onClick={()=>{ setPage("picks"); window.history.pushState(null, "", "/picks"); }}>Back to Edit</button>
          <div style={{ flex:1, textAlign:"center", color:"#9aa4c7", fontSize:13 }}>{msg}</div>
          <button type="button" onClick={confirmAndSubmit} disabled={!!(picksLocked)}>Confirm & Submit</button>
        </div>
      </Card>
    </Container>
  );
}

function ReceiptPage({ setPage }) {
  const [receipt, setReceipt] = React.useState(null);
  React.useEffect(() => {
    const r = JSON.parse(localStorage.getItem("receipt") || "null");
    if (!r) { setPage("picks"); return; }
    setReceipt(r);
  }, [setPage]);

  if (!receipt) return null;

  return (
    <Container maxWidth={720}>
      <Card>
        <h3 style={{ marginTop:0, marginBottom:8 }}>
          Picks Submitted — Receipt <span style={{ fontWeight:400 }}> (*SCREENSHOT THIS*)</span>
        </h3>
        <p style={{ marginTop:0 }}>
          Your code is <b>{receipt.code}</b>. Use this with your last name to edit before kickoff.
        </p>
        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:16 }}>
          <button type="button" onClick={()=>{
            setReceipt(null);
            localStorage.removeItem("receipt");
            setPage("picks");
            window.history.pushState(null, "", "/picks");
          }}>Done</button>
        </div>
      </Card>
    </Container>
  );
}
function ModalOverlay({ children }) {
  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,0.45)",
      display:"grid", placeItems:"center", padding:"24px", zIndex: 1000
    }}>
      <div style={{
        width:"min(920px, 94vw)", maxHeight:"86vh", overflow:"auto",
        background:"transparent", border:"none", boxShadow:"none", padding:0
      }}>
        {children}
      </div>
    </div>
  );
}
export default function App() {
  const { user, isAdmin } = useAuthAdmin();
  const [page, setPage] = useState("picks");
  // --- Path router shim (picks|leader|admin|admin/picks) ---
  useEffect(() => {
    const readPath = () => {
      const p = (window.location.pathname || "/").replace(/^\/|\/$/g, "");
      if (p === "") { setPage("picks"); return; }
      if (p === "picks" || p === "leader" || p === "admin") { setPage(p); return; }
      if (p === "admin/picks") { setPage("adminpicks"); return; }
    };
    readPath(); // on load
    window.addEventListener("popstate", readPath);
    return () => window.removeEventListener("popstate", readPath);
  }, []);

  useEffect(() => {
    document.body.style.margin = 0;
    document.body.style.background = "#0b1220";
    document.body.style.color = "#eef2ff";
    document.body.style.fontFamily = "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

  }, []);

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return (
    <>
      {(page === "picks" || page === "confirm" || page === "receipt") && <PicksPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "leader" && <LeaderboardPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "admin" && <AdminPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminpicks" && <AdminPicksPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "confirm" && <ModalOverlay><ConfirmPage setPage={setPage} /></ModalOverlay>}
      {page === "receipt" && <ModalOverlay><ReceiptPage setPage={setPage} /></ModalOverlay>}
    </>
  );
}

























































































/* ===== Admin: group games into date sections (ESPN-style) ===== */
const _tzDefault = "America/New_York";

const _maybeDate = (g) => {
  try { if (typeof kickoffDate === "function") return kickoffDate(g); } catch {}
  if (g?.kickoff?.seconds) return new Date(g.kickoff.seconds * 1000);
  if (g?.kickoff?.toDate) return g.kickoff.toDate();
  const cand = g?.kickoff ?? g?.start ?? g?.startTime ?? g?.start_time ?? g?.startDate ?? g?.start_date ?? g?.date ?? g?.startTimeStr;
  return cand ? new Date(cand) : null;
};

const _kickoffLabel = (g, { timeZone = _tzDefault } = {}) => {
  try { if (typeof kickoffLabel === "function") return kickoffLabel(g, { timeZone }); } catch {}
  const d = _maybeDate(g);
  if (!d || isNaN(+d)) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone
  }).format(d);
};

function _ymdKey(d, timeZone = _tzDefault) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const yyyy = parts.find(p => p.type === "year")?.value;
  const mm   = parts.find(p => p.type === "month")?.value;
  const dd   = parts.find(p => p.type === "day")?.value;
  return `${yyyy}-${mm}-${dd}`;
}

function groupGamesByDate(games = [], { timeZone = _tzDefault } = {}) {
  const map = new Map();
  for (const g of games) {
    const d = kickoffDate(g);
    if (!d || isNaN(+d)) continue;
    const key = _ymdKey(d, timeZone);
    const header = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(d);
    if (!map.has(key)) map.set(key, { key, header, items: [] });
    map.get(key).items.push(g);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// JSX renderer: call with your existing row renderer to keep current controls
function renderGamesGroupedByDate(games, { timeZone = _tzDefault, renderRow } = {}) {
  const groups = groupGamesByDate(games, { timeZone });
groups.forEach(g => { if (Array.isArray(g.items)) g.items.sort((a,b)=>((a.orderDay ?? 1e9)-(b.orderDay ?? 1e9)) || ((a.order ?? 1e9)-(b.order ?? 1e9))); });
groups.forEach(g => { if (Array.isArray(g.items)) g.items.sort((a,b)=>((a.orderDay ?? 1e9)-(b.orderDay ?? 1e9)) || ((a.order ?? 1e9)-(b.order ?? 1e9))); });

  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
  return (
    <div className="space-y-10">
      {groups.map(grp => (
        <section key={grp.key} style={{ marginBottom: 48 }}>
          <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>{grp.header}</div>
          <div className="space-y-2">
            {grp.items
              .sort((a,b)=>((a.orderDay ?? 1e9)-(b.orderDay ?? 1e9)) || ((a.order ?? 1e9)-(b.order ?? 1e9)))
              .map((g, i) =>
                renderRow
                  ? renderRow(g, i, { timeZone, kickoffLabel: _kickoffLabel })
                  : (
                    <div key={g.id || i} className="rounded-2xl shadow p-3 flex items-center justify-between">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {/* Optional logos here */}
                        <div>{g.away?.name ?? g.away}</div>
                        <div>@</div>
                        <div>{g.home?.name ?? g.home}</div>
                      </div>
                      <div style={{ opacity: 0.8 }}>{_kickoffLabel(g, { timeZone })}</div>
                    </div>
                  )
              )}
          </div>
        </section>
      ))}
    </div>
  );
}
/* ===== /group games by date ===== */


/* === Admin: time-only label for grouped rows === */
function timeLabelOnly(g, { timeZone = _tzDefault } = {}) {
  const d = _maybeDate(g);
  if (!d || isNaN(+d)) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone
  }).format(d);
}


















// restore Admin-SetGamedayBtn 2025-08-29T01:53:49




















































































































































































































































  
// === Doc ID helper: {year}_W{week}_{last2}-{hash8} ===
// Only last 2 digits of the 6-digit code appear in the ID; hash prevents collisions.
async function computePickDocId(year, week, code, lastNameLower) {
  try {
    const last2 = String(code).slice(-2);
    const input = `${year}|${week}|${String(code)}|${String((lastNameLower||"")).toLowerCase()}`;
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    const hash8 = Array.from(new Uint8Array(buf).slice(0,4))
      .map(b => b.toString(16).padStart(2,"0"))
      .join("");
    return `${year}_W${week}_${last2}-${hash8}`;
  } catch (e) {
    console.error("computePickDocId failed, falling back to legacy id:", e);
    return `${year}_W${week}_${code}`; // safe fallback (legacy id)
  }
}







//
// ==== DEBUG HELPERS (temporary) ====
if (typeof window !== "undefined") {
  window._lbDebug = {
    live: async () => {
      try {
        const s = await getDoc(doc(db, "config", "live"));
        console.log("[_lbDebug.live]", s.exists() ? s.data() : null);
        return s.exists() ? s.data() : null;
      } catch (e) { console.error(e); return null; }
    },
    games: async (Y, W) => {
      try {
        const g = await listGames({ year: Y, week: W, includedOnly: true });
        console.table(g.map(x => ({ id: x.id, away: x.away, home: x.home, included: x.included })));
        return g;
      } catch (e) { console.error(e); return []; }
    },
    results: async (ids) => {
      try {
        const r = await getResultsMap(ids);
        console.log("[_lbDebug.results]", r);
        return r;
      } catch (e) { console.error(e); return {}; }
    },
  };
  console.log("%c_lbDebug ready. Try: await _lbDebug.live()", "font-weight:bold");
}
if (typeof window !== "undefined" && window._lbDebug) {
  window._lbDebug.picks = async (Y, W) => {
    try {
      const P = await loadPicks(Y, W);
      console.log("[_lbDebug.picks]", P);
      return P;
    } catch (e) { console.error(e); return []; }
  };
  window._lbDebug.score = (p, G, R) =>
    G.reduce((acc, g) => {
      const pick = p.picks?.[g.id];
      const win  = R[g.id]?.winner;
      return acc + (pick && win && pick === win ? 1 : 0);
    }, 0);
}
if (typeof window !== "undefined" && window._lbDebug) {
  // Self-contained picks fetch (no dependency on loadPicks)
  window._lbDebug.picks = async (Y, W) => {
    try {
      const picksCol = collection(db, "picks");
      const qy = query(picksCol, where("year","==",Y), where("week","==",W));
      const s = await getDocs(qy);
      const arr = [];
      s.forEach(d => arr.push({ id: d.id, ...d.data() }));
      console.log("[_lbDebug.picks]", arr);
      return arr;
    } catch (e) { console.error(e); return []; }
  };
  window._lbDebug.score = (p, G, R) =>
    G.reduce((acc, g) => {
      const pick = p.picks?.[g.id];
      const win  = R[g.id]?.winner;
      return acc + (pick && win && pick === win ? 1 : 0);
    }, 0);
}
if (typeof window !== "undefined" && window._lbDebug) {
  window._lbDebug.setWinner = async (gid, side) => {
    try {
      const gs = await getDoc(doc(db, "games", gid));
      if (!gs.exists()) throw new Error("No game: " + gid);
      const g = { id: gid, ...gs.data() };
      const val = String(side).trim().toLowerCase();
      let w = null;
      if (val === "home" || val === g.home.toLowerCase()) w = g.home;
      else if (val === "away" || val === g.away.toLowerCase()) w = g.away;
      else throw new Error('Use "home" or "away" (or exact team name)');
      await setDoc(doc(db, "results", gid), { winner: w, updatedAt: serverTimestamp() }, { merge: true });
      console.log("setWinner OK:", gid, "?", w);
      return { gid, winner: w };
    } catch (e) { console.error("setWinner ERR:", e); return null; }
  };
}

if (typeof window !== "undefined") {
  window._lbDebug = window._lbDebug || {};
  window._lbDebug.auth = {
    signIn: async () => {
      const auth = getAuth();
      const prov = new GoogleAuthProvider();
      const res = await signInWithPopup(auth, prov);
      console.log("[auth] signed in:", res.user.uid, res.user.email);
      return res.user;
    },
    signOut: () => signOut(getAuth()),
    me: () => {
      const u = getAuth().currentUser;
      const who = u ? { uid: u.uid, email: u.email } : null;
      console.log("[auth] me:", who);
      return who;
    },
  };
  console.log("_lbDebug.auth ready ? try: await _lbDebug.auth.signIn()");
}

/* ==== Minimal auth helpers (use ./firebase wrappers) ==== */
if (typeof window !== "undefined") {
  // Trigger Google popup (same as Headerï¿½s ï¿½Admin Loginï¿½)
  window._signin = () => googleLogin();
  window._signout = () => logout();

  // Keep a live copy of the current user; _whoami() returns { uid, email } or null
  window._whoami = (() => {
    let last = null;
    try {
      onAuth(u => {
        last = u || null;
        if (u) console.log("[auth] signed in:", u.uid, (u.email || "").toLowerCase());
        else console.log("[auth] signed out");
      });
    } catch (_) {}
    return () => (last ? { uid: last.uid, email: (last.email || "").toLowerCase() } : null);
  })();

  console.log("_signin/_whoami ready ? click 'Admin Login' in the header, then run _whoami()");
}
/* ==== end auth helpers ==== */





























































































































































/* === LIVE DEMO GENERATOR (fixture JSON) — appended === */
async function makeLiveDemoFromGames(games = [], opts = {}) {
  try {
    const seed = (opts.seed ?? Date.now()) % 1000;
    let x = (seed || 1) >>> 0;
    const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return ((x>>>0)/0xffffffff); };

    const scenarios = [
      { status: "scheduled",    period: 0, clock: "",       style: "none"  },
      { status: "in_progress",  period: 1, clock: "12:34",  style: "low"   },
      { status: "halftime",     period: 2, clock: "",       style: "mid"   },
      { status: "in_progress",  period: 3, clock: "06:21",  style: "mid"   },
      { status: "in_progress",  period: 4, clock: "02:03",  style: "high"  },
      { status: "final",        period: 4, clock: "",       style: "final" },
      { status: "final",        period: 5, clock: "",       style: "ot"    }, // FINAL/OT
    ];
    const pickStyle = () => scenarios[Math.floor(rnd() * scenarios.length)];

    const mkScore = (style) => {
      if (style === "none")  return [0, 0];
      if (style === "low")   return [Math.floor(rnd()*7), Math.floor(rnd()*7)];
      if (style === "mid")   return [7 + Math.floor(rnd()*14), 7 + Math.floor(rnd()*14)];
      if (style === "high")  return [20 + Math.floor(rnd()*21), 17 + Math.floor(rnd()*21)];
      if (style === "final") { let a = 10 + Math.floor(rnd()*31), h = 10 + Math.floor(rnd()*31); if (a === h) a += 3; return [a, h]; }
      if (style === "ot")    { let a = 24 + Math.floor(rnd()*24), h = 24 + Math.floor(rnd()*24); if (a === h) a += (rnd()<0.5?2:3); return [a, h]; }
      return [0, 0];
    };

    const demo = (Array.isArray(games) ? games : []).slice(0, 24).map((g, i) => {
      const awayTeam = String(g?.away || g?.awayTeam || "");
      const homeTeam = String(g?.home || g?.homeTeam || "");
      const sc = pickStyle();
      const [awayPoints, homePoints] = mkScore(sc.style);
      const possession = (sc.status === "in_progress" && rnd() < 0.5) ? (rnd() < 0.5 ? "away" : "home") : null;

      const awayRank = Number.isFinite(+g?.awayRank) ? +g.awayRank : null;
      const homeRank = Number.isFinite(+g?.homeRank) ? +g.homeRank : null;

      const kickDate = new Date(Date.now() + (i * 35 * 60 * 1000));
      const kickoffLabel = new Intl.DateTimeFormat("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York"
      }).format(kickDate);

      return { awayTeam, homeTeam, awayRank, homeRank, status: sc.status, period: sc.period, clock: sc.clock, awayPoints, homePoints, possession, kickoffLabel };
    });

    const json = JSON.stringify(demo, null, 2);

    // Clipboard (best effort)
    try { await navigator.clipboard.writeText(json); console.info("[demo] JSON copied to clipboard"); } catch {}

    // Download as fallback
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "scoreboard-demo.json";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch {}

    window.__DEMO_FIXTURE__ = demo;
    alert("Demo created:\n\n1) File downloaded and JSON copied.\n2) Replace /public/dev/scoreboard-demo.json with it.\n3) Toggle Fixture: ON to preview.");
  } catch (e) {
    console.error("makeLiveDemoFromGames failed", e);
    alert("Failed to build demo: " + (e?.message || e));
  }
}
/* === end LIVE DEMO GENERATOR === */














/* === DEV: load + merge Firestore results (week doc + legacy per-game) === */
if (typeof window !== "undefined") {
  window._loadResults = async function() {
    try {
      // uses already-imported Firestore symbols in App.jsx (db, getDoc, getDocs, doc, collection)
      const appSnap = await getDoc(doc(db, "config", "app"));
      const app = appSnap.exists() ? appSnap.data() : {};
      const year = app?.currentYear;
      const week = app?.currentWeek;
      if (!year || !week) { console.warn("[fs results] missing currentYear/currentWeek"); return null; }

      const normalizeKey = (name) => {
        if (!name) return "";
        let s = String(name).toLowerCase();
        s = s.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
        s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
        if (s === "texasam" || s === "texasa&m") s = "texasam";
        return s;
      };
      const gid = (home, away) => normalizeKey(away) + "__" + normalizeKey(home);

      // 1) New format: results/{year}_W{week}.games
      const weekId = year + "_W" + week;
      const weekSnap = await getDoc(doc(db, "results", weekId));
      const merged = {};
      if (weekSnap.exists()) {
        const data = weekSnap.data() || {};
        const games = data.games || {};
        for (const [k, v] of Object.entries(games)) {
          merged[k] = { ...v, source: "weekdoc" };
        }
      }

      // 2) Legacy per-game docs: results/{year}_W{week}_<Home>_at_<Away>
      const all = await getDocs(collection(db, "results"));
      const prefix = year + "_W" + week + "_";
      all.forEach((d) => {
        const id = d.id || "";
        if (!id.startsWith(prefix)) return;
        const r = d.data() || {};
        // derive teams from fields or doc id
        const byIdHome = id.split("_at_")[0]?.replace(prefix, "").replace(/_/g," ") || "";
        const byIdAway = id.split("_at_")[1]?.replace(/_/g," ") || "";
        const home = r.home || r.homeTeam || r.home_team || byIdHome;
        const away = r.away || r.awayTeam || r.away_team || byIdAway;
        const hp = (r.homePoints ?? r.home_points ?? r.homeScore ?? null);
        const ap = (r.awayPoints ?? r.away_points ?? r.awayScore ?? null);
        let winner = r.winner || null;
        if (winner == null && hp != null && ap != null) {
          winner = (+hp > +ap) ? normalizeKey(home) : ((+ap > +hp) ? normalizeKey(away) : "tie");
        }
        const key = gid(home, away);
        merged[key] = {
          ...(merged[key] || {}),
          winner,
          homePoints: (hp != null ? +hp : null),
          awayPoints: (ap != null ? +ap : null),
          status: r.status ?? null,
          period: r.period ?? null,
          source: (merged[key]?.source ? (merged[key].source + "+legacy") : "legacy"),
          finalizedAt: merged[key]?.finalizedAt || r.finalizedAt || null
        };
      });

      window.__FS_RESULTS = merged;
      console.info("[fs results] merged", { weekId, count: Object.keys(merged).length, keys: Object.keys(merged).slice(0,6) });
      return merged;
    } catch (e) {
      console.error("[_loadResults] failed", e);
      return null;
    }
  };
}




/* === Bridge: copy winners from results/{year}_W{week}.games -> results/{gameId} (per-game) with backup === */
async function copyWinnersFromWeekToPerGame() {
  try {
    const appSnap = await getDoc(doc(db, "config", "app"));
    const app = appSnap.exists() ? appSnap.data() : {};
    const y = app?.currentYear;
    const w = app?.currentWeek;
    if (!y || !w) { alert("currentYear/currentWeek missing (config/app)."); return; }

    const normalizeKey = (name) => {
      if (!name) return "";
      let s = String(name).toLowerCase();
      s = s.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
      s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
      if (s === "texasam" || s === "texasa&m") s = "texasam";
      return s;
    };
    const keyFrom = (home, away) => `${normalizeKey(away)}__${normalizeKey(home)}`;

    const weekId = `${y}_W${w}`;
    const weekSnap = await getDoc(doc(db, "results", weekId));
    if (!weekSnap.exists()) { alert(`No week results found at results/${weekId}. Run "Write Winners (CFBD)" first.`); return; }
    const gamesMap = (weekSnap.data() || {}).games || {};
    const haveKeys = Object.keys(gamesMap);
    if (haveKeys.length === 0) { alert("Week results has no games map."); return; }

    const qGames = query(collection(db, "games"), where("year","==", Number(y)), where("week","==", Number(w)));
    const gsSnap = await getDocs(qGames);
    if (gsSnap.size === 0) { alert(`No games found for ${y}/W${w}.`); return; }
    const byGameId = {};
    gsSnap.forEach(d => {
      const g = d.data() || {};
      byGameId[d.id] = { id: d.id, home: g.home || g.homeTeam || "", away: g.away || g.awayTeam || "" };
    });

    const perGameIds = Object.keys(byGameId);
    const backup = {};
    for (const gid of perGameIds) {
      const rs = await getDoc(doc(db, "results", gid));
      if (rs.exists()) backup[gid] = rs.data();
    }

    const backupId = `${y}_W${w}_` + Date.now();
    await setDoc(doc(db, "results_backups", backupId), {
      id: backupId, year: y, week: w, createdAt: serverTimestamp(), perGame: backup
    }, { merge: true });

    const batch = writeBatch(db);
    let writes = 0, skips = 0;
    for (const gid of perGameIds) {
      const { home, away } = byGameId[gid];
      if (!home || !away) { skips++; continue; }
      const k = keyFrom(home, away);
      const r = gamesMap[k];
      if (!r || !r.winner || r.winner === "tie") { skips++; continue; }

      batch.set(doc(db, "results", gid), {
        id: gid, year: y, week: w, home, away,
        winner: r.winner,
        homePoints: (Number.isFinite(+r.homePoints) ? +r.homePoints : null),
        awayPoints: (Number.isFinite(+r.awayPoints) ? +r.awayPoints : null),
        status: r.status || (r.winner ? "final" : null),
        period: (typeof r.period === "number" ? r.period : null),
        source: (r.source ? (String(r.source) + "+bridge") : "bridge"),
        updatedAt: serverTimestamp(),
        finalizedAt: r.finalizedAt || null
      }, { merge: true });
      writes++;
    }

    if (writes === 0) {
      alert(`Nothing to write. (Matched ${perGameIds.length} game(s), ${skips} skipped.)`);
      return;
    }

    await batch.commit();
    alert(`Applied winners to per-game results.\n\nWeek ${w}, ${y}\nWrote: ${writes}\nSkipped: ${skips}\nBackup: results_backups/${backupId}`);
  } catch (err) {
    console.error("[Bridge: copyWinnersFromWeekToPerGame] failed", err);
    alert("Bridge failed: " + (err?.message || String(err)));
  }
}
/* === end bridge === */











































































































































