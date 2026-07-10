/** Normalize a school string into a filename-safe id */
export function normalizeId(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function espnWeekUrl(year, week) {
  const u = new URL("https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard");
  u.searchParams.set("year", String(year));
  u.searchParams.set("week", String(week));
  u.searchParams.set("seasontype", "2");   // regular season
  u.searchParams.set("groups", "80");      // FBS only
  u.searchParams.set("limit", "400");      // headroom
  return u.toString();
}

export async function fetchEspnWeek(fetchJson, year, week) {
  const url = espnWeekUrl(year, week);
  const res = await fetchJson(url);
  if (!res.ok) return { ok:false, events:[] };
  const root = res.data || {};
  return { ok:true, events: Array.isArray(root.events) ? root.events : [] };
}

function nameFromTeam(t) {
  return t?.location || t?.displayName || t?.name || t?.shortDisplayName || "";
}

// Format a YYYY-MM-DD key in America/New_York for a given ISO/UTC timestamp
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function mapEspnEventsToGames(events) {
  const perDay = new Map(); // dayKey -> next index (1-based)
  const out = [];
  (events || []).forEach((ev, i) => {
    const comp = ev?.competitions?.[0];
    if (!comp) return;
    const comps = comp.competitors || [];
    if (comps.length < 2) return;

    const cHome = comps.find(x => x.homeAway === "home") || comps[0];
    const cAway = comps.find(x => x.homeAway === "away") || comps[1];
    const tHome = cHome?.team || {};
    const tAway = cAway?.team || {};

    const home = nameFromTeam(tHome);
    const away = nameFromTeam(tAway);
    const homeRank = (cHome?.curatedRank?.current ?? cHome?.rank ?? null);
    const awayRank = (cAway?.curatedRank?.current ?? cAway?.rank ?? null);
    const startTimeStr = ev?.date || comp?.date || "";

    // Compute per-day order in ET
    let dayKey = null, orderDay = null;
    try {
      const d = startTimeStr ? new Date(startTimeStr) : null;
      if (d && !Number.isNaN(+d)) {
        dayKey = dayKeyFmt.format(d); // "YYYY-MM-DD" in ET
        const next = (perDay.get(dayKey) || 0) + 1;
        perDay.set(dayKey, next);
        orderDay = next;
      }
    } catch {}

    const key = `${normalizeId(away)}__${normalizeId(home)}`;
    out.push({
      home, away,
      homeRank: Number.isFinite(+homeRank) ? +homeRank : null,
      awayRank: Number.isFinite(+awayRank) ? +awayRank : null,
      startTimeStr,
      included: true,
      _espnIdx: i,      // global ESPN index (whole week)
      _espnKey: key,
      dayKey,           // ET date string "YYYY-MM-DD"
      orderDay          // 1..N for that ET date
    });
  });
  return out;
}

export async function mergeEspnWeek({ year, week, games, debug, fetchJson }) {
  try {
    debug.sourceTried?.push?.("ESPN-week");
    const { ok, events } = await fetchEspnWeek(fetchJson, year, week);
    if (!ok) return;

    debug.espnDirect = events.length;
    const mapped = mapEspnEventsToGames(events);

    // Order maps
    const orderMap = new Map(mapped.map(m => [m._espnKey, m._espnIdx]));
    const dayOrderMap = new Map(mapped.map(m => [m._espnKey, m.orderDay ?? null]));

    // Annotate any existing games that match ESPN by normalized names
    for (const g of games) {
      const key = `${normalizeId(g.away)}__${normalizeId(g.home)}`;
      if (orderMap.has(key)) g._espnIdx = orderMap.get(key);
      if (dayOrderMap.has(key)) g._orderDay = dayOrderMap.get(key);
    }

    // Push any missing ESPN games
    const seen = new Set(games.map(g => `${normalizeId(g.away)}__${normalizeId(g.home)}`));
    for (const m of mapped) {
      if (!seen.has(m._espnKey)) {
        games.push(m);
        seen.add(m._espnKey);
      }
    }

    // Final in-memory order = ESPN week order (stable), but we’ll sort per-day at render-time
    games.sort((a, b) => {
      const ai = Number.isFinite(a._espnIdx) ? a._espnIdx : 1e9;
      const bi = Number.isFinite(b._espnIdx) ? b._espnIdx : 1e9;
      return ai - bi;
    });

    debug._espnOrderSize = orderMap.size;
  } catch (e) {
    // swallow network/shape errors
  }
}
