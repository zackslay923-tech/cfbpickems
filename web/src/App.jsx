import teamColors from "./lib/teamColors.json";

/* === School color helpers === */
const normalizeName = (s) => String(s||"")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "");

const SCHOOL_COLORS = new Map(
  Object.entries(teamColors).map(([k,v]) => [normalizeName(k), String(v).toUpperCase()])
);

function textColorFor(bg) {
  try {
    const hex = String(bg||"").replace("#","");
    const full = hex.length===3 ? hex.split("").map(c=>c+c).join("") : hex;
    const r=parseInt(full.slice(0,2),16), g=parseInt(full.slice(2,4),16), b=parseInt(full.slice(4,6),16);
    const yiq=(r*299+g*587+b*114)/1000;
    return yiq >= 140 ? "#111" : "#fff";
  } catch(e) { return "#fff"; }
}
const schoolBg = (name) => (name ? (SCHOOL_COLORS.get(normalizeName(name)) || null) : null);

/* Winners row style (pure fn so we can call it from JSX) */
const winnerCellStyleFn = (results, cell, g) => {
  const COL_W = 140;
  const base = {
    ...cell,
    fontWeight: 700,
    fontSize: "15px",
    textAlign: "center",
    width: COL_W,
    minWidth: COL_W,
  };
  const w = results?.[g?.id]?.winner;
  if (!w) return base;
  const bg = schoolBg(w);
  if (!bg) return base;
  return { ...base, background: bg, color: textColorFor(bg) };
};
/* === end helpers === */
import "./index.css";
import "./App.css";
import { mergeEspnWeek } from "./lib/espnWeek";
import React, { useEffect, useState, useRef , useMemo } from "react";
import TeamLogo from "./components/TeamLogo";
import Scorebug from "./components/Scorebug"; // SCOREBUG import
import useScoreboard from "./lib/useScoreboard";
import AdminPicksPage from "./components/AdminPicksPage";
import BulkImportPicksPreview from "./components/BulkImportPicksPreview";
import { db, googleLogin, logout, onAuth, enablePushNotifications } from "./firebase";

import { onSnapshot, collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, serverTimestamp, writeBatch, query, where , runTransaction } from "firebase/firestore";


/* === Fit font helper (for header + winners) === */
const fitFontByLen = (len) => (len <= 28 ? 15 : len <= 34 ? 14 : len <= 40 ? 13 : len <= 46 ? 12 : 11);
/* === end fit font === */

// Is this a real, selected week/year value? Deliberately distinct from a plain
// truthy/finite check: Number(null) and Number("") both coerce to 0, so a
// naive Number.isFinite(Number(v)) would treat "not yet chosen" the same as
// "week 0" was chosen. Week 0 is a legitimate CFB week (real games exist for
// it), so it must survive this check while null/undefined/"" must not.
const hasWeekValue = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

// True on narrow (mobile-width) viewports; updates live on resize/rotate.
// Lets specific components render a distinct compact mobile layout without
// touching the desktop rendering at all.
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

// Device/install detection for the "add to home screen" prompt. iOS Safari
// only allows push notifications for a site that's been installed this way,
// so it gates whether we auto-show the install steps vs. the notification
// prompt on first visit.
function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+
}
function isAndroidDevice() {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}
function isStandaloneMode() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone === true;
}

// Android Chrome fires this before the page has any React state to catch it
// in, so it's captured at module scope and replayed to whichever component
// asks for it via useInstallPromptAvailable(). iOS has no equivalent event -
// Apple only allows the manual Share > Add to Home Screen flow.
let deferredInstallPrompt = null;
const installPromptListeners = new Set();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installPromptListeners.forEach(fn => fn());
  });
}
function useInstallPromptAvailable() {
  const [available, setAvailable] = useState(!!deferredInstallPrompt);
  useEffect(() => {
    const fn = () => setAvailable(true);
    installPromptListeners.add(fn);
    return () => installPromptListeners.delete(fn);
  }, []);
  return available;
}
async function triggerAndroidInstallPrompt() {
  if (!deferredInstallPrompt) return false;
  const evt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  evt.prompt();
  try { await evt.userChoice; } catch (e) {}
  return true;
}

// ---------- small UI helpers ----------
function Row({ children, style }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", ...style }}>{children}</div>;
}
function Card({ children, style }) {
  return <div style={{
    background: "#121a2b", border: "1px solid #1f2a44",
    borderRadius: 16, padding: 16, boxShadow: "0 10px 24px rgba(0,0,0,.25)"
  , ...style}}>{children}</div>;
}
function Container({ children, maxWidth = 720, padding = 24 }) { return <div style={{ maxWidth: maxWidth, margin: "0 auto", padding }}>{children}</div>; }
function Header({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const onIOS = isIOSDevice();
  const onAndroid = isAndroidDevice();
  const showIOSSteps = onIOS || !onAndroid;
  const showAndroidSteps = onAndroid || !onIOS;
  const androidInstallAvailable = useInstallPromptAvailable();
  const [androidInstalling, setAndroidInstalling] = useState(false);
  async function handleAndroidInstallClick() {
    setAndroidInstalling(true);
    const worked = await triggerAndroidInstallPrompt();
    setAndroidInstalling(false);
    if (worked) setShowInstallModal(false);
  }
  const logoTapsRef = useRef({ count: 0, timer: null });
  function handleLogoTap() {
    if (user) return;
    const t = logoTapsRef.current;
    t.count += 1;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { t.count = 0; }, 2000);
    if (t.count >= 5) {
      t.count = 0;
      googleLogin();
    }
  }
  const [notifState, setNotifState] = useState(
    (typeof Notification !== "undefined" && Notification.permission === "granted") ? "on" : "off"
  );
  const [notifDontShowAgain, setNotifDontShowAgain] = useState(false);
  const needsHomeScreenFirst = isIOSDevice() && !isStandaloneMode();
  const [showWhatsNewModal, setShowWhatsNewModal] = useState(() => {
    if (typeof window === "undefined" || !isMobile || isStandaloneMode()) return false;
    try {
      if (localStorage.getItem("whatsNewDismissedForever") === "1") return false;
      if (sessionStorage.getItem("whatsNewShownThisSession") === "1") return false;
      sessionStorage.setItem("whatsNewShownThisSession", "1");
    } catch (e) {}
    return true;
  });
  function closeWhatsNewModal() {
    try { localStorage.setItem("whatsNewDismissedForever", "1"); } catch (e) {}
    setShowWhatsNewModal(false);
    // hand off to whichever of the install/notification prompts is relevant,
    // as if this were the first render for that one
    if (needsHomeScreenFirst) {
      try {
        if (localStorage.getItem("installPromptDismissedForever") !== "1") {
          sessionStorage.setItem("installPromptShownThisSession", "1");
          setShowInstallModal(true);
        }
      } catch (e) {}
    } else if (isMobile && !(typeof Notification !== "undefined" && Notification.permission === "granted")) {
      try {
        if (localStorage.getItem("notifPromptDismissedForever") !== "1") {
          sessionStorage.setItem("notifPromptShownThisSession", "1");
          setShowNotifModal(true);
        }
      } catch (e) {}
    }
  }
  const [showInstallModal, setShowInstallModal] = useState(() => {
    if (typeof window === "undefined" || !needsHomeScreenFirst || showWhatsNewModal) return false;
    try {
      if (localStorage.getItem("installPromptDismissedForever") === "1") return false;
      if (sessionStorage.getItem("installPromptShownThisSession") === "1") return false;
      sessionStorage.setItem("installPromptShownThisSession", "1");
    } catch (e) {}
    return true;
  });
  const [installDontShowAgain, setInstallDontShowAgain] = useState(false);
  function closeInstallModal() {
    if (installDontShowAgain) {
      try { localStorage.setItem("installPromptDismissedForever", "1"); } catch (e) {}
    }
    setShowInstallModal(false);
  }
  const [showNotifModal, setShowNotifModal] = useState(() => {
    if (typeof window === "undefined" || needsHomeScreenFirst || !isMobile || showWhatsNewModal) return false;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") return false;
    try {
      if (localStorage.getItem("notifPromptDismissedForever") === "1") return false;
      if (sessionStorage.getItem("notifPromptShownThisSession") === "1") return false;
      sessionStorage.setItem("notifPromptShownThisSession", "1");
    } catch (e) {}
    return true;
  });
  function closeNotifModal() {
    if (notifDontShowAgain) {
      try { localStorage.setItem("notifPromptDismissedForever", "1"); } catch (e) {}
    }
    setShowNotifModal(false);
  }
  async function handleEnableNotifications() {
    setNotifState("working");
    try {
      await enablePushNotifications({ isAdmin });
      setNotifState("on");
      setShowNotifModal(false);
    } catch (e) {
      setNotifState("off");
      alert((e && e.message) ? e.message : "Couldn't enable notifications.");
    }
  }
  // Covers signing in as admin *after* already enabling notifications on this
  // device - retags the existing token so admin-only alerts still reach it.
  useEffect(() => {
    if (!isAdmin || notifState !== "on") return;
    let token = null;
    try { token = localStorage.getItem("pushToken"); } catch (e) {}
    if (!token) return;
    setDoc(doc(db, "pushTokens", token), { isAdmin: true }, { merge: true }).catch(() => {});
  }, [isAdmin, notifState]);
  // notifState "on" only reflects the browser's notification *permission* -
  // it's possible to have permission granted but never actually finish
  // registering a token (e.g. the page reloaded mid-flow, or permission was
  // granted some other way). That leaves someone stuck: the app thinks
  // they're done and hides the enable button, but no token was ever saved.
  // Since permission is already granted, silently retry registration - this
  // won't prompt the user again.
  useEffect(() => {
    if (notifState !== "on") return;
    let existing = null;
    try { existing = localStorage.getItem("pushToken"); } catch (e) {}
    if (existing) return;
    enablePushNotifications({ isAdmin }).catch(() => {});
  }, [notifState, isAdmin]);

  return (
    <>
    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", rowGap: 8, marginBottom: 16 }}>
      <h1 style={{ margin: 0, fontSize: 20, userSelect:"none" }} onClick={handleLogoTap}>CFB Pick'em</h1>
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href="#" onClick={(e)=>{e.preventDefault();

    history.pushState(null, "", "/picks"); setPage("picks");}}>Picks</a>
        <a href="#" onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/leader"); setPage("leader");}}>Leaderboard</a>
        <a href="#" onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/myseason"); setPage("myseason");}}>My Season</a>
        {isAdmin && <a href="#" onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/admin"); setPage("admin");}}>Admin</a>}
        {isMobile && !isStandaloneMode() && (
          <a href="#" onClick={(e)=>{e.preventDefault(); setShowInstallModal(true);}} title="Add to home screen" aria-label="Add to home screen">📲</a>
        )}
        {isMobile && notifState !== "on" && (
          <a href="#" onClick={(e)=>{e.preventDefault(); setShowNotifModal(true);}} title="Enable notifications" aria-label="Enable notifications">🔔</a>
        )}
        {isMobile && notifState === "on" && (
          <a href="#" onClick={async (e)=>{e.preventDefault();
            let t = null; try { t = localStorage.getItem("pushToken"); } catch (err) {}
            if (t) {
              alert(`Notifications are ON for this device.\n\nDevice ID: ${t.slice(0, 24)}…\n\nShow this to Zack so he can match it in Manage Devices and label it as yours.`);
              return;
            }
            // No token cached - retry registration right now, out loud this
            // time, so a real failure (unsupported browser, iOS without
            // home-screen install, etc.) is visible instead of silently
            // swallowed like the background self-heal attempt.
            try {
              const token = await enablePushNotifications({ isAdmin });
              alert(`Notifications are ON for this device.\n\nDevice ID: ${token.slice(0, 24)}…\n\nShow this to Zack so he can match it in Manage Devices and label it as yours.`);
            } catch (err) {
              alert("Still couldn't register this device for notifications.\n\nReason: " + ((err && err.message) ? err.message : String(err)) + "\n\nIf you're on an iPhone, this usually means the app needs to be added to your home screen first (Share > Add to Home Screen), then opened from there.");
            }
          }} title="Notifications are on — tap to see your device ID" aria-label="Notification status">🔔✅</a>
        )}
        {user && <a href="#" onClick={(e)=>{e.preventDefault(); logout();}}>Sign out</a>}
      </nav>
    </div>
    {showWhatsNewModal && (
      <div style={{
        position:"fixed", inset:0, zIndex:100, background:"rgba(4,7,15,.72)",
        display:"flex", alignItems:"center", justifyContent:"center", padding:16
      }}>
        <div style={{
          background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16,
          padding:"22px 24px", maxWidth:360, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.5)"
        }}>
          <div style={{ fontSize:28, marginBottom:8 }}>📲</div>
          <h3 style={{ margin:"0 0 8px", fontSize:17, color:"#eef2ff" }}>Get the full app</h3>
          <p style={{ margin:"0 0 18px", fontSize:14, color:"#cfd8f0", lineHeight:1.6 }}>
            Add this to your home screen to unlock <b>notifications</b> for picks, kickoff, and results &mdash; plus <b>autosaving picks</b> so you never lose your progress.
          </p>
          <button
            onClick={closeWhatsNewModal}
            style={{ width:"100%", background:"#6aa2ff", color:"#07152b", border:0, padding:"10px 14px", borderRadius:10, fontWeight:600, cursor:"pointer" }}
          >
            Add to Home Screen
          </button>
        </div>
      </div>
    )}
    {showInstallModal && (
      <div style={{
        position:"fixed", inset:0, zIndex:100, background:"rgba(4,7,15,.72)",
        display:"flex", alignItems:"center", justifyContent:"center", padding:16
      }}>
        <div style={{
          background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16,
          padding:"22px 24px", maxWidth:380, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.5)"
        }}>
          <div style={{ fontSize:28, marginBottom:8 }}>📲</div>
          <h3 style={{ margin:"0 0 8px", fontSize:17, color:"#eef2ff" }}>Add this to your home screen</h3>
          <p style={{ margin:"0 0 16px", fontSize:14, color:"#9aa4c7", lineHeight:1.5 }}>
            {showIOSSteps && !showAndroidSteps
              ? "It'll open like a regular app, and it's what lets notifications work on iPhone."
              : "It'll open like a regular app, right from your home screen."}
          </p>
          <div style={{ marginBottom:14 }}>
            {showIOSSteps && (
              <>
                <div style={{ fontSize:13, fontWeight:700, color:"#eef2ff", marginBottom:6 }}>On iPhone (must be on Safari)</div>
                <ol style={{ margin: showAndroidSteps ? "0 0 14px" : 0, paddingLeft:20, fontSize:14, color:"#cfd8f0", lineHeight:1.6 }}>
                  <li>Tap the <b>Share</b> icon (square with an arrow up, or <b>&#8226;&#8226;&#8226;</b> on newer iOS)</li>
                  <li>Tap <b>View More</b> if you don't see &ldquo;Add to Home Screen&rdquo; right away</li>
                  <li>Tap <b>Add to Home Screen</b>, then <b>Add</b></li>
                </ol>
              </>
            )}
            {showAndroidSteps && (
              <>
                <div style={{ fontSize:13, fontWeight:700, color:"#eef2ff", marginBottom:6 }}>On Android (Chrome)</div>
                {androidInstallAvailable ? (
                  <button
                    onClick={handleAndroidInstallClick}
                    disabled={androidInstalling}
                    style={{ width:"100%", background:"#1a6b46", color:"#fff", border:0, padding:"9px 14px", borderRadius:10, fontWeight:600, cursor:"pointer", marginBottom:2 }}
                  >
                    {androidInstalling ? "Opening…" : "Click Here to Install"}
                  </button>
                ) : (
                  <ol style={{ margin:0, paddingLeft:20, fontSize:14, color:"#cfd8f0", lineHeight:1.6 }}>
                    <li>Tap the menu icon (&#8942;) in the top right</li>
                    <li>Tap <b>Add to Home screen</b> (or <b>Install app</b>)</li>
                    <li>Tap <b>Add</b> / <b>Install</b> to confirm</li>
                  </ol>
                )}
              </>
            )}
          </div>
          <div style={{ display:"flex", gap:10, marginBottom:14 }}>
            <button
              onClick={closeInstallModal}
              style={{ flex:1, background:"#6aa2ff", color:"#07152b", border:0, padding:"10px 14px", borderRadius:10, fontWeight:600, cursor:"pointer" }}
            >
              Got it
            </button>
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"#9aa4c7", cursor:"pointer" }}>
            <input
              type="checkbox"
              checked={installDontShowAgain}
              onChange={(e)=>setInstallDontShowAgain(e.target.checked)}
            />
            Don&rsquo;t show me this again
          </label>
        </div>
      </div>
    )}
    {showNotifModal && (
      <div style={{
        position:"fixed", inset:0, zIndex:100, background:"rgba(4,7,15,.72)",
        display:"flex", alignItems:"center", justifyContent:"center", padding:16
      }}>
        <div style={{
          background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16,
          padding:"22px 24px", maxWidth:360, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.5)"
        }}>
          <div style={{ fontSize:28, marginBottom:8 }}>🔔</div>
          <h3 style={{ margin:"0 0 8px", fontSize:17, color:"#eef2ff" }}>Turn on notifications?</h3>
          <p style={{ margin:"0 0 16px", fontSize:14, color:"#9aa4c7", lineHeight:1.5 }}>
            Get a heads-up when picks open, when the leaderboard unlocks, and reminders to submit picks.
          </p>
          <div style={{ display:"flex", gap:10, marginBottom:14 }}>
            <button
              onClick={handleEnableNotifications}
              disabled={notifState === "working"}
              style={{ flex:1, background:"#6aa2ff", color:"#07152b", border:0, padding:"10px 14px", borderRadius:10, fontWeight:600, cursor:"pointer" }}
            >
              {notifState === "working" ? "Enabling…" : "Enable Notifications"}
            </button>
            <button
              onClick={closeNotifModal}
              style={{ background:"transparent", color:"#9aa4c7", border:"1px solid #2a3655", padding:"10px 14px", borderRadius:10, cursor:"pointer" }}
            >
              Not now
            </button>
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"#9aa4c7", cursor:"pointer" }}>
            <input
              type="checkbox"
              checked={notifDontShowAgain}
              onChange={(e)=>setNotifDontShowAgain(e.target.checked)}
            />
            Don&rsquo;t show me this again
          </label>
        </div>
      </div>
    )}
    </>
  );
}
function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>{label}{children}</label>;
}
const inputStyle = { background:"#0c1426", color:"#fff", border:"1px solid #1f2a44", padding:"10px 12px", borderRadius:10 };

// --- Admin UI helpers: consistent button semantics + section grouping ---
const ADMIN_TONES = {
  primary: { bg: "#2a4fb8", border: "#3b63d6", text: "#fff", dot: "#6aa2ff" },
  neutral: { bg: "transparent", border: "#2a3655", text: "#cfd8f0", dot: "#8ea0c9" },
  success: { bg: "#1a6b46", border: "#238a5c", text: "#fff", dot: "#3ecf8e" },
  warning: { bg: "#8a5d12", border: "#a8791d", text: "#fff", dot: "#f0b429" },
  danger:  { bg: "#7a2530", border: "#9c303d", text: "#fff", dot: "#f0596b" },
  purple:  { bg: "#5b2a8a", border: "#7440ab", text: "#fff", dot: "#b48aef" }
};
// Only ever used on admin pages, so it's safe to shrink buttons directly off
// the current viewport width - no isMobile plumbing needed at 56 call sites,
// and it stays correct on resize since every admin page already re-renders
// on the breakpoint via its own useIsMobile() call.
function adminBtn(variant = "neutral", extra = {}) {
  const t = ADMIN_TONES[variant] || ADMIN_TONES.neutral;
  const compact = typeof window !== "undefined" && window.innerWidth < 768;
  return {
    background: t.bg, border: `1px solid ${t.border}`, color: t.text,
    padding: compact ? "6px 10px" : "9px 14px", borderRadius: 10, fontSize: compact ? 12.5 : 14, fontWeight: 600,
    cursor: "pointer", ...extra
  };
}
function AdminSection({ title, tone = "neutral", right, children }) {
  const isMobile = useIsMobile();
  const dot = (ADMIN_TONES[tone] || ADMIN_TONES.neutral).dot;
  return (
    <div style={{ background:"#0e1730", border:"1px solid #1f2a44", borderRadius:14, padding: isMobile ? "10px 12px" : "16px 18px", marginTop: isMobile ? 10 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: isMobile ? 8 : 12, flexWrap:"wrap", gap: isMobile ? 6 : 8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ width:8, height:8, borderRadius:"50%", background:dot, display:"inline-block" }} />
          <h3 style={{ margin:0, fontSize: isMobile ? 13.5 : 15, letterSpacing:.3, color:"#eef2ff" }}>{title}</h3>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}
function StatusBadge({ tone = "neutral", children, style }) {
  const t = ADMIN_TONES[tone] || ADMIN_TONES.neutral;
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", fontSize:12, fontWeight:600,
      padding:"3px 10px", borderRadius:999, whiteSpace:"nowrap",
      background: `${t.dot}22`, color: t.dot, border: `1px solid ${t.dot}55`,
      ...style
    }}>
      {children}
    </span>
  );
}

// Renders "#7 Team" if rank is 1..25, else just "Team"
function teamLabel(name, rank) {
  const n = Number(rank);
  return n && n > 0 && n <= 25 ? `#${n} ${name}` : name;
}

// ---------- shared helpers ----------
const norm = (s) => String(s || "")
  .normalize("NFD")               // split letters + diacritics
  .replace(/[\u0300-\u036f]/g, "")// strip diacritics (?? -> e)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");     // keep only a??"z, 0??"9

// ---------- auth/admin state ----------
function useAuthAdmin() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => onAuth(async u => {
    setUser(u || null);
    if (u) {
      const email = (u.email || "").toLowerCase();
      let isAdm = false;
      try {
        const s1 = await getDoc(doc(db, "admins", u.uid || ""));
        if (s1.exists()) isAdm = true;
      } catch (e) {}
      if (!isAdm) {
        try {
          const s2 = await getDoc(doc(db, "admins", email));
          if (s2.exists()) isAdm = true;
        } catch (e) {}
      }
      setIsAdmin(isAdm);
    } else {
      setIsAdmin(false);
    }
  }), []);
  return { user, isAdmin };
}

// ---------- Firestore helpers ----------
async function listGames({ year, week, includedOnly }) {
  const col = collection(db, "games");
  const baseQ = query(col, where("year","==", year), where("week","==", week));
  const q = includedOnly
    ? query(col, where("year","==", year), where("week","==", week), where("included","==", true))
    : baseQ;

  const snap = await getDocs(q);
  const items = [];
  snap.forEach(d => items.push({ id: d.id, ...d.data() }));

  const _etDay = new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" });
  items.sort((a,b)=>{
    const da = a.startTimeStr ? new Date(a.startTimeStr) : null;
    const db = b.startTimeStr ? new Date(b.startTimeStr) : null;
    const ka = (da && !isNaN(+da)) ? _etDay.format(da) : "9999-12-31";
    const kb = (db && !isNaN(+db)) ? _etDay.format(db) : "9999-12-31";
    if (ka !== kb) return ka.localeCompare(kb);         // day (ET)
    const oa = (a.orderDay ?? 1e9), ob = (b.orderDay ?? 1e9);
    if (oa !== ob) return oa - ob;                      // ESPN per-day
    const wa = (a.order ?? 1e9), wb = (b.order ?? 1e9);
    if (wa !== wb) return wa - wb;                      // ESPN week (fallback)
    return String(a.away||"").localeCompare(String(b.away||"")); // stable tie-break
  });
  return items;
}
async function setGameIncluded(gameId, included) {
  await setDoc(doc(db, "games", gameId), { included: !!included }, { merge: true });
}


async function setGameGameday(year, week, gameId) {
  const q = query(collection(db, "games"), where("year","==",year), where("week","==",week));
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.forEach(d => {
    batch.set(d.ref, { gameday: d.id === gameId }, { merge: true });
  });
  await batch.commit();
}
async function setResult(gameId, winner, totalPoints) {
  const payload = { winner: String(winner), updatedAt: serverTimestamp() };
  if (totalPoints !== undefined && totalPoints !== null && totalPoints !== "") {
    payload.totalPoints = Number(totalPoints);
  }
  await setDoc(doc(db, "results", gameId), payload, { merge: true });
}
async function getResultsMap(gameIds) {
  const map = {};
  await Promise.all(gameIds.map(async id => {
    const s = await getDoc(doc(db, "results", id));
    if (s.exists()) map[id] = s.data();
  }));
  return map;
}

async function getWeekResultsMap(year, week, games) {
  // Prefer the weekly results doc: results/{year}_W{week}.games -> { [gameId]: result }
  try {
    const s = await getDoc(doc(db, "results", `${year}_W${week}`));
    if (!s.exists()) return null;
    const weekData = s.data() || {};
    const gamesMap = weekData.games || {};
    // Normalize team names to CFBD weekly key: "away__home"
    const normalizeKey = (name) => {
      if (!name) return "";
      let out = String(name).toLowerCase();
      out = out.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
      out = out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
      if (out === "texasam" || out === "texasa&m") out = "texasam";
      return out;
    };
    const keyFrom = (home, away) => `${normalizeKey(away)}__${normalizeKey(home)}`;

    const map = {};
    for (const g of games) {
      const home = g.home || g.homeTeam || "";
      const away = g.away || g.awayTeam || "";
      const k = keyFrom(home, away);
      const r = gamesMap[k];
      if (r) {
      // Recase winner to the exact team label when possible
      const nh = normalizeKey(home);
      const na = normalizeKey(away);
      let winner = r.winner;
      if (winner) {
        const nw = normalizeKey(String(winner));
        if (nw === "tie") { winner = null; } else if (nw === nh) winner = home;
        else if (nw === na) winner = away;
        else winner = String(winner).toUpperCase();
      }
      map[g.id] = { ...r, winner };
    }
    }
    return map;
  } catch (e) {
    console.warn("[getWeekResultsMap] failed", e);
    return null;
  }
}
function picksDocId(year, week, email) {
  return `${year}_W${week}_${(email||"").toLowerCase()}`.replace(/[^\w\-@.]+/g, "_");
}
async function getPicksForWeek(year, week) {
  const y = Number(year), w = Number(week);
  // Try numeric fields first
  let snap = await getDocs(query(collection(db, "picks"), where("year","==", y), where("week","==", w)));
  let out = [];
  snap.forEach(d => out.push(d.data()));

  // Fallback to string-typed fields (legacy/edge docs)
  if (!Array.isArray(out) || out.length === 0) {
    const snap2 = await getDocs(query(collection(db, "picks"), where("year","==", String(y)), where("week","==", String(w))));
    const out2 = [];
    snap2.forEach(d => out2.push(d.data()));
    if (out2.length) out = out2;
  }
  return out;
}

