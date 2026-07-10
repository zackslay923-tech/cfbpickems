/**
 * SCOREBUG v1 — presentational only (no data fetching).
 * Props:
 *  - awayId, homeId: strings used by <TeamLogo school={...}/>
 *  - kickoffLabel: preformatted ET time (e.g., "Sat 3:30 PM ET")
 *  - live: { status, period, clock, homePoints, awayPoints, possession } | null
 */

import React from "react";

import { useRef, useLayoutEffect } from 'react';
import TeamLogo from "./TeamLogo";

const Scorebug = React.memo(function Scorebug({
  awayId,
  homeId,
  kickoffLabel,
  live,
}) {
  const status = live?.status ?? "scheduled";
  const isLive = (status === "in_progress" || status === "live");
  const period = live?.period;
  const clock = live?.clock;
  const clockDisplay = (Number(period) === 2 && typeof clock !== 'undefined' && clock !== null && /^0+:?0{2}$/.test(String(clock))) ? 'HALF' : clock;
  const awayPts = Number.isFinite(live?.awayPoints) ? live.awayPoints : null;
  const homePts = Number.isFinite(live?.homePoints) ? live.homePoints : null;
  const possession = live?.possession; // "home" | "away" | undefined

  // center status line
  let centerText = kickoffLabel || "";
  if (status === "final" || status === "completed") {
    centerText = period && period > 4 ? "FINAL/OT" : "FINAL";
  } else if (status === "halftime") {
    centerText = "HALF";
  } else if (status === "in_progress" || status === "live") {
    if (period && clock) centerText = `Q${period} • ${clockDisplay}`;
    else if (period) centerText = `Q${period}`;
    else centerText = "LIVE";
  } else if (typeof status === "string" && /delay|suspend|cancel/i.test(status)) {
    centerText = status.toUpperCase().replace("_"," ");
  }

  const haveBoth = awayPts != null && homePts != null;
  const awayLead = haveBoth ? awayPts > homePts : false;
  const homeLead = haveBoth ? homePts > awayPts : false;

  return (
    <div
      className="scorebug"
      data-testid={`scorebug-${awayId}__${homeId}`}
      aria-label={`${awayId} ${awayPts ?? "–"}, ${homeId} ${homePts ?? "–"}, ${centerText}`}
    >
      <div className="sb-side sb-away">
        
        <div className="sb-logo">
          <TeamLogo school={awayId} size={42} />{possession === "away" && status !== "final" && status !== "postgame" && status !== "completed" && <span className="sb-possession" role="img" aria-label="possession" style={{ display:"inline-block", margin:"0 6px", fontSize:14, lineHeight:1, transform:"rotate(45deg)", transformOrigin:"50% 50%" }}><img src="/logos/footballarrow.png" alt="" width="12" height="12" style={{verticalAlign:"-1px"}} /></span>}
        </div>
        <div className={`sb-score ${awayLead ? "sb-lead" : ""}`} aria-live="polite" data-testid="away-score">
          {awayPts ?? "–"}
        </div>
      </div>

      <div className={"sb-center " + (isLive ? "sb-live" : "")} data-testid="status"><span className="sb-time">{centerText}</span></div>

      <div className="sb-side sb-home">
  
  <div className="sb-logo">
    <TeamLogo school={homeId} size={42} />{possession === "home" && status !== "final" && status !== "postgame" && status !== "completed" && <span className="sb-possession" role="img" aria-label="possession" style={{ display:"inline-block", margin:"0 6px", fontSize:14, lineHeight:1, transform:"rotate(45deg)", transformOrigin:"50% 50%" }}><img src="/logos/footballarrow.png" alt="" width="12" height="12" style={{verticalAlign:"-1px"}} /></span>}
  </div>
  <div className={`sb-score ${homeLead ? "sb-lead" : ""}`} aria-live="polite" data-testid="home-score">
    {homePts ?? "–"}
  </div>
</div>

      <style>{`
  .scorebug {
    display: grid;
    grid-template-areas:
      "top"
      "away"
      "home";
    grid-template-rows: auto auto auto;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(12,16,22,.92), rgba(8,11,16,.92));
    box-shadow: 0 2px 12px rgba(0,0,0,.35);
    font-size: 14px;
    line-height: 1;
    color: rgba(255,255,255,.92);
    user-select: none;
    width: 100%;
  }

  /* top row: possession left, time/quarter right */
  .sb-center {
  container-type: inline-size;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  opacity: .95;
  max-width: 100%;
  min-width: 0;
}
  .sb-possession { font-size: 11px; opacity: .85; display: inline-flex; align-items: center; overflow: visible; }
  
  .sb-possession img { width: 14px !important; height: 14px !important; display: inline-block; }.sb-time, .sb-clock {
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  letter-spacing: .1px;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  font-size: clamp(10px, 3.5cqw, 12px);
}

  /* middle & bottom rows: team rows */
  .sb-away { grid-area: away; }
  .sb-home { grid-area: home; }

  .sb-side {
    display: grid;
    grid-template-columns: auto 1fr auto; /* logo | name | score */
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  /* LOGO: left-aligned contents */
  .sb-logo {
    width: 42px; height: 42px;
    border-radius: 0;
    background: transparent;
    overflow: visible;
    display: flex;
    align-items: center;
    justify-content: flex-start;  /* left-align inner content */
    padding-left: 2px;            /* slight inset so it doesn’t touch the edge */
    font-weight: 700;
  }
  .sb-logo img {
    width: 100%; height: 100%;
    object-fit: contain;
    object-position: left center; /* anchor image to the left */
    display: block;
  }

  .sb-team { min-width: 0; }
  .sb-name {
    font-size: 13px;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: .95;
  }
  .sb-seed { font-size: 11px; opacity: .75; }
  .sb-score {
    min-width: 36px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 18px;
  }

  @media (max-width: 768px) {
    .scorebug { gap: 8px; padding: 8px 10px; }
    .sb-logo { border-radius: 0; overflow: visible; width: 42px; height: 42px; }
    .sb-score { min-width: 32px; font-size: 16px; }
  }

  .sb-center.sb-live { color: #EF4444; font-weight: 800; }

  /* Force centered top row (time/clock/quarter) */
  .sb-top { justify-content: center !important; text-align: center; width: 100%; }
  .sb-top > * { text-align: center; }

  /* Vertical centering for top row */
  .sb-top { align-items: center !important; }
`}</style>
    </div>
  );
});

export default Scorebug;

































