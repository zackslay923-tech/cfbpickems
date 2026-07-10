// /web/src/lib/cfbd.js
// Utilities to pull team logo URLs from the CollegeFootballData (CFBD) API
// and produce a lookup map keyed by normalized school name.
//
// Reads your API key from Firestore doc: config/cfbd { apiKey: "..." }
// Make sure only Admins can read this doc via Firestore Rules.

import { doc, getDoc } from "firebase/firestore";

export const normalize = (s = "") => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function getCfbdKey(db) {
  const snap = await getDoc(doc(db, "config", "cfbd"));
  const key = snap.exists() ? snap.data().apiKey : null;
  if (!key) throw new Error("CFBD API key not found in Firestore at config/cfbd");
  return key;
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CFBD ${res.status} ${res.statusText}: ${url}\n${text}`);
  }
  return res.json();
}

/**
 * Build a map: { normalizedSchool: logoUrl }
 *
 * We query both FBS and FCS so your site covers games like Idaho State (FCS).
 * If you only need FBS, set includeFcs=false.
 */
export async function getLogoMap(db, { year, includeFcs = true } = {}) {
  const token = await getCfbdKey(db);
  const base = "https://api.collegefootballdata.com";

  // Prefer the generic /teams endpoint with classification filters for broad coverage.
  const params = year ? `?year=${encodeURIComponent(year)}` : "";
  const [fbs, fcs] = await Promise.all([
    fetchJson(`${base}/teams${params}${params ? "&" : "?"}classification=fbs`, token),
    includeFcs ? fetchJson(`${base}/teams${params}${params ? "&" : "?"}classification=fcs`, token) : Promise.resolve([]),
  ]);

  const all = [...fbs, ...(includeFcs ? fcs : [])];
  const map = {};

  for (const t of all) {
    // CFBD team object includes `school` and `logos` (array of URLs).
    const key = normalize(t.school);
    const url = Array.isArray(t.logos) && t.logos.length ? t.logos[0] : null;
    if (key && url && !map[key]) map[key] = url;

    // Also index common alternates (e.g., nicknames if provided)
    if (t.school?.includes("(")) {
      // e.g., "Miami (FL)" -> "miamifl"
      const alt = normalize(t.school.replace(/[()]/g, ""));
      if (alt && url && !map[alt]) map[alt] = url;
    }
    if (t.alt_name1) {
      const alt1 = normalize(t.alt_name1);
      if (alt1 && url && !map[alt1]) map[alt1] = url;
    }
    if (t.alt_name2) {
      const alt2 = normalize(t.alt_name2);
      if (alt2 && url && !map[alt2]) map[alt2] = url;
    }
  }

  return map;
}

/**
 * Derive logo URLs for a game object that has homeTeam/awayTeam strings.
 * Returns { homeLogo, awayLogo }.
 */
export function resolveGameLogos(game, logoMap) {
  const homeKey = normalize(game.homeTeam);
  const awayKey = normalize(game.awayTeam);
  return {
    homeLogo: logoMap[homeKey] ?? null,
    awayLogo: logoMap[awayKey] ?? null,
  };
}