// Compute one week's standings: each submitted player's correct-pick count,
// sorted, with the winner marked (via the GameDay tiebreaker when there's a
// tie for first, only once every game that week is final). Shared by the
// Leaderboard page and MySeasonPage so both agree on who won a given week.
async function computeWeekStandings(year, week) {
  let g = await listGames({ year, week, includedOnly: true });
  if (!Array.isArray(g) || g.length === 0) { g = await listGames({ year, week, includedOnly: false }); }
  const ids = g.map(x => x.id);
  const [rFromWeek, rFromGames] = await Promise.all([
    getWeekResultsMap(year, week, g),
    getResultsMap(ids)
  ]);
  const r = { ...(rFromWeek || {}), ...(rFromGames || {}) };
  const picks = await getPicksForWeek(year, week);

  const rows = picks.map(p => {
    let correct = 0;
    for (const id of ids) {
      const w = r[id]?.winner;
      const pick = p.picks?.[id];
      if (w && pick && w === pick) correct++;
    }
    const name = `${p.firstName||""} ${p.lastName||""}`.trim() || p.email;
    const tbVal = (p?.tiebreaker?.total ?? p?.tieBreaker ?? p?.tiebreak ?? p?.tb ?? null);
    return {
      name, firstName: p.firstName || "", lastName: p.lastName || "",
      email: p.email, venmo: p.venmo || "",
      points: correct, picks: p.picks || {},
      tb: (tbVal === null || tbVal === "" ? null : Number(tbVal)),
    };
  }).sort((a,b)=> (b.points - a.points) || a.name.localeCompare(b.name));

  const allGamesFinal = ids.length > 0 && ids.every(id => !!r[id]?.winner);
  if (rows.length && allGamesFinal) {
    const gdGame = g.find(x => x && x.gameday);
    const gdTotalRaw = gdGame ? r[gdGame.id]?.totalPoints : null;
    const gdTotal = Number.isFinite(+gdTotalRaw) ? +gdTotalRaw : null;
    const topPoints = rows[0].points;
    const topGroup = rows.filter(p => p.points === topPoints);
    if (topGroup.length === 1) {
      topGroup[0].isWinner = true;
    } else if (gdTotal == null) {
      topGroup.forEach(p => { p.isWinner = true; p.winNote = "Tied for 1st — GameDay tiebreaker not final yet"; });
    } else {
      const diffOf = (p) => p.tb == null ? Infinity : Math.abs(p.tb - gdTotal);
      const bestDiff = Math.min(...topGroup.map(diffOf));
      if (bestDiff === Infinity) {
        topGroup.forEach(p => { p.isWinner = true; p.winNote = "Tied for 1st — no tiebreaker guess on file"; });
      } else {
        const coWinners = topGroup.filter(p => diffOf(p) === bestDiff);
        if (coWinners.length > 1) {
          coWinners.forEach(p => { p.isWinner = true; p.winNote = "Tied for 1st — pot split (tiebreaker also tied)"; });
        } else {
          coWinners[0].isWinner = true;
          coWinners[0].winNote = `Won on tiebreaker — guessed ${coWinners[0].tb}, GameDay total was ${gdTotal}`;
        }
        topGroup.sort((a, b) => diffOf(a) - diffOf(b) || a.name.localeCompare(b.name));
        const rest = rows.filter(p => p.points !== topPoints);
        rows.splice(0, rows.length, ...topGroup, ...rest);
      }
    }
  }

  const playedGames = ids.filter(id => !!r[id]?.winner).length;
  return { games: g, results: r, rows, allGamesFinal, totalGames: ids.length, playedGames };
}

// ---------- Import helpers (CFBD + ESPN with CORS fallback) ----------
const FBS_CONF = new Set([
  "ACC","American Athletic","American","Big 12","Big Ten",
  "Conference USA","CUSA","Mid-American","MAC","Mountain West","Pac-12","SEC","Sun Belt",
  "FBS Independents","Independent","Independents"
]);

async function getCfbdKey() {
  const s = await getDoc(doc(db, "config", "cfbd"));
  return s.exists() ? String(s.data().apiKey || "") : "";
}
async function setCfbdKey(apiKey) {
  await setDoc(doc(db, "config", "cfbd"), { apiKey: String(apiKey) }, { merge: true });
}

async function fetchJson(url, options) {
  try {
    const r = await fetch(url, options);
    if (!r.ok) return { ok: false, status: r.status, data: null };
    const data = await r.json();
    return { ok: true, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}

async function buildFbsNameSet(apiKey, year) {
  const add = (set, t) => {
    const fields = [t.school, t.name, t.team, t.display_name, t.abbreviation, t.alt_name1, t.alt_name2, t.alt_name3];
    for (const f of fields) { const n = norm(f); if (n) set.add(n); }
  };
  const base = "https://api.collegefootballdata.com";
  const endpoints = [
    `/teams/fbs?year=${encodeURIComponent(year)}`,
    `/teams?year=${encodeURIComponent(year)}&division=fbs`,
    `/teams?year=${encodeURIComponent(year)}&classification=fbs`
  ];
  const set = new Set();
  for (const ep of endpoints) {
    const res = await fetchJson(base + ep, { headers: { Authorization: "Bearer " + apiKey }});
    if (res.ok && Array.isArray(res.data)) {
      for (const t of res.data) add(set, t);
      if (set.size) break;
    }
  }
  return set;
}

// Team -> AP Top 25 rank (falls back to whatever poll CFBD does have, e.g.
// Coaches) for a given week. Week 0 games are early enough that CFBD often
// hasn't posted a week-0-specific poll yet, so if the requested week comes
// back empty, this also tries week 1 (the preseason poll effectively still
// applies to those games).
async function buildRankMap(apiKey, year, week) {
  const fetchOne = async (w) => {
    const map = new Map();
    const url = `https://api.collegefootballdata.com/rankings?year=${encodeURIComponent(year)}&week=${encodeURIComponent(w)}&seasonType=regular`;
    const res = await fetchJson(url, { headers: { Authorization: "Bearer " + apiKey } });
    if (!res.ok || !Array.isArray(res.data)) return map;
    for (const entry of res.data) {
      const polls = Array.isArray(entry.polls) ? entry.polls : [];
      const ap = polls.find(p => /ap top ?25/i.test(p.poll || "")) || polls[0];
      if (!ap || !Array.isArray(ap.ranks)) continue;
      for (const r of ap.ranks) {
        const n = norm(r.school);
        if (n && Number.isFinite(+r.rank) && !map.has(n)) map.set(n, +r.rank);
      }
    }
    return map;
  };
  const map = await fetchOne(week);
  if (map.size || Number(week) !== 0) return map;
  return fetchOne(1);
}

function getRankFromCompetitor(c) {
  const r1 = c?.curatedRank?.current;
  const r2 = c?.rank;
  const r3 = c?.team?.rank;
  const candidates = [r1, r2, r3];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

function mapEspnEventsToGames(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const ev of events) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const teams = comp.competitors || [];
    const home = teams.find(t => (t.homeAway || t.home_away) === "home");
    const away = teams.find(t => (t.homeAway || t.home_away) === "away");
    const homeName = home?.team?.location || home?.team?.displayName || home?.team?.name || home?.team?.shortDisplayName || "";
const awayName = away?.team?.location || away?.team?.displayName || away?.team?.name || away?.team?.shortDisplayName || "";
    const homeAbbr = home?.team?.abbreviation || "";
    const awayAbbr = away?.team?.abbreviation || "";

    if (homeName && awayName) {
      const homeRank = getRankFromCompetitor(home);
      const awayRank = getRankFromCompetitor(away);
      out.push({
        home: homeName, away: awayName,
        homeAbbr, awayAbbr,
        homeRank, awayRank,
        startTimeStr: ev.date || ""
      });
    }
  }
  return out;
}

async function importWeek({ year, week }) {
  const debug = { sourceTried: [], cfbdGames: 0, fbsTeamNames: 0, espnDirect: 0, espnProxy: 0, includedFbs: 0, writtenTotal: 0 };
  const batch = writeBatch(db);
  const keepIds = new Set();

  // --- Try CFBD first
  const apiKey = await getCfbdKey();
  let games = [];
  if (apiKey) {
    debug.sourceTried.push("CFBD");
    const gamesUrl = `https://api.collegefootballdata.com/games?year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}&seasonType=regular`;
    const resGames = await fetchJson(gamesUrl, { headers: { Authorization: "Bearer " + apiKey }});
    if (resGames.ok && Array.isArray(resGames.data)) {
      // Defensive: CFBD's own `week` query param has been observed to be silently
      // ignored for week=0 (returning the entire season instead of filtering), so
      // never trust that the response only contains the requested week - verify
      // each game's own `week` field before treating it as belonging to this import.
      const weekMatched = resGames.data.filter(g => Number(g.week) === Number(week));
      debug.cfbdGames = weekMatched.length;
      const fbsSet = await buildFbsNameSet(apiKey, year);
      debug.fbsTeamNames = fbsSet.size;
      const rankMap = await buildRankMap(apiKey, year, week);
      for (const g of weekMatched) {
        const homeN = norm(g.home_team), awayN = norm(g.away_team);
        const isFbsByTeam = fbsSet.has(homeN) || fbsSet.has(awayN);
        const isFbsByConf = FBS_CONF.has(g.home_conference || "") || FBS_CONF.has(g.away_conference || "");
        const included = isFbsByTeam || isFbsByConf;
        if (included) debug.includedFbs++;
        games.push({
          home: g.home_team || "", away: g.away_team || "",
          homeAbbr: null, awayAbbr: null,
          homeRank: rankMap.get(homeN) ?? null, awayRank: rankMap.get(awayN) ?? null,
          startTimeStr: g.start_date || "", included
        });
      }
    }
  }

  // --- If still nothing included, try ESPN (FBS only, groups=80)
  if (!games.length || games.every(g => !g.included)) {
    debug.sourceTried.push("ESPN");
    games = [];
    const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?year=${year}&week=${week}&seasontype=2&groups=80`;
    let res = await fetchJson(espnUrl);
    if (res.ok && res.data) {
      const ev = res.data.events || [];
      debug.espnDirect = ev.length;
      const mapped = mapEspnEventsToGames(ev);
      for (const m of mapped) games.push({ ...m, included: true }); // ESPN FBS only
      debug.includedFbs += mapped.length;
    } else {
      debug.sourceTried.push("ESPN(proxy)");
      const prox = `https://r.jina.ai/http://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?year=${year}&week=${week}&seasontype=2&groups=80`;
      res = await fetchJson(prox);
      if (res.ok && res.data) {
        const ev = res.data.events || [];
        debug.espnProxy = ev.length;
        const mapped = mapEspnEventsToGames(ev);
        for (const m of mapped) games.push({ ...m, included: true });
        debug.includedFbs += mapped.length;
      }
    }
  }

  // --- Merge ESPN week (FBS) to fill gaps
  await mergeEspnWeek({ year, week, games, debug, fetchJson });
// --- Write what we have (don't delete old docs unless we wrote something)
  // --- Ensure ESPN week merge + debug before write
  await mergeEspnWeek({ year, week, games, debug, fetchJson });
  console.info("[Pickems] import debug", {
    sourceTried: debug.sourceTried, cfbdGames: debug.cfbdGames,
    espnDirect: debug.espnDirect, espnProxy: debug.espnProxy,
    includedFbs: debug.includedFbs, preWriteCount: games.length
  });
  window._importDebug = { debug, games };
  // Stamp persistent ESPN order index on each game
    // Stamp ESPN order per WEEK and per DAY (ET)
  {
    const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
    const perDay = new Map(); // "YYYY-MM-DD" (ET) -> next index (1-based)
    games.forEach((g, i) => {
      g.order = i + 1; // ESPN week order
      // prefer helper-provided per-day index, else compute
      if (Number.isFinite(g._orderDay)) {
        g.orderDay = g._orderDay;
      } else {
        const d = g.startTimeStr ? new Date(g.startTimeStr) : null;
        const key = (d && !Number.isNaN(+d)) ? fmt.format(d) : "tbd";
        const next = (perDay.get(key) || 0) + 1;
        perDay.set(key, next);
        g.orderDay = next;
      }
    });
  }
  for (const g of games) {
    const id = `${year}_W${week}_${g.away}_at_${g.home}`.replace(/[^\w\-@.]+/g, "_");
    keepIds.add(id);
    batch.set(doc(db, "games", id), {
      id, year, week,
      away: g.away, home: g.home,
      awayAbbr: g.awayAbbr ?? null, homeAbbr: g.homeAbbr ?? null,
      awayRank: g.awayRank ?? null, homeRank: g.homeRank ?? null,
      included: (g.included ?? true),
      startTimeStr: g.startTimeStr ?? null,
      order: (g.order ?? g._order ?? null),
      orderDay: (g.orderDay ?? null),
    }, { merge: true });
  }
  if (games.length > 0) {
    const existingSnap = await getDocs(query(collection(db, "games"),
      where("year","==",year), where("week","==",week)));
    existingSnap.forEach(d => { if (!keepIds.has(d.id)) batch.delete(d.ref); });
  }
  await batch.commit();

  debug.writtenTotal = games.length;
  return debug;
}

// ---------- pages ----------

// ---- helpers: strip mascot from team name ----
function stripMascot(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  if (parts.length <= 2) return s;

  const keepers = new Set(["State","Tech","A&M","&","University","College","Institute"]);
  const adj = new Set(["Tar","Nittany","Fighting","Ragin'","Mean","Golden","Black","Blue","Green","Crimson","Scarlet","Red","Orange","Rainbow","War","Great","Lady"]);

  let removed = 0;
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (keepers.has(last) || /\)/.test(last)) break;
    parts.pop(); removed++;
    while (parts.length > 1 && adj.has(parts[parts.length - 1])) { parts.pop(); removed++; }
    if (removed > 0 && parts.length <= 2) break;
  }
  return parts.join(" ");
}

function teamLabelNoMascot(name, rank) { if (String(rank) === "99" || Number(rank) === 99) rank = null;
  const base = stripMascot(name);
  return (rank ? `#${rank} ` : "") + base;
}
// ---- end helpers ----
function PicksPage({ user, isAdmin, setPage }) {
  // --- Subscribe to live week (config/live) and mirror into local state ---

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      setLive(d);
    });
    return () => unsub();
  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);
  // One-time copy of live {year,week} to local state (prevents flicker)

  const [live, setLive] = useState({ year: null, week: null });
  const initFromLiveRef = useRef(false);
  useEffect(() => {
    if (!initFromLiveRef.current && live?.year && live?.week) {
      setYear(live.year);
      setWeek(live.week);
      initFromLiveRef.current = true;
    }
  }, [live]);
  // Default Admin to live Year/Week exactly once
  const liveSyncedRef = useRef(false);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
const pot = useMemo(() => (pickCount * 5), [pickCount]);
  // If games still haven't loaded 5s in (e.g. a slow first load on a freshly
  // installed home-screen app), offer a manual refresh instead of sitting blank.
  const [showSlowLoadHint, setShowSlowLoadHint] = useState(false);
  const gamesRef = useRef(games);
  useEffect(() => { gamesRef.current = games; }, [games]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!gamesRef.current || gamesRef.current.length === 0) setShowSlowLoadHint(true);
    }, 5000);
    return () => clearTimeout(t);
  }, []);

useEffect(() => {
  (async () => {
    try {
      if (hasWeekValue(year) && hasWeekValue(week)) {
        const arr = await getPicksForWeek(year, week);
        setPickCount(Array.isArray(arr) ? arr.length : 0);
      } else {
        setPickCount(0);
      }
    } catch {
      setPickCount(0);
    }
  })();
}, [year, week]);
// INITIAL_LIVE_AUTOLOAD: on first mount, load games for the live week (config/live)
  useEffect(() => {
        try {
      const ref = doc(db, "config", "live");
      // Subscribe once, then auto-unsub after we apply the first live week load
      const unsub = onSnapshot(ref, async (s) => {
        const d = s.data() || {};
        const y = Number(d.year), w = Number(d.week);
        setLive({ year: y, week: w });
        if (!hasWeekValue(y) || !hasWeekValue(w)) { return; }

        // Keep Admin controls consistent, but the important part is we load the live week now:
        setYear(y);
        setWeek(w);

        try {
          const gs = await listGames({ year: y, week: w, includedOnly: false });
          setGames(gs);
        } catch (e) {
          console.error(e);
        } finally {
          // We only need this once on entry; further changes can be manual
          unsub();
        }
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.error(e);
    }
  }, []);
const [form, setForm] = useState({ firstName:"", lastName:"", email:"", phone:"", venmo:"", venmoConfirmed:false })
  // Returning players shouldn't have to retype their contact info every
  // week - once they've filled in both names (and this isn't an edit of an
  // already-loaded submission), look up their most recent past submission
  // by the same name/Venmo identity matching used elsewhere and fill in
  // whatever contact fields they haven't already typed themselves.
  const autofillFromHistory = async () => {
    if (editing) return;
    const fn = (form.firstName || "").trim();
    const ln = (form.lastName || "").trim();
    if (!fn || !ln) return;
    if ((form.email || "").trim() && (form.phone || "").trim() && (form.venmo || "").trim()) return;
    try {
      const snap = await getDocs(query(collection(db, "picks"), where("lastNameLower", "==", ln.toLowerCase())));
      const docs = [];
      snap.forEach(d => docs.push(d.data()));
      if (docs.length === 0) return;

      const dsu = makeDSU();
      const keyed = [];
      for (const p of docs) {
        const nk = personKey(p);
        const vk = venmoKeyOf(p);
        if (!nk && !vk) continue;
        if (nk && vk) dsu.union(nk, vk);
        keyed.push({ p, key: nk || vk });
      }
      const targetKey = personKey({ firstName: fn, lastName: ln });
      if (!targetKey) return;
      const targetRoot = dsu.find(targetKey);
      const mine = keyed.filter(rec => dsu.find(rec.key) === targetRoot).map(rec => rec.p);
      if (mine.length === 0) return;

      const latest = mine.reduce((best, p) => {
        const ms = p.updatedAt?.toMillis ? p.updatedAt.toMillis() : (p.createdAt?.toMillis ? p.createdAt.toMillis() : 0);
        return (!best || ms >= best._ms) ? { ...p, _ms: ms } : best;
      }, null);
      if (!latest) return;

      setForm(f => ({
        ...f,
        email: f.email || latest.email || "",
        phone: f.phone || latest.phone || "",
        venmo: f.venmo || latest.venmo || "",
      }));
    } catch (e) {
      // Best-effort convenience only - a failed lookup just means the
      // player fills the fields in themselves, same as always.
    }
  };
  const [errors, setErrors] = useState({});
  const [touchedSubmit, setTouchedSubmit] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [picks, setPicks] = useState({});
  useEffect(() => { window._picks = picks; window._setPicks = setPicks; }, [picks]);
  const [msg, setMsg] = useState("");
  // Submissions lock (config/app.picksLocked)
  const [picksLocked, setPicksLocked] = useState(false);
  const [potHidden, setPotHidden] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
      setPotHidden(!!d.potHidden);
    });
    return () => unsub && unsub();
  }, []);

// Weeks dropdown: populate from games in the selected year
const [weeksForYear, setWeeksForYear] = useState([]);
useEffect(() => {
  (async () => {
    try {
      const q = query(collection(db, "games"), where("year", "==", Number(year)));
      const snap = await getDocs(q);
      const uniq = new Set();
      snap.forEach(d => {
        const w = d.data()?.week;
        if (Number.isFinite(+w)) uniq.add(Number(w));
      });
      setWeeksForYear([...uniq].sort((a,b)=>a-b));
    } catch (err) {
      console.error("weeksForYear load failed", err);
      setWeeksForYear([]);
    }
  })();
}, [year]);const [tiebreaker, setTiebreaker] = useState({ gameId: null, total: "" });

    // Put College GameDay at the end of the list
  const gameday = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
  const displayGames = gameday ? [...games.filter(x => x && x.id !== gameday.id), gameday] : games;
  const pickGroups = useMemo(
    () => groupGamesByDate(displayGames || [], { timeZone: "America/New_York" }),
    [displayGames]
  );
  // Earliest included kickoff (for deadline label on Picks)
  const earliestGame = useMemo(() => {
    const arr = (displayGames || [])
      .map(g => ({ g, d: kickoffDate(g) }))
      .filter(x => x.d instanceof Date && !isNaN(x.d));
    arr.sort((a,b) => a.d - b.d);
    return arr[0]?.g || null;
  }, [displayGames]);
  // Mobile-only layout flag for small view tweaks
  const [isMobile, setIsMobile] = useState(() => (typeof window !== "undefined" ? window.innerWidth <= 560 : false));
  useEffect(() => {
    const onResize = () => setIsMobile(typeof window !== "undefined" ? window.innerWidth <= 560 : false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const badgeSize  = isMobile ? 40 : 72;
  const badgeTop   = isMobile ? 4  : 6;
  const badgeRight = isMobile ? 4  : 6;
const [code, setCode] = useState("");
  const [loadCode, setLoadCode] = useState("");
  const [loadLastName, setLoadLastName] = useState("");
  const [editing, setEditing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);

  // --- Autosave picks-in-progress to localStorage, so closing the tab or
  // losing connection mid-fill doesn't lose everything already selected.
  // Cleared once the real submit succeeds (see onSubmitPicks).
  const draftKey = (hasWeekValue(year) && hasWeekValue(week)) ? `draft_${year}_${week}` : null;
  const [draftReady, setDraftReady] = useState(false);
  const draftKeyLoadedRef = useRef(null);

  useEffect(() => {
    if (!draftKey || editing) return;
    if (draftKeyLoadedRef.current === draftKey) return;
    draftKeyLoadedRef.current = draftKey;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (saved) {
        if (saved.form) setForm(f => ({ ...f, ...saved.form }));
        if (saved.picks) setPicks(saved.picks);
        if (saved.tiebreaker) setTiebreaker(saved.tiebreaker);
      }
    } catch (_) {}
    setDraftReady(true);
  }, [draftKey, editing]);

  useEffect(() => {
    if (!draftKey || !draftReady) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ form, picks, tiebreaker }));
    } catch (_) {}
  }, [draftKey, draftReady, form, picks, tiebreaker]);


  const email = (user?.email || "").toLowerCase();

  const load = async () => {
    setMsg("Loading games...");
    let items; try { items = await listGames({ year, week, includedOnly: true }); } catch (e) { console.error("listGames failed:", e); setMsg("Failed to load games: " + (e?.message || e)); return; }
    setGames(items);
    window._logoGames = items; // temp: expose games for the logo audit
    setMsg(items.length ? "" : "No games yet for that week.");
    if (email) {
      const s = await getDoc(doc(db, "picks", picksDocId(year, week, email)));
      if (s.exists()) {
        const d = s.data();
        setForm({ firstName: d.firstName||"", lastName: d.lastName||"", email: (d.email || "").toLowerCase(), phone: d.phone || "", venmo: d.venmo || "" });
        setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      } else {
        setPicks({}); setTiebreaker({ gameId: null, total: "" });
      }
    }
  };

  useEffect(() => {
  if (!(hasWeekValue(year) && hasWeekValue(week))) return;
  load();
  /* eslint-disable-next-line */
}, [year, week, email]);

    // --- Step 4: validation & submit gating (Pickems Coach) ---
  const validatePicks = (opts = {}) => {
    const errs = {};
    const needIncludedFlag = games.some(g => Object.prototype.hasOwnProperty.call(g, "included"));
    const requiredGames = needIncludedFlag ? games.filter(g => !!g.included) : games;

    if (!String(form.firstName || "").trim()) errs.firstName = "First name is required";
    if (!String(form.lastName  || "").trim()) errs.lastName  = "Last name is required";
    if (!String(form.phone     || "").trim()) errs.phone     = "Phone is required";
    if (!String(form.venmo     || "").trim()) errs.venmo     = "Venmo is required";
    if (!form.venmoConfirmed) errs.venmoConfirmed = "Please confirm your Venmo is correct";

    const missingGames = [];
    for (const g of requiredGames) {
      const pick = picks && picks[g.id];
      if (!(pick === g.home || pick === g.away)) missingGames.push(g);
    }
    if (missingGames.length) {
      errs.picks = missingGames.length + " game" + (missingGames.length>1?"s":"") + " not selected";
    }

    const ok = Object.keys(errs).length === 0;
    const parts = [];
    if (errs.firstName) parts.push("first name");
    if (errs.lastName) parts.push("last name");
    if (errs.phone) parts.push("phone");
    if (errs.venmo) parts.push("venmo");
    if (errs.venmoConfirmed) parts.push("venmo confirmation");
    if (missingGames.length) parts.push(missingGames.length + " game picks");
    const message = ok ? "" : (parts.join(", ") + " required.");

    if (!opts.silent && typeof setErrors === "function") setErrors(errs);

    const focus = () => {
      try {
        if (errs.firstName) { var el = document.querySelector('input[name="firstName" aria-invalid={touchedSubmit && !!errors.firstName}]'); if (el) el.focus(); return; }
        if (errs.lastName)  { var el2 = document.querySelector('input[name="lastName" aria-invalid={touchedSubmit && !!errors.lastName}]'); if (el2) el2.focus(); return; }
        if (errs.phone)     { var el3 = document.querySelector('input[name="phone" aria-invalid={touchedSubmit && !!errors.phone}]'); if (el3) el3.focus(); return; }
        if (errs.venmo)     { var el4 = document.querySelector('input[name="venmo" aria-invalid={touchedSubmit && !!errors.venmo}]'); if (el4) el4.focus(); return; }
        if (errs.venmoConfirmed) { var el5 = document.querySelector('input[aria-label="venmo"]'); if (el5) el5.focus(); return; }
        if (missingGames[0]) {
          var firstId = missingGames[0].id;
          var card = document.querySelector('[data-game-id="' + firstId + '"]');
          if (card) { try { card.scrollIntoView({behavior:"smooth", block:"center"}); } catch (e) { card.scrollIntoView(true); } }
        }
      } catch (e) {}
    };
    return { ok, errors: errs, message, missingGames, focus };
  };

  const isValid = useMemo(function(){ return validatePicks({ silent: true }).ok; }, [form, picks, games]);

    // Keep validation errors updated after a submit attempt
  useEffect(() => {
    if (touchedSubmit) {
      const r = validatePicks({ silent: true });
      if (typeof setErrors === "function") setErrors(r.errors);
    }
  }, [form, picks, games, touchedSubmit]);
