import React, { useEffect, useMemo, useState } from "react";

/**
 * Local-only team logo loader for Pick'ems.
 * - Probes /public/logos/*.png (no remote fetch).
 * - Builds multiple filename candidates from the provided "school" string.
 * - Renders nothing until a logo (or fallback) actually decodes.
 * - Falls back to /logos/_default.png only if none of the candidates load.
 * - Busts cache with ASSET_VER whenever logos change.
 */
const ASSET_VER = "logos-local-7";

function deaccent(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normId(s) {
  return deaccent(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function squeezeWords(s) {
  return deaccent(s).toLowerCase().replace(/[^\w]+/g, " ").trim().replace(/\s+/g, "");
}

/**
 * Remove trailing mascot words while preserving school tokens.
 * Keeps tokens like "State", "Tech", "A&M", "A&T", "College", "University".
 */
function stripMascot(name) {
  const keepers = new Set(["State", "Tech", "A&M", "A&T", "&", "University", "College", "Institute"]);
  const adj = new Set(["Tar","Nittany","Fighting","Ragin","Mean","Golden","Black","Blue","Green","Crimson","Scarlet","Red","Orange","Rainbow","War","Great","Lady"]);
  let parts = String(name || "").trim().split(/\s+/);

  // Preserve parenthetical qualifiers as part of the school (e.g., "Miami (OH)")
  // If last token is like "(OH)" treat it as part of the school.
  const endsWithParen = /\(.+\)$/.test(name || "");
  if (endsWithParen) return name;

  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (keepers.has(last) || /\)/.test(last)) break;
    // Pop mascot words; also strip trailing adjectives like "Golden" in "Golden Flashes"
    parts.pop();
    while (parts.length > 1 && adj.has(parts[parts.length - 1])) parts.pop();
    // Stop if we'd collapse to 1–2 words which are almost certainly the school
    if (parts.length <= 2) break;
  }
  return parts.join(" ");
}

/**
 * Known alias map: normalized key -> normalized filename (without ".png").
 * Keep this conservative to avoid wrong matches. Abbreviations known to exist locally are mapped to long forms.
 */
const ALIASES = new Map(Object.entries({
  // Common local abbreviation files you mentioned
  "unc": "northcarolinatarheels",
  "pitt": "pittsburghpanthers",
  "cal": "californiagoldenbears",
  "usf": "southfloridabulls",  
  "famu": "famu",
  "floridaam": "famu",
  "floridaamrattlers": "famu",

  // Helpful long?short bridges for frequent mismatches
  "miamioh": "miamiohredhawks",
  "miamiohio": "miamiohredhawks",
  "hawaii": "hawaiirainbowwarriors",
  "olemiss": "mississippirebels",
  "nicholls": "nichollsstate",
  "searizonalouisiana": "southeasternlouisiana", // guard against weird minifications
}));

/**
 * Expand candidate filename ids from a given display string.
 */
function buildCandidates(display) {
  const raw = String(display || "").trim();
  if (!raw) return [];

  const schoolOnly = stripMascot(raw);

  // Normalize variants
  const full = normId(raw);
  const school = normId(schoolOnly);

  // Add “St” ? “State” looseners for school-only variant
  const schoolLoose = school
    .replace(/\bst\b/g, "state")
    .replace(/\bste\b/g, "state");

  const cands = [];

  // 1) Full as-is (if it already includes the mascot, this usually wins)
  if (full) cands.push(full);

  // 2) School-only
  if (school && school !== full) cands.push(school);
  if (schoolLoose && schoolLoose !== school) cands.push(schoolLoose);

  // 3) Minus last word / last two (from school-only)
  const words = deaccent(schoolOnly).split(/\s+/);
  if (words.length >= 3) cands.push(normId(words.slice(0, -1).join(" ")));
  if (words.length >= 4) cands.push(normId(words.slice(0, -2).join(" ")));

  // 4) Aliases (check both full and school ids)
  const aliasFromFull = ALIASES.get(full);
  const aliasFromSchool = ALIASES.get(school) || ALIASES.get(schoolLoose);
  if (aliasFromFull) cands.push(aliasFromFull);
  if (aliasFromSchool) cands.push(aliasFromSchool);

  // 5) Squeezed tokens (defensive against odd filenames)
  cands.push(squeezeWords(schoolOnly));

  // Deduplicate while preserving order
  return [...new Set(cands)];
}

async function probe(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ ok: true, src });
    im.onerror = () => resolve({ ok: false, src });
    im.src = src;
  });
}

export default function TeamLogo({ school, size = 96, alt, style, className, ...rest }) {
  const [resolved, setResolved] = useState(undefined); // undefined = not ready; string = url
  const candidates = useMemo(() => buildCandidates(school), [school]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Try each candidate under /logos/*.png with cache bust
      for (const id of candidates) {
        const url = `/logos/${id}.png?v=${ASSET_VER}`;
        const res = await probe(url);
        if (cancelled) return;
        if (res.ok) {
          setResolved(res.src);
          return;
        }
      }
      // Fallback
      const def = `/logos/_default.png?v=${ASSET_VER}`;
      const res = await probe(def);
      if (!cancelled && res.ok) setResolved(res.src);
    }

    setResolved(undefined);
    run();

    return () => { cancelled = true; };
  }, [candidates.join("|")]);

  if (!resolved) return null;

  const px = Number.isFinite(size) ? size : 96;
  const aria = alt || (school ? `${school} logo` : "Team logo");

  return (
    <img
      src={resolved}
      alt={aria}
      width={px}
      height={px}
      className={className}
      style={{ display: "block", objectFit: "contain", width: px, height: px, ...style }}
      {...rest}
    />
  );
}


