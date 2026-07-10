import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { collection, query, where, getDocs, doc, writeBatch, serverTimestamp } from "firebase/firestore";

/* ===== helpers ===== */
const deaccent = (s) => String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const simplify = (s) => deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g,"").trim();

/** Keep school tokens (strip mascot if obvious) */
function stripMascot(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  if (/\(.+\)$/.test(raw)) return raw; // keep "Miami (OH)"
  const keepers = new Set(["State","Tech","A&M","A&T","&","Atlantic","Miss","Ole","Miami","Southern","Northern","Eastern","Western","Central"]);
  const parts = raw.split(/\s+/);
  const mascots = new Set([
    "Tigers","Bulldogs","Rebels","Razorbacks","Hurricanes","Hokies","Seminoles","Gators","Longhorns","Aggies","Volunteers",
    "Lions","Wildcats","Heels","Owls","Blazers","Gamecocks","Bruins","Trojans","Mustangs","Bearcats","Huskies","Beavers",
    "Cardinal","Ducks","Hawks","Bears","Spartans","Redhawks","Bobcats","Warhawks","Eagles","Flashes","Wave","Midshipmen",
    "Green","Mean","Wolfpack","Tar","Heels","Danes","Great"
  ]);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!keepers.has(last) && mascots.has(last)) parts.pop();
  }
  return parts.join(" ");
}

/** RFC-4180-ish CSV parser (handles quotes + CRLF) */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "");

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuotes && s[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      row.push(field); field = "";
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = "";
      if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
  return rows.map(r => r.map(x => String(x).replace(/^\uFEFF/, "").trim()));
}