const onSubmitPicks = function(e){ e.preventDefault(); if (picksLocked) { if (typeof setMsg==="function") setMsg("Submissions are locked right now."); return; }
    const result = validatePicks();
    if (!result.ok) { 
      if (typeof setMsg === "function") setMsg(result.message || "Please complete all required fields and picks.");
      if (result.focus) result.focus();
      return;
    }
    // Reuse 6-digit code when editing; otherwise generate
  const nextCode = (editing && typeof code === "string" && /^\d{6}$/.test(code))
    ? code
    : String(Math.floor(100000 + Math.random() * 900000));
  if (typeof setCode === "function") setCode(nextCode);

  const p = {
    year, week,
    form: { ...form, lastNameLower: (form.lastName || "").toLowerCase().trim() },
    picks,
    code: nextCode,
    editing: !!editing
  };
  try { if (typeof tiebreaker !== "undefined") { p.tiebreaker = tiebreaker; } localStorage.setItem("pending", JSON.stringify(p)); } catch (_){}
  try { if (draftKey) localStorage.removeItem(draftKey); } catch (_){}
if (typeof setPage === "function") setPage("confirm");
if (typeof window !== "undefined") window.history.pushState(null, "", "/confirm");
  setMsg("");
  return; // no write here; Confirm button will write
};
  async function loadByCode() {
    setMsg("");
    const c = (loadCode || "").trim();
    const ln = (loadLastName || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(c) || ln.length === 0) {
      setMsg("Enter your 6-digit code and last name."); return;
    }
    const id = year + "_W" + week + "_" + c;
    try {
      const ref = doc(db, "picks", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { setMsg("No picks found for that code."); return; }
      const d = snap.data();
      const storedLower = (d.lastNameLower || (d.lastName || "").toLowerCase().trim());
      if (storedLower !== ln) { setMsg("Code and last name do not match."); return; }

      setForm(f => ({
        ...f,
        firstName: d.firstName || "",
        lastName: d.lastName || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setMsg("Loaded. Editing code " + c + ".");
    } catch (e) {
      const m = (e && e.message) ? String(e.message) : String(e);
      setMsg("Load failed: " + m);
    }
  }
    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  return (<Container>
<Header user={user} isAdmin={isAdmin} setPage={setPage} />
      <Card style={{ background:"#121a2b" , position:"relative" }}>
        <div style={{ position:"absolute", top:8, left:8, zIndex:2 }}>
    {(!potHidden || isAdmin) && (<>
      <div style={{ fontSize:"0.95rem", fontWeight:600 }}>Current Pot{potHidden ? " (hidden)" : ""}</div>
      <div style={{ fontSize:"1.5rem", fontWeight:800, lineHeight:1 }}>
        ${pot.toLocaleString()} 💰
      </div>
    </>)}
  </div><div style={{ position:"absolute", top:8, right:8, zIndex:2 }}>
    <button onClick={()=>setShowRules(true)} type="button">Rules</button>
  </div>
<Row style={{ justifyContent: "space-between" }}>
  <div style={{ margin:"20px 0 2px", lineHeight:1.25, textAlign:"center", padding:"20px 16px", width:"100%" , position:"relative", paddingBottom:0  }}>
<div style={{ minHeight: 40 }}>
  <div style={{ fontWeight:800, fontSize:30, textDecoration:"underline", opacity:(week==null?0:1), transition:"opacity 150ms ease" }}>
    {week == null ? "" : ("Welcome to Week " + week + "!")}
  </div>
</div>
      <div style={{ marginTop:0, marginBottom:8, textAlign:"center", opacity:.85 }}>(Share with your friends!)</div>
<div style={{ opacity:.85 }}>
      Deadline to submit: {earliestGame ? kickoffLabel(earliestGame, { timeZone: "America/New_York" }) : "TBD"}
    </div>
    <div style={{ marginTop:10, display:"grid", rowGap: 0, justifyItems:"center", width:"100%", marginBottom: 0 }}>
  <div style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
    <span style={{ opacity:.85, fontStyle:"italic", fontSize:13 }}>Already submitted for this week?</span>
    <button onClick={()=>setShowLoad(v=>!v)} style={{ background:"transparent", border:"none", padding:0, height:"auto", width:"auto", fontSize:14, textDecoration:"underline", color:"inherit", cursor:"pointer" }}>Edit here</button>
  </div>
</div>
    <div style={{ marginTop:8, display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap" }}>
      </div>
  </div>
          <div style={{ display:"flex", alignItems:"baseline", gap:12 }}></div>
          
        </Row>

        {showLoad && (
  <>
    <Row style={{ marginBottom: 14, gap: 14, alignItems:"stretch" }}>
      <div style={{ fontWeight:600, flexBasis:"100%" }}>Load by code</div>

      <Field label="Code" style={{ justifyContent:"flex-end" }}>
        <input
          style={inputStyle}
          name="loadCode"
          value={loadCode}
          onChange={e=>setLoadCode(e.target.value)}
          maxLength={6}
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="123456"
        />
      </Field>

      <Field label="Last name" style={{ justifyContent:"flex-end" }}>
        <input
          style={inputStyle}
          name="loadLastName"
          value={loadLastName}
          onChange={e=>setLoadLastName(e.target.value)}
          placeholder="Smith"
        />
      </Field>

      <button
        type="button"
        onClick={loadByCode} style={{top:-14, position:"relative", alignSelf:"flex-end",  padding:"8px 10px", fontSize:12, borderRadius:8, width:72, marginLeft:8}}
      >
        Load
      </button>
    </Row>

    {editing && (
      <div style={{marginBottom:8,fontSize:13,color:"#64748b"}}>
        Editing mode ? code <b>{code}</b>
        <button
          type="button"
          style={{marginLeft:8}}
          onClick={()=>{
            setEditing(false);
            setCode("");
            setLoadCode("");
            setLoadLastName("");
            setShowLoad(false);
            setMsg("");
          }}
        >Clear</button>
      </div>
    )}
  </>
)}
<div role="status" aria-live="polite" style={{ 
  marginTop: 8, marginBottom: 10, padding: "8px 12px", borderRadius: 8, fontWeight: 600, 
  display: "flex", alignItems: "center", gap: 8,
  background: picksLocked ? "#fee2e2" : "#dcfce7",
  color: picksLocked ? "#7f1d1d" : "#14532d",
  border: "1px solid rgba(0,0,0,0.08)"
}}>
  <span style={{ 
    display:"inline-block",
    width:10, height:10, borderRadius:"9999px", 
    background: picksLocked ? "#ef4444" : "#22c55e" 
  }} />
  <span>{picksLocked ? "Submissions CLOSED" : "Submissions OPEN"}</span>
</div>
<form onSubmit={onSubmitPicks} style={{ marginTop: 12 }}>
          <Row style={{ marginBottom: 14 }}>
  <Field label="First name"><input style={inputStyle} name="firstName" value={form.firstName} onChange={e=>setForm({...form, firstName:e.target.value})} onBlur={autofillFromHistory} required/></Field>
  <Field label="Last name"><input style={inputStyle} name="lastName" value={form.lastName} onChange={e=>setForm({...form, lastName:e.target.value})} onBlur={autofillFromHistory} required/></Field>
</Row>
          <Row style={{ marginBottom: 14 }}>
            <Field label="Email">
  <input style={inputStyle} name="email" value={form.email || ""} onChange={e=>setForm({...form, email:e.target.value})} placeholder="you@example.com"/>
</Field>
            <Field label="Phone">
              <input style={inputStyle} name="phone" value={form.phone} onChange={e=>setForm({...form, phone:e.target.value})} placeholder="555-555-5555"/>
            </Field>
            <Field label="Venmo">
              <input style={inputStyle} name="venmo" value={form.venmo} onChange={e=>setForm({...form, venmo:e.target.value})} placeholder="@username"/>
            </Field>
          </Row>

          {showSlowLoadHint && games.length === 0 && (
            <div style={{
              margin:"12px 0", padding:"10px 14px", borderRadius:10, textAlign:"center",
              background:"rgba(240,180,41,0.12)", color:"#f0b429", border:"1px solid rgba(240,180,41,0.45)", fontSize:14
            }}>
              Games are taking a while to load.{" "}
              <a href="#" onClick={(e)=>{e.preventDefault(); window.location.reload();}} style={{ color:"#f0b429", fontWeight:700, textDecoration:"underline" }}>
                Tap here to refresh
              </a>
            </div>
          )}
          <div style={{ margintop:-4, display:"flex", flexDirection:"column", alignItems:"center" }}>
            {pickGroups.map(grp => (
              <section key={grp.key} style={{ margin: "24px 0 6px", width: "100%" }}>
                <div style={{ fontWeight:700, fontSize:16, opacity:.85, margin:"12px 0 8px" }}>{grp.header}</div>
                {grp.items.map(g => (

              <div key={g.id} data-game-id={g.id} style={{ position:"relative",  border:"1px dashed #1f2a44", padding:12, borderRadius:12, margin:"10px auto", maxWidth: 720, width:"100%", marginBottom: 0 }}>
          {g.gameday && (
  <>
    <img src="/logos/collegegameday.png" alt="College GameDay" style={{ position:"absolute", top:6, left:6, width:badgeSize, height:badgeSize, opacity:0.95, pointerEvents:"none" }} />
    <img src="/logos/collegegameday.png" alt="" aria-hidden="true" style={{ position:"absolute", top:badgeTop, right:badgeRight, width:badgeSize, height:badgeSize, opacity:0.95, pointerEvents:"none" }} />
  </>
)}
                <div style={{ order:1, flex:1 }} />
                                    <Row role="radiogroup" style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap: 16, justifyItems:"center", alignItems:"center", justifyContent:"center" }} aria-label={'Pick winner for ' + teamLabel(g.away, g.awayRank) + ' at ' + teamLabel(g.home, g.homeRank)}>
                    <label role="radio" aria-checked={(picks[g.id]===g.away)} onClick={() => setPicks({ ...picks, [g.id]: g.away })} tabIndex={0} onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setPicks({...picks, [g.id]: g.away}); }}} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, justifySelf:"end" }}>
                      <input type="radio" style={{position:"absolute",opacity:0,width:0,height:0}} name={g.id} checked={picks[g.id]===g.away} onChange={()=>setPicks({...picks, [g.id]: g.away})}/>
                      <div className="logoBox" style={{ width:96, height:96, outline: (picks[g.id]===g.away) ? "4px solid #3b82f6" : undefined, outlineOffset:2, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center" }}><TeamLogo school={g.away} size={96}/></div>
                      <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div>
                    </label><div aria-hidden="true" style={{ gridColumn:"2", alignSelf:"center", justifySelf:"center", fontWeight:800, color:"#fff", fontSize:28, lineHeight:"1", margin:"0 6px", pointerEvents:"none" }}>@</div>

                    <label role="radio" aria-checked={(picks[g.id]===g.home)} onClick={() => setPicks({ ...picks, [g.id]: g.home })} tabIndex={0} onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setPicks({...picks, [g.id]: g.home}); }}} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, justifySelf:"start" }}>
                      <input type="radio" style={{position:"absolute",opacity:0,width:0,height:0}} name={g.id} checked={picks[g.id]===g.home} onChange={()=>setPicks({...picks, [g.id]: g.home})}/>
                      <div className="logoBox" style={{ width:96, height:96, outline: (picks[g.id]===g.home) ? "4px solid #3b82f6" : undefined, outlineOffset:2, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center" }}><TeamLogo school={g.home} size={96}/></div>
                      <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>
                    </label>
                  </Row>                  {g.gameday && (
                    <div style={{ marginTop: 16, border:"1px solid #2b3a5c", borderRadius:12, padding:12, background:"#0e1524" }}>
                      <div style={{ fontWeight:700, letterSpacing:0.5, marginBottom:6 }}>College GameDay TIEBREAKER</div>
                      {week === 0 && (
                        <div style={{ fontSize:12, fontStyle:"italic", color:"#9aa4c7", marginBottom:8 }}>
                          Not actually CollegeGameDay, but we need a tiebreaker — and Go Noles.
                        </div>
                      )}
                      <label style={{ display:"block" }}>
                        {"Total Points Scored in the "}
                        <strong>{teamLabelNoMascot(g.away, g.awayRank)} @ {teamLabelNoMascot(g.home, g.homeRank)}</strong>
                        {" Game? (Whole number)"}
                        <input
                          type="number"
                          inputMode="numeric"
                          step="1"
                          min="0"
                          style={{ ...inputStyle, width:220, marginLeft:8, marginTop:8 }}
                          value={tiebreaker.total}
                          onChange={(e)=> setTiebreaker({ gameId: g.id, total: (e.target.value || "").replace(/[^\d]/g,"") })}
                        />
                      </label>
                    </div>
                  )}
              </div>
            
                ))}
              </section>
            ))}
          </div>

          <Row style={{ justifyContent: "flex-end", marginTop: 12 }}><div style={{ marginRight:"auto", display:"flex", alignItems:"center", gap:12 }}><input type="checkbox" aria-label="venmo" checked={form.venmoConfirmed} onChange={e=>setForm({...form, venmoConfirmed:e.target.checked})} /><span style={{ fontSize:12 }}>By checking this box, I confirm I have sent $5 to @ZackSlay on Venmo</span></div>
            <div style={{color:"#c0392b",fontSize:12,margin:"8px 0"}} role="alert">{touchedSubmit && !isValid && (errors.picks || "Please complete all required fields and picks.")}</div>
<button type="submit" disabled={!isValid || picksLocked}>Submit / Update Picks</button>
          <div style={{ color:'#9aa4c7', margintop:-4, fontSize:13 }}>{msg}</div>
          </Row>
        </form>

        
      {showRules && (
  <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999}}>
    <div style={{ background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16, padding:16, maxWidth:720, width:"90%", boxShadow:"0 10px 24px rgba(0,0,0,.35)" }}>
      <h3 style={{ marginTop:0, marginBottom:8 }}>Rules</h3>
      <div style={{ lineHeight: 1.6 }}>
  <h4 style={{ marginTop: 0 }}>Welcome to the 2026 Season!</h4>
  <ul style={{ paddingLeft: "1.25rem", margin: 0 }}>
    <li><strong>Weekly Picks:</strong> Each week you'll pick winners from a curated slate — marquee matchups, AP Top 25 games, all Florida FBS teams, plus a few randoms to keep it interesting.</li>
    <li><strong>Tiebreaker:</strong> Closest to the actual total combined points (over or under) wins. If still tied, the pot is split.</li>
    <li><strong>One Entry:</strong> Only one form per person per week. Need to change a pick before the deadline? Click <em>Edit here</em> and enter your code.</li>
    <li><strong>Canceled/Postponed Games:</strong> If a listed game is canceled or postponed and not completed within the scoring window, it's a <em>push</em> (no points awarded).</li>
    <li><strong>Deadline:</strong> Picks lock at <strong>kickoff of the first game</strong> on the slate.</li>
    <li><strong>Payment:</strong> Venmo <strong>$5</strong> each week to <strong>@ZackSlay</strong> (Zack Slay).</li>
    <li><strong>Payout:</strong> <strong>Winner-take-all.</strong> The highest score wins the entire pot. If there's a tie on points, the tiebreaker decides; if still tied, the pot is split.</li>
  </ul>
</div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:16 }}>
        <button type="button" onClick={()=>setShowRules(false)}>Close</button>
      </div>
    </div>
  </div>
)}
</Card>
    </Container>
  );
}

// -------- LEADERBOARD (sticky first two columns, logos in headers + winners row) --------
function LeaderboardPage({ user, isAdmin, setPage }) {  // DEV: CFBD diagnostics — verify token retrieval/log (no CFBD API calls)
  const isMobile = useIsMobile();
  useEffect(() => { if (!isAdmin) return; if (import.meta && import.meta.env && import.meta.env.DEV) {
      getCfbdKey()
        .then(k => console.debug("[cfbd:diag] token present:", !!k))
        .catch(err => console.warn("[cfbd:diag] token check error:", err?.message || err));
    }
  }, []);
  // SCOREBUG MOUNT flags
  const [showScorebug, setShowScorebug] = useState(() => { try { const v = localStorage.getItem("showScorebug"); return v ? (v === "1") : true; } catch { return true; } });
useEffect(() => { try { localStorage.setItem("showScorebug", showScorebug ? "1" : "0"); } catch {} }, [showScorebug]);
// SCOREBOARD HOOK v3 (config-driven fixture)
  // CFBD token subscriber (read-only; never logged)
  const [cfbdTok, setCfbdTok] = useState(null);
  useEffect(() => { if (!isAdmin) return; const unsub = onSnapshot(doc(db, "config", "cfbd"), (s) => {
      try {
        const d = s && typeof s.data === "function" ? s.data() : null;
        const t = d ? (d.key || d.token || d.apiKey || d.cfbdKey) : null; // support common field names
        setCfbdTok(t || null);
        if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) {
          console.debug("[scoreboard:cfbd] token loaded:", t ? "(present)" : "(missing)");
        }
      } catch {
        setCfbdTok(null);
      }
    });
    return () => unsub && unsub();
  }, []);
  const sbCfg = ((typeof appCfg !== "undefined" && appCfg && appCfg.scoreboard) || {});
  const [sbHardStopGlobal, setSbHardStopGlobal] = useState(null);
  // DEV probe: watch config/app for scoreboard.hardStop (no behavior change)
  useEffect(() => {
    try {
      const ref = doc(db, "config", "app");
      const unsub = onSnapshot(ref, (s) => {
        const d = (s && typeof s.data === "function") ? (s.data() || {}) : {};
        try { window.__APP_CFG = d; } catch {}
        const h =
          !!(d.scoreboard && (
            typeof d.scoreboard.hardStop !== "undefined" ? d.scoreboard.hardStop :
            typeof d.scoreboard.hardstop !== "undefined" ? d.scoreboard.hardstop : false
          ));
        try { setSbHardStopGlobal(h); } catch {}
        if (import.meta?.env?.DEV) console.debug("[global HS] Firestore config/app scoreboard.hardStop =", h, d);
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[global HS] probe failed:", e?.message || e);
    }
  }, []);
  const [sbHardStop, setSbHardStop] = useState(() => { try { const v = localStorage.getItem("sbHardStop"); return v === "1"; } catch { return false; } }); // ADMIN: Hard Stop (default ON; persisted)
useEffect(() => { try { localStorage.setItem("sbHardStop", sbHardStop ? "1" : "0"); } catch {} }, [sbHardStop]);
const [sbLocalFixture, setSbLocalFixture] = useState(() => {
  try { const v = localStorage.getItem("sbLocalFixture"); return v ? (v === "1") : false; } catch { return false; }
}); // ADMIN: Fixture mode (persisted)
useEffect(() => { try { localStorage.setItem("sbLocalFixture", sbLocalFixture ? "1" : "0"); } catch {} }, [sbLocalFixture]);

const hasToken = !!cfbdTok;
const cfg = sbCfg ?? {};
const cfgEmpty = !cfg || (Object.keys(cfg).length === 0 && cfg.constructor === Object);

const sbSourceRaw = cfg?.testMode ? "fixture" : (cfg?.mode === "off" ? "none" : "cfbd");
const sbSource = ((sbHardStopGlobal === null ? sbHardStop : sbHardStopGlobal) ? "none" : (sbLocalFixture ? "fixture" : sbSourceRaw));
if (typeof console !== "undefined" && import.meta && import.meta.env && import.meta.env.DEV) {
    }

  // CFBD PARAMS — memoized to avoid polling effect resets
  const cfbdParams = React.useMemo(() => {
    // merge any config-provided params; keep groups:80 as default
    const base = (sbCfg && sbCfg.cfbdParams) || {};
    return { groups: 80, ...base };
  }, [JSON.stringify((sbCfg && sbCfg.cfbdParams) || {})]);

  const sbOpts = React.useMemo(() => ({
cfbdToken: cfbdTok,
token: cfbdTok,
  source: sbSource,
  fixturePath: (sbCfg && sbCfg.fixturePath) || "/dev/scoreboard-demo.json",
  intervalSec: sbCfg && sbCfg.testMode
    ? Math.max(5, Math.min(60, Number(sbCfg.testIntervalSec || 10)))
    : Math.max(60, Math.min(180, Number(sbCfg.intervalSec || 60))),
  pauseWhenHidden: true,
  cfbd: { token: cfbdTok, params: (sbCfg && sbCfg.cfbdParams) || {} }
}), [cfbdTok, sbSource, sbCfg?.fixturePath, sbCfg?.testMode, sbCfg?.testIntervalSec, sbCfg?.intervalSec, cfbdParams]);
  const sbNorm = (s) => String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/g, "");
  const { map: sbMap, lastUpdatedEt: sbUpdated, isPaused: sbPaused, refresh: sbRefresh } = useScoreboard(sbOpts);

  const [publicSbMap, setPublicSbMap] = useState(new Map());
// Everyone subscribes to a published scoreboard map for public/live viewing
useEffect(() => {
  try {
    const unsub = onSnapshot(doc(db, "config", "liveMap"), (s) => {
      try {
        const d = s?.data() || {};
        const obj = (d && d.map) ? d.map : {};
        // Convert plain object -> Map
        setPublicSbMap(new Map(Object.entries(obj || {})));
      } catch {}
    });
    return () => { try { unsub(); } catch {} };
  } catch {}
}, []);

// Admin relay: when admin is live on CFBD, publish a trimmed map for the public
useEffect(() => {
  try {
    if (isAdmin && sbSource === "cfbd" && sbMap && typeof sbMap.size === "number" && sbMap.size > 0) {
      const obj = Object.fromEntries(Array.from(sbMap.entries()));
      const json = JSON.stringify(obj);
      const now = Date.now();
      const last = lastPublishRef.current || { t: 0, h: "" };
      const changed = json !== last.h;
      const due = (now - last.t) >= 20000; // 20s min interval
      if (changed || due) {
        setDoc(doc(db, "config", "liveMap"), { map: obj, updatedAt: now }, { merge: true });
        lastPublishRef.current = { t: now, h: json };
      }
    }
  } catch {}
}, [isAdmin, sbSource, sbMap]);
  const scoreMap = sbMap;

  // Public liveMap (read-only): used when user is NOT admin
  const [publicLiveMap, setPublicLiveMap] = React.useState(null);

  React.useEffect(() => {
    if (isAdmin) return; // admins use direct CFBD map
    try {
      const ref = doc(db, "config", "liveMap");
      const unsub = onSnapshot(ref, (snap) => {
        const data = snap.data?.() ?? snap.data();
        const items = Array.isArray(data?.items) ? data.items : [];
        const m = new Map(items.map(it => [it.key ?? `${it.awayTeam}_at_${it.homeTeam}`, it]));
        setPublicLiveMap(m);
        if (import.meta?.env?.DEV) console.debug("[liveMap] received items:", items.length); try { window._liveMap = m; window._uiScoreMap = m; } catch {}
        // Expose for quick console checks
        try { window._liveMap = m; } catch {}
      });
      return () => unsub && unsub();
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[liveMap] listener failed", e);
    }
  }, [isAdmin]);

  // For future rendering swap: prefer public map when not admin
  const uiScoreMap = isAdmin ? sbMap : (publicLiveMap ?? new Map());
  try { window._uiScoreMap = uiScoreMap; } catch {}

useEffect(() => {
  try {
    window._lbDebug = window._lbDebug || {};
    window._lbDebug.liveMap = () => {
      const toKeys = (m) => (m && typeof m.size === "number" && m.size > 0) ? Array.from(m.keys()) : [];
      const out = {
        isAdmin: !!isAdmin,
        sbSource,
        sbMapSize: (sbMap && sbMap.size) || 0,
        publicLiveMapSize: (publicLiveMap && publicLiveMap.size) || 0,
        publicSbMapSize: (publicSbMap && publicSbMap.size) || 0,
        uiScoreMapSize: (uiScoreMap && uiScoreMap.size) || 0,
        sampleUiKeys: toKeys(uiScoreMap).slice(0, 5),
      };
      console.log("[lb] liveMap diag", out);
      return out;
    };
  } catch {}
}, [isAdmin, sbSource, sbMap, publicLiveMap, publicSbMap, uiScoreMap]);

  // Publish minimal, public-friendly live map for the Leaderboard
  useEffect(() => { try {
      const items = [];
      for (const [key, v] of (sbMap ? Array.from(sbMap.entries()) : [])) {
        items.push({ key, awayTeam: v?.awayTeam ?? v?.away ?? null,
          homeTeam: v?.homeTeam ?? v?.home ?? null,
          status: v?.status ?? null,
          period: Number.isFinite(+v?.period) ? +v.period : null,
          clock: typeof v?.clock === "string" ? v.clock : null,
          awayPoints: Number.isFinite(+v?.awayPoints) ? +v.awayPoints : null,
          homePoints: Number.isFinite(+v?.homePoints) ? +v.homePoints : null,
          possession: (v?.possession === "home" || v?.possession === "away") ? v.possession : null,
          startTime: v?.startTime ?? null,
        });
      }
      if (items.length > 0) {
        setDoc(doc(db, "config", "liveMap"), { items, updatedAt: serverTimestamp() }, { merge: true });
        if (import.meta?.env?.DEV) console.debug("[liveMap] published items:", items.length);
      }
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[liveMap] publish failed", e);
    }
  }, [isAdmin, sbMap]);
  // Instant fetch when ready (one-shot): as soon as source is "cfbd" and token exists
  const __sbInstantOnce = useRef(false);
  useEffect(() => {
    if (__sbInstantOnce.current) return;
    if (sbSource === "cfbd" && cfbdTok && typeof sbRefresh === "function") {
      __sbInstantOnce.current = true;
      // microtask to ensure hook is fully settled
      Promise.resolve().then(() => { try { sbRefresh(); } catch {} });
    }
  }, [sbSource, cfbdTok]);
  // Instant fetch when ready: as soon as we’re allowed to poll, fetch once so scores appear immediately
  useEffect(() => {
    try {
      if (sbSource === "cfbd" && cfbdTok) {
        if (typeof sbRefresh === "function") sbRefresh();
      }
    } catch (_) {}
  }, [sbSource, cfbdTok]);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      setLive(d);
    });
    return () => unsub();
  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);
  // One-time copy of live {year,week} to local state (prevents flicker)

  const [live, setLive] = useState({ year: null, week: null });
  const initFromLiveRef = useRef(false);
  useEffect(() => {
    if (!initFromLiveRef.current && live?.year && live?.week) {
      setYear(live.year);
      setWeek(live.week);
      initFromLiveRef.current = true;
    }
  }, [live]);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
const pot = useMemo(() => (pickCount * 5), [pickCount]);

useEffect(() => {
  (async () => {
    try {
      if (hasWeekValue(year) && hasWeekValue(week)) {
        const arr = await getPicksForWeek(year, week);
        setPickCount(Array.isArray(arr) ? arr.length : 0);
      } else {
        setPickCount(0);
      }
    } catch {
      setPickCount(0);
    }
  })();
}, [year, week]);
// INITIAL_LIVE_AUTOLOAD: on first mount, load games for the live week (config/live)
  useEffect(() => {
        try {
      const ref = doc(db, "config", "live");
      // Subscribe once, then auto-unsub after we apply the first live week load
      const unsub = onSnapshot(ref, async (s) => {
        const d = s.data() || {};
        const y = Number(d.year), w = Number(d.week);
        setLive({ year: y, week: w });
        if (!hasWeekValue(y) || !hasWeekValue(w)) { return; }

        // Keep Admin controls consistent, but the important part is we load the live week now:
        setYear(y);
        setWeek(w);

        try {
          const gs = await listGames({ year: y, week: w, includedOnly: false });
          setGames(gs);
        } catch (e) {
          console.error(e);
        } finally {
          // We only need this once on entry; further changes can be manual
          unsub();
        }
      });
      return () => { try { unsub(); } catch {} };
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Put College GameDay at the end of the list (Leaderboard)
  const gameday = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
  const displayGames = gameday ? [...games.filter(x => x && x.id !== gameday.id), gameday] : games;
  const [results, setResults] = useState({});
  // Auto-winner detection now runs server-side in the publishLiveMap Cloud
  // Function, so it works regardless of whether an admin has this page open.
  const [players, setPlayers] = useState([]);
  // Pickems Coach: public picks flag (read-only)
  const [lbPicksPublic, setLbPicksPublic] = useState(null);
  
  const [cfgLoaded, setCfgLoaded] = useState(false);useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s?.data?.() || {};
      setLbPicksPublic(!!d.leaderboardPicksPublic); setCfgLoaded(true);
    });
    return () => unsub();
  }, []);// [{name,email,points,picks:{gameId:choice}}]
  const [msg, setMsg] = useState("");
  // Submissions lock (config/app.picksLocked)
  const [picksLocked, setPicksLocked] = useState(false);
  const [potHidden, setPotHidden] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
      setPotHidden(!!d.potHidden);
    });
    return () => unsub && unsub();
  }, []);

// Weeks dropdown: populate from games in the selected year
const [weeksForYear, setWeeksForYear] = useState([]);
useEffect(() => {
  (async () => {
    try {
      const q = query(collection(db, "games"), where("year", "==", Number(year)));
      const snap = await getDocs(q);
      const uniq = new Set();
      snap.forEach(d => {
        const w = d.data()?.week;
        if (Number.isFinite(+w)) uniq.add(Number(w));
      });
      setWeeksForYear([...uniq].sort((a,b)=>a-b));
    } catch (err) {
      console.error("weeksForYear load failed", err);
      setWeeksForYear([]);
    }
  })();
}, [year]);const [loadCode, setLoadCode] = useState("");
  const [loadLastName, setLoadLastName] = useState("");
  const [editing, setEditing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);


  // Compact widths (tweak here as you like)
  const NAME_COL_W = 130;
  const POINTS_COL_W = 60;

  
