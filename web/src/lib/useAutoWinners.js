/**
 * useAutoWinners v1
 * Admin-only auto writer for winners when games finish.
 *
 * Call like:
 *   useAutoWinners({ isAdmin, year, week, games, resultsMap, liveMap, setResultFn })
 *
 * - games: array with { id, home, away }
 * - resultsMap: { [gameId]: {winner?, totalPoints?} } (what you already fetched)
 * - liveMap: Map keyed by "away__home" (or "home__away") -> { status, period, clock, homePoints, awayPoints }
 * - setResultFn: (gameId, winner, totalPoints) => Promise<void>
 */

import { useEffect, useRef } from "react";

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function keyBoth(away, home) {
  const a = norm(away), h = norm(home);
  return [a + "__" + h, h + "__" + a];
}

function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "final" || s === "completed" || s === "postgame";
}

export default function useAutoWinners({
  isAdmin,
  year,
  week,
  games,
  resultsMap,
  liveMap,
  setResultFn
}) {
  const writing = useRef(new Set()); // de-dupe while writes in flight

  useEffect(() => {
    if (!isAdmin) return;
    if (!Array.isArray(games) || games.length === 0) return;
    if (!liveMap || typeof liveMap.get !== "function") return;
    if (!resultsMap || typeof resultsMap !== "object") return;
    if (typeof setResultFn !== "function") return;

    const finalsToWrite = [];

    for (const g of games) {
      const already = resultsMap?.[g.id]?.winner;
      if (already) continue; // winner is already recorded

      const [k1, k2] = keyBoth(g.away, g.home);
      const live = liveMap.get(k1) || liveMap.get(k2);
      if (!live) continue;

      const { status, homePoints, awayPoints, period } = live;
      if (!isFinalStatus(status)) continue;

      // both scores must be numbers (0 is valid)
      const hp = Number.isFinite(homePoints) ? homePoints : null;
      const ap = Number.isFinite(awayPoints) ? awayPoints : null;
      if (hp === null || ap === null) continue;

      // ties shouldn't happen in CFB; if equal, skip
      if (hp === ap) continue;

      const winner = hp > ap ? g.home : g.away;
      const totalPoints = hp + ap;

      // avoid duplicate concurrent writes
      const key = g.id + "|" + winner + "|" + totalPoints;
      if (writing.current.has(key)) continue;

      finalsToWrite.push({ id: g.id, winner, totalPoints, key });
    }

    if (finalsToWrite.length === 0) return;

    (async () => {
      for (const f of finalsToWrite) {
        try {
          writing.current.add(f.key);
          await setResultFn(f.id, f.winner, f.totalPoints);
          // optional: console feedback for admins
          // eslint-disable-next-line no-console
          console.log("[auto-winner] set", { gameId: f.id, winner: f.winner, totalPoints: f.totalPoints });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[auto-winner] write failed", f, e);
        } finally {
          writing.current.delete(f.key);
        }
      }
    })();
  }, [isAdmin, year, week, games, resultsMap, liveMap, setResultFn]);
}