/** Fetch CFBD /games for a given (year, week), normalize to Scorebug-live shape by our gameId convention. */
export async function cfbdGamesWeek({ year, week, token }) {
  try {
    if (!year || !week || !token) return new Map();
    const url = `https://api.collegefootballdata.com/games?year=${Number(year)}&week=${Number(week)}&division=fbs`;
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` }});
    if (!res.ok) return new Map();
    const arr = await res.json();
    const norm = (s) => {
      if (!s) return "";
      let t = String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"");
      t = t.replace(/&/g, "and");
      t = t.replace(/[^A-Za-z0-9 ]+/g," ").replace(/\s+/g," ").trim();
      return t;
    };
    const toId = (away, home) => {
      const A = norm(away).replace(/\s+/g,"");
      const H = norm(home).replace(/\s+/g,"");
      // Our app uses: `${year}_W${week}_${Away}_at_${Home}` (words concatenated)
      return `${year}_W${week}_` + A + "_at_" + H;
    };
    const m = new Map();
    for (const g of Array.isArray(arr) ? arr : []) {
      const gid = toId(g.away_team, g.home_team);
      const hp  = Number.isFinite(+g.home_points) ? +g.home_points : null;
      const ap  = Number.isFinite(+g.away_points) ? +g.away_points : null;
      // status from CFBD 'completed' or 'final' ? "final"
      const st  = (g.status && String(g.status).toLowerCase().includes("final")) || g.completed ? "final" : null;
      m.set(gid, {
        status: st,
        period: st === "final" ? 4 : null,
        clock: null,
        homePoints: hp,
        awayPoints: ap,
        possession: null
      });
    }
    return m;
  } catch (e) {
    console.error("[cfbdGamesWeek] failed", e);
    return new Map();
  }
}