const GAME_COL_W = 140;
const loadAll = async () => {
  if (!(hasWeekValue(year) && hasWeekValue(week))) { return; }
  setMsg("Loading...");
  try {
    const { games: g, results: r, rows, playedGames } = await computeWeekStandings(year, week);
    setGames(g);
    setResults(r);
    setPlayers(rows);
    setMsg(`Week ${week}  -  Included games: ${g.length}  -  Finished: ${playedGames}`);
  } catch (e) {
    setMsg("Load failed: " + (e?.message || String(e)));
  }
};

  useEffect(() => {
  if (!(hasWeekValue(year) && hasWeekValue(week))) return;
  loadAll();
  /* eslint-disable-next-line */
}, [year, week]);
// INITIAL_KICK: ensure one load after mount (handles first-open race) — with short poll until year/week are finite
useEffect(() => {
  let tries = 0;
  const t = setInterval(() => {
    if (hasWeekValue(year) && hasWeekValue(week)) {
      try { loadAll(); } catch (e) { console.error("init loadAll failed", e); }
      clearInterval(t);
    } else if (++tries >= 20) { // ~3 seconds max (20 * 150ms)
      clearInterval(t);
    }
  }, 150);
  return () => clearInterval(t);
  /* eslint-disable-next-line */
}, []);// Step 8.2 ? Admin lock override
  const [lbLocked, setLbLocked] = useState(null);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setLbLocked(!!d.leaderboardLocked);
    });
    return () => unsub();
  }, []);

  if (lbLocked && !isAdmin && Number(year) === Number(live?.year) && Number(week) === Number(live?.week)) {
      // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  return (<Container maxWidth={1200}>
        <Header user={user} isAdmin={isAdmin} setPage={setPage} />
        <Card>
          <h2 style={{ margin: 0 }}>CFB Pick'Ems Week {week}</h2>
<Field label="Previous weeks">
  <select value={(week ?? '')} onChange={e => setWeek(Number(e.target.value))} style={inputStyle}>
    {(weeksForYear.length ? weeksForYear : Array.from({ length: 21 }, (_, i) => i)).map(w => (
      <option key={w} value={w}>Week {w}</option>
    ))}
  </select>
</Field>
          <div style={{ marginTop: 8, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700 }}>Leaderboard locked for Week {week}</div>
            <div>Leaderboard will be activated when the first game kicks off</div>
            <div>To submit or edit picks, visit the Picks page</div>
          </div>
        </Card>
      </Container>
    );
  }

  const sticky1 = (extra = {}) => ({
  position: "sticky",
  left: 0,
  zIndex: 5,
  background: "#0b1220",
  width: NAME_COL_W,
  minWidth: NAME_COL_W,
  borderRight: "none",
  boxShadow: "inset -1px 0 0 0 #1f2a44",
  ...extra
});
  const sticky2 = (extra = {}) => ({
  position: "sticky",
  left: NAME_COL_W,
  zIndex: 4,
  background: "#0b1220",
  width: POINTS_COL_W,
  minWidth: POINTS_COL_W,
  borderRight: "none",
  boxShadow: "inset -1px 0 0 0 #1f2a44",
  ...extra
});

  const cell = { lineHeight:"1.15", border:"1px solid #1f2a44", padding:"4px 6px", whiteSpace:"nowrap", fontSize:11 };
  const headerCell = { ...cell, textAlign:"center", paddingTop: 12, paddingBottom: 12, lineHeight: 1.25, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontSize: "clamp(10px, 0.95vw, 12px)" };


  const pickCellBase = { ...cell, textAlign:"center", width: GAME_COL_W, minWidth: GAME_COL_W, maxWidth: GAME_COL_W };
  const pickCellStyle = (gameId, choice) => { const base = { ...cell, textAlign:"center", width: 140, minWidth: 140 };
  const w = results[gameId]?.winner;
  if (!w || !choice) return base;
  if (choice === w) return { ...base, background: "#00ff00", color: "#111" };
  return { ...base, background: "#ea9999", color: "#111" };
};

  // Winner cell with tiny logo
  const winnerCell = (g) => {
    const w = results[g.id]?.winner;
    if (!w) return "";
    const isHome = w === g.home;
    const rank = isHome ? g.homeRank : g.awayRank;
    return (
      <span style={{ display:"inline-flex", flexWrap:"wrap", justifyContent:"center", alignItems:"center", width:"100%", textAlign:"center", rowGap:"0", lineHeight: 1.24, fontWeight:700, fontSize: fitFontByLen(((teamLabelNoMascot(g.away,g.awayRank)||"").length + (teamLabelNoMascot(g.home,g.homeRank)||"").length)), gap: 8 }}>
        <span>{teamLabel(w, rank)}</span>
      </span>
    );
  };

  const playedCount = games.filter(g => !!results[g.id]?.winner).length;

    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  return (<Container maxWidth={1200}>
      <Header user={user} isAdmin={isAdmin} setPage={setPage} />
      <Card>
        <Row style={{ justifyContent:"space-between", alignItems:"flex-end" }}>
          <h2 style={{ margin: 0 }}>CFB Pick'Ems Week {week}</h2>
<Field label="Previous weeks">
  <select value={(week ?? '')} onChange={e => setWeek(Number(e.target.value))} style={inputStyle}>
    {(weeksForYear.length ? weeksForYear : Array.from({ length: 21 }, (_, i) => i)).map(w => (
      <option key={w} value={w}>Week {w}</option>
    ))}
  </select>
</Field>
        </Row>
        {isMobile && (
          <div style={{ fontSize:11, color:"#9aa4c7", margin:"6px 2px 0", textAlign:"center" }}>
            &harr; Swipe the table to see more games
          </div>
        )}
        <Row style={{ justifyContent:"space-between", alignItems:"flex-end" }}>


                    <div style={{ order:1, flex:1 }} /><div id="lbTopScroll" style={{  overflowX:"auto", height:10, marginBottom:0, width:"100%"  }} onMouseEnter={(e) => { const b = document.getElementById("lbGrid"); const s = document.getElementById("lbTopSpacer"); if (b && s) { const w = b.scrollWidth; if (s.style.width !== (w + "px")) s.style.width = (w + "px"); } }} onScroll={(e) => {
       const b = document.getElementById('lbGrid');
       if (b && b.scrollLeft !== e.currentTarget.scrollLeft) b.scrollLeft = e.currentTarget.scrollLeft;
     }}>
  <div id="lbTopSpacer" style={{ height:1 }} />
</div>
<div id="lbGrid" style={{ marginTop:0, overflowX:"auto", border:"1px solid #1f2a44", borderRadius:12 }}
     onScroll={(e) => {
       const t = document.getElementById('lbTopScroll');
       if (t && t.scrollLeft !== e.currentTarget.scrollLeft) t.scrollLeft = e.currentTarget.scrollLeft;
       const s = document.getElementById('lbTopSpacer');
       const w = e.currentTarget.scrollWidth;
       if (s && s.style.width !== (w + 'px')) s.style.width = w + 'px';
     }}>
{isAdmin && (
  <div className="scoreboard-admin-strip" /* SCOREBOARD ADMIN STRIP v1 */
       style={{ display:"flex", gap:12, alignItems:"center", flexWrap:"wrap", fontSize:12, margin:"8px 0",
                padding:"6px 10px", borderRadius:8, background:"rgba(16,20,28,.6)", color:"#fff",
                /* Pinned to the left edge (like the Name/Score columns below) so it stays
                   visible instead of scrolling away with the game columns on mobile. */
                position:"sticky", left:0, width:"max-content", maxWidth:"100%" }}>
<button
  onClick={async (e) => {
    e.preventDefault();
    try {
      const { setDoc, doc, serverTimestamp, getDoc, writeBatch } = await import("firebase/firestore");
      const appSnap = await getDoc(doc(db,"config","app"));
      const appData = appSnap.exists() ? appSnap.data() : {};
      let y = appData?.currentYear;
      let w = appData?.currentWeek;
      const tok = cfbdTok;
      // --- prompt override so the button respects the week you choose ---
      try {
        const defStr = (y && w) ? `${y}-W${w}` : "";
        const resp = prompt("Write Winners (CFBD) for which Year-Week? (use YYYY-W#)", defStr);
        if (!resp) return;
        const m = resp.match(/^(\d{4})\s*-\s*W\s*(\d{1,2})$/i);
        if (!m) { alert("Invalid format. Use YYYY-W# (e.g., 2025-W2)."); return; }
        y = Number(m[1]);
        w = Number(m[2]);
      } catch {}

      if (!tok) { alert("CFBD token missing (config/cfbd)."); return; }
      if (!hasWeekValue(y) || !hasWeekValue(w)) { alert("currentYear/currentWeek missing (config/app)."); return; }

      const normalizeKey = (name) => {
        if (!name) return "";
        let s = String(name).toLowerCase();
        s = s.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
        s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
        if (s === "texasam" || s === "texasa&m") s = "texasam";
        return s;
      };
      const gameIdFrom = (home, away) => `${normalizeKey(away)}__${normalizeKey(home)}`;

      // Write directly to results/{gameId} (the same schema "Set Winner" and the
      // server-side auto-writer use) instead of a separate weekly-bulk doc, so
      // there's a single results schema going forward.
      const ourGames = await listGames({ year: y, week: w, includedOnly: false });
      const byKey = new Map(ourGames.map(g => [gameIdFrom(g.home, g.away), g]));

      const qs = new URLSearchParams({ year: String(y), week: String(w), seasonType: "regular", division: "fbs" });
      const url = `https://api.collegefootballdata.com/games?${qs}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) throw new Error(`CFBD HTTP ${res.status}`);
      const arr = await res.json();

      const batch = writeBatch(db);
      let written = 0, skippedNoMatch = 0, skippedIncomplete = 0;
      for (const g of (Array.isArray(arr) ? arr : [])) {
        const home = g.home_team ?? g.homeTeam ?? g.home ?? "";
        const away = g.away_team ?? g.awayTeam ?? g.away ?? "";
        const hp = Number.isFinite(+g.home_points) ? +g.home_points : (Number.isFinite(+g.homePoints) ? +g.homePoints : null);
        const ap = Number.isFinite(+g.away_points) ? +g.away_points : (Number.isFinite(+g.awayPoints) ? +g.awayPoints : null);
        if (hp == null || ap == null || hp === ap) { skippedIncomplete++; continue; }

        const ourGame = byKey.get(gameIdFrom(home, away));
        if (!ourGame) { skippedNoMatch++; continue; }

        const winner = hp > ap ? ourGame.home : ourGame.away;
        batch.set(doc(db, "results", ourGame.id), {
          winner, totalPoints: hp + ap,
          updatedAt: serverTimestamp(),
          source: "cfbd-manual"
        }, { merge: true });
        written++;
      }
      await batch.commit();

      alert(`Winners written for ${written} game(s) in week ${w}, ${y}.` +
        (skippedNoMatch ? ` (${skippedNoMatch} CFBD game(s) had no matching imported game.)` : "") +
        (skippedIncomplete ? ` (${skippedIncomplete} not yet final or tied.)` : ""));
    } catch (err) {
      console.error("[Write Winners (CFBD)] failed", err);
      alert("Write failed: " + (err?.message || err));
    }
  }}
  style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background:"transparent", color:"#fff", cursor:"pointer", marginLeft:6 }}
>
  Write Winners (CFBD)
</button>
    <span style={{opacity:.8}}>Scoreboard:</span>
    <strong>{(() => { const m = String(sbSource||"none").toLowerCase(); return m === "fixture" ? "Demo" : m === "cfbd" ? "Live" : "Off"; })()}</strong>
    <span style={{opacity:.8}}>Last updated:</span>
    <span>{sbUpdated || "—"}</span>
    <span style={{opacity:.8}}>Status:</span>
    <span>{(sbSource === "none" ? "Paused" : (sbPaused ? "Paused" : "Running"))}</span>
    <span style={{opacity:.8, marginLeft:12}}>Live Scores:</span>
    <button
      onClick={async (e) => { e.preventDefault(); const next = !(sbHardStopGlobal ?? sbHardStop); try { await setDoc(doc(db,"config","app"), { scoreboard: { hardStop: next, mode: next ? "off" : "on" } }, { merge:true }); } catch (err) { console.error("[hardStop] update failed", err); } }}
      style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background: (sbHardStopGlobal ?? sbHardStop) ? "#B91C1C" : "#065F46", color:"#fff", fontWeight:600 }}
      title="Turn live scores on or off (master kill switch)"
    >
      {(sbHardStopGlobal ?? sbHardStop) ? "OFF" : "ON"}
    </button>
    <span style={{opacity:.8, marginLeft:12}}>Scorebug:</span>
    <button
      onClick={(e) => { e.preventDefault(); setShowScorebug(v => !v); }}
      style={{ padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.2)", background: showScorebug ? "#065F46" : "#B91C1C", color:"#fff", fontWeight:600 }}
      title="Toggle the scorebug row">
      {showScorebug ? "ON" : "OFF"}
    </button>
    <button onClick={(e) => { e.preventDefault(); sbRefresh && sbRefresh(); }}
            style={{ marginLeft:"auto", padding:"4px 8px", borderRadius:6, border:"1px solid rgba(255,255,255,.25)",
                     background:"transparent", color:"#fff", cursor:"pointer" }}>
      Refresh
    </button>
  
    
</div>
)}
          {!lbPicksPublic && !isAdmin && (
            <div role="status" style={{
              marginTop: 8, marginBottom: 12, padding: "12px 16px", borderRadius: 10,
              lineHeight: 1.6, background: "rgba(240,180,41,0.12)", color: "#f0b429",
              border: "1px solid rgba(240,180,41,0.45)", fontWeight: 600
            }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Leaderboard locked for Week {week}</div>
              <div>It will be activated when the first game kicks off.</div>
              <div>To submit or edit picks, visit the Picks page and type in your edit code.</div>
              <div>If you lost your code, contact Zack.</div>
            </div>
          )}
          <table style={{ tableLayout:"auto", borderCollapse:"separate", borderSpacing:0, width:"max-content", minWidth:"auto" }}>
            <thead>
              <tr>
                <th rowSpan={showScorebug ? 3 : 2} colSpan={2} style={{ ...headerCell, ...sticky1(), width: NAME_COL_W + POINTS_COL_W, minWidth: NAME_COL_W + POINTS_COL_W, padding:"1px 4px", fontSize:11, lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", verticalAlign:"middle" }}>
                  {(!potHidden || isAdmin) && (<>
                    <div style={{ fontSize:"0.95rem", fontWeight:600 }}>
                      This Week&apos;s Pot{potHidden ? " (hidden)" : ""}:
                    </div>
                    <div style={{ fontSize:"1.4rem", fontWeight:800, lineHeight:1.3 }}>
                      ${pot.toLocaleString()} 💰
                    </div>
                  </>)}
                </th>
                {(() => {
  const tz = "America/New_York";
  const fmtDay = new Intl.DateTimeFormat("en-US",{ weekday:"long", timeZone: tz });
  const fmtTime = new Intl.DateTimeFormat("en-US",{ hour:"numeric", minute:"2-digit", hour12:true, timeZone: tz });

  // Robust GameDay detection: allow flag on the game OR a live config id match if present
  const isGameDay = (g) => {
  const id = String(g?.id ?? "");
  const liveId = String((live && (live.gameDayId ?? live.gamedayId)) ?? "");
  if (liveId) return id === liveId; // single source of truth when provided
  return g?.gameday === true || g?.isGameDay === true || g?.gameDay === true;
};

  // Local date extraction (donâ€™t depend on external helpers here)
  const dateOf = (g) => {
    try {
      let s = g?.startTimeStr ?? g?.start ?? g?.start_time ?? g?.kickoff ?? g?.date;
      if (!s) return null;
      if (typeof s === "object" && typeof s.toDate === "function") return s.toDate();
      if (typeof s === "object" && typeof s.seconds === "number") return new Date(s.seconds * 1000);
      if (typeof s === "number") return new Date(s < 1e12 ? s * 1000 : s);
      if (typeof s === "string") return new Date(s);
    } catch (_) {}
    return null;
  };

  // Label rules: non-Sat -> "<Day> Night Games"; Sat 12:00 PM -> "Noon Games"; else "<h:mm AM/PM> Kickoff"; fallback "TBD"
  const labelFor = (g) => {
    const d = dateOf(g);
    if (!d || isNaN(+d)) return "TBD";
    const weekday = fmtDay.format(d);
    if (weekday !== "Saturday") return `${weekday} Night Games`;
    const time = fmtTime.format(d);
    if (time === "12:00 PM") return "Noon Games";
    return isMobile ? time : `${time} Kickoff`;
  };

  // Build spans across ALL games; insert a standalone cell wherever GameDay appears
  const spans = [];
  let i = 0;
// Force GameDay to the end for grouping labels only (does not reorder table columns)
const seq = [
  ...games.filter(g => !(g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId))),
  ...games.filter(g =>  (g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId)))
];
while (i < seq.length) {
    const g = seq[i];
    if (g?.gameday || (live?.gamedayGameId && g?.id === live?.gamedayGameId)) {
      spans.push({ type: "gameday", span: 1 });
      i++;
      continue;
    }
    const lbl = labelFor(g);
    let span = 1; i++;
    while (i < seq.length && !(seq[i]?.gameday || (live?.gamedayGameId && seq[i]?.id === live?.gamedayGameId)) && labelFor(seq[i]) === lbl) { span++; i++; }
    spans.push({ type: "group", label: lbl, span });
  }

  return <>
    {spans.map((sp, idx) => sp.type === "group" ? (
      <th key={"grp-"+idx}
          colSpan={sp.span}
          style={{ ...headerCell, textAlign:"center", fontSize:11, padding:"1px 4px", lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", background:"rgba(0,0,0,0.04)" }}>
        {sp.label}
      </th>
    ) : (
      <th key={"grp-gameday-"+idx}
          style={{ ...headerCell, textAlign:"center", fontSize:11, padding:"1px 4px", lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", background:"rgba(0,0,0,0.04)" }} colSpan={2}>
        College GameDay
      </th>
    ))}
  </>;
})()}
              </tr>
              <tr>
                {displayGames.map(g => (

                  <th key={g.id} data-game-id={g.id} style={{ ...headerCell, textAlign: "center" }}><div style={{ display:"block", width:"100%", textAlign:"center", lineHeight: 1.24 }}>
  <div style={{
    whiteSpace:"nowrap",
    fontWeight:700,
    fontSize: fitFontByLen(Math.max(((teamLabelNoMascot(g.away,g.awayRank)||"").length + 2), (teamLabelNoMascot(g.home,g.homeRank)||"").length))
  }}>
    {teamLabelNoMascot(g.away,g.awayRank)} <span aria-hidden="true" style={{ color:"#fff", padding: 0, margin: "0 0 0 2px" }}>@</span>
  </div>
  <div style={{
    whiteSpace:"nowrap",
    fontWeight:700,
    fontSize: fitFontByLen(Math.max(((teamLabelNoMascot(g.away,g.awayRank)||"").length + 2), (teamLabelNoMascot(g.home,g.homeRank)||"").length))
  }}>
    {teamLabelNoMascot(g.home,g.homeRank)}
  </div>
</div></th>
                
                ))}{gameday ? (<th key="tb" style={{ ...headerCell, textAlign:"center" }}><div style={{ display:"block", width:"100%", textAlign:"center", lineHeight: 1.24 }}>
  <div style={{ whiteSpace:"nowrap" }}>College GameDay</div>
  <div style={{ whiteSpace:"nowrap" }}>Tiebreaker</div>
</div></th>) : null}
              </tr>
{showScorebug && (
  <tr className="scorebug-row"> {/* SCOREBUG ROW v1 (disabled by flag) */}
    {displayGames.map(g => (
      <td key={"sb-" + g.id} style={{ ...cell, textAlign: "center" }}>
        <Scorebug
            awayId={g.away}
            homeId={g.home}
            kickoffLabel={kickoffLabel(g, { timeZone: "America/New_York" })}
            live={(() => {
              // winners map for this week (already loaded into `results`)
              const r = results?.[g?.id] || null;
              const fromWinners = r ? {
                status: r.status || (r.winner ? "final" : null),
                period: (typeof r.period === "number" ? r.period : (r.status === "final" ? 4 : null)),
                clock: null,
                homePoints: (typeof r.homePoints === "number" ? r.homePoints : null),
                awayPoints: (typeof r.awayPoints === "number" ? r.awayPoints : null),
                possession: null
              } : null;

              // If this is NOT the current live week, always show winners (finals) for past weeks
              const isCurrent = Number(year) === Number(live?.year) && Number(week) === Number(live?.week);
              if (!isCurrent) return fromWinners;

              // For the current week, prefer live scoreboard; fallback to winners if missing/final only
              const norm = (s) => {
                if (!s) return "";
                let t = String(s).toLowerCase();
                t = t.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
                t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ");
                const squish = t.replace(/\s+/g,"");
                return squish;
              };
              const awayKey = norm(g?.away);
const homeKey = norm(g?.home);
const key = awayKey + "__" + homeKey;
// Prefer CFBD map when active; otherwise use the published public map
const uiMap = (() => {
  try {
    if (sbMap && typeof sbMap.size === "number" && sbMap.size > 0) return sbMap;
  } catch {}
  try {
    if (publicLiveMap && typeof publicLiveMap.size === "number" && publicLiveMap.size > 0) return publicLiveMap;
  } catch {}
  try {
    if (publicSbMap && typeof publicSbMap.size === "number" && publicSbMap.size > 0) return publicSbMap;
  } catch {}
  return new Map();
})();
let liveItem = (uiMap && uiMap.get) ? uiMap.get(key) : null;
if (!liveItem && uiMap && uiMap.size) {
  try {
    // Fallback: find any key that contains both normalized tokens (covers school-only vs mascot)
    const keys = Array.from(uiMap.keys());
    const guess = keys.find(k => k.indexOf(awayKey) !== -1 && k.indexOf(homeKey) !== -1);
    if (guess) liveItem = uiMap.get(guess);
  } catch {}
}
return liveItem || fromWinners;
            })()}
          />
      </td>
    ))}
  </tr>
)}
              <tr>
                <td style={{ ...cell, ...sticky1({ fontStyle:"italic" }) }}></td>
                <td style={{ ...cell, ...sticky2({ textAlign:"center", fontWeight:600 }) }}>{playedCount}</td>
                {displayGames.map(g => (

                  <td key={g.id} data-game-id={g.id} style={{ ...winnerCellStyleFn(results, cell, g), width: 140, minwidth: 140, fontStyle:"italic", fontSize: fitFontByLen(String(results[g.id]?.winner||"").length) }}>{winnerCell(g)}</td>
                
                ))}{gameday ? (<td key="tb_win" style={{ ...cell, textAlign:"center", fontStyle:"italic", width: 140, minwidth: 140 }}></td>) : null}
              </tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr key={p.id || p.code || p.email || p.name}>
                  <td style={{ ...cell, ...sticky1() }}>
                    {p.isWinner && <span title={p.winNote || "Winner"} style={{ marginRight: 6 }}>🏆</span>}
                    {p.name}
                    {p.winNote && <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.75, marginTop: 2 }}>{p.winNote}</div>}
                  </td>
                  <td style={{ ...cell, ...sticky2({ textAlign:"center", fontWeight:700 }) }}>{p.points}</td>
                  {displayGames.map(g => {
                    const canSeePicks = lbPicksPublic || isAdmin;
                    const choice = p.picks?.[g.id];
                    const label = !canSeePicks ? "🔒" :
                      choice === g.home ? teamLabel(g.home, g.homeRank) :
                      choice === g.away ? teamLabel(g.away, g.awayRank) :
                      (choice || "-");
                    return (
                      <td key={g.id} data-game-id={g.id} style={{ ...pickCellStyle(g.id, canSeePicks ? choice : null), width: 140, minwidth: 140 }}><div style={{display:"flex",justifyContent:"center"}}>{label}</div></td>
                    );
                  })}
                {gameday ? (
  <td key={"tb_"+(p.email||p.name||p.code||p.id)}
      style={{ ...cell, textAlign:"center", width: 140, minwidth: 140 }}>
    {(lbPicksPublic || isAdmin) ? (p.tb ?? (p.tiebreaker?.total ?? p.tiebreaker ?? p.tieBreaker ?? p.tiebreak ?? p.tb ?? "")) : "🔒"}
  </td>
) : null}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Row>
      
</Card>
    </Container>
  );
}

/** kickoff helpers (ignore start_time_tbd if we have a real datetime) */
const kickoffDate = (g) => {
  if (!g) return null;
  // consider many possible fields
  const cand = [
    g.kickoff, g.start, g.startTime, g.start_time,
    g.startDate, g.start_date, g.date, g.startTimeStr
  ].find(v => v != null);

  let d = null;
  try {
    const s = cand;
    if (!s) return null;

    if (typeof s === "object") {
      if (typeof s.toDate === "function") {
        d = s.toDate();                           // Firestore Timestamp
      } else if (typeof s.seconds === "number") {
        d = new Date(s.seconds * 1000);           // {seconds, nanoseconds}
      }
    } else if (typeof s === "number") {
      d = new Date(s < 1e12 ? s * 1000 : s);      // seconds or ms
    } else if (typeof s === "string") {
      const trimmed = s.trim();
      // Support "YYYY-MM-DD HH:MM" by normalizing to ISO
      if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(trimmed)) {
        d = new Date(trimmed.replace(" ", "T") + (g.tz || g.timezone || "Z"));
      } else {
        d = new Date(trimmed);                    // ISO or RFC string
      }
    }

    if (!d && g.date && g.time) {
      d = new Date(g.date + "T" + g.time + (g.tz || g.timezone || "Z"));
    }
  } catch (_) {}

  return d && isFinite(d.getTime()) ? d : null;
};

const kickoffLabel = (g, opts = {}) => {
  const d = kickoffDate(g);
  if (!d) return "TBD";
  const tz =
    (opts && opts.timeZone) ||
    (Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "America/New_York";
  try {
    // Use explicit fields (widely supported) + weekday at the start.
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz
    }).format(d);
  } catch (_e) {
    // Fallbacks if some options are not supported
    try {
      return d.toLocaleString("en-US", { weekday: "short" });
    } catch {
      return d.toString();
    }
  }
};

const isKickoffTbd = (g) => !kickoffDate(g);

function AdminNotificationsPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  // Per-device action buttons: instead of an unpredictable ragged wrap, lay
  // them out as a deliberate 2-per-row grid on mobile (still a flex-wrap
  // container, just with each button's basis pinned to half width).
  const deviceBtnHalf = isMobile ? { flexBasis: "calc(50% - 4px)" } : undefined;
  const [msg, setMsg] = useState("");
  const [live, setLive] = useState({ year: null, week: null });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);
  const year = live.year, week = live.week;

  const [notifCfg, setNotifCfg] = useState({});
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      const def = {
        reminder2dEnabled: true, reminder1dEnabled: true, reminderMorningEnabled: true, reminder2hEnabled: true,
        reminderEnabled: true, kickoffEnabled: true, resultsEnabled: true,
        reminder2dSentWeekKey: null, reminder1dSentWeekKey: null, reminderMorningSentWeekKey: null, reminder2hSentWeekKey: null,
        reminderSentWeekKey: null, kickoffSentWeekKey: null, resultsSentWeekKey: null
      };
      setNotifCfg({ ...def, ...(d.notifications || {}) });
    });
    return () => unsub();
  }, []);
  async function toggleAutoNotif(key) {
    try {
      const next = notifCfg[key] === false;
      await setDoc(doc(db, "config", "app"), { notifications: { [key]: next }, updatedAt: serverTimestamp() }, { merge: true });
      setMsg(`Notification ${next ? "enabled" : "disabled"}.`);
    } catch (e) {
      setMsg("Failed to save: " + (e?.message || String(e)));
    }
  }

  const [pushDevices, setPushDevices] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "pushTokens"), (snap) => {
      const rows = [];
      snap.forEach(d => rows.push({ token: d.id, ...d.data() }));
      rows.sort((a, b) => {
        const byName = (a.name || "").localeCompare(b.name || "");
        if (byName) return byName;
        // Unnamed devices: newest first, so a recent reinstall is easy to spot.
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
      setPushDevices(rows);
    }, () => setPushDevices([]));
    return () => unsub();
  }, []);
  async function toggleDeviceBlocked(token, blocked) {
    try {
      await setDoc(doc(db, "pushTokens", token), { blocked }, { merge: true });
    } catch (e) {
      setMsg("Failed to update device: " + (e?.message || String(e)));
    }
  }
  // Manual override for the auto-retag (which only fires when the same
  // device is both signed in as admin and has notifications on) - lets an
  // admin tag their own device directly when that didn't happen on its own.
  async function toggleDeviceAdmin(token, isAdmin) {
    try {
      await setDoc(doc(db, "pushTokens", token), { isAdmin }, { merge: true });
    } catch (e) {
      setMsg("Failed to update device: " + (e?.message || String(e)));
    }
  }
  // Permanent removal - for old reinstall tokens etc. that stay technically
  // valid to FCM (so the dry-run cleanup won't ever flag them) but are known
  // by a human to be dead weight.
  async function deleteDevice(token, label) {
    if (!window.confirm(`Permanently remove ${label || "this device"}? This can't be undone.`)) return;
    try {
      await deleteDoc(doc(db, "pushTokens", token));
    } catch (e) {
      setMsg("Failed to remove device: " + (e?.message || String(e)));
    }
  }
  const [editingDeviceToken, setEditingDeviceToken] = useState(null);
  const [deviceNameDraft, setDeviceNameDraft] = useState("");
  async function saveDeviceName(token) {
    try {
      await setDoc(doc(db, "pushTokens", token), { name: deviceNameDraft.trim() }, { merge: true });
      setEditingDeviceToken(null);
    } catch (e) {
      setMsg("Failed to rename device: " + (e?.message || String(e)));
    }
  }

  // Which devices have a picks submission on file for the current live week.
  // Prefer the exact push-token tag on the picks doc, but that's only there
  // if notifications were already enabled *before* they submitted - most
  // people submitted first and enabled notifications after (especially
  // anyone who hit the pushTokens registration bug), so fall back to
  // matching by name against who actually submitted this week.
  const [submittedTokens, setSubmittedTokens] = useState(new Set());
  const [submittedNameKeys, setSubmittedNameKeys] = useState(new Set());
  const deviceNameKey = (name) => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    return personKey({ firstName: parts[0], lastName: parts.slice(1).join(" ") });
  };
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) { setSubmittedTokens(new Set()); setSubmittedNameKeys(new Set()); return; }
    const unsub = onSnapshot(
      query(collection(db, "picks"), where("year", "==", Number(year)), where("week", "==", Number(week))),
      (snap) => {
        const tokens = new Set();
        const nameKeys = new Set();
        snap.forEach(d => {
          const p = d.data();
          const t = p?.pushToken; if (t) tokens.add(t);
          const nk = personKey(p); if (nk) nameKeys.add(nk);
        });
        setSubmittedTokens(tokens);
        setSubmittedNameKeys(nameKeys);
      },
      () => { setSubmittedTokens(new Set()); setSubmittedNameKeys(new Set()); }
    );
    return () => unsub();
  }, [year, week]);

  // Per-device targeted notification (vs. the broadcast "Send a Notification"
  // below) - same notificationOutbox trigger, but tagged with a targetToken
  // so the Cloud Function delivers to just that one device.
  const [messagingToken, setMessagingToken] = useState(null);
  const [messageTitleDraft, setMessageTitleDraft] = useState("");
  const [messageBodyDraft, setMessageBodyDraft] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  async function sendTargetedMessage(token) {
    const title = messageTitleDraft.trim();
    if (!title) { setMsg("Enter a title before sending."); return; }
    setSendingMessage(true);
    try {
      await addDoc(collection(db, "notificationOutbox"), {
        title, body: messageBodyDraft.trim(), targetToken: token, createdAt: serverTimestamp()
      });
      setMsg("Notification sent to that device.");
      setMessagingToken(null);
      setMessageTitleDraft("");
      setMessageBodyDraft("");
    } catch (e) {
      setMsg("Failed to send: " + (e?.message || String(e)));
    } finally {
      setSendingMessage(false);
    }
  }

  // Stale-device cleanup: dry-run every token (nothing delivered to anyone)
  // and prune whichever ones FCM reports as no longer registered.
  const [deviceCleanup, setDeviceCleanup] = useState(null);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "deviceCleanup"), (s) => setDeviceCleanup(s.data() || null));
    return () => unsub();
  }, []);
  const [cleaningDevices, setCleaningDevices] = useState(false);
  async function cleanupDevicesNow() {
    setCleaningDevices(true);
    try {
      await addDoc(collection(db, "deviceCleanupRequests"), { createdAt: serverTimestamp() });
      setMsg("Checking all devices for stale registrations…");
    } catch (e) {
      setMsg("Failed to start cleanup: " + (e?.message || String(e)));
      setCleaningDevices(false);
    }
  }
  // The check runs server-side and reports back via config/deviceCleanup, so
  // clear the "in progress" state once a newer run shows up.
  const lastCleanupSeenRef = useRef(null);
  useEffect(() => {
    if (!deviceCleanup?.lastRunAt) return;
    const ms = deviceCleanup.lastRunAt?.toMillis ? deviceCleanup.lastRunAt.toMillis() : 0;
    if (ms !== lastCleanupSeenRef.current) {
      lastCleanupSeenRef.current = ms;
      setCleaningDevices(false);
    }
  }, [deviceCleanup]);

  const [customNotifTitle, setCustomNotifTitle] = useState("");
  const [customNotifBody, setCustomNotifBody] = useState("");
  const [sendingCustomNotif, setSendingCustomNotif] = useState(false);
  async function sendCustomNotification() {
    const title = customNotifTitle.trim();
    if (!title) { setMsg("Enter a title before sending."); return; }
    setSendingCustomNotif(true);
    try {
      await addDoc(collection(db, "notificationOutbox"), { title, body: customNotifBody.trim(), createdAt: serverTimestamp() });
      setMsg("Push notification sent to everyone.");
      setCustomNotifTitle("");
      setCustomNotifBody("");
    } catch (e) {
      console.error(e);
      setMsg("Failed to send notification");
    } finally {
      setSendingCustomNotif(false);
    }
  }

  return (<Container maxWidth={1200} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ maxWidth: 1200, padding: isMobile ? 12 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0 }}>Notifications</h2>
        <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin"); setPage("admin"); }}>&larr; Back to Admin</button>
      </div>
      {msg && (
        <div style={{ marginTop:12, padding:"8px 12px", borderRadius:10, background:"rgba(106,162,255,.1)", border:"1px solid rgba(106,162,255,.3)", color:"#cfe0ff", fontSize:13 }}>{msg}</div>
      )}

      <AdminSection title="Automated Notifications" tone="neutral">
        <p style={{ margin:"0 0 12px", fontSize:13, color:"#9aa4c7" }}>
          These fire on their own as part of the kickoff automation. Turning one off here only stops that notification &mdash; the underlying automation (locking picks, turning live score polling back off, etc.) still runs.
        </p>
        {(() => {
          const weekKey = (hasWeekValue(year) && hasWeekValue(week)) ? `${year}_W${week}` : null;
          const notif = notifCfg || {};
          const rows = [
            { key: "reminder2dEnabled", sentField: "reminder2dSentWeekKey", label: "2-day reminder", desc: "Sent ~2 days before the week's first game" },
            { key: "reminder1dEnabled", sentField: "reminder1dSentWeekKey", label: "1-day reminder", desc: "Sent ~1 day (24 hours) before the week's first game" },
            { key: "reminderMorningEnabled", sentField: "reminderMorningSentWeekKey", label: "Game day morning reminder", desc: "Sent at 9:00 AM ET the day of the first game" },
            { key: "reminder2hEnabled", sentField: "reminder2hSentWeekKey", label: "2-hour reminder", desc: "Sent ~2 hours before the week's first game" },
            { key: "reminderEnabled", sentField: "reminderSentWeekKey", label: "1-hour reminder", desc: "Sent ~1 hour before the week's first game" },
            { key: "kickoffEnabled", sentField: "kickoffSentWeekKey", label: "Picks locked / leaderboard live", desc: "Sent the moment the first game kicks off" },
            { key: "resultsEnabled", sentField: "resultsSentWeekKey", label: "Final standings are in", desc: "Sent once every game that week is final" }
          ];
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {rows.map(r => {
                const enabled = notif[r.key] !== false;
                const sent = weekKey && notif[r.sentField] === weekKey;
                return (
                  <div key={r.key} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8, padding:"10px 12px", background:"#0e1730", border:"1px solid #1f2a44", borderRadius:10 }}>
                    <div>
                      <div style={{ fontWeight:600, fontSize:14 }}>{r.label}</div>
                      <div style={{ fontSize:12, color:"#9aa4c7" }}>{r.desc}</div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <StatusBadge tone={sent ? "success" : "neutral"}>{sent ? `Sent for ${weekKey}` : "Not sent yet"}</StatusBadge>
                      <StatusBadge tone={enabled ? "primary" : "danger"}>{enabled ? "On" : "Off"}</StatusBadge>
                      <button style={adminBtn(enabled ? "neutral" : "primary")} onClick={() => toggleAutoNotif(r.key)}>
                        {enabled ? "Turn Off" : "Turn On"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </AdminSection>

      <AdminSection title="Manage Devices" tone="neutral" right={<StatusBadge tone="neutral">{pushDevices.length} registered</StatusBadge>}>
        <p style={{ margin:"0 0 12px", fontSize:13, color:"#9aa4c7" }}>
          Every device that's enabled notifications. Devices are only labeled with a name once that browser submits picks &mdash; otherwise they show as unknown. Blocking a device stops every notification (automated and custom) from reaching it.
        </p>
        <Row style={{ marginBottom: 12, alignItems: "center", gap: 10 }}>
          <button style={adminBtn("neutral")} disabled={cleaningDevices} onClick={cleanupDevicesNow}>
            {cleaningDevices ? "Checking…" : "Clean Up Devices Now"}
          </button>
          {deviceCleanup?.lastRunAt && (
            <span style={{ fontSize: 12, color: "#9aa4c7" }}>
              Last check: removed {deviceCleanup.removedCount ?? 0} of {deviceCleanup.checkedCount ?? "?"} device(s)
            </span>
          )}
        </Row>
        {pushDevices.length === 0 ? (
          <div style={{ fontSize:13, color:"#9aa4c7" }}>No devices have enabled notifications yet.</div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {pushDevices.map(d => {
              const blocked = d.blocked === true;
              const editing = editingDeviceToken === d.token;
              const messaging = messagingToken === d.token;
              const submitted = submittedTokens.has(d.token) || (d.name && submittedNameKeys.has(deviceNameKey(d.name)));
              return (
                <div key={d.token} style={{ padding:"9px 12px", background:"#0e1730", border:"1px solid #1f2a44", borderRadius:10 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                    <div>
                      {editing ? (
                        <div style={{ display:"flex", gap:6 }}>
                          <input
                            style={{ ...inputStyle, padding:"4px 8px", fontSize:13, width:180 }}
                            placeholder="who's this?"
                            value={deviceNameDraft}
                            onChange={e => setDeviceNameDraft(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") saveDeviceName(d.token); }}
                            autoFocus
                          />
                          <button style={{ ...adminBtn("success"), padding:"4px 8px", fontSize:12 }} onClick={() => saveDeviceName(d.token)}>Save</button>
                          <button style={{ ...adminBtn("neutral"), padding:"4px 8px", fontSize:12 }} onClick={() => setEditingDeviceToken(null)}>Cancel</button>
                        </div>
                      ) : (
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <div style={{ fontWeight:600, fontSize:14 }}>{d.name || "Unknown device"}</div>
                          {d.name && (
                            <StatusBadge tone={submitted ? "success" : "warning"}>
                              {submitted ? "Submitted" : "Not Submitted"}
                            </StatusBadge>
                          )}
                          {d.isAdmin === true && <StatusBadge tone="primary">Admin</StatusBadge>}
                        </div>
                      )}
                      <div style={{ fontSize:11, color:"#9aa4c7", fontFamily:"monospace" }}>{d.token.slice(0, 24)}&hellip;</div>
                      <div style={{ fontSize:11, color:"#9aa4c7" }}>
                        {d.device ? `${d.device} · ` : ""}Registered: {d.createdAt?.toDate ? d.createdAt.toDate().toLocaleString("en-US", { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) : "unknown"}
                      </div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <div style={isMobile ? { flexBasis: "100%" } : undefined}>
                        <StatusBadge tone={blocked ? "danger" : "success"}>{blocked ? "Blocked" : "Active"}</StatusBadge>
                      </div>
                      {!editing && !messaging && (
                        <button style={adminBtn("success", deviceBtnHalf)} onClick={() => { setEditingDeviceToken(d.token); setDeviceNameDraft(d.name || ""); }}>
                          Rename
                        </button>
                      )}
                      {!editing && !messaging && (
                        <button style={adminBtn(d.isAdmin === true ? "neutral" : "purple", deviceBtnHalf)} onClick={() => toggleDeviceAdmin(d.token, d.isAdmin !== true)}>
                          {d.isAdmin === true ? "Unmark Admin" : "Mark as Admin"}
                        </button>
                      )}
                      {!editing && !messaging && (
                        <button style={adminBtn("primary", deviceBtnHalf)} onClick={() => { setMessagingToken(d.token); setMessageTitleDraft(""); setMessageBodyDraft(""); }}>
                          Message
                        </button>
                      )}
                      <button style={adminBtn(blocked ? "primary" : "warning", deviceBtnHalf)} onClick={() => toggleDeviceBlocked(d.token, !blocked)}>
                        {blocked ? "Unblock" : "Block"}
                      </button>
                      {!editing && !messaging && (
                        <button style={adminBtn("danger", deviceBtnHalf)} title="Permanently remove this device (e.g. an old reinstall)" onClick={() => deleteDevice(d.token, d.name)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {messaging && (
                    <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #1f2a44", display:"flex", flexDirection:"column", gap:8 }}>
                      <input
                        style={inputStyle}
                        placeholder="Title"
                        value={messageTitleDraft}
                        onChange={e => setMessageTitleDraft(e.target.value)}
                        autoFocus
                      />
                      <input
                        style={inputStyle}
                        placeholder="Message (optional)"
                        value={messageBodyDraft}
                        onChange={e => setMessageBodyDraft(e.target.value)}
                      />
                      <Row style={isMobile ? { flexDirection: "column", alignItems: "stretch" } : undefined}>
                        <button style={adminBtn("primary")} disabled={sendingMessage} onClick={() => sendTargetedMessage(d.token)}>
                          {sendingMessage ? "Sending…" : `Send to ${d.name || "this device"}`}
                        </button>
                        <button style={adminBtn("neutral")} onClick={() => setMessagingToken(null)}>Cancel</button>
                      </Row>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </AdminSection>

      <AdminSection title="Send a Notification" tone="success">
        <p style={{ margin:"0 0 10px", fontSize:13, color:"#9aa4c7" }}>
          Sends a push notification to everyone who's enabled notifications &mdash; use this for anything the automatic ones don't cover (deadline changes, reminders, etc).
        </p>
        <Field label="Title">
          <input
            style={{...inputStyle, width:"100%"}}
            value={customNotifTitle}
            onChange={e=>setCustomNotifTitle(e.target.value)}
            placeholder="e.g. Deadline extended!"
            maxLength={80}
          />
        </Field>
        <Field label="Message (optional)">
          <textarea
            style={{...inputStyle, width:"100%", minHeight:70, fontFamily:"inherit", resize:"vertical"}}
            value={customNotifBody}
            onChange={e=>setCustomNotifBody(e.target.value)}
            placeholder="e.g. Picks now close Sunday at noon instead."
            maxLength={200}
          />
        </Field>
        <Row style={{ marginTop: 10 }}>
          <button style={adminBtn("success")} onClick={sendCustomNotification} disabled={sendingCustomNotif || !customNotifTitle.trim()}>
            {sendingCustomNotif ? "Sending…" : "Send Notification"}
          </button>
        </Row>
      </AdminSection>
    </Card>
  </Container>);
}

const ENTRY_FEE = 5;

function AdminPaymentsPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const [live, setLive] = useState({ year: null, week: null });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);
  const syncedRef = useRef(false);
  useEffect(() => {
    if (!syncedRef.current && hasWeekValue(live.year) && hasWeekValue(live.week)) {
      setYear(Number(live.year));
      setWeek(Number(live.week));
      syncedRef.current = true;
    }
  }, [live]);

  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) { setRows([]); return; }
    const q = query(collection(db, "picks"), where("year", "==", Number(year)), where("week", "==", Number(week)));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      all.sort((a, b) => (a.lastNameLower || "").localeCompare(b.lastNameLower || "") || (a.firstName || "").localeCompare(b.firstName || ""));
      setRows(all);
    });
    return () => unsub();
  }, [year, week]);

  const [qtext, setQtext] = useState("");
  const filtered = useMemo(() => {
    const t = qtext.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(p => {
      const name = `${p.firstName || ""} ${p.lastName || ""}`.toLowerCase();
      return name.includes(t) || (p.venmo || "").toLowerCase().includes(t) || (p.code || "").includes(t);
    });
  }, [rows, qtext]);

  const paidCount = rows.filter(p => p.paid === true).length;

  async function togglePaid(p) {
    try {
      await setDoc(doc(db, "picks", p.id), { paid: !p.paid }, { merge: true });
    } catch (e) {
      console.error(e);
    }
  }

  return (<Container maxWidth={900} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ maxWidth: 900, padding: isMobile ? 12 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0 }}>Payment Tracking</h2>
        <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin"); setPage("admin"); }}>&larr; Back to Admin</button>
      </div>

      <Row style={{ marginTop:16, gap:16 }}>
        <Field label="Year"><input style={{...inputStyle, width:"6rem"}} type="number" value={year ?? ""} onChange={e=>setYear(Number(e.target.value))} /></Field>
        <Field label="Week"><input style={{...inputStyle, width:"4rem"}} type="number" value={week ?? ""} onChange={e=>setWeek(Number(e.target.value))} /></Field>
        <Field label="Filter (name, code, venmo)"><input style={{...inputStyle, width:"16rem"}} value={qtext} onChange={e=>setQtext(e.target.value)} placeholder="Start typing…" /></Field>
      </Row>

      <div style={{ marginTop:14, display:"flex", gap:8, flexWrap:"wrap" }}>
        <StatusBadge tone={paidCount === rows.length && rows.length > 0 ? "success" : "primary"}>
          {paidCount} / {rows.length} paid
        </StatusBadge>
        <StatusBadge tone="neutral">
          ${paidCount * ENTRY_FEE} / ${rows.length * ENTRY_FEE} collected
        </StatusBadge>
      </div>

      <div style={{ marginTop:14, overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:520 }}>
          <thead>
            <tr style={{ textAlign:"left" }}>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Name</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Code</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Venmo</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Owes</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Paid</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const name = `${p.firstName || ""} ${p.lastName || ""}`.trim() || p.email || "(no name)";
              return (
                <tr key={p.id} style={{ borderBottom:"1px solid #1f2a44" }}>
                  <td style={{ padding:"8px 10px" }}>{name}</td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>{p.code}</td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>{p.venmo}</td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>${ENTRY_FEE}</td>
                  <td style={{ padding:"8px 10px" }}>
                    <input type="checkbox" checked={p.paid === true} onChange={()=>togglePaid(p)} style={{ width:18, height:18, cursor:"pointer" }} />
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ padding:"16px 10px", opacity:.7 }}>No picks for {year} / W{week}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  </Container>);
}

function personKey(p) {
  const n = `${(p.firstName || "").trim().toLowerCase()}_${(p.lastName || "").trim().toLowerCase()}`;
  return n.replace(/^_+|_+$/g, "") || null;
}
function venmoKeyOf(p) {
  const v = String(p.venmo || "").trim().toLowerCase().replace(/^@+/, "");
  return v ? `v:${v}` : null;
}
// Simple union-find: two picks docs count as the same person if they share
// either a normalized name or a normalized Venmo username, so a typo'd or
// nicknamed name still gets matched via a consistent Venmo.
function makeDSU() {
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find, union };
}

function AdminMissingPicksPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const [live, setLive] = useState({ year: null, week: null });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [week, setWeek] = useState(null);
  const syncedRef = useRef(false);
  useEffect(() => {
    if (!syncedRef.current && hasWeekValue(live.year) && hasWeekValue(live.week)) {
      setYear(Number(live.year));
      setWeek(Number(live.week));
      syncedRef.current = true;
    }
  }, [live]);

  // Everyone who has ever submitted picks, any year/week, grouped into
  // people (not raw docs) via the name/Venmo union-find above - the
  // "roster" to check this week's submissions against, since the app has
  // no separate participant list.
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) { setData(null); return; }
    const unsub = onSnapshot(collection(db, "picks"), (snap) => {
      const dsu = makeDSU();
      const docs = [];
      snap.forEach(d => {
        const p = d.data();
        const nk = personKey(p);
        const vk = venmoKeyOf(p);
        if (!nk && !vk) return;
        if (nk && vk) dsu.union(nk, vk);
        docs.push({ p, key: nk || vk });
      });

      const submittedRoots = new Set();
      for (const rec of docs) {
        if (Number(rec.p.year) === Number(year) && Number(rec.p.week) === Number(week)) {
          submittedRoots.add(dsu.find(rec.key));
        }
      }

      const clusters = new Map();
      for (const rec of docs) {
        const root = dsu.find(rec.key);
        const existing = clusters.get(root);
        const ms = rec.p.updatedAt?.toMillis ? rec.p.updatedAt.toMillis() : (rec.p.createdAt?.toMillis ? rec.p.createdAt.toMillis() : 0);
        if (!existing || ms >= existing._ms) {
          clusters.set(root, { key: root, firstName: rec.p.firstName, lastName: rec.p.lastName, phone: rec.p.phone, venmo: rec.p.venmo, email: rec.p.email, _ms: ms });
        }
      }

      setData({ clusters, submittedRoots });
    });
    return () => unsub();
  }, [year, week]);

  // Manually-entered emails for people whose picks docs never captured one -
  // keyed by the same identity key (personKey/venmoKeyOf root) used above,
  // so it's tied to the person, not any single week's submission.
  const [contactOverrides, setContactOverrides] = useState({});
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "contacts"), (snap) => {
      const m = {};
      snap.forEach(d => { m[d.id] = d.data() || {}; });
      setContactOverrides(m);
    });
    return () => unsub();
  }, [isAdmin]);
  // Someone can opt out of the "Email Missing" reminder without being removed
  // from the roster - stored alongside their contact info (contacts for
  // existing players, unassignedContacts for promoted new invitees).
  const toggleOptOut = async (p) => {
    const next = !p.optedOut;
    try {
      if (p.key.startsWith("unassigned:")) {
        await setDoc(doc(db, "unassignedContacts", p.key.slice("unassigned:".length)), { optedOut: next }, { merge: true });
      } else {
        await setDoc(doc(db, "contacts", p.key), { optedOut: next, updatedAt: serverTimestamp() }, { merge: true });
      }
    } catch (err) {
      alert("Couldn't update opt-out status: " + (err?.message || String(err)));
    }
  };

  // Inline edit for any roster row - name/phone/venmo/email. For real
  // players this writes to `contacts` as an override on top of whatever
  // their picks doc has; for promoted invitees it writes straight to their
  // unassignedContacts doc, which is the only record of them.
  const [editingKey, setEditingKey] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: "", phone: "", venmo: "", email: "" });
  const startEdit = (p) => {
    setEditingKey(p.key);
    setEditDraft({ name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), phone: p.phone || "", venmo: p.venmo || "", email: p.email || "" });
  };
  const cancelEdit = () => setEditingKey(null);
  const saveEdit = async (p) => {
    const parts = editDraft.name.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ");
    try {
      if (p.key.startsWith("unassigned:")) {
        await setDoc(doc(db, "unassignedContacts", p.key.slice("unassigned:".length)), {
          name: editDraft.name.trim(), phone: editDraft.phone.trim(), venmo: editDraft.venmo.trim(), email: editDraft.email.trim(),
        }, { merge: true });
      } else {
        await setDoc(doc(db, "contacts", p.key), {
          firstName, lastName, phone: editDraft.phone.trim(), venmo: editDraft.venmo.trim(), email: editDraft.email.trim(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
      setEditingKey(null);
    } catch (err) {
      alert("Couldn't save changes: " + (err?.message || String(err)));
    }
  };

  // Emails that don't belong to anyone in the roster yet - e.g. a new invite
  // list where names haven't been sorted out. Kept separate from `contacts`
  // (which is keyed to an existing player's name/Venmo identity) since there's
  // no identity to attach these to until someone assigns a name. Once named
  // and promoted, they're merged into the roster below like anyone else who
  // hasn't submitted - there's no picks doc for them, so they're always
  // "missing" until they actually play a week.
  const [unassigned, setUnassigned] = useState({});
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "unassignedContacts"), (snap) => {
      const m = {};
      snap.forEach(d => { m[d.id] = d.data() || {}; });
      setUnassigned(m);
    });
    return () => unsub();
  }, [isAdmin]);
  const unassignedList = useMemo(
    () => Object.entries(unassigned).filter(([, v]) => !v.promoted).map(([id, v]) => ({ id, email: v.email || id, name: v.name || "" }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    [unassigned]
  );
  const promotedRoster = useMemo(() => {
    return Object.entries(unassigned).filter(([, v]) => v.promoted).map(([id, v]) => {
      const parts = (v.name || "").trim().split(/\s+/).filter(Boolean);
      return { key: `unassigned:${id}`, firstName: parts[0] || v.email || id, lastName: parts.slice(1).join(" "), phone: v.phone || "", venmo: v.venmo || "", email: v.email || id, optedOut: !!v.optedOut };
    });
  }, [unassigned]);
  const [unassignedDraft, setUnassignedDraft] = useState("");
  const [nameDrafts, setNameDrafts] = useState({});

  const addUnassignedEmails = async () => {
    const knownEmails = new Set(
      [...data?.clusters.values() || []].map(c => String(c.email || "").trim().toLowerCase()).filter(Boolean)
    );
    const emails = [...new Set(
      unassignedDraft.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(s => s && s.includes("@"))
    )].filter(e => !knownEmails.has(e) && !unassigned[e]);
    if (emails.length === 0) { setUnassignedDraft(""); return; }
    try {
      await Promise.all(emails.map(e => setDoc(doc(db, "unassignedContacts", e), { email: e, name: "", createdAt: serverTimestamp() }, { merge: true })));
      setUnassignedDraft("");
    } catch (err) {
      alert("Couldn't save those emails: " + (err?.message || String(err)));
    }
  };
  const saveUnassignedName = async (id, name) => {
    try {
      await setDoc(doc(db, "unassignedContacts", id), { name: (name || "").trim() }, { merge: true });
    } catch (err) {
      alert("Couldn't save that name: " + (err?.message || String(err)));
    }
  };
  const promoteToRoster = async (id) => {
    try {
      await setDoc(doc(db, "unassignedContacts", id), { promoted: true }, { merge: true });
    } catch (err) {
      alert("Couldn't add to the roster: " + (err?.message || String(err)));
    }
  };
  const promoteAllUnassigned = async () => {
    if (unassignedList.length === 0) return;
    if (!window.confirm(`Add all ${unassignedList.length} unassigned email(s) to the roster now? You can opt out or fill in names/edit afterward.`)) return;
    try {
      await Promise.all(unassignedList.map(u => setDoc(doc(db, "unassignedContacts", u.id), { promoted: true }, { merge: true })));
    } catch (err) {
      alert("Couldn't add everyone to the roster: " + (err?.message || String(err)));
    }
  };
  const removeUnassigned = async (id) => {
    try { await deleteDoc(doc(db, "unassignedContacts", id)); } catch (err) { alert("Couldn't remove: " + (err?.message || String(err))); }
  };

  const missing = useMemo(() => {
    const fromRoster = data ? [...data.clusters.values()]
      .filter(c => !data.submittedRoots.has(c.key))
      .map(c => {
        const ov = contactOverrides[c.key] || {};
        return {
          ...c,
          firstName: ov.firstName || c.firstName,
          lastName: ov.lastName || c.lastName,
          phone: ov.phone || c.phone,
          venmo: ov.venmo || c.venmo,
          email: ov.email || c.email || "",
          optedOut: !!ov.optedOut,
        };
      }) : [];
    return [...fromRoster, ...promotedRoster]
      .sort((a, b) => (a.lastName || "").localeCompare(b.lastName || "") || (a.firstName || "").localeCompare(b.firstName || ""));
  }, [data, contactOverrides, promotedRoster]);

  const loaded = !!data;
  const totalEver = (data ? data.clusters.size : 0) + promotedRoster.length;
  const submittedCount = totalEver - missing.length;

  const missingEmails = useMemo(() => [...new Set(missing.filter(p => !p.optedOut).map(p => String(p.email || "").trim()).filter(Boolean))], [missing]);

  const openGmailDraft = () => {
    if (missingEmails.length === 0) { alert("No email addresses on file for anyone missing."); return; }
    const subject = `Reminder: Submit your Week ${week} picks!`;
    const body = `Hey! Just a friendly reminder that you haven't submitted your picks for Week ${week} yet.\n\nGet them in here: https://cfbpickems.web.app\n\nDon't wait until the last minute!\n\n- Zack`;
    const url = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&bcc=${encodeURIComponent(missingEmails.join(","))}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (<Container maxWidth={900} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ maxWidth: 900, padding: isMobile ? 12 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0 }}>Who Hasn't Submitted</h2>
        <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin"); setPage("admin"); }}>&larr; Back to Admin</button>
      </div>
      <p style={{ margin:"10px 0 0", fontSize:13, color:"#9aa4c7" }}>
        Compares this week's submissions against everyone who's ever played, by name.
      </p>

      <Row style={{ marginTop:16, gap:16 }}>
        <Field label="Year"><input style={{...inputStyle, width:"6rem"}} type="number" value={year ?? ""} onChange={e=>setYear(Number(e.target.value))} /></Field>
        <Field label="Week"><input style={{...inputStyle, width:"4rem"}} type="number" value={week ?? ""} onChange={e=>setWeek(Number(e.target.value))} /></Field>
      </Row>

      {loaded && (
        <div style={{ marginTop:14, display:"flex", gap:8, flexWrap:"wrap" }}>
          <StatusBadge tone={missing.length === 0 ? "success" : "warning"}>
            {submittedCount} / {totalEver} submitted
          </StatusBadge>
          <StatusBadge tone={missing.length === 0 ? "success" : "danger"}>
            {missing.length} not yet submitted
          </StatusBadge>
          {missing.length > 0 && (
            <button style={adminBtn("primary")} onClick={openGmailDraft} title="Opens a Gmail compose window, BCC'd to everyone missing an email on file — nothing sends automatically">
              ✉️ Email Missing ({missingEmails.length})
            </button>
          )}
        </div>
      )}

      <div style={{ marginTop:14, overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:480 }}>
          <thead>
            <tr style={{ textAlign:"left" }}>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Name</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Email</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Phone</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Venmo</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}></th>
            </tr>
          </thead>
          <tbody>
            {missing.map(p => {
              const isEditing = editingKey === p.key;
              if (isEditing) {
                return (
                  <tr key={p.key} style={{ borderBottom:"1px solid #1f2a44" }}>
                    <td style={{ padding:"8px 10px" }}>
                      <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:140 }} placeholder="name"
                        value={editDraft.name} onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} />
                    </td>
                    <td style={{ padding:"8px 10px" }}>
                      <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:160 }} type="email" placeholder="email"
                        value={editDraft.email} onChange={e => setEditDraft(d => ({ ...d, email: e.target.value }))} />
                    </td>
                    <td style={{ padding:"8px 10px" }}>
                      <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:120 }} placeholder="phone"
                        value={editDraft.phone} onChange={e => setEditDraft(d => ({ ...d, phone: e.target.value }))} />
                    </td>
                    <td style={{ padding:"8px 10px" }}>
                      <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:120 }} placeholder="venmo"
                        value={editDraft.venmo} onChange={e => setEditDraft(d => ({ ...d, venmo: e.target.value }))} />
                    </td>
                    <td style={{ padding:"8px 10px", display:"flex", gap:6 }}>
                      <button style={{ ...adminBtn("success"), padding:"4px 8px", fontSize:12 }} onClick={() => saveEdit(p)}>Save</button>
                      <button style={{ ...adminBtn("neutral"), padding:"4px 8px", fontSize:12 }} onClick={cancelEdit}>Cancel</button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={p.key} style={{ borderBottom:"1px solid #1f2a44" }}>
                  <td style={{ padding:"8px 10px" }}>{`${p.firstName || ""} ${p.lastName || ""}`.trim()}</td>
                  <td style={{ padding:"8px 10px", opacity: p.optedOut ? 0.5 : .9 }}>
                    {p.email || "—"}
                    {p.optedOut && <span style={{ marginLeft:6, fontSize:11, color:"#f0b429" }}>(opted out)</span>}
                  </td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>{p.phone}</td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>{p.venmo}</td>
                  <td style={{ padding:"8px 10px", display:"flex", gap:6 }}>
                    <button style={{ ...adminBtn("neutral"), padding:"4px 8px", fontSize:12 }} onClick={() => startEdit(p)}>Edit</button>
                    {p.email && (
                      <button
                        style={{ ...adminBtn(p.optedOut ? "neutral" : "warning"), padding:"4px 8px", fontSize:12 }}
                        title={p.optedOut ? "Excluded from Email Missing — click to opt back in" : "Exclude this person from the Email Missing draft"}
                        onClick={() => toggleOptOut(p)}
                      >
                        {p.optedOut ? "Opted out" : "Opt out"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {loaded && missing.length === 0 && (
              <tr><td colSpan={5} style={{ padding:"16px 10px", opacity:.7 }}>Everyone who's ever played has submitted for {year} / W{week}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>

    <Card style={{ maxWidth: 900, marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Unassigned Emails</h3>
      <p style={{ margin: "10px 0 0", fontSize: 13, color: "#9aa4c7" }}>
        Emails that don't belong to anyone on the roster yet - e.g. new invitees. Paste any number below (comma, space, or newline separated); attach a name to each whenever you figure out who's who.
      </p>
      <Row style={{ marginTop: 14, gap: 10, alignItems: "flex-start" }}>
        <textarea
          style={{ ...inputStyle, flex: 1, minHeight: 70, fontFamily: "inherit", resize: "vertical" }}
          placeholder="jane@example.com, john@example.com..."
          value={unassignedDraft}
          onChange={e => setUnassignedDraft(e.target.value)}
        />
        <button style={adminBtn("primary")} onClick={addUnassignedEmails}>Add</button>
      </Row>

      {unassignedList.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button style={adminBtn("success")} onClick={promoteAllUnassigned}>
            Add All {unassignedList.length} to Roster
          </button>
        </div>
      )}

      {unassignedList.length > 0 && (
        <div style={{ marginTop: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Email</th>
                <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Name</th>
                <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}></th>
              </tr>
            </thead>
            <tbody>
              {unassignedList.map(u => (
                <tr key={u.id} style={{ borderBottom: "1px solid #1f2a44" }}>
                  <td style={{ padding: "8px 10px" }}>{u.email}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        style={{ ...inputStyle, padding: "4px 8px", fontSize: 12, width: 180 }}
                        placeholder="name"
                        value={nameDrafts[u.id] ?? u.name}
                        onChange={e => setNameDrafts(d => ({ ...d, [u.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") saveUnassignedName(u.id, nameDrafts[u.id]); }}
                      />
                      <button style={{ ...adminBtn("neutral"), padding: "4px 8px", fontSize: 12 }} onClick={() => saveUnassignedName(u.id, nameDrafts[u.id])}>Save</button>
                    </div>
                  </td>
                  <td style={{ padding: "8px 10px", display: "flex", gap: 6 }}>
                    {u.name && (
                      <button style={{ ...adminBtn("success"), padding: "4px 8px", fontSize: 12 }} onClick={() => promoteToRoster(u.id)} title="Adds them to the main roster above, so they show up in Who Hasn't Submitted and the Email Missing draft">
                        Add to Roster
                      </button>
                    )}
                    <button style={{ ...adminBtn("danger"), padding: "4px 8px", fontSize: 12 }} onClick={() => removeUnassigned(u.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  </Container>);
}

// Look up everything a person has ever submitted, across all years/weeks,
// using the same name+Venmo identity matching as AdminMissingPicksPage
// (there's no login/account system, so this is the only way to tie someone's
// weeks together — a fresh random code is generated per week's submission).
async function findMySeason({ firstName, lastName, venmo }) {
  const ln = (lastName || "").trim().toLowerCase();
  if (!ln) throw new Error("Enter your last name.");

  const snap = await getDocs(query(collection(db, "picks"), where("lastNameLower", "==", ln)));
  const docs = [];
  snap.forEach(d => docs.push(d.data()));
  if (docs.length === 0) return { weeks: [] };

  const dsu = makeDSU();
  const keyed = [];
  for (const p of docs) {
    const nk = personKey(p);
    const vk = venmoKeyOf(p);
    if (!nk && !vk) continue;
    if (nk && vk) dsu.union(nk, vk);
    keyed.push({ p, key: nk || vk });
  }

  const targetKey = venmoKeyOf({ venmo }) || personKey({ firstName, lastName });
  if (!targetKey) throw new Error("Enter your first and last name.");
  const targetRoot = dsu.find(targetKey);
  const mine = keyed.filter(rec => dsu.find(rec.key) === targetRoot);
  if (mine.length === 0) return { weeks: [] };

  // One entry per year/week (in case of duplicate submissions, keep the latest).
  const byWeek = new Map();
  for (const { p } of mine) {
    const wk = `${p.year}_${p.week}`;
    const ms = p.updatedAt?.toMillis ? p.updatedAt.toMillis() : (p.createdAt?.toMillis ? p.createdAt.toMillis() : 0);
    const existing = byWeek.get(wk);
    if (!existing || ms >= existing._ms) byWeek.set(wk, { year: Number(p.year), week: Number(p.week), email: p.email, _ms: ms });
  }
  const weekRefs = [...byWeek.values()].sort((a, b) => a.year - b.year || a.week - b.week);

  const weeks = [];
  for (const wr of weekRefs) {
    const { rows, totalGames } = await computeWeekStandings(wr.year, wr.week);
    const mineRow = rows.find(r => r.email && wr.email && r.email === wr.email) || null;
    weeks.push({
      year: wr.year, week: wr.week,
      points: mineRow?.points ?? null,
      totalGames,
      isWinner: !!mineRow?.isWinner,
      winNote: mineRow?.winNote || null,
    });
  }
  return { weeks };
}

function MySeasonPage({ user, isAdmin, setPage }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [venmo, setVenmo] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [weeks, setWeeks] = useState(null);

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus("loading"); setError(""); setWeeks(null);
    try {
      const result = await findMySeason({ firstName, lastName, venmo });
      setWeeks(result.weeks);
      setStatus("done");
    } catch (err) {
      setError(err?.message || "Something went wrong looking that up.");
      setStatus("error");
    }
  };

  const weeksWon = weeks ? weeks.filter(w => w.isWinner).length : 0;
  const totalCorrect = weeks ? weeks.reduce((sum, w) => sum + (w.points ?? 0), 0) : 0;
  const bestWeek = weeks && weeks.length ? weeks.reduce((a, b) => (b.points ?? -1) > (a.points ?? -1) ? b : a) : null;

  return (<Container maxWidth={720}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card>
      <h2 style={{ margin: 0 }}>My Season</h2>
      <p style={{ margin: "10px 0 0", fontSize: 13, color: "#9aa4c7" }}>
        See every week you've played, your record, and any weeks you've won. We match you by name and Venmo — the same edit code you use each week doesn't carry over between weeks.
      </p>

      <form onSubmit={onSubmit}>
        <Row style={{ marginTop: 16, gap: 14 }}>
          <Field label="First name"><input style={inputStyle} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" /></Field>
          <Field label="Last name"><input style={inputStyle} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Smith" /></Field>
          <Field label="Venmo (optional)"><input style={inputStyle} value={venmo} onChange={e => setVenmo(e.target.value)} placeholder="@jane-smith" /></Field>
        </Row>
        <button type="submit" style={{ marginTop: 14, padding: "10px 16px", borderRadius: 10, border: "1px solid #1f2a44", background: "#6aa2ff", color: "#07152b", fontWeight: 700, cursor: "pointer" }} disabled={status === "loading"}>
          {status === "loading" ? "Looking..." : "Find My Season"}
        </button>
      </form>

      {status === "error" && (
        <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 10, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#fca5a5", fontSize: 13 }}>{error}</div>
      )}

      {status === "done" && weeks && weeks.length === 0 && (
        <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 10, background: "rgba(240,180,41,.1)", border: "1px solid rgba(240,180,41,.3)", color: "#f0b429", fontSize: 13 }}>
          No submissions found under that name{venmo ? " or Venmo" : ""}. Double check the spelling of your last name, or try adding your Venmo username.
        </div>
      )}

      {status === "done" && weeks && weeks.length > 0 && (
        <>
          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <StatusBadge tone="neutral">{weeks.length} week{weeks.length === 1 ? "" : "s"} played</StatusBadge>
            <StatusBadge tone={weeksWon > 0 ? "success" : "neutral"}>{weeksWon} week{weeksWon === 1 ? "" : "s"} won</StatusBadge>
            <StatusBadge tone="neutral">{totalCorrect} total correct picks</StatusBadge>
            {bestWeek && <StatusBadge tone="primary">Best week: W{bestWeek.week} ({bestWeek.points}/{bestWeek.totalGames})</StatusBadge>}
          </div>

          <div style={{ marginTop: 14, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Year</th>
                  <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Week</th>
                  <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Record</th>
                  <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Result</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map(w => (
                  <tr key={`${w.year}_${w.week}`} style={{ borderBottom: "1px solid #1f2a44" }}>
                    <td style={{ padding: "8px 10px" }}>{w.year}</td>
                    <td style={{ padding: "8px 10px" }}>{w.week}</td>
                    <td style={{ padding: "8px 10px" }}>{w.points ?? "-"} / {w.totalGames}</td>
                    <td style={{ padding: "8px 10px" }}>
                      {w.isWinner ? <span title={w.winNote || "Winner"}>🏆 Won{w.winNote ? " (tiebreaker)" : ""}</span> : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  </Container>);
}

function AdminPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  // On mobile, action-button groups stack full-width (one per row) instead of
  // wrapping mid-row - align-items:stretch fills each button to the row's
  // width since neither Row nor adminBtn() set an explicit width.
  const stackRow = isMobile ? { flexDirection: "column", alignItems: "stretch" } : undefined;
  // Paired with stackRow: a badge sitting next to a stacked full-width button
  // shouldn't stretch into a full-width bar too, so pin it to its own size.
  const badgeAlign = isMobile ? { alignSelf: "flex-start", marginTop: 2 } : undefined;
  const [live, setLive] = useState({ year: null, week: null });
  const [year, setYear] = useState(null);
  const [week, setWeek] = useState(null);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
  const [msg, setMsg] = useState("");
  const [weeksForYear, setWeeksForYear] = useState([]);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [appCfg, setAppCfg] = useState({ leaderboardLocked: false, leaderboardPicksPublic: false, picksLocked: false, potHidden: false });
  const [dummyWeekExists, setDummyWeekExists] = useState(false);
  const [localFixture, setLocalFixture] = useState(() => {
    try { return localStorage.getItem("sbLocalFixture") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("sbLocalFixture", localFixture ? "1" : "0"); } catch {}
  }, [localFixture]);
  const pot = useMemo(() => (pickCount * 5), [pickCount]);

  // Does the 2099/W1 test sandbox currently exist?
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "games"), where("year","==",2099), where("week","==",1)),
      (snap) => setDummyWeekExists(!snap.empty)
    );
    return () => unsub();
  }, []);

  // Subscribe to config/live (drives the "Current Week" display and Sync GameDay)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);

  // Seed Year/Week from the live week exactly once. After that, Admin can
  // freely browse other weeks without snapping back when config/live changes.
  const seededFromLiveRef = useRef(false);
  useEffect(() => {
    if (seededFromLiveRef.current) return;
    if (hasWeekValue(live?.year) && hasWeekValue(live?.week)) {
      setYear(Number(live.year));
      setWeek(Number(live.week));
      seededFromLiveRef.current = true;
    }
  }, [live]);

  // Load games whenever the selected year/week changes
  const gamesLoadSeq = useRef(0);
  useEffect(() => {
    if (!isAdmin || !hasWeekValue(year) || !hasWeekValue(week)) return;
    const seq = ++gamesLoadSeq.current;
    (async () => {
      try {
        const gs = await listGames({ year, week, includedOnly: false });
        if (gamesLoadSeq.current === seq) setGames(gs);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [isAdmin, year, week]);

  // Pick count for the selected week (drives the pot display)
  useEffect(() => {
    (async () => {
      try {
        if (hasWeekValue(year) && hasWeekValue(week)) {
          const arr = await getPicksForWeek(year, week);
          setPickCount(Array.isArray(arr) ? arr.length : 0);
        } else {
          setPickCount(0);
        }
      } catch {
        setPickCount(0);
      }
    })();
  }, [year, week]);

  // Weeks dropdown: populate from games in the selected year
  useEffect(() => {
    (async () => {
      try {
        const q = query(collection(db, "games"), where("year", "==", Number(year)));
        const snap = await getDocs(q);
        const uniq = new Set();
        snap.forEach(d => {
          const w = d.data()?.week;
          if (Number.isFinite(+w)) uniq.add(Number(w));
        });
        setWeeksForYear([...uniq].sort((a,b)=>a-b));
      } catch (err) {
        console.error("weeksForYear load failed", err);
        setWeeksForYear([]);
      }
    })();
  }, [year]);

  // CFBD API key (admin-only, stored in config/cfbd)
  useEffect(() => {
    if (!isAdmin) return;
    (async () => { setApiKey(await getCfbdKey()); })();
  }, [isAdmin]);

  // config/app: scoreboard settings + leaderboard/picks lock flags, in one subscription
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      const defSb = {
        mode: "off",
        intervalSec: 60,
        window: { startET: "12:00", endET: "02:00" }, // game-hours gate for the server-side cron
        testMode: false,
        testIntervalSec: 10,
        fixturePath: "/dev/scoreboard-demo.json",
        autoWriteWinners: true, // server-side auto-winner writer on/off (publishLiveMap)
        autoLockPicks: true // server-side auto-lock-at-kickoff on/off (publishLiveMap)
      };
      setAppCfg({
        leaderboardLocked: !!d.leaderboardLocked,
        leaderboardPicksPublic: !!d.leaderboardPicksPublic,
        picksLocked: !!d.picksLocked,
        potHidden: !!d.potHidden,
        scoreboard: { ...defSb, ...(d.scoreboard || {}) }
      });
    });
    return () => unsub();
  }, []);

  const togglePotHidden = async () => {
    try {
      await setDoc(doc(db, "config", "app"), { potHidden: !appCfg.potHidden, updatedAt: serverTimestamp() }, { merge: true });
      setMsg(`Pot ${appCfg.potHidden ? "shown" : "hidden"} for everyone but admins.`);
    } catch (e) {
      setMsg("Failed to save: " + (e?.message || String(e)));
    }
  };

  const toggleLeaderboardLock = async () => {
    try {
      await setDoc(doc(db, "config", "app"), { leaderboardLocked: !appCfg.leaderboardLocked, updatedAt: serverTimestamp() }, { merge: true });
      setMsg("Saved leaderboard setting.");
    } catch (e) {
      setMsg("Failed to save: " + (e?.message || String(e)));
    }
  };

  const toggleLeaderboardPicks = async () => {
    try {
      await setDoc(
        doc(db, "config", "app"),
        { leaderboardPicksPublic: !appCfg.leaderboardPicksPublic, updatedAt: serverTimestamp() },
        { merge: true }
      );
      setMsg("Saved picks visibility.");
    } catch (e) {
      setMsg("Failed to save: " + (e?.message || String(e)));
    }
  };

  if (!user) return <Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>Please sign in with Google.</p></Card></Container>;
  if (!isAdmin) return <Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>This account is not an admin.</p></Card></Container>;

  const saveKey = async () => {
    await setCfbdKey(apiKey);
    setMsg("Saved CFBD key.");
  };
  const doImport = async () => {
    setMsg("Importing...");
    try {
      const d = await importWeek({ year, week });
      const all = await listGames({ year, week, includedOnly: false });
      const includedDb = all.filter(x => x.included).length;

      setMsg(
        `Imported ${d.writtenTotal} game(s). Included (FBS): ${includedDb}. ` +
        `[debug: tried=${d.sourceTried.join("??'") || "none"}, cfbdWeek=${d.cfbdGames}, fbsNames=${d.fbsTeamNames}, espnDirect=${d.espnDirect}, espnProxy=${d.espnProxy}]`
      );
      setGames(all);
    } catch (e) {
      setMsg(e.message || String(e));
    }
  };
  // Pulls spreads/over-under from CFBD's /lines endpoint - manual only (no
  // automation/cron calls this), same "click to fetch" shape as "Import
  // week" right next to it. Stored directly on the games/{id} doc so it
  // shows up wherever a game's other fields already do.
  const doSyncOdds = async () => {
    setMsg("Syncing odds...");
    try {
      if (!apiKey) throw new Error("CFBD API key missing - save it above first.");
      if (!hasWeekValue(year) || !hasWeekValue(week)) throw new Error("Select a year/week first.");

      const normalizeKey = (name) => {
        if (!name) return "";
        let s = String(name).toLowerCase();
        s = s.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
        s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
        if (s === "texasam" || s === "texasa&m") s = "texasam";
        return s;
      };
      const gameIdFrom = (home, away) => `${normalizeKey(away)}__${normalizeKey(home)}`;

      const ourGames = await listGames({ year, week, includedOnly: false });
      const byKey = new Map(ourGames.map(g => [gameIdFrom(g.home, g.away), g]));

      const qs = new URLSearchParams({ year: String(year), week: String(week), seasonType: "regular" });
      const res = await fetch(`https://api.collegefootballdata.com/lines?${qs}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`CFBD HTTP ${res.status}`);
      const arr = await res.json();

      const batch = writeBatch(db);
      let written = 0, skippedNoMatch = 0, skippedNoLines = 0;
      for (const g of (Array.isArray(arr) ? arr : [])) {
        const home = g.homeTeam ?? g.home_team ?? "";
        const away = g.awayTeam ?? g.away_team ?? "";
        const ourGame = byKey.get(gameIdFrom(home, away));
        if (!ourGame) { skippedNoMatch++; continue; }

        const lines = Array.isArray(g.lines) ? g.lines : [];
        if (!lines.length) { skippedNoLines++; continue; }
        const line = lines.find(l => String(l.provider || "").toLowerCase() === "consensus") || lines[0];

        batch.set(doc(db, "games", ourGame.id), {
          spread: Number.isFinite(+line.spread) ? +line.spread : null,
          formattedSpread: line.formattedSpread || null,
          overUnder: Number.isFinite(+line.overUnder) ? +line.overUnder : null,
          oddsProvider: line.provider || null,
          oddsUpdatedAt: serverTimestamp()
        }, { merge: true });
        written++;
      }
      await batch.commit();

      setMsg(
        `Synced odds for ${written} game(s).` +
        (skippedNoMatch ? ` ${skippedNoMatch} CFBD game(s) had no matching imported game.` : "") +
        (skippedNoLines ? ` ${skippedNoLines} game(s) have no lines posted yet.` : "")
      );
      setGames(await listGames({ year, week, includedOnly: false }));
    } catch (e) {
      setMsg("Odds sync failed: " + (e?.message || String(e)));
    }
  };
  // Backfills homeRank/awayRank on games already imported before this fix
  // existed - only touches those two fields (unlike "Import week", which
  // would also reset any manual include/exclude choices).
  const doSyncRankings = async () => {
    setMsg("Syncing rankings...");
    try {
      if (!apiKey) throw new Error("CFBD API key missing - save it above first.");
      if (!hasWeekValue(year) || !hasWeekValue(week)) throw new Error("Select a year/week first.");

      const rankMap = await buildRankMap(apiKey, year, week);
      const ourGames = await listGames({ year, week, includedOnly: false });

      const batch = writeBatch(db);
      let updated = 0;
      for (const g of ourGames) {
        const homeRank = rankMap.get(norm(g.home)) ?? null;
        const awayRank = rankMap.get(norm(g.away)) ?? null;
        if (homeRank === (g.homeRank ?? null) && awayRank === (g.awayRank ?? null)) continue;
        batch.set(doc(db, "games", g.id), { homeRank, awayRank }, { merge: true });
        updated++;
      }
      if (updated > 0) await batch.commit();

      setMsg(`Synced rankings - updated ${updated} of ${ourGames.length} game(s).`);
      setGames(await listGames({ year, week, includedOnly: false }));
    } catch (e) {
      setMsg("Rankings sync failed: " + (e?.message || String(e)));
    }
  };
  const toggle = async (g, v) => {
    await setGameIncluded(g.id, v);
    setGames(await listGames({ year, week, includedOnly: false }));
  };
  const chooseWinner = async (g) => {
  // Force an exact winner string that will match picks/leaderboard comparisons
  const choice = window.prompt(
    `Set winner:
HOME: ${g.home}
AWAY: ${g.away}

Type "home" or "away".`,
    "home"
  );
  if (!choice) return;
  const val = String(choice).trim().toLowerCase();
  let w = null;
  if (val === "home" || val === g.home.toLowerCase()) w = g.home;
  else if (val === "away" || val === g.away.toLowerCase()) w = g.away;
  else { setMsg('Cancelled: type "home" or "away" (or the full team name).'); return; }

  let totalPoints;
  if (g.gameday) {
    // This is the week's tiebreaker game — capture the final combined score
    // by hand instead of trusting an auto-reported CFBD score.
    const totalStr = window.prompt(`Combined final score for the GameDay tiebreaker (${g.away} + ${g.home} points):`);
    if (totalStr === null) { setMsg("Cancelled: total points required to save the GameDay result."); return; }
    const n = Number(totalStr);
    if (!Number.isFinite(n)) { setMsg("Cancelled: enter a valid number for total points."); return; }
    totalPoints = n;
  }

  await setResult(g.id, w, totalPoints);
  setMsg("Saved result. Refresh Leaderboard to update.");
};

  // Deselect all included games (batch)
  const deselectAll = async () => {
    const selected = games.filter(x => x.included);
    if (selected.length === 0) { setMsg("No games are selected."); return; }
    if (!window.confirm(`Deselect all ${selected.length} game(s)?`)) return;
    const batch = writeBatch(db);
    for (const g of selected) {
      batch.update(doc(db, "games", g.id), { included: false, updatedAt: serverTimestamp() });
    }
    await batch.commit();
    setGames(await listGames({ year, week, includedOnly: false }));
  };

  // ---------- Dummy Week helpers ----------
  const createDummyWeek = async () => {
    setMsg("Creating dummy week...");
    const Y = 2099, W = 1;
    const batch = writeBatch(db);

    const dummyGames = [
  { away:"Notre Dame",      awayRank:9,  home:"Texas A&M",     homeRank:6,  startTimeStr:"2099-08-26T23:00:00Z" },
  { away:"Miami",           awayRank:24, home:"Florida",       homeRank:17, startTimeStr:"2099-08-31T23:00:00Z" },
  { away:"Clemson",         awayRank:18, home:"Georgia",       homeRank:7,  startTimeStr:"2099-09-01T00:00:00Z" },
  { away:"Boise State",     awayRank:null,home:"Oregon",       homeRank:12, startTimeStr:"2099-09-01T00:30:00Z" },
  { away:"Texas",           awayRank:5,  home:"Michigan",      homeRank:3,  startTimeStr:"2099-09-01T01:00:00Z" },
  { away:"Florida State",   awayRank:11, home:"LSU",           homeRank:10, startTimeStr:"2099-09-01T01:30:00Z" },

  { away:"Alabama",         awayRank:2,  home:"Oklahoma",      homeRank:14, startTimeStr:"2099-09-01T02:00:00Z" },
  { away:"USC",             awayRank:20, home:"Washington",    homeRank:8,  startTimeStr:"2099-09-01T02:30:00Z" },
  { away:"Penn State",      awayRank:13, home:"Ohio State",    homeRank:4,  startTimeStr:"2099-09-01T03:00:00Z" },
  { away:"Tennessee",       awayRank:15, home:"North Carolina",homeRank:19, startTimeStr:"2099-09-01T03:30:00Z" },

  { away:"Utah",            awayRank:16, home:"TCU",           homeRank:21, startTimeStr:"2099-09-01T04:00:00Z" },
  { away:"Nebraska",        awayRank:null,home:"Iowa",         homeRank:25, startTimeStr:"2099-09-01T04:30:00Z" },
  { away:"Wisconsin",       awayRank:null,home:"Minnesota",    homeRank:null,startTimeStr:"2099-09-01T05:00:00Z" },
  { away:"Ole Miss",        awayRank:22, home:"Auburn",        homeRank:null,startTimeStr:"2099-09-01T05:30:00Z" },

  { away:"Kansas State",    awayRank:23, home:"Kansas",        homeRank:null,startTimeStr:"2099-09-01T06:00:00Z" },
  { away:"UCF",             awayRank:null,home:"West Virginia",homeRank:null,startTimeStr:"2099-09-01T06:30:00Z" },
  { away:"Duke",            awayRank:null,home:"NC State",     homeRank:null,startTimeStr:"2099-09-01T07:00:00Z" },
  { away:"Arizona",         awayRank:null,home:"Arizona State",homeRank:null,startTimeStr:"2099-09-01T07:30:00Z" },
  { away:"BYU",             awayRank:null,home:"Utah State",   homeRank:null,startTimeStr:"2099-09-01T08:00:00Z" },
  { away:"Army",            awayRank:null,home:"Navy",         homeRank:null,startTimeStr:"2099-09-01T08:30:00Z" }
];

    const keepIds = new Set();
    const ids = [];
    for (const g of dummyGames) {
      const id = `${Y}_W${W}_${g.away}_at_${g.home}`.replace(/[^\w\-@.]+/g, "_");
      keepIds.add(id); ids.push({ id, g });
      batch.set(doc(db, "games", id), {
        id, year: Y, week: W,
        away: g.away, home: g.home,
        awayAbbr: null, homeAbbr: null,
        awayRank: g.awayRank ?? null, homeRank: g.homeRank ?? null,
      included: (g.included ?? true),
      startTimeStr: g.startTimeStr ?? null,
      order: (g.order ?? g._order ?? null),
      orderDay: (g.orderDay ?? null),
      }, { merge: true });
    }

    const existing = await getDocs(query(collection(db, "games"), where("year","==",Y), where("week","==",W)));
    existing.forEach(d => { if (!keepIds.has(d.id)) batch.delete(d.ref); });

    const winnersById = {};
    winnersById[ids[0].id] = ids[0].g.home; // Texas A&M
    winnersById[ids[1].id] = ids[1].g.home; // Florida
    winnersById[ids[2].id] = ids[2].g.home; // Georgia

    for (const { id } of ids) {
      const w = winnersById[id];
      if (w) batch.set(doc(db, "results", id), { winner: w, updatedAt: serverTimestamp() }, { merge: true });
    }

    await batch.commit();

    // Seed picks
    let seeded = 0;
    const samples = (() => {
  const names = [
    "Alex Smith","Jordan Lee","Taylor Kim","Casey Nguyen","Morgan Patel","Riley Johnson","Cameron Brooks",
    "Avery Martinez","Quinn Davis","Harper Wilson","Jamie Clark","Parker Lewis","Emery Thompson","Drew Rivera",
    "Kendall Wright","Rowan Hall","Reese Young","Sawyer King","Skyler Scott","Charlie Green","Elliot Adams",
    "Sasha Baker","Devon Carter","Shawn Perez","Blake Turner","Leslie Torres","Hayden Flores","Sidney Howard",
    "Micah Ward","Noel Butler","Angel Price","Jules Stewart","Phoenix Bell","River Cooper","Sloan Reed"
  ];
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const parts = names[i].split(" ");
    const firstName = parts[0];
    const lastName  = parts.slice(1).join(" ") || "";
    const email = (firstName.toLowerCase() + "." + (lastName.toLowerCase().replace(/\s+/g,"")) + "@example.com");
    const picks = {};
    ids.forEach(({ id, g }, j) => {
      // Simple variety: some users slightly favor home teams, others away; alternates by game index.
      const bias = (i % 5);              // 0..4
      const favorHome = (bias === 0 || bias === 3);
      const pick = ((j + (favorHome ? 1 : 0)) % 2 === 0) ? g.away : g.home;
      picks[id] = pick;
    });
    out.push({ firstName, lastName, email, picks });
  }
  return out;
})();
    if (user?.email) {
      samples.push({
        firstName: (user.displayName || user.email).split(" ")[0] || "You",
        lastName: "",
        email: user.email,
        picks: {
          [ids[0].id]: ids[0].g.home,
          [ids[1].id]: ids[1].g.home,
          [ids[2].id]: ids[2].g.home,
        }
      });
    }
    for (const s of samples) {
      try {
        await setDoc(doc(db, "picks", picksDocId(Y, W, s.email)), {
          id: picksDocId(Y, W, s.email),
          year: Y, week: W, email: s.email,
          firstName: s.firstName, lastName: s.lastName,
          phone: "", venmo: "",
          picks: s.picks, updatedAt: serverTimestamp()
        }, { merge: true });
        seeded++;
      } catch (_) {}
    }

    setMsg(`Dummy week created (Year ${Y}, Week ${W})  -  Games: ${ids.length}  -  Winners set: ${Object.keys(winnersById).length}  -  Sample players seeded: ${seeded}`);
  };

  // Clear Dummy Week
  const clearDummyWeek = async () => {
  const t0 = Date.now();
  try {
    const Y = 2099, W = 1;
    setMsg("Clearing dummy week...");

    // Query targets
    const qGames = query(collection(db, "games"), where("year","==",Y), where("week","==",W));
    const qPicks = query(collection(db, "picks"), where("year","==",Y), where("week","==",W));

    const gsSnap  = await getDocs(qGames);
    const gameIds = gsSnap.docs.map(d => d.id);
    const psSnap  = await getDocs(qPicks);

    // Results are keyed by game id; derive from gameIds
    const resultsToDelete = gameIds.length;

    setMsg("Deleting " + gsSnap.size + " games, " + resultsToDelete + " results, " + psSnap.size + " picks...");

    const batch = writeBatch(db);
    gsSnap.forEach(d => batch.delete(d.ref));
    gameIds.forEach(id => batch.delete(doc(db, "results", id)));
    psSnap.forEach(d => batch.delete(d.ref));

    await batch.commit();

    // Quick verify
    const leftGames = (await getDocs(qGames)).size;
    const leftPicks = (await getDocs(qPicks)).size;

    const ms = Date.now() - t0;

    // Refresh Admin data + final message
    setGames(await listGames({ year: Y, week: W, includedOnly: false }));
    setMsg("Dummy week cleared (Year " + Y + ", Week " + W + ") - Deleted: Games " + gsSnap.size + " -> " + leftGames + ", Results " + resultsToDelete + ", Picks " + psSnap.size + " -> " + leftPicks + " - " + ms + "ms");
  } catch (err) {
    console.error("clearDummyWeek failed:", err);
    setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
  }
};

    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}ï¿½`);

      // Check both numeric-typed and string-typed year/week (defensive for any older docs)
      const qNum = query(collection(db, "picks"), where("year","==", Y), where("week","==", W));
      const sNum = await getDocs(qNum);
      let pickCount = sNum.size;
      if (pickCount === 0) {
        const qStr = query(collection(db, "picks"), where("year","==", String(Y)), where("week","==", String(W)));
        const sStr = await getDocs(qStr);
        pickCount = sStr.size;
      }
      if (pickCount > 0) { setMsg(`Aborted: found ${pickCount} pick(s) for ${Y} / W${W}.`); return; }

      // No picks -> remove all games and their results for this week
      const qGames = query(collection(db, "games"), where("year","==", Y), where("week","==", W));
      const gsSnap = await getDocs(qGames);
      const gameIds = gsSnap.docs.map(d => d.id);

      if (gsSnap.size === 0) { setMsg(`Nothing to delete for ${Y} / W${W}.`); return; }
      if (!window.confirm(`Delete ${gsSnap.size} game(s) and ${gameIds.length} result(s) for ${Y} / W${W}? This will abort if any picks exist.`)) return;

      const batch = writeBatch(db);
      gsSnap.forEach(d => batch.delete(d.ref));
      gameIds.forEach(id => batch.delete(doc(db, "results", id)));
      await batch.commit();

      // Refresh list + toast
      const leftGames = (await getDocs(qGames)).size;
      setGames(await listGames({ year: Y, week: W, includedOnly: false }));
      setMsg(`Cleared ${Y} / W${W}. Deleted games: ${gsSnap.size} -> ${leftGames}. Results deleted: ${gameIds.length}.`);
    } catch (err) {
      console.error("clearWeekIfNoPicks failed:", err);
      setMsg("Clear failed: " + (err && err.message ? err.message : String(err)));
    }
  };

  if (year == null || week == null) { return (<Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>Loading live week&hellip;</p></Card></Container>); }
  return (<Container maxWidth={720} padding={isMobile ? 12 : 24}>
      <Header user={user} isAdmin={isAdmin} setPage={setPage} />
      <Card style={{ maxWidth: 1200, padding: isMobile ? 12 : 16 }}>
        <div style={{ display:"flex", alignItems: isMobile ? "stretch" : "center", justifyContent:"space-between", flexDirection: isMobile ? "column" : "row", flexWrap:"wrap", gap:10 }}>
          <h2 style={{ margin:0 }}>Admin</h2>
          <Row style={{ gap:8, ...stackRow }}>
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/picks"); setPage("adminpicks"); }}>Open Picks Management</button>
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/payments"); setPage("adminpayments"); }}>Payment Tracking</button>
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/missing"); setPage("adminmissing"); }}>Who Hasn't Submitted</button>
          </Row>
        </div>
        {msg && (
          <div style={{ marginTop:12, padding:"8px 12px", borderRadius:10, background:"rgba(106,162,255,.1)", border:"1px solid rgba(106,162,255,.3)", color:"#cfe0ff", fontSize:13 }}>{msg}</div>
        )}

        <AdminSection title="Live Week" tone="primary" right={<StatusBadge tone="primary">Live: {live?.year ?? "-"} / W{live?.week ?? "-"}</StatusBadge>}>
          <Row>
            <Field label="Year"><input style={{...inputStyle, width:"6rem"}} type="number" value={(year ?? '')} onChange={e=>setYear(Number(e.target.value))}/></Field>
            <Field label="Week"><input style={{...inputStyle, width:"4rem"}} type="number" value={(week ?? '')} onChange={e=>setWeek(Number(e.target.value))}/></Field>
            <button style={adminBtn("neutral")} onClick={async()=>setGames(await listGames({ year, week, includedOnly: false }))}>Load</button>
          </Row>
          <Row style={{ marginTop: 10, ...stackRow }}>
            <button style={adminBtn("primary")} onClick={async()=>{ try { await setDoc(doc(db,"config","live"), { year, week }, { merge:true });
await setDoc(doc(db,"config","app"), { currentYear: year, currentWeek: week, updatedAt: serverTimestamp() }, { merge:true }); setMsg(`Live week set to ${year} / W${week} (config/live + config/app)`); } catch(e) { console.error(e); setMsg("Failed to set live week"); } }}>Set Live Week</button>
            <button style={adminBtn("success")} onClick={async()=>{ try { await addDoc(collection(db,"notificationOutbox"), { title: `🏈 Week ${week} is open`, body: "Picks are open — submit yours on the Picks page.", createdAt: serverTimestamp() }); setMsg(`Push notification sent to everyone for Week ${week}.`); } catch(e) { console.error(e); setMsg("Failed to send notification"); } }}>Notify Players: Picks Open</button>
            <button style={adminBtn("neutral")} onClick={async()=>{
              try {
                const gs = await listGames({ year, week, includedOnly: false });
                const gd = (gs || []).filter(g => g && g.gameday);
                if (gd.length !== 1) {
                  setMsg(gd.length === 0 ? "No GameDay game flagged for this week." : "Multiple GameDay games flagged — fix in Games.");
                  return;
                }
                await setDoc(doc(db, "config", "live"), { gamedayGameId: gd[0].id, gamedayHome: gd[0].home }, { merge: true });
                setMsg("Synced live GameDay to " + (gd[0].away || "Away") + " @ " + (gd[0].home || "Home") + ".");
              } catch (e) {
                console.error(e);
                setMsg("Failed to sync live GameDay");
              }
            }}>Sync Live GameDay</button>
          </Row>
          <Row style={{ marginTop: 10 }}>
            <button style={adminBtn("danger")} onClick={clearWeekIfNoPicks}>Clear Week (if no picks)</button>
          </Row>
        </AdminSection>

        <AdminSection title="Notifications" tone="neutral">
          <p style={{ margin:"0 0 10px", fontSize:13, color:"#9aa4c7" }}>
            Automated reminder/kickoff/results toggles, device management, and sending a custom push all live on their own page now.
          </p>
          <button style={adminBtn("primary")} onClick={() => { window.history.pushState(null, "", "/admin/notifications"); setPage("adminnotifications"); }}>Manage Notifications</button>
        </AdminSection>

        <BulkImportPicksPreview year={year} week={week} />

        <AdminSection title="Submissions" tone="warning" right={
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <StatusBadge tone={appCfg.picksLocked ? "danger" : "success"}>{appCfg.picksLocked ? "Locked" : "Open"}</StatusBadge>
            <StatusBadge tone={appCfg.scoreboard?.autoLockPicks !== false ? "primary" : "neutral"}>
              Automation: {appCfg.scoreboard?.autoLockPicks !== false ? "On" : "Off"}
            </StatusBadge>
          </div>
        }>
          <Row style={{ marginBottom: 10, ...stackRow }}>
            <button style={adminBtn("warning")} onClick={async ()=>{ try {
              await setDoc(doc(db, "config", "app"), { picksLocked: true, updatedAt: serverTimestamp() }, { merge: true });
              setMsg("Submissions locked.");
            } catch (e) {
              setMsg("Failed: " + (e?.message || String(e)));
            } }}>
              Lock Submissions
            </button>
            <button style={adminBtn("success")} onClick={async ()=>{ try {
              await setDoc(doc(db, "config", "app"), { picksLocked: false, updatedAt: serverTimestamp() }, { merge: true });
              setMsg("Submissions unlocked.");
            } catch (e) {
              setMsg("Failed: " + (e?.message || String(e)));
            } }}>
              Unlock Submissions
            </button>
          </Row>
          <Row>
            <button
              style={adminBtn(appCfg.scoreboard?.autoLockPicks !== false ? "neutral" : "primary")}
              title="Auto-lock picks + open leaderboard at kickoff. Turn off to make a manual unlock stick during a game."
              onClick={async ()=>{
                const next = appCfg.scoreboard?.autoLockPicks === false; // currently off -> turn on
                try {
                  await setDoc(doc(db, "config", "app"), { scoreboard: { autoLockPicks: next }, updatedAt: serverTimestamp() }, { merge: true });
                  setMsg(`Auto-lock-at-kickoff turned ${next ? "ON" : "OFF"}.`);
                } catch (e) {
                  setMsg("Failed: " + (e?.message || String(e)));
                }
              }}
            >
              Automation: {appCfg.scoreboard?.autoLockPicks !== false ? "ON (turn off)" : "OFF (turn on)"}
            </button>
          </Row>
        </AdminSection>

        <AdminSection title="Leaderboard" tone="warning">
          <Row style={{ marginBottom: 10, ...stackRow }}>
            <button style={adminBtn(appCfg.leaderboardLocked ? "success" : "warning")} onClick={toggleLeaderboardLock}>
              {appCfg.leaderboardLocked ? "Unlock Leaderboard" : "Lock Leaderboard (current week)"}
            </button>
            <StatusBadge tone={appCfg.leaderboardLocked ? "danger" : "success"} style={badgeAlign}>
              {appCfg.leaderboardLocked ? "Locked (current week)" : "Unlocked"}
            </StatusBadge>
          </Row>
          <Row style={stackRow}>
            <button style={adminBtn("neutral")} onClick={toggleLeaderboardPicks}>
              {appCfg.leaderboardPicksPublic ? "Switch to Admin-Only Picks" : "Switch to Public Picks"}
            </button>
            <StatusBadge tone={appCfg.leaderboardPicksPublic ? "primary" : "neutral"} style={badgeAlign}>
              {appCfg.leaderboardPicksPublic ? "Public (everyone can see picks)" : "Admin-Only"}
            </StatusBadge>
          </Row>
          <Row style={{ marginTop: 10, ...stackRow }}>
            <button style={adminBtn(appCfg.potHidden ? "success" : "warning")} onClick={togglePotHidden}>
              {appCfg.potHidden ? "Show Pot" : "Hide Pot"}
            </button>
            <StatusBadge tone={appCfg.potHidden ? "danger" : "success"} style={badgeAlign}>
              {appCfg.potHidden ? "Hidden from everyone but admins" : "Visible to everyone"}
            </StatusBadge>
          </Row>
        </AdminSection>

        <AdminSection title="Testing Mode (without live games)" tone="neutral" right={
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <StatusBadge tone={dummyWeekExists ? "success" : "neutral"}>Sandbox: {dummyWeekExists ? "Active" : "Empty"}</StatusBadge>
            <StatusBadge tone={appCfg.scoreboard?.testMode ? "primary" : (appCfg.scoreboard?.mode === "on" ? "success" : "neutral")}>
              Scoreboard: {appCfg.scoreboard?.testMode ? "Demo" : (appCfg.scoreboard?.mode === "on" ? "Live" : "Off")}
            </StatusBadge>
            <StatusBadge tone={localFixture ? "primary" : "neutral"}>Local Override: {localFixture ? "On" : "Off"}</StatusBadge>
          </div>
        }>
          <Row style={{ marginBottom: 10, ...stackRow }}>
            <button style={adminBtn("success")} onClick={createDummyWeek}>Create Dummy Week (2099 / W1)</button>
            <button style={adminBtn("danger")} onClick={clearDummyWeek}>Clear Dummy Week</button>
          </Row>
          <Row style={{ marginBottom: 10, ...stackRow }}>
            <button style={adminBtn("neutral")} onClick={async()=>{
              try {
                await setDoc(doc(db, "config", "app"), {
                  scoreboard: {
                    testMode: true,
                    mode: "off",
                    fixturePath: "/dev/scoreboard-demo.json"
                  },
                  updatedAt: serverTimestamp()
                }, { merge: true });
                setMsg("Scoreboard set to DEMO (fixture) via config/app.");
              } catch(e) {
                console.error(e);
                setMsg("Failed to set scoreboard to DEMO");
              }
            }}>
              Use Demo (Fixture)
            </button>

            <button style={adminBtn("primary")} onClick={async()=>{
              try {
                await setDoc(doc(db, "config", "app"), {
                  scoreboard: {
                    testMode: false,
                    mode: "on"
                  },
                  updatedAt: serverTimestamp()
                }, { merge: true });
                setMsg("Scoreboard set to CFBD LIVE via config/app.");
              } catch(e) {
                console.error(e);
                setMsg("Failed to set scoreboard to LIVE");
              }
            }}>
              Use CFBD Live
            </button>
          </Row>
          <Row style={stackRow}>
            <button style={adminBtn("neutral")} onClick={(e)=>{ e.preventDefault(); try { makeLiveDemoFromGames(games||[]); } catch(err){ console.error(err); } }}>
              Make Live Demo
            </button>
            <button style={adminBtn(localFixture ? "primary" : "neutral")} onClick={()=>setLocalFixture(v=>!v)} title="Force local fixture JSON in your own browser; disables CFBD calls for safe testing">
              Local Fixture Override: {localFixture ? "ON" : "OFF"}
            </button>
          </Row>
        </AdminSection>

        <AdminSection title="Schedule Import" tone="primary">
          <Row>
            <Field label="CFBD API key (stored admin-only in Firestore)">
              <div style={{ display:"flex", gap:8, flexWrap: isMobile ? "wrap" : "nowrap" }}>
                <input style={{...inputStyle, width: isMobile ? "100%" : "24rem"}} type={showApiKey ? "text" : "password"} autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="Bearer key from collegefootballdata.com"/>
                <button type="button" style={adminBtn("neutral", { padding:"9px 12px" })} onClick={()=>setShowApiKey(v=>!v)}>{showApiKey ? "Hide" : "Show"}</button>
              </div>
            </Field>
          </Row>
          <Row style={{ marginTop: 10, ...stackRow }}>
            <button style={adminBtn("primary")} onClick={saveKey}>Save key</button>
            <button style={adminBtn("primary")} onClick={doImport}>Import week</button>
            <button style={adminBtn("primary")} onClick={doSyncOdds} title="Pulls spreads/over-under from CFBD for the selected week - only runs when clicked, never automatically">Sync Odds (CFBD)</button>
            <button style={adminBtn("primary")} onClick={doSyncRankings} title="Pulls AP Top 25 ranks from CFBD for the selected week's games - only runs when clicked, never automatically">Sync Rankings (CFBD)</button>
          </Row>
        </AdminSection>

        <AdminSection title="Games" tone="neutral" right={
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <StatusBadge tone="neutral">Selected: {games.filter(x => x.included).length} / {games.length}</StatusBadge>
            <button
              type="button"
              onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); deselectAll(); }}
              style={adminBtn("neutral", { padding:"6px 10px" })}
              aria-label="Deselect all games"
              title="Deselect all games"
            >
              Deselect All
            </button>
          </div>
        }>
{renderGamesGroupedByDate(games, {
  timeZone: "America/New_York",
  renderRow: (g, i, { kickoffLabel }) => (
    <div
      key={g.id} data-game-id={g.id}
      role="switch"
      aria-checked={!!g.included}
      tabIndex={0}
      onClick={(e)=>toggle(g, !g.included)}
      onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggle(g, !g.included);} }}
      style={{
        display:"flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "center",
        gap:12, flexWrap: isMobile ? "wrap" : "nowrap",
        border: g.included ? "1px solid #2ecc71" : "1px dashed #1f2a44",
        padding:12, borderRadius:12, margin:"10px auto",
        maxWidth: 1200, width:"100%", cursor:"pointer",
        boxShadow: g.included ? "0 0 0 2px #2ecc71 inset" : "none",
        background: g.included ? "rgba(46,204,113,0.08)" : "transparent",
        transition:"box-shadow 120ms ease, background 120ms ease, border-color 120ms ease"
      }}
    >
      <div style={{ marginBottom: 16, textAlign:"left", whiteSpace: isMobile ? "normal" : "nowrap", overflow: isMobile ? "visible" : "hidden", textOverflow: isMobile ? "clip" : "ellipsis", minWidth:0, width: isMobile ? "100%" : undefined }}>
        <strong style={{ display:"inline-flex", flexWrap:"wrap", justifyContent:"center", alignItems:"center", width:"100%", textAlign:"center", rowGap:"0", lineHeight: 1.24, fontWeight:700, fontSize: fitFontByLen(((teamLabelNoMascot(g.away,g.awayRank)||"").length + (teamLabelNoMascot(g.home,g.homeRank)||"").length)), gap:6 }}>
          <TeamLogo school={g.away} size={48} /> <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div> @ <TeamLogo school={g.home} size={48} /> <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>
        </strong>
        {(g.formattedSpread || g.overUnder != null) && (
          <div style={{ marginTop:4, fontSize:11, color:"#9aa4c7", textAlign:"center" }}>
            {g.formattedSpread || ""}{g.formattedSpread && g.overUnder != null ? " · " : ""}{g.overUnder != null ? `O/U ${g.overUnder}` : ""}
          </div>
        )}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginLeft: isMobile ? 0 : "auto", width: isMobile ? "100%" : undefined, justifyContent: isMobile ? "space-between" : "flex-start", flexWrap: isMobile ? "wrap" : "nowrap" }}>
  <span style={{ whiteSpace:"nowrap", opacity: 0.8 }}>{timeLabelOnly(g,{ timeZone:"America/New_York" })}</span>
    <button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); setGameGameday(g.year, g.week, g.id).then(async ()=>{ setGames(await listGames({ year, week, includedOnly: false })); setMsg("Set College GameDay to " + teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank)); }); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); setGameGameday(g.year, g.week, g.id).then(async ()=>{ setGames(await listGames({ year, week, includedOnly: false })); setMsg("Set College GameDay to " + teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank)); }); }}}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer", color:"#fff", marginRight:8, background: g.gameday ? "rgba(241,196,15,0.1)" : "transparent", boxShadow: g.gameday ? "0 0 0 2px #f1c40f inset" : "none" }}
    aria-label={"Set College GameDay for " + teamLabelNoMascot(g.away, g.awayRank) + " at " + teamLabelNoMascot(g.home, g.homeRank)}
    title={g.gameday ? "College GameDay (selected)" : "Set as College GameDay"}
  >
    {"?"}
  </button><button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); chooseWinner(g); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); chooseWinner(g);} }}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer" }}
    aria-label={`Set winner for $<div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div> at $<div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>`}
  >
    Set Winner
  </button>
</div>
    </div>
  )
})}
        </AdminSection>
      </Card>