async function fetchGames(year, week) {
  const qy = query(collection(db, "games"), where("year","==", Number(year)), where("week","==", Number(week)));
  const snap = await getDocs(qy);
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

/** alias expansion for tricky names */
const ALIAS_MAP = new Map([
  ["massachusetts","umass"], ["longislanduniversity","liu"],
  ["floridaatlantic","fau"], ["floridainternational","fiu"],
  ["southerncalifornia","usc"], ["california","cal"],
  ["arkansaspinebluff","uapb"], ["texasam","texasam"],
  ["olemiss","olemiss"], ["southernmiss","southernmiss"],
  ["utsa","utsa"], ["smu","smu"], ["tcu","tcu"], ["ucla","ucla"], ["usc","usc"],
  ["ohiostate","ohiostate"], ["texasstate","texasstate"]
]);

function expandTokens(name) {
  const full = simplify(String(name||""));
  const school = simplify(stripMascot(name));
  const set = new Set([full, school]);
  for (const t of Array.from(set)) {
    if (ALIAS_MAP.has(t)) set.add(ALIAS_MAP.get(t));
    for (const [k,v] of ALIAS_MAP.entries()) if (v === t) set.add(k);
  }
  const out = new Set();
  for (const t of set) out.add(t.replace(/&/g,""));
  return out;
}

/* ===== component ===== */
export default function BulkImportPicksPreview({ year, week }) {
  const [csv, setCsv] = useState("");
  const [games, setGames] = useState([]);
  const [report, setReport] = useState("");
  const [details, setDetails] = useState([]);
  const [dryRun, setDryRun] = useState(true);
  const [status, setStatus] = useState("");
  const [diag, setDiag] = useState([]);
  const [bfDiag, setBfDiag] = useState([]);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => { (async () => { try { setGames(await fetchGames(year, week)); } catch { setGames([]); } })(); }, [year, week]);

  const dbGames = useMemo(() => games.map(g => {
    const awayTokens = expandTokens(g.away);
    const homeTokens = expandTokens(g.home);
    return {
      id: g.id,
      awayTokens, homeTokens,
      awayKey: g.awayId || g.away,
      homeKey: g.homeId || g.home,
      label: stripMascot(g.away) + " @ " + stripMascot(g.home)
    };
  }), [games]);

  function headerMatchesGame(s, g) {
    let hasAway = false, hasHome = false;
    for (const t of g.awayTokens) { if (t && s.includes(t)) { hasAway = true; break; } }
    for (const t of g.homeTokens) { if (t && s.includes(t)) { hasHome = true; break; } }
    return hasAway && hasHome;
  }

  /* ==== header check ==== */
  function runCheck() {
    const table = parseCSV(csv);
    if (table.length < 2) { setReport("Need headers + at least one data row."); setDetails([]); return; }

    const headers = table[0];
    const hsRaw = headers.map(h => String(h).trim());
    const hs = hsRaw.map(h => simplify(h));

    const hasEmail = hsRaw.some(h => /email/i.test(h));
    const hasPhone = hsRaw.some(h => /phone/i.test(h));
    const hasVenmo = hsRaw.some(h => /venmo/i.test(h));
    const hasFirst = hsRaw.some(h => /\bfirst\b/i.test(h));
    const hasLast  = hsRaw.some(h => /\blast\b/i.test(h));
    const hasName  = hsRaw.some(h => /\bname\b/i.test(h) && !/username/i.test(h));

    const looksTieHeader = (raw) => /total\s*points/i.test(String(raw));

    const sheetGames = hs.map((s, i) => ({ i, s, raw: hsRaw[i] }))
      .filter(({ s, raw }) => !looksTieHeader(raw) && dbGames.some(g => headerMatchesGame(s, g)));

    let matched = 0;
    const unmatched = [];
    for (const { s, raw } of sheetGames) {
      const found = dbGames.find(g => headerMatchesGame(s, g));
      if (found) matched++; else if (unmatched.length < 6) unmatched.push(raw);
    }

    let dbCovered = 0;
    for (const g of dbGames) if (hs.some(s => headerMatchesGame(s, g))) dbCovered++;

    setReport(
      "Parsed " + (table.length - 1) + " row(s). " +
      "Sheet game headers: " + sheetGames.length + ". " +
      "Matched (sheet→DB): " + matched + "/" + sheetGames.length + ". " +
      "DB games covered by sheet: " + dbCovered + "/" + dbGames.length + ". " +
      "Detected: " + (hasEmail ? "email " : "") + (hasPhone ? "phone " : "") + (hasVenmo ? "venmo " : "") +
      (hasFirst||hasLast ? (hasFirst?"first ":"")+(hasLast?"last ":"") : (hasName?"name ":""))
    );
    setDetails(unmatched);
  }

  function splitName(name) {
    const raw = String(name||"").trim();
    if (!raw) return { firstName:"", lastName:"" };
    if (raw.includes(",")) { const parts = raw.split(","); return { firstName: (parts[1]||"").trim(), lastName: (parts[0]||"").trim() }; }
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { firstName: parts[0], lastName: "" };
    const last = parts.pop();
    return { firstName: parts.join(" "), lastName: last };
  }
  const boolish = (v) => ["y","yes","true","1","paid"].includes(String(v||"").trim().toLowerCase());

  function mapColumns2(headers, rows) {
    const hsRaw = headers.map(h => String(h).trim());
    const hs = hsRaw.map(h => simplify(h));

    const findIdx = (...labels) => {
      for (const lab of labels) {
        const re = new RegExp(lab, "i");
        const idx = hsRaw.findIndex(h => re.test(h));
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const iEmail = findIdx("^Email", "Email Address", "E-mail");
    const iName  = findIdx("^Name$", "^Full Name", "^Fullname");
    const iFirst = findIdx("^First Name", "^First\\b", "^Firstname");
    const iLast  = findIdx("^Last Name", "^Last\\b", "^Lastname");
    const iPhone = findIdx("^Phone", "Phone Number", "Phone #");
    const iVenmo = findIdx("^Venmo", "Venmo Username", "Venmo Username \\(For Payout\\)");
    const iPaid  = findIdx("Did you Venmo", "^Paid$", "Payment");
    const iTieTotal = hsRaw.findIndex(h => /total\s*points/i.test(String(h)));

    const looksTieHeader = (raw) => /total\s*points/i.test(String(raw));

    const gameCols = {};
    hs.forEach((s, i) => {
      const rawH = hsRaw[i];
      if (looksTieHeader(rawH)) return;
      const g = dbGames.find(gm => headerMatchesGame(s, gm));
      if (g) gameCols[i] = g;
    });

    return { iEmail, iName, iFirst, iLast, iPhone, iVenmo, iPaid, iTieTotal, gameCols };
  }

  function generateCode(existing) {
    let code = "";
    do { code = String(Math.floor(100000 + Math.random() * 900000)); }
    while (existing.has(code));
    existing.add(code);
    return code;
  }

  /* ==== import ==== */
  const runImport = async () => {
    setReport("");
    setBfDiag([]);
    setStatus(dryRun ? "Dry run: analyzing..." : "Writing...");
    try {
      const table = parseCSV(csv);
      if (table.length < 2) { setStatus("No data rows. Paste CSV and Check headers first."); return; }
      const headers = table[0];
      const rows = table.slice(1);
      const mapped = mapColumns2(headers, rows);
      const { iName, iFirst, iLast, iPhone, iVenmo, iPaid, iTieTotal, gameCols } = mapped;
      const colCount = Object.keys(gameCols).length;

      const codes = new Set();
      const outDocs = [];
      const diagRows = [];
      const gdGame = Array.isArray(games) ? (games.find(x => x && x.gameday) || null) : null;

      for (const cells of rows) {
        let firstName = iFirst >= 0 ? cells[iFirst] : "";
        let lastName  = iLast  >= 0 ? cells[iLast]  : "";
        if ((!firstName || !lastName) && iName >= 0) {
          const s = splitName(cells[iName]);
          if (!firstName) firstName = s.firstName;
          if (!lastName)  lastName  = s.lastName;
        }

        const norm = (x) => {
          const s = String(x || "").trim();
  if (!enabled) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
  <h3 style={{ marginTop: 0 }}>Bulk import picks (CSV)</h3>
  <button type="button" onClick={e => setEnabled(false)}>Close</button>
</div>
      </div>
      <button type="button" onClick={e => setEnabled(true)}>Open CSV importer</button>
      <div style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
        The importer is hidden. Click the button to open it.
      </div>
    </div>
  );
}
  return (s === "-" || /^n\/?a$/i.test(s)) ? "" : s;
        };
        const phone = iPhone >= 0 ? norm(cells[iPhone]) : "";
        const venmo = iVenmo >= 0 ? norm(cells[iVenmo]) : "";
        const venmoConfirmed = iPaid >= 0 ? boolish(cells[iPaid]) : false;

        let tiebreakerTotal = null;
        if (iTieTotal >= 0) {
          const m = String(cells[iTieTotal] || "").match(/\d+(\.\d+)?/);
          if (m) tiebreakerTotal = Number(m[0]);
        }

        const picks = {};
        for (const iStr in gameCols) {
          const i = Number(iStr);
          const g = gameCols[i];
          const v = simplify(cells[i] || "");

          let choice = null;
          if (v === "away" || v === "a") choice = g.awayKey;
          else if (v === "home" || v === "h") choice = g.homeKey;
          else {
            let hitsAway = false, hitsHome = false, awayLen = 0, homeLen = 0;
            for (const t of g.awayTokens) { if (t && v.includes(t)) { hitsAway = true; if (t.length > awayLen) awayLen = t.length; } }
            for (const t of g.homeTokens) { if (t && v.includes(t)) { hitsHome = true; if (t.length > homeLen) homeLen = t.length; } }
            if (hitsAway && !hitsHome) choice = g.awayKey;
            else if (hitsHome && !hitsAway) choice = g.homeKey;
            else if (hitsAway && hitsHome) {
              if (awayLen > homeLen) choice = g.awayKey;
              else if (homeLen > awayLen) choice = g.homeKey;
            }
          }
          if (choice) picks[g.id] = choice;
        }

        const requiredOK = (Boolean(firstName) || Boolean(lastName)) && (Object.keys(picks).length === colCount);

        const missing = [];
        for (const iStr in gameCols) {
          const i = Number(iStr);
          const g = gameCols[i];
          if (!picks[g.id]) missing.push({ index: i, header: headers[i], value: cells[i] });
        }
        diagRows.push({
          name: ((firstName ? (firstName + " ") : "") + (lastName || "")).trim(),
          picksCount: Object.keys(picks).length,
          expected: colCount,
          missing,
          nameOk: Boolean(firstName || lastName)
        });

        if (!requiredOK) continue;

        const code = generateCode(codes);
        const id = String(year) + "_W" + String(week) + "_" + code;
        const docData = {
          id, year: Number(year), week: Number(week), code,
          firstName, lastName, lastNameLower: String(lastName || "").toLowerCase(),
          phone, venmo, venmoConfirmed,
          tiebreakerTotal: tiebreakerTotal,
          picks,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        };
        if (gdGame && tiebreakerTotal !== null) {
          docData.tiebreaker = { gameId: gdGame.id, total: tiebreakerTotal };
        }
        outDocs.push(docData);
      }

      setDiag(diagRows);
      if (dryRun) {
        setStatus("Dry run: would write " + outDocs.length + "/" + rows.length + " picks (" + colCount + " games matched).");
        return;
      }

      let written = 0;
      for (let i = 0; i < outDocs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of outDocs.slice(i, i + 400)) {
          batch.set(doc(db, "picks", d.id), d, { merge: true });
        }
        await batch.commit();
        written += Math.min(400, outDocs.length - i);
      }
      setStatus("Imported " + written + " pick(s).");
    } catch (e) {
      console.error(e);
      setStatus("Failed to import. See console.");
    }
  };

  /* ==== backfill (with dry-run preview) ==== */
  const runBackfill = async () => {
    setReport("");
    setDiag([]);
    try {
      const table = parseCSV(csv);
      if (table.length < 2) { setStatus("No data rows. Paste CSV first."); return; }
      const headers = table[0];
      const rows = table.slice(1);
      const { iPhone, iVenmo, iTieTotal } = mapColumns2(headers, rows);
      if (iTieTotal < 0) { setStatus("Could not find the 'Total Points' column in the CSV."); return; }

      const gdGame = Array.isArray(games) ? (games.find(g => g && g.gameday) || null) : null;
      if (!gdGame) { setStatus("Could not determine GameDay game from DB."); return; }

      const toDigits = (x) => String(x||"").replace(/\D+/g,"");
      const totalsByVenmo = new Map();
      const totalsByPhone = new Map();
      for (const cells of rows) {
        const ven = iVenmo >= 0 ? String(cells[iVenmo]||"").trim().toLowerCase() : "";
        const ph  = iPhone >= 0 ? toDigits(cells[iPhone]) : "";
        const m   = String(cells[iTieTotal] || "").match(/\d+(\.\d+)?/);
        const total = m ? Number(m[0]) : null;
        if (total !== null) {
          if (ven) totalsByVenmo.set(ven, total);
          if (ph && ph.length >= 7) totalsByPhone.set(ph, total);
        }
      }

      const psnap = await getDocs(query(collection(db, "picks"),
        where("year","==", Number(year)), where("week","==", Number(week))
      ));

      const docsArr = psnap.docs;
      const matches = [];
      for (const d of docsArr) {
        const data = d.data() || {};
        const ven  = String(data.venmo || "").trim().toLowerCase();
        const ph   = toDigits(data.phone || "");
        const total = (ven && totalsByVenmo.get(ven)) ?? (ph && totalsByPhone.get(ph));
        if (total !== undefined && total !== null) {
          matches.push({
            id: d.id,
            name: ((data.firstName||"") + " " + (data.lastName||"")).trim(),
            venmo: data.venmo || "",
            phoneLast4: (ph || "").slice(-4),
            total
          });
        }
      }

      if (dryRun) {
        setBfDiag(matches);
        setStatus("Backfill dry run: would update " + matches.length + "/" + psnap.size + " pick(s).");
        return;
      }

      let updated = 0;
      for (let i = 0; i < matches.length; i += 400) {
        const batch = writeBatch(db);
        for (const m of matches.slice(i, i+400)) {
          batch.set(doc(db, "picks", m.id),
            { tiebreaker: { gameId: gdGame.id, total: m.total }, tiebreakerTotal: m.total },
            { merge: true }
          );
        }
        await batch.commit();
        updated += Math.min(400, matches.length - i);
      }
      setBfDiag([]);
      setStatus("Backfilled tiebreakers on " + updated + "/" + psnap.size + " pick(s).");
    } catch (e) {
      console.error(e);
      setStatus("Backfill failed. See console.");
    }
  };
  if (!enabled) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
  <h3 style={{ marginTop: 0 }}>Bulk import picks (CSV)</h3>
  <button type="button" onClick={e => setEnabled(false)}>Close</button>
