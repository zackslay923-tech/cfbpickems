import React, { useEffect, useMemo, useState } from "react";
import { db, googleLogin } from "../firebase";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";

function Row({ children, style }) {
  return <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", ...style }}>{children}</div>;
}
function Card({ children, style }) {
  return <div style={{ background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16, padding:16, boxShadow:"0 10px 24px rgba(0,0,0,.25)", ...style }}>{children}</div>;
}
function Container({ children, maxWidth = 1100 }) {
  return <div style={{ maxWidth, margin:"0 auto", padding:24 }}>{children}</div>;
}
function Field({ label, children }) {
  return <label style={{ display:"flex", flexDirection:"column", gap:8, fontSize:14 }}>{label}{children}</label>;
}
const inputStyle = { background:"#0c1426", color:"#fff", border:"1px solid #1f2a44", padding:"10px 12px", borderRadius:10 };

function formatTs(ts) {
  try {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : (typeof ts.seconds === "number" ? new Date(ts.seconds * 1000) : new Date(ts));
    if (!(d instanceof Date) || isNaN(+d)) return "";
    return new Intl.DateTimeFormat("en-US",{ month:"short", day:"numeric", hour:"numeric", minute:"2-digit", hour12:true, timeZone:"America/New_York" }).format(d);
  } catch { return ""; }
}

// Simple right-side drawer
function Drawer({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true"
      onClick={(e)=>{ if (e.target === e.currentTarget) onClose(); }}
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.5)", zIndex:1000, display:"flex", justifyContent:"flex-end" }}>
      <div style={{ width:"min(520px, 100%)", height:"100%", background:"#0b1220", borderLeft:"1px solid #1f2a44", padding:16, overflow:"auto" }}>
        <Row style={{ justifyContent:"space-between" }}>
          <h3 style={{ margin:0 }}>{title}</h3>
          <button onClick={onClose}>Close</button>
        </Row>
        <div style={{ height:8 }} />
        {children}
      </div>
    </div>
  );
}