</Container>
  );
}

function ConfirmPage({ setPage }) {
  const isMobile = useIsMobile();
  const [picksLocked, setPicksLocked] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      const d = s.data() || {};
      setPicksLocked(!!d.picksLocked);
    });
    return () => unsub && unsub();
  }, []);
  const [pending, setPending] = React.useState(null);
  const [games, setGames] = React.useState([]);
  const [msg, setMsg] = React.useState("");

  React.useEffect(() => {
  (async () => {
    try {
      const p = JSON.parse(localStorage.getItem("pending") || "null");
      if (!p || !hasWeekValue(p.year) || !hasWeekValue(p.week)) { setPage("picks"); return; }
      setPending(p);

      // Use the same fetch + sort as PicksPage
      let items = await listGames({ year: p.year, week: p.week, includedOnly: true });

      // Put College GameDay at the end (same presentation as Picks)
      const gd = Array.isArray(items) ? items.find(x => x && x.gameday) : null;
      items = gd ? [...items.filter(x => x && x.id !== gd.id), gd] : items;

      setGames(items);
    } catch (e) {
      setPage("picks");
    }
  })();
}, [setPage]);

  const normEmail = (s) => String(s||"").trim().toLowerCase();
const normPhone = (s) => String(s||"").replace(/[^0-9]/g, "");
const normVenmo = (s) => String(s||"").trim().toLowerCase().replace(/^@+/, "");const confirmAndSubmit = async () => { if (picksLocked) { if (typeof setMsg==="function") setMsg("Submissions are locked right now."); return; }
    if (!pending) return;
    setMsg("Saving...");
    try {
      const { year, week, form, picks, code, tiebreaker } = pending;
      // ---- Front-end validations (required fields & all picks) ----
      const phoneDigits = String((form && form.phone) || "").replace(/[^0-9]/g, "");
      const venmoTrim   = String((form && form.venmo) || "").trim();
      const firstTrim   = String((form && form.firstName) || "").trim();
      const lastTrim    = String((form && form.lastName) || "").trim();

      // Required: first & last name
      if (!firstTrim || !lastTrim) { setMsg("Enter your first and last name."); return; }

      // Required: phone (any digits; Firestore rules may be stricter)
      if (!phoneDigits) { setMsg("Enter your phone number."); return; }

      // Required: Venmo + confirmation checkbox
      if (!venmoTrim) { setMsg("Enter your Venmo username."); return; }
      if (!form?.venmoConfirmed) { setMsg("Please confirm your Venmo is correct."); return; }

      // Required: a pick for every included game
      const missingPick = (Array.isArray(games) ? games : [])
        .filter(g => (typeof g?.included === "boolean" ? g.included : true))
        .find(g => (picks == null || picks[g.id] == null));
      if (missingPick) { setMsg("Make a pick for every listed game."); return; }
      const id = `${year}_W${week}_${code}`;
      const gd = games.find(x => x && x.gameday);

      const payload = {
        id, year, week, code,
        firstName: form.firstName,
        lastName: form.lastName,
        lastNameLower: (form.lastName || "").toLowerCase().trim(),
        phone: form.phone || "",
        venmo: form.venmo || "",
        email: (form.email || "").toLowerCase(),
        venmoConfirmed: !!form.venmoConfirmed,
        picks,
        updatedAt: serverTimestamp()
      };
      // If this browser has notifications enabled, tag the submission with
      // its push token so reminder notifications can skip devices that
      // already submitted for this week.
      try {
        const pushToken = localStorage.getItem("pushToken");
        if (pushToken) {
          payload.pushToken = pushToken;
          setDoc(doc(db, "pushTokens", pushToken), { name: `${firstTrim} ${lastTrim}`.trim() }, { merge: true }).catch(()=>{});
        }
      } catch (e) {}

      if (gd) {
        const tbTotal = tiebreaker && tiebreaker.total !== "" ? Number(tiebreaker.total) : NaN;
        if (Number.isNaN(tbTotal)) { setMsg("Enter total points for the College GameDay tiebreaker."); return; }
        payload.tiebreaker = { gameId: gd.id, total: tbTotal };
      }

      try {
  await runTransaction(db, async (tx) => {
    const locks = [];
    const eKey = normEmail(form.email);
    const pKey = normPhone(form.phone);
    const vKey = normVenmo(form.venmo);
    if (eKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_email_${eKey}`), type: "email", value: eKey });
    if (pKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_phone_${pKey}`), type: "phone", value: pKey });
    if (vKey) locks.push({ ref: doc(db, "keys", `${year}_W${week}_venmo_${vKey}`), type: "venmo", value: vKey });

    // If any lock exists and points to a different submission, block
    for (const l of locks) {
      const s = await tx.get(l.ref);
      const existing = s.exists() ? s.data() : null;
      if (existing && existing.picksId !== id) {
        throw new Error("DUPLICATE_LOCK");
      }
    }

    // Create/update locks for this submission, then write the picks
    for (const l of locks) {
      tx.set(l.ref, { year, week, type: l.type, value: l.value, picksId: id, code, createdAt: serverTimestamp() }, { merge: true });
    }
    tx.set(doc(db, "picks", id), payload, { merge: true });
  });
} catch (e2) {
  const msg = String((e2 && e2.message) || e2 || "");
  if (msg === "DUPLICATE_LOCK") {
    setMsg("this email/number/venmo is already associated with a submission, if you feel this was reached in error contact zslay@live.com");
    return;
  }
  throw e2;
}localStorage.setItem("receipt", JSON.stringify({ year, week, code, form, picks, tiebreaker: payload.tiebreaker || null }));
      setMsg("");
      setPage("receipt");
      window.history.pushState(null, "", "/receipt");
    } catch (e) {
      setMsg("Save failed: " + (e && e.message ? e.message : e));
    }
  };

  const included = Array.isArray(games) ? games.filter(g => (typeof g.included === "boolean" ? g.included : true)) : [];
  const gd = included.find(x => x && x.gameday);
  const list = gd ? [...included.filter(x => x && x.id !== gd.id), gd] : included;

  const pickLabel = (g) => {
    const t = pending?.picks?.[g.id];
    if (t == null) return "(no pick)";
    if (t === g.home) return teamLabel(g.home, g.homeRank);
    if (t === g.away) return teamLabel(g.away, g.awayRank);
    return String(t);
  };

  if (!pending) return null;

  return (
    <Container maxWidth={720}>
      <Card style={{ maxWidth: 900, padding: isMobile ? 12 : 16 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
          <h2 style={{ margin:0 }}>Confirm Your Picks — Week {pending.week}</h2>
          <div style={{ display:"flex", alignItems:"center", gap:8, background:"#0e1730", border:"1px solid #1f2a44", borderRadius:999, padding:"6px 14px" }}>
            <span style={{ fontSize:12, color:"#9aa4c7" }}>Edit code</span>
            <code style={{ fontSize:16, fontWeight:700, letterSpacing:1 }}>{pending.code}</code>
          </div>
        </div>
        <div style={{ fontSize:13, color:"#9aa4c7", margin:"6px 0 16px" }}>
          Double-check your picks below, then confirm to submit.
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap: isMobile ? 4 : 8 }}>
          {list.map(g => {
            const pickedHome = pending?.picks?.[g.id] === g.home;
            const pickedAway = pending?.picks?.[g.id] === g.away;
            const hasPick = pickedHome || pickedAway;

            if (isMobile) {
              // Compact, single-line, non-wrapping row so a full slate stays
              // screenshot-friendly - long names truncate instead of wrapping.
              return (
                <div key={g.id} style={{
                  display:"flex", alignItems:"center", gap:6, flexWrap:"nowrap",
                  padding:"6px 8px", borderRadius:8,
                  background:"#0e1730", border: g.gameday ? "1px solid #f0b429" : "1px solid #1f2a44"
                }}>
                  <TeamLogo school={g.away} size={16} style={{ opacity: pickedAway ? 1 : .4, flexShrink:0 }}/>
                  <span style={{ fontSize:11, fontWeight: pickedAway ? 700 : 400, color: pickedAway ? "#fff" : "#9aa4c7", minWidth:0, flexShrink:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {teamLabelNoMascot(g.away, g.awayRank)}
                  </span>
                  <span style={{ fontSize:10, color:"#5b6a8f", flexShrink:0 }}>@</span>
                  <TeamLogo school={g.home} size={16} style={{ opacity: pickedHome ? 1 : .4, flexShrink:0 }}/>
                  <span style={{ fontSize:11, fontWeight: pickedHome ? 700 : 400, color: pickedHome ? "#fff" : "#9aa4c7", minWidth:0, flexShrink:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {teamLabelNoMascot(g.home, g.homeRank)}
                  </span>
                  <div style={{ marginLeft:"auto", flexShrink:0 }}>
                    <StatusBadge tone={hasPick ? "success" : "danger"}>{pickLabel(g)}</StatusBadge>
                  </div>
                </div>
              );
            }

            return (
              <div key={g.id} style={{
                display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap",
                padding:"10px 14px", borderRadius:12,
                background:"#0e1730", border: g.gameday ? "1px solid #f0b429" : "1px solid #1f2a44"
              }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0, flexWrap:"wrap" }}>
                  <TeamLogo school={g.away} size={28} style={{ opacity: pickedAway ? 1 : .4 }}/>
                  <span style={{ fontSize:13, fontWeight: pickedAway ? 700 : 400, color: pickedAway ? "#fff" : "#9aa4c7" }}>
                    {teamLabelNoMascot(g.away, g.awayRank)}
                  </span>
                  <span style={{ fontSize:12, color:"#5b6a8f" }}>@</span>
                  <TeamLogo school={g.home} size={28} style={{ opacity: pickedHome ? 1 : .4 }}/>
                  <span style={{ fontSize:13, fontWeight: pickedHome ? 700 : 400, color: pickedHome ? "#fff" : "#9aa4c7" }}>
                    {teamLabelNoMascot(g.home, g.homeRank)}
                  </span>
                  {g.gameday && <span style={{ fontSize:11, color:"#f0b429", fontWeight:700, marginLeft:4 }}>GAMEDAY</span>}
                </div>
                <StatusBadge tone={hasPick ? "success" : "danger"}>{pickLabel(g)}</StatusBadge>
              </div>
            );
          })}
        </div>

        {gd && (
          <div style={{ marginTop: 16, padding:"12px 14px", borderRadius:12, background:"#0e1730", border:"1px solid #f0b429" }}>
            <div style={{ fontSize:12, color:"#f0b429", fontWeight:700, marginBottom:4 }}>College GameDay Tiebreaker</div>
            <div style={{ fontSize:14, fontWeight:600 }}>
              Total points: {pending?.tiebreaker?.total === "" || pending?.tiebreaker?.total == null ? "(not set)" : Number(pending.tiebreaker.total)}
            </div>
          </div>
        )}

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:20, gap:12, flexWrap:"wrap" }}>
          <button type="button" style={adminBtn("neutral")} onClick={()=>{ setPage("picks"); window.history.pushState(null, "", "/picks"); }}>Back to Edit</button>
          {msg && <div style={{ flex:1, textAlign:"center", color:"#f0b429", fontSize:13, fontWeight:600 }}>{msg}</div>}
          <button type="button" style={adminBtn(picksLocked ? "neutral" : "primary")} onClick={confirmAndSubmit} disabled={!!(picksLocked)}>Confirm & Submit</button>
        </div>
      </Card>
    </Container>
  );
}