</div>
      </div>
      <button type="button" onClick={e => setEnabled(true)}>Open CSV importer</button>
      <div style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
        The importer is hidden. Click the button to open it.
      </div>
    </div>
  );
}
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
  <h3 style={{ marginTop: 0 }}>Bulk import picks (CSV)</h3>
  <button type="button" onClick={e => setEnabled(false)}>Close</button>
</div>
      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>
        1) Paste CSV (File → Download → CSV). 2) Click <b>Check headers</b>. 3) Leave <b>Dry run</b> on and click <b>Import</b> to simulate. 4) Uncheck <b>Dry run</b> to write. 5) Use <b>Backfill</b> to add tiebreakers to already-written docs.
      </div>
      <textarea
        value={csv}
        onChange={e => setCsv(e.target.value)}
        placeholder="Paste CSV here"
        style={{ width:"100%", height: 140 }}
      />
      <div style={{ display:"flex", gap:12, alignItems:"center", marginTop:8, flexWrap:"wrap" }}>
        <button type="button" onClick={runCheck}>Check headers</button>
        <label style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
          <input type="checkbox" checked={dryRun} onChange={e=>setDryRun(e.target.checked)} />
          Dry run
        </label>
        <button type="button" onClick={runImport}>Import</button>
        <button type="button" onClick={runBackfill}>Backfill tiebreakers (update)</button>
        <div style={{ fontSize: 13, opacity: 0.85 }}>{report}</div>
        {status && <div style={{ fontSize: 13, opacity: 0.85 }}>{status}</div>}
      </div>

      {/* Import diagnostics (rows short on picks / missing name) */}
      {diag && !!diag.length && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>Rows needing attention:</div>
          <div style={{ maxHeight: 240, overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, whiteSpace: 'pre-wrap', border: '1px solid #eee', padding: 8, borderRadius: 8 }}>
            {diag.filter(r => (r.picksCount < r.expected) || !r.nameOk).map((r, idx) => (
              <div key={idx} style={{ marginBottom: 6 }}>
                • {r.name || '(no name)'} — {r.picksCount}/{r.expected} picks — {r.nameOk ? "name OK" : "missing name"}
                {r.missing && r.missing.length > 0 && r.missing.map((m, j) => (
                  <div key={j} style={{ marginLeft: 14 }}>
                    - {String(m.header || '')}: "{String(m.value || '')}"
                  </div>
                ))}
              </div>
            ))}
            {diag.filter(r => (r.picksCount < r.expected) || !r.nameOk).length === 0 && <div>All rows have full picks.</div>}
          </div>
        </div>
      )}

      {/* Backfill preview */}
      {bfDiag && bfDiag.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>Backfill preview:</div>
          <div style={{ maxHeight: 240, overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, whiteSpace: 'pre-wrap', border: '1px solid #eee', padding: 8, borderRadius: 8 }}>
            {bfDiag.map((m, idx) => (
              <div key={idx} style={{ marginBottom: 6 }}>
                • {m.name || '(no name)'} — {m.venmo || 'no venmo'} — ****{m.phoneLast4 || ''} — total: {m.total}
              </div>
            ))}
          </div>
        </div>
      )}

      {!!details.length && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          Examples of unmatched sheet headers: {details.join(" • ")}
        </div>
      )}
    </div>
  );
}



