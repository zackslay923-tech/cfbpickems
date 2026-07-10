import React from "react";

const TEAM_ABBR_OVERRIDE = new Map([
  ["Florida State", "FSU"],
  ["Texas A&M", "TAMU"],
  ["UT San Antonio", "UTSA"],
  ["Miami (FL)", "MIA-FL"],
  ["Miami (OH)", "MIA-OH"],
]);

function compactCommonWords(s) {
  return s
    .replace(/\bState\b/gi, "St.")
    .replace(/\bInternational\b/gi, "Intl.")
    .replace(/\bUniversity\b/gi, "Univ.")
    .replace(/\bEastern\b/gi, "E.")
    .replace(/\bWestern\b/gi, "W.")
    .replace(/\bNorthern\b/gi, "N.")
    .replace(/\bSouthern\b/gi, "S.");
}

function initialsMiddleWords(s) {
  const parts = s.split(/\s+/);
  if (parts.length <= 2) return s;
  return [parts[0], ...parts.slice(1, -1).map(w => (w ? (w[0].toUpperCase() + ".") : "")), parts.at(-1)]
    .filter(Boolean)
    .join(" ");
}

function makeCompactName(full) {
  const compact = compactCommonWords(full);
  return initialsMiddleWords(compact);
}

/**
 * AbbrevIfOverflow — shows `full` unless it overflows, then tries:
 * 1) apiAbbr or override-map
 * 2) compacted version
 * 3) final hard cap (slice)
 */
export function AbbrevIfOverflow({
  full,
  apiAbbr,
  className,
  title = null,
  maxChars = 12,
}) {
  const [mode, setMode] = React.useState("full");
  const ref = React.useRef(null);

  React.useLayoutEffect(() => { setMode("full"); }, [full, apiAbbr]);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fitPass = () => {
      const over = el.scrollWidth > el.clientWidth;
      if (!over) return;

      const override = TEAM_ABBR_OVERRIDE.get(full);
      const abbrCandidate = override || apiAbbr;
      if (mode === "full" && abbrCandidate) { setMode("abbr"); return; }
      if (mode === "full" && !abbrCandidate) { setMode("compact"); return; }
      if (mode === "abbr") { setMode("compact"); return; }
      if (mode === "compact") { setMode("truncate"); return; }
    };

    const raf = requestAnimationFrame(fitPass);
    const ro = new ResizeObserver(() => fitPass());
    ro.observe(el);
    const onWinResize = () => fitPass();
    window.addEventListener("resize", onWinResize);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
    };
  }, [full, apiAbbr, mode]);

  let text = full;
  if (mode === "abbr") {
    text = TEAM_ABBR_OVERRIDE.get(full) || apiAbbr || full;
  } else if (mode === "compact") {
    text = makeCompactName(full);
  } else if (mode === "truncate") {
    const compact = makeCompactName(full);
    text = (compact.length > maxChars) ? compact.slice(0, maxChars) : compact;
  }

  return (
    <span
      ref={ref}
      className={className}
      style={{ display: "inline-block", maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "clip" }}
      title={title ?? full}
    >
      {text}
    </span>
  );
}