function ReceiptPage({ setPage }) {
  const isMobile = useIsMobile();
  const [receipt, setReceipt] = React.useState(null);
  const [games, setGames] = React.useState([]);

  React.useEffect(() => {
    const r = JSON.parse(localStorage.getItem("receipt") || "null");
    if (!r) { setPage("picks"); return; }
    setReceipt(r);
  }, [setPage]);

  React.useEffect(() => {
    if (!receipt || !hasWeekValue(receipt.year) || !hasWeekValue(receipt.week)) return;
    (async () => {
      try {
        let items = await listGames({ year: receipt.year, week: receipt.week, includedOnly: true });
        const gd = Array.isArray(items) ? items.find(x => x && x.gameday) : null;
        items = gd ? [...items.filter(x => x && x.id !== gd.id), gd] : items;
        setGames(items);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [receipt]);

  if (!receipt) return null;

  const gd = games.find(x => x && x.gameday);
  const pickLabel = (g) => {
    const t = receipt?.picks?.[g.id];
    if (t == null) return "(no pick)";
    if (t === g.home) return teamLabel(g.home, g.homeRank);
    if (t === g.away) return teamLabel(g.away, g.awayRank);
    return String(t);
  };

  return (
    <Container maxWidth={720}>
      <Card style={{ maxWidth: 900, padding: isMobile ? 12 : 16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:28 }}>✅</span>
          <h2 style={{ margin:0 }}>Picks Submitted — Week {receipt.week}</h2>
        </div>
        <div style={{ fontSize:13, color:"#9aa4c7", margin:"8px 0 4px" }}>
          <strong style={{ color:"#f0b429" }}>Screenshot this page</strong> as your record. Use your code + last name to edit before kickoff.
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, background:"#0e1730", border:"1px solid #1f2a44", borderRadius:999, padding:"6px 14px", width:"fit-content", margin:"12px 0 16px" }}>
          <span style={{ fontSize:12, color:"#9aa4c7" }}>Edit code</span>
          <code style={{ fontSize:16, fontWeight:700, letterSpacing:1 }}>{receipt.code}</code>
        </div>

        {games.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap: isMobile ? 4 : 8 }}>
            {games.map(g => {
              const pickedHome = receipt?.picks?.[g.id] === g.home;
              const pickedAway = receipt?.picks?.[g.id] === g.away;
              const hasPick = pickedHome || pickedAway;

              if (isMobile) {
                // Compact, single-line, non-wrapping row so a full slate stays
                // screenshot-friendly - long names truncate instead of wrapping.
                return (
                  <div key={g.id} style={{
                    display:"flex", alignItems:"center", gap:6, flexWrap:"nowrap",
                    padding:"6px 8px", borderRadius:8,
                    background:"#0e1730", border: g.gameday ? "1px solid #f0b429" : "1px solid #1f2a44"
                  }}>
                    <TeamLogo school={g.away} size={16} style={{ opacity: pickedAway ? 1 : .4, flexShrink:0 }}/>
                    <span style={{ fontSize:11, fontWeight: pickedAway ? 700 : 400, color: pickedAway ? "#fff" : "#9aa4c7", minWidth:0, flexShrink:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {teamLabelNoMascot(g.away, g.awayRank)}
                    </span>
                    <span style={{ fontSize:10, color:"#5b6a8f", flexShrink:0 }}>@</span>
                    <TeamLogo school={g.home} size={16} style={{ opacity: pickedHome ? 1 : .4, flexShrink:0 }}/>
                    <span style={{ fontSize:11, fontWeight: pickedHome ? 700 : 400, color: pickedHome ? "#fff" : "#9aa4c7", minWidth:0, flexShrink:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {teamLabelNoMascot(g.home, g.homeRank)}
                    </span>
                    <div style={{ marginLeft:"auto", flexShrink:0 }}>
                      <StatusBadge tone={hasPick ? "success" : "danger"}>{pickLabel(g)}</StatusBadge>
                    </div>
                  </div>
                );
              }

              return (
                <div key={g.id} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap",
                  padding:"10px 14px", borderRadius:12,
                  background:"#0e1730", border: g.gameday ? "1px solid #f0b429" : "1px solid #1f2a44"
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0, flexWrap:"wrap" }}>
                    <TeamLogo school={g.away} size={28} style={{ opacity: pickedAway ? 1 : .4 }}/>
                    <span style={{ fontSize:13, fontWeight: pickedAway ? 700 : 400, color: pickedAway ? "#fff" : "#9aa4c7" }}>
                      {teamLabelNoMascot(g.away, g.awayRank)}
                    </span>
                    <span style={{ fontSize:12, color:"#5b6a8f" }}>@</span>
                    <TeamLogo school={g.home} size={28} style={{ opacity: pickedHome ? 1 : .4 }}/>
                    <span style={{ fontSize:13, fontWeight: pickedHome ? 700 : 400, color: pickedHome ? "#fff" : "#9aa4c7" }}>
                      {teamLabelNoMascot(g.home, g.homeRank)}
                    </span>
                    {g.gameday && <span style={{ fontSize:11, color:"#f0b429", fontWeight:700, marginLeft:4 }}>GAMEDAY</span>}
                  </div>
                  <StatusBadge tone={hasPick ? "success" : "danger"}>{pickLabel(g)}</StatusBadge>
                </div>
              );
            })}
          </div>
        )}

        {gd && receipt?.tiebreaker && (
          <div style={{ marginTop: 16, padding:"12px 14px", borderRadius:12, background:"#0e1730", border:"1px solid #f0b429" }}>
            <div style={{ fontSize:12, color:"#f0b429", fontWeight:700, marginBottom:4 }}>College GameDay Tiebreaker</div>
            <div style={{ fontSize:14, fontWeight:600 }}>
              Total points: {receipt.tiebreaker.total ?? "(not set)"}
            </div>
          </div>
        )}

        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:20 }}>
          <button type="button" style={adminBtn("primary")} onClick={()=>{
            setReceipt(null);
            localStorage.removeItem("receipt");
            setPage("picks");
            window.history.pushState(null, "", "/picks");
          }}>Done</button>
        </div>
      </Card>
    </Container>
  );
}
function ModalOverlay({ children }) {
  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(5,8,16,0.92)",
      display:"grid", placeItems:"center", padding:"24px", zIndex: 1000
    }}>
      <div style={{
        width:"min(920px, 94vw)", maxHeight:"86vh", overflow:"auto",
        background:"transparent", border:"none", boxShadow:"none", padding:0
      }}>
        {children}
      </div>
    </div>
  );
}
export default function App() {
  const { user, isAdmin } = useAuthAdmin();
  const [page, setPage] = useState("picks");
  // --- Path router shim (picks|leader|admin|admin/picks|admin/notifications) ---
  useEffect(() => {
    const readPath = () => {
      const p = (window.location.pathname || "/").replace(/^\/|\/$/g, "");
      if (p === "") { setPage("picks"); return; }
      if (p === "picks" || p === "leader" || p === "admin" || p === "myseason") { setPage(p); return; }
      if (p === "admin/picks") { setPage("adminpicks"); return; }
      if (p === "admin/notifications") { setPage("adminnotifications"); return; }
      if (p === "admin/payments") { setPage("adminpayments"); return; }
      if (p === "admin/missing") { setPage("adminmissing"); return; }
    };
    readPath(); // on load
    window.addEventListener("popstate", readPath);
    return () => window.removeEventListener("popstate", readPath);
  }, []);

  useEffect(() => {
    document.body.style.margin = 0;
    document.body.style.background = "#0b1220";
    document.body.style.color = "#eef2ff";
    document.body.style.fontFamily = "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  }, []);

  return (
    <>
      {(page === "picks" || page === "confirm" || page === "receipt") && <PicksPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "leader" && <LeaderboardPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "myseason" && <MySeasonPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "admin" && <AdminPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminpicks" && <AdminPicksPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminnotifications" && <AdminNotificationsPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminpayments" && <AdminPaymentsPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminmissing" && <AdminMissingPicksPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "confirm" && <ModalOverlay><ConfirmPage setPage={setPage} /></ModalOverlay>}
      {page === "receipt" && <ModalOverlay><ReceiptPage setPage={setPage} /></ModalOverlay>}
    </>
  );
}

























































































/* ===== Admin: group games into date sections (ESPN-style) ===== */
const _tzDefault = "America/New_York";

const _maybeDate = (g) => {
  try { if (typeof kickoffDate === "function") return kickoffDate(g); } catch {}
  if (g?.kickoff?.seconds) return new Date(g.kickoff.seconds * 1000);
  if (g?.kickoff?.toDate) return g.kickoff.toDate();
  const cand = g?.kickoff ?? g?.start ?? g?.startTime ?? g?.start_time ?? g?.startDate ?? g?.start_date ?? g?.date ?? g?.startTimeStr;
  return cand ? new Date(cand) : null;
};

const _kickoffLabel = (g, { timeZone = _tzDefault } = {}) => {
  try { if (typeof kickoffLabel === "function") return kickoffLabel(g, { timeZone }); } catch {}
  const d = _maybeDate(g);
  if (!d || isNaN(+d)) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone
  }).format(d);
};

