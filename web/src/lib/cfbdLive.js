/**
 * CFBDLIVE v2 — adds real fetch (not wired yet)
 * Exports:
 *   - normalizeScoreboardItems(items): Map keyed by "away__home"
 *   - fetchCfbdScoreboard({ token, groups=80, date, week, year, seasonType }): Promise<any[]>
 *
 * Notes:
 * - Caller must pass a CFBD API token; we never read or store it here.
 * - At minimum, pass { token, groups: 80 }. You can also pass a specific { date } (YYYY-MM-DD, ET)
 *   or { week, year, seasonType } if you prefer.
 */

const DEV = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) || false;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * @param {Array<any>} items
 * @returns {Map<string, { status:string|null, period:number|null, clock:string|null, homePoints:number|null, awayPoints:number|null, possession:"home"|"away"|null, startTime:any }>}
 */
export function normalizeScoreboardItems(items) {
  const m = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const awayId = it.awayTeam ?? it.away ?? it.away_team ?? "";
    const homeId = it.homeTeam ?? it.home ?? it.home_team ?? "";
    const key = norm(awayId) + "__" + norm(homeId);
    m.set(key, {
      status: it.status ?? it.gameStatus ?? null,
      period: typeof it.period === "number" ? it.period : (typeof it.quarter === "number" ? it.quarter : null),
      clock: it.clock ?? it.timeRemaining ?? null,
      homePoints: Number.isFinite(it.homePoints) ? it.homePoints : (Number.isFinite(it.home_points) ? it.home_points : null),
      awayPoints: Number.isFinite(it.awayPoints) ? it.awayPoints : (Number.isFinite(it.away_points) ? it.away_points : null),
      possession: it.possession === "home" || it.possession === "away" ? it.possession : null,
      startTime: it.startTime ?? it.start_time ?? null,
    });
  }
  return m;
}

/**
 * Fetch CFBD REST live scoreboard.
 * @param {Object} opts
 * @param {string} opts.token                CFBD API token (Bearer)
 * @param {number} [opts.groups=80]          CFBD group id (80 = FBS)
 * @param {string} [opts.date]               YYYY-MM-DD (ET) — optional
 * @param {number} [opts.week]               Optional CFBD week
 * @param {number} [opts.year]               Optional season year
 * @param {"regular"|"postseason"} [opts.seasonType]
 * @returns {Promise<any[]>} raw items from CFBD /scoreboard
 */
export async function fetchCfbdScoreboard(opts = {}) {
  const {
    token,
    groups = 80,
    date,
    week,
    year,
    seasonType,
  } = opts || {};

  if (!token) {
    if (DEV) console.warn("[cfbdLive:v2] missing token; returning []");
    return [];
  }

  const params = new URLSearchParams();
  if (groups != null) params.set("groups", String(groups));
  if (date) params.set("date", date);                // YYYY-MM-DD, ET
  if (week != null) params.set("week", String(week));
  if (year != null) params.set("year", String(year));
  if (seasonType) params.set("seasonType", String(seasonType));

  const url = `https://api.collegefootballdata.com/scoreboard?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json"
      },
      cache: "no-store",
    });
    if (!res.ok) {
      if (DEV) console.warn("[cfbdLive:v2] non-2xx", res.status, await res.text().catch(()=>"-"));
      return [];
    }
    const json = await res.json();
    if (DEV) console.debug("[cfbdLive:v2] scoreboard items:", Array.isArray(json) ? json.length : "n/a");
    return Array.isArray(json) ? json : [];
  } catch (e) {
    if (DEV) console.warn("[cfbdLive:v2] fetch error:", e);
    return [];
  }
}

export default { normalizeScoreboardItems, fetchCfbdScoreboard };