export default function AdminPicksPage({ user, isAdmin, setPage }) {
  // Default Year/Week from config/live (read-only)
  const [live, setLive] = useState(null);
  const [liveLoaded, setLiveLoaded] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      setLive(d);
      setLiveLoaded(true);
    });
    return () => unsub();
  }, []);

  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);  
  // One-time sync from config/live ? local state
  const [syncedFromLive, setSyncedFromLive] = useState(false);  
  // Default to live Year/Week exactly once when config/live arrives
  useEffect(() => {
    try {
      if (!syncedFromLive && liveLoaded && live && Number(live.year) && Number(live.week)) {
        setYear(Number(live.year));
        setWeek(Number(live.week));
        setSyncedFromLive(true);
      }
    } catch (e) { /* no-op */ }
  }, [live, liveLoaded, syncedFromLive]);

  // Stream all picks for the selected year/week (Admin only)
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!user || !isAdmin) return;
    setMsg("Loading picks…");
    setRows([]);
    const q = query(collection(db, "picks"), where("year", "==", Number(year)), where("week", "==", Number(week)));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      all.sort((a,b) => (a.lastNameLower||"").localeCompare(b.lastNameLower||"") || (a.firstName||"").localeCompare(b.firstName||""));
      setRows(all);
      setMsg(`Showing ${all.length} pick(s) for ${year} / W${week}`);
    }, (err) => {
      setMsg(`Error loading picks: ${err?.message || err}`);
    });
    return () => unsub();
  }, [user, isAdmin, year, week]);

  // Client-side filter box
  const [qtext, setQtext] = useState("");
  const filtered = useMemo(() => {
    const q = qtext.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(p => {
      const name = `${p.firstName||""} ${p.lastName||""}`.toLowerCase();
      const phone = (p.phone||"").toLowerCase();
      const venmo = (p.venmo||"").toLowerCase();
      const code = (p.code||"").toLowerCase();
      return name.includes(q) || phone.includes(q) || venmo.includes(q) || code.includes(q);
    });
  }, [rows, qtext]);

  // Selection (for Drawer)
  const [selected, setSelected] = useState(null);
  const openPick = (p) => setSelected(p);
  const closePick = () => setSelected(null);

  if (!user) {
    return (
      <Container>
        <Card>
          <h2>Admin Picks — Sign In Required</h2>
          <p>Please sign in with your admin Google account to continue.</p>
          <button onClick={googleLogin}>Admin Login</button>
        </Card>
      </Container>
    );
  }
  if (!isAdmin) {
    return (
      <Container>
        <Card>
          <h2>Admin Picks — Access Denied</h2>
          <p>Your account is not in <code>admins</code>. Ask an owner to add you.</p>
          <button onClick={()=>setPage("admin")}>Go to Admin Home</button>
        </Card>
      </Container>
    );
  }

  return (
    <Container>
      <Card>
        <Row style={{ justifyContent:"space-between" }}>
          <h2 style={{ margin:0 }}>Admin Picks Management</h2>
          <button onClick={()=>setPage("admin")}>Back to Admin Home</button>
        </Row>

        <div style={{ marginTop:8, color:"#9aa4c7" }}>
          Live view of <b>all picks</b> for the selected Year/Week. Click a row to view details (read-only).
        </div>

        <Row style={{ marginTop:16, gap:16 }}>
          <Field label="Year">
            <input style={{ ...inputStyle, width:"6rem" }} type="number" value={year} onChange={e=>setYear(Number(e.target.value))} />
          </Field>
          <Field label="Week">
            <input style={{ ...inputStyle, width:"4rem" }} type="number" value={week} onChange={e=>setWeek(Number(e.target.value))} />
          </Field>
          <Field label="Filter (name, code, phone, venmo)">
            <input style={{ ...inputStyle, width:"18rem" }} value={qtext} onChange={e=>setQtext(e.target.value)} placeholder="Start typing…" />
          </Field>
        </Row>

        <div style={{ marginTop:8, color:"#9aa4c7" }}>{msg}</div>

        <div style={{ marginTop:12, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:720 }}>
            <thead>
              <tr style={{ textAlign:"left" }}>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44", position:"sticky", left:0, background:"#121a2b", zIndex:1 }}>Name</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Code</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Phone</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Email</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Venmo</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Confirmed</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Created</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Updated</th>
                <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const name = `${p.firstName||""} ${p.lastName||""}`.trim() || p.email || "(no name)";
                const cnt = p.picks ? Object.keys(p.picks).length : 0;
                return (
                  <tr key={p.id} style={{ borderBottom:"1px solid #1f2a44", cursor:"pointer" }} onClick={()=>openPick(p)}>
                    <td style={{ padding:"8px 10px", position:"sticky", left:0, background:"#0b1220", zIndex:1 }}>{name}</td>
                    <td style={{ padding:"8px 10px", opacity:.9 }}>{p.code}</td>
                    <td style={{ padding:"8px 10px", opacity:.9 }}>{p.phone}</td><td>{p.email || ""}</td>
                    <td style={{ padding:"8px 10px", opacity:.9 }}>{p.venmo}</td>
                    <td style={{ padding:"8px 10px" }}>{p.venmoConfirmed ? "Yes" : "No"}</td>
                    <td style={{ padding:"8px 10px" }}>{cnt}</td>
                    <td style={{ padding:"8px 10px", opacity:.9 }}>{formatTs(p.createdAt)}</td>
                    <td style={{ padding:"8px 10px", opacity:.9 }}>{formatTs(p.updatedAt)}</td>
                    <td style={{ padding:"8px 10px" }}>
                      <button onClick={(e)=>{ e.stopPropagation(); openPick(p); }}>View</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Drawer open={!!selected} onClose={closePick} title={selected ? `Pick • ${selected.firstName||""} ${selected.lastName||""}` : "Pick"}>
          {selected && (
            <div>
              <Card>
                <Row style={{ justifyContent:"space-between" }}>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Doc ID</div>
                    <code style={{ fontSize:12, userSelect:"all" }}>{selected.id}</code>
                  </div>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Code</div>
                    <div style={{ fontWeight:600 }}>{selected.code}</div>
                  </div>
                </Row>
                <div style={{ height:12 }} />
                <Row style={{ gap:24, alignItems:"flex-start" }}>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Name</div>
                    <div>{(selected.firstName||"") + " " + (selected.lastName||"")}</div>
                  </div>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Phone</div>
          <div>Email</div>
                    <div>{selected.phone || ""}</div>
                  </div>
                  <div>
                    <div style={{ minWidth: 200, fontWeight:700 }}>Email</div><div style={{ opacity:.8, fontSize:12 }}>Email</div>
                    <div>{selected.venmo || ""}</div>
                  </div>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Venmo</div>
                    <div>{selected.venmoConfirmed ? "Yes" : "No"}</div>
                  </div>
                </Row>
                <div style={{ height:12 }} />
                <Row style={{ gap:24 }}>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Year / Week</div>
                    <div>{String(selected.year)} / W{String(selected.week)}</div>
                  </div>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Created</div>
                    <div>{formatTs(selected.createdAt)}</div>
                  </div>
                  <div>
                    <div style={{ opacity:.8, fontSize:12 }}>Updated</div>
                    <div>{formatTs(selected.updatedAt)}</div>
                  </div>
                </Row>
              </Card>

              <div style={{ height:12 }} />

              <Card>
                <h4 style={{ marginTop:0 }}>Picks</h4>
                <div style={{ fontSize:13, opacity:.9 }}>
                  {selected.picks ? (
                    <pre style={{ whiteSpace:"pre-wrap", wordBreak:"break-word", background:"transparent", padding:0, margin:0 }}>
{JSON.stringify(selected.picks, null, 2)}
                    </pre>
                  ) : (
                    <em>No picks object found.</em>
                  )}
                </div>
              </Card>

              <div style={{ height:12 }} />

              <Row style={{ justifyContent:"space-between" }}>
                <div style={{ opacity:.7, fontSize:12 }}>Read-only view (no admin editing).</div>
                <button onClick={closePick}>Close</button>
              </Row>
            </div>
          )}
        </Drawer>

      </Card>
    </Container>
  );
}