function _ymdKey(d, timeZone = _tzDefault) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const yyyy = parts.find(p => p.type === "year")?.value;
  const mm   = parts.find(p => p.type === "month")?.value;
  const dd   = parts.find(p => p.type === "day")?.value;
  return `${yyyy}-${mm}-${dd}`;
}

function groupGamesByDate(games = [], { timeZone = _tzDefault } = {}) {
  const map = new Map();
  for (const g of games) {
    const d = kickoffDate(g);
    if (!d || isNaN(+d)) continue;
    const key = _ymdKey(d, timeZone);
    const header = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(d);
    if (!map.has(key)) map.set(key, { key, header, items: [] });
    map.get(key).items.push(g);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// JSX renderer: call with your existing row renderer to keep current controls
function renderGamesGroupedByDate(games, { timeZone = _tzDefault, renderRow } = {}) {
  const groups = groupGamesByDate(games, { timeZone });
groups.forEach(g => { if (Array.isArray(g.items)) g.items.sort((a,b)=>((a.orderDay ?? 1e9)-(b.orderDay ?? 1e9)) || ((a.order ?? 1e9)-(b.order ?? 1e9))); });
groups.forEach(g => { if (Array.isArray(g.items)) g.items.sort((a,b)=>((a.orderDay ?? 1e9)-(b.orderDay ?? 1e9)) || ((a.order ?? 1e9)-(b.order ?? 1e9))); });

  return (
    <div className="space-y-10">
      {groups.map(grp => (
        <section key={grp.key} style={{ marginBottom: 48 }}>
          <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>{grp.header}</div>
          <div className="space-y-2">
            {grp.items
              .sort((a,b)=>((a.orderDay ?? 1e9)-(b.orderDay ?? 1e9)) || ((a.order ?? 1e9)-(b.order ?? 1e9)))
              .map((g, i) =>
                renderRow
                  ? renderRow(g, i, { timeZone, kickoffLabel: _kickoffLabel })
                  : (
                    <div key={g.id || i} className="rounded-2xl shadow p-3 flex items-center justify-between">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {/* Optional logos here */}
                        <div>{g.away?.name ?? g.away}</div>
                        <div>@</div>
                        <div>{g.home?.name ?? g.home}</div>
                      </div>
                      <div style={{ opacity: 0.8 }}>{_kickoffLabel(g, { timeZone })}</div>
                    </div>
                  )
              )}
          </div>
        </section>
      ))}
    </div>
  );
}
/* ===== /group games by date ===== */


/* === Admin: time-only label for grouped rows === */
function timeLabelOnly(g, { timeZone = _tzDefault } = {}) {
  const d = _maybeDate(g);
  if (!d || isNaN(+d)) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone
  }).format(d);
}


















// restore Admin-SetGamedayBtn 2025-08-29T01:53:49




















































































































































































































































  
// === Doc ID helper: {year}_W{week}_{last2}-{hash8} ===
// Only last 2 digits of the 6-digit code appear in the ID; hash prevents collisions.
async function computePickDocId(year, week, code, lastNameLower) {
  try {
    const last2 = String(code).slice(-2);
    const input = `${year}|${week}|${String(code)}|${String((lastNameLower||"")).toLowerCase()}`;
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    const hash8 = Array.from(new Uint8Array(buf).slice(0,4))
      .map(b => b.toString(16).padStart(2,"0"))
      .join("");
    return `${year}_W${week}_${last2}-${hash8}`;
  } catch (e) {
    console.error("computePickDocId failed, falling back to legacy id:", e);
    return `${year}_W${week}_${code}`; // safe fallback (legacy id)
  }
}







//
// ==== DEBUG HELPERS (temporary) ====
if (typeof window !== "undefined") {
  window._lbDebug = {
    live: async () => {
      try {
        const s = await getDoc(doc(db, "config", "live"));
        console.log("[_lbDebug.live]", s.exists() ? s.data() : null);
        return s.exists() ? s.data() : null;
      } catch (e) { console.error(e); return null; }
    },
    games: async (Y, W) => {
      try {
        const g = await listGames({ year: Y, week: W, includedOnly: true });
        console.table(g.map(x => ({ id: x.id, away: x.away, home: x.home, included: x.included })));
        return g;
      } catch (e) { console.error(e); return []; }
    },
    results: async (ids) => {
      try {
        const r = await getResultsMap(ids);
        console.log("[_lbDebug.results]", r);
        return r;
      } catch (e) { console.error(e); return {}; }
    },
  };
  console.log("%c_lbDebug ready. Try: await _lbDebug.live()", "font-weight:bold");
}
if (typeof window !== "undefined" && window._lbDebug) {
  window._lbDebug.picks = async (Y, W) => {
    try {
      const P = await loadPicks(Y, W);
      console.log("[_lbDebug.picks]", P);
      return P;
    } catch (e) { console.error(e); return []; }
  };
  window._lbDebug.score = (p, G, R) =>
    G.reduce((acc, g) => {
      const pick = p.picks?.[g.id];
      const win  = R[g.id]?.winner;
      return acc + (pick && win && pick === win ? 1 : 0);
    }, 0);
}
if (typeof window !== "undefined" && window._lbDebug) {
  // Self-contained picks fetch (no dependency on loadPicks)
  window._lbDebug.picks = async (Y, W) => {
    try {
      const picksCol = collection(db, "picks");
      const qy = query(picksCol, where("year","==",Y), where("week","==",W));
      const s = await getDocs(qy);
      const arr = [];
      s.forEach(d => arr.push({ id: d.id, ...d.data() }));
      console.log("[_lbDebug.picks]", arr);
      return arr;
    } catch (e) { console.error(e); return []; }
  };
  window._lbDebug.score = (p, G, R) =>
    G.reduce((acc, g) => {
      const pick = p.picks?.[g.id];
      const win  = R[g.id]?.winner;
      return acc + (pick && win && pick === win ? 1 : 0);
    }, 0);
}
if (typeof window !== "undefined" && window._lbDebug) {
  window._lbDebug.setWinner = async (gid, side) => {
    try {
      const gs = await getDoc(doc(db, "games", gid));
      if (!gs.exists()) throw new Error("No game: " + gid);
      const g = { id: gid, ...gs.data() };
      const val = String(side).trim().toLowerCase();
      let w = null;
      if (val === "home" || val === g.home.toLowerCase()) w = g.home;
      else if (val === "away" || val === g.away.toLowerCase()) w = g.away;
      else throw new Error('Use "home" or "away" (or exact team name)');
      await setDoc(doc(db, "results", gid), { winner: w, updatedAt: serverTimestamp() }, { merge: true });
      console.log("setWinner OK:", gid, "?", w);
      return { gid, winner: w };
    } catch (e) { console.error("setWinner ERR:", e); return null; }
  };
}

if (typeof window !== "undefined") {
  window._lbDebug = window._lbDebug || {};
  window._lbDebug.auth = {
    signIn: async () => {
      const auth = getAuth();
      const prov = new GoogleAuthProvider();
      const res = await signInWithPopup(auth, prov);
      console.log("[auth] signed in:", res.user.uid, res.user.email);
      return res.user;
    },
    signOut: () => signOut(getAuth()),
    me: () => {
      const u = getAuth().currentUser;
      const who = u ? { uid: u.uid, email: u.email } : null;
      console.log("[auth] me:", who);
      return who;
    },
  };
  console.log("_lbDebug.auth ready ? try: await _lbDebug.auth.signIn()");
}

/* ==== Minimal auth helpers (use ./firebase wrappers) ==== */
if (typeof window !== "undefined") {
  // Trigger Google popup (same as Headerï¿½s ï¿½Admin Loginï¿½)
  window._signin = () => googleLogin();
  window._signout = () => logout();

  // Keep a live copy of the current user; _whoami() returns { uid, email } or null
  window._whoami = (() => {
    let last = null;
    try {
      onAuth(u => {
        last = u || null;
        if (u) console.log("[auth] signed in:", u.uid, (u.email || "").toLowerCase());
        else console.log("[auth] signed out");
      });
    } catch (_) {}
    return () => (last ? { uid: last.uid, email: (last.email || "").toLowerCase() } : null);
  })();

  console.log("_signin/_whoami ready ? click 'Admin Login' in the header, then run _whoami()");
}
/* ==== end auth helpers ==== */





























































































































































/* === LIVE DEMO GENERATOR (fixture JSON) — appended === */
async function makeLiveDemoFromGames(games = [], opts = {}) {
  try {
    const seed = (opts.seed ?? Date.now()) % 1000;
    let x = (seed || 1) >>> 0;
    const rnd = () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return ((x>>>0)/0xffffffff); };

    const scenarios = [
      { status: "scheduled",    period: 0, clock: "",       style: "none"  },
      { status: "in_progress",  period: 1, clock: "12:34",  style: "low"   },
      { status: "halftime",     period: 2, clock: "",       style: "mid"   },
      { status: "in_progress",  period: 3, clock: "06:21",  style: "mid"   },
      { status: "in_progress",  period: 4, clock: "02:03",  style: "high"  },
      { status: "final",        period: 4, clock: "",       style: "final" },
      { status: "final",        period: 5, clock: "",       style: "ot"    }, // FINAL/OT
    ];
    const pickStyle = () => scenarios[Math.floor(rnd() * scenarios.length)];

    const mkScore = (style) => {
      if (style === "none")  return [0, 0];
      if (style === "low")   return [Math.floor(rnd()*7), Math.floor(rnd()*7)];
      if (style === "mid")   return [7 + Math.floor(rnd()*14), 7 + Math.floor(rnd()*14)];
      if (style === "high")  return [20 + Math.floor(rnd()*21), 17 + Math.floor(rnd()*21)];
      if (style === "final") { let a = 10 + Math.floor(rnd()*31), h = 10 + Math.floor(rnd()*31); if (a === h) a += 3; return [a, h]; }
      if (style === "ot")    { let a = 24 + Math.floor(rnd()*24), h = 24 + Math.floor(rnd()*24); if (a === h) a += (rnd()<0.5?2:3); return [a, h]; }
      return [0, 0];
    };

    const demo = (Array.isArray(games) ? games : []).slice(0, 24).map((g, i) => {
      const awayTeam = String(g?.away || g?.awayTeam || "");
      const homeTeam = String(g?.home || g?.homeTeam || "");
      const sc = pickStyle();
      const [awayPoints, homePoints] = mkScore(sc.style);
      const possession = (sc.status === "in_progress" && rnd() < 0.5) ? (rnd() < 0.5 ? "away" : "home") : null;

      const awayRank = Number.isFinite(+g?.awayRank) ? +g.awayRank : null;
      const homeRank = Number.isFinite(+g?.homeRank) ? +g.homeRank : null;

      const kickDate = new Date(Date.now() + (i * 35 * 60 * 1000));
      const kickoffLabel = new Intl.DateTimeFormat("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York"
      }).format(kickDate);

      return { awayTeam, homeTeam, awayRank, homeRank, status: sc.status, period: sc.period, clock: sc.clock, awayPoints, homePoints, possession, kickoffLabel };
    });

    const json = JSON.stringify(demo, null, 2);

    // Clipboard (best effort)
    try { await navigator.clipboard.writeText(json); console.info("[demo] JSON copied to clipboard"); } catch {}

    // Download as fallback
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "scoreboard-demo.json";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch {}

    window.__DEMO_FIXTURE__ = demo;
    alert("Demo created:\n\n1) File downloaded and JSON copied.\n2) Replace /public/dev/scoreboard-demo.json with it.\n3) Toggle Fixture: ON to preview.");
  } catch (e) {
    console.error("makeLiveDemoFromGames failed", e);
    alert("Failed to build demo: " + (e?.message || e));
  }
}
/* === end LIVE DEMO GENERATOR === */














/* === DEV: load + merge Firestore results (week doc + legacy per-game) === */
if (typeof window !== "undefined") {
  window._loadResults = async function() {
    try {
      // uses already-imported Firestore symbols in App.jsx (db, getDoc, getDocs, doc, collection)
      const appSnap = await getDoc(doc(db, "config", "app"));
      const app = appSnap.exists() ? appSnap.data() : {};
      const year = app?.currentYear;
      const week = app?.currentWeek;
      if (!hasWeekValue(year) || !hasWeekValue(week)) { console.warn("[fs results] missing currentYear/currentWeek"); return null; }

      const normalizeKey = (name) => {
        if (!name) return "";
        let s = String(name).toLowerCase();
        s = s.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
        s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
        if (s === "texasam" || s === "texasa&m") s = "texasam";
        return s;
      };
      const gid = (home, away) => normalizeKey(away) + "__" + normalizeKey(home);

      // 1) New format: results/{year}_W{week}.games
      const weekId = year + "_W" + week;
      const weekSnap = await getDoc(doc(db, "results", weekId));
      const merged = {};
      if (weekSnap.exists()) {
        const data = weekSnap.data() || {};
        const games = data.games || {};
        for (const [k, v] of Object.entries(games)) {
          merged[k] = { ...v, source: "weekdoc" };
        }
      }

      // 2) Legacy per-game docs: results/{year}_W{week}_<Home>_at_<Away>
      const all = await getDocs(collection(db, "results"));
      const prefix = year + "_W" + week + "_";
      all.forEach((d) => {
        const id = d.id || "";
        if (!id.startsWith(prefix)) return;
        const r = d.data() || {};
        // derive teams from fields or doc id
        const byIdHome = id.split("_at_")[0]?.replace(prefix, "").replace(/_/g," ") || "";
        const byIdAway = id.split("_at_")[1]?.replace(/_/g," ") || "";
        const home = r.home || r.homeTeam || r.home_team || byIdHome;
        const away = r.away || r.awayTeam || r.away_team || byIdAway;
        const hp = (r.homePoints ?? r.home_points ?? r.homeScore ?? null);
        const ap = (r.awayPoints ?? r.away_points ?? r.awayScore ?? null);
        let winner = r.winner || null;
        if (winner == null && hp != null && ap != null) {
          winner = (+hp > +ap) ? normalizeKey(home) : ((+ap > +hp) ? normalizeKey(away) : "tie");
        }
        const key = gid(home, away);
        merged[key] = {
          ...(merged[key] || {}),
          winner,
          homePoints: (hp != null ? +hp : null),
          awayPoints: (ap != null ? +ap : null),
          status: r.status ?? null,
          period: r.period ?? null,
          source: (merged[key]?.source ? (merged[key].source + "+legacy") : "legacy"),
          finalizedAt: merged[key]?.finalizedAt || r.finalizedAt || null
        };
      });

      window.__FS_RESULTS = merged;
      console.info("[fs results] merged", { weekId, count: Object.keys(merged).length, keys: Object.keys(merged).slice(0,6) });
      return merged;
    } catch (e) {
      console.error("[_loadResults] failed", e);
      return null;
    }
  };
}















































































































































