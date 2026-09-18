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
  const r = results?.[g?.id];
  if (r?.push) return { ...base, background: "#2a3655", color: "#cfd8f0" };
  const w = r?.winner;
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
import BulkImportPicksPreview from "./components/BulkImportPicksPreview";
import { db, storage, googleLogin, logout, onAuth, enablePushNotifications } from "./firebase";

import { onSnapshot, collection, doc, documentId, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, writeBatch, query, where, orderBy, runTransaction, arrayUnion, arrayRemove } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";


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
// Generic "still loading" gate for a page's initial data fetch. Shows a
// plain loading message instead of whatever half-populated/default state
// the page would otherwise render for a moment (e.g. games that haven't
// actually been picked yet looking like real selections) - people were
// reading that flash of wrong-looking data as a bug rather than a loading
// state. A "Refresh" button appears after 5s in case loading is stuck
// rather than just slow.
function LoadingGate({ ready, children, label = "Loading…" }) {
  const [showRefresh, setShowRefresh] = useState(false);
  useEffect(() => {
    if (ready) { setShowRefresh(false); return; }
    const t = setTimeout(() => setShowRefresh(true), 5000);
    return () => clearTimeout(t);
  }, [ready]);

  if (ready) return <>{children}</>;

  return (
    <Card>
      <div style={{ textAlign: "center", padding: "48px 20px" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#cfd8f0" }}>{label}</div>
        {showRefresh && (
          <>
            <div style={{ marginTop: 10, fontSize: 13, color: "#9aa4c7" }}>Taking longer than usual.</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ marginTop: 16, padding: "10px 22px", borderRadius: 10, border: "none", background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
            >
              Refresh
            </button>
          </>
        )}
      </div>
    </Card>
  );
}
function Header({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const [chatOpen, setChatOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // One-time "new feature" banner, shown to every device (not just mobile,
  // unlike the install/notification prompts below) the first time the app
  // loads after this shipped. Previously announced weekly chat; now
  // repurposed for the new partial-slate submission option - a fresh
  // localStorage key so it reaches everyone again, including people who
  // already dismissed the chat announcement.
  const [showAnnounceBanner, setShowAnnounceBanner] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("partialSlateAnnounceDismissedForever") !== "1"; } catch (e) { return false; }
  });
  function dismissAnnounceBanner() {
    try { localStorage.setItem("partialSlateAnnounceDismissedForever", "1"); } catch (e) {}
    setShowAnnounceBanner(false);
  }
  // Dynamic day/time for the banner's copy below - computed live from the
  // real schedule (the same "later day-group's earliest kickoff" PicksPage
  // uses for its own partial-slate deadline) so it can't go stale the way a
  // hardcoded time would the moment a game gets added or pulled from the
  // slate. Only subscribes while the banner is still showing - no point
  // keeping listeners open for everyone who's already dismissed it.
  const [bannerLive, setBannerLive] = useState({ year: null, week: null });
  useEffect(() => {
    if (!showAnnounceBanner) return;
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => {
      const d = s.data() || {};
      setBannerLive({ year: Number(d.year), week: Number(d.week) });
    });
    return () => unsub();
  }, [showAnnounceBanner]);
  const [bannerGames, setBannerGames] = useState([]);
  useEffect(() => {
    if (!showAnnounceBanner) return;
    const { year, week } = bannerLive;
    if (!Number.isFinite(year) || !Number.isFinite(week)) { setBannerGames([]); return; }
    const unsub = onSnapshot(
      query(collection(db, "games"), where("year", "==", year), where("week", "==", week)),
      (snap) => setBannerGames(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setBannerGames([])
    );
    return () => unsub();
  }, [showAnnounceBanner, bannerLive.year, bannerLive.week]);
  const bannerSchedule = useMemo(() => {
    const needsIncludedFlag = bannerGames.some(g => Object.prototype.hasOwnProperty.call(g, "included"));
    const list = needsIncludedFlag ? bannerGames.filter(g => !!g.included) : bannerGames;
    const groups = groupGamesByDate(list, { timeZone: "America/New_York" });
    if (groups.length < 2) return null; // nothing later this week to describe
    const laterDates = groups.slice(1).flatMap(grp => grp.items)
      .map(g => kickoffDate(g))
      .filter(d => d instanceof Date && !isNaN(d))
      .sort((a, b) => a - b);
    const earliestLater = laterDates[0];
    if (!earliestLater) return null;
    const firstDate = kickoffDate(groups[0]?.items?.[0]);
    const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" });
    const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    const fmtTime = (d) => timeFmt.format(d).toLowerCase().replace(/\s/g, "").replace(":00", "");
    return {
      firstDay: (firstDate instanceof Date && !isNaN(firstDate)) ? dayFmt.format(firstDate) : "kickoff",
      laterDay: dayFmt.format(earliestLater),
      laterTime: fmtTime(earliestLater),
    };
  }, [bannerGames]);
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

  // Same link set either way - inline on desktop, collapsed into the
  // hamburger dropdown on mobile - so there's one definition to keep in sync
  // instead of two copies of every onClick. linkStyle differs per context
  // (compact inline links on desktop vs. full-width tappable rows in the
  // mobile dropdown) since both reuse this same function.
  const renderNavLinks = (linkStyle) => (
    <>
      <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/picks"); setPage("picks");}}>Picks</a>
      <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/leader"); setPage("leader");}}>Leaderboard</a>
      <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/myseason"); setPage("myseason");}}>My Season</a>
      <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/overall"); setPage("overall");}}>Overall</a>
      {isAdmin && <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); history.pushState(null, "", "/admin"); setPage("admin");}}>Admin</a>}
      {isMobile && !isStandaloneMode() && (
        <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); setShowInstallModal(true);}} title="Add to home screen" aria-label="Add to home screen">📲 Add to home screen</a>
      )}
      {isMobile && notifState !== "on" && (
        <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); setShowNotifModal(true);}} title="Enable notifications" aria-label="Enable notifications">🔔 Enable notifications</a>
      )}
      {isMobile && notifState === "on" && (
        <a href="#" style={linkStyle} onClick={async (e)=>{e.preventDefault();
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
        }} title="Notifications are on — tap to see your device ID" aria-label="Notification status">🔔✅ Notifications on</a>
      )}
      {user && <a href="#" style={linkStyle} onClick={(e)=>{e.preventDefault(); logout();}}>Sign out</a>}
    </>
  );

  return (
    <>
    <div style={{
      display: "flex", flexDirection: "column",
      position: "sticky", top: 0, zIndex: 50, background: "#0b1220", padding: "10px 0", marginBottom: 16,
      borderBottom: "1px solid #1f2a44",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <h1 style={{ margin: 0, fontSize: 20, userSelect:"none" }} onClick={handleLogoTap}>CFB Pick'em</h1>
          <WeekChat isAdmin={isAdmin} open={chatOpen} onOpenChange={setChatOpen} />
        </Row>
        {isMobile ? (
          <button
            type="button"
            onClick={() => setMobileMenuOpen(v => !v)}
            aria-label="Menu"
            aria-expanded={mobileMenuOpen}
            style={{ background: "transparent", border: "none", color: "#eef2ff", fontSize: 22, cursor: "pointer", padding: 4, lineHeight: 1 }}
          >
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
        ) : (
          <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {renderNavLinks()}
          </nav>
        )}
      </div>
      {isMobile && mobileMenuOpen && (
        <nav
          onClick={() => setMobileMenuOpen(false)}
          style={{
            display: "flex", flexDirection: "column", gap: 2, marginTop: 10, paddingTop: 10, borderTop: "1px solid #1f2a44",
          }}
        >
          {renderNavLinks({ padding: "10px 4px", fontSize: 15, borderRadius: 8, display: "block" })}
        </nav>
      )}
    </div>
    {showAnnounceBanner && (
      <div style={{
        display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:10,
        background:"#1c2b52", border:"1px solid #2a4fb8", borderRadius:10,
        padding:"9px 12px", marginBottom:14, fontSize:13, color:"#eef2ff", lineHeight:1.45
      }}>
        <div>
          <div>
            <b>⏳ New this week</b> — {bannerSchedule ? `${bannerSchedule.laterDay}'s` : "later"} picks stay editable until{" "}
            {bannerSchedule ? `${bannerSchedule.laterTime} on ${bannerSchedule.laterDay}` : "their kickoff"}, even after new submissions lock at{" "}
            {bannerSchedule ? `${bannerSchedule.firstDay}'s` : "the first"} kickoff.
          </div>
          <div style={{ marginTop:8 }}>
            <b>Can't finish by {bannerSchedule ? bannerSchedule.firstDay : "then"}?</b> Opt into a Partial Slate to submit{" "}
            {bannerSchedule ? `${bannerSchedule.firstDay}'s` : "those"} picks now and fill in {bannerSchedule ? `${bannerSchedule.laterDay}'s` : "the rest"} later.
          </div>
        </div>
        <button
          onClick={dismissAnnounceBanner}
          aria-label="Dismiss"
          style={{ background:"transparent", border:"none", color:"#cfd8f0", cursor:"pointer", fontSize:16, flexShrink:0, padding:2, lineHeight:1 }}
        >
          ✕
        </button>
      </div>
    )}
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
function Field({ label, children, style }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, ...style }}>{label}{children}</label>;
}
// fontSize:16 isn't styling preference - below 16px, iOS Safari auto-zooms
// the page in when a text input is focused (its heuristic for "this text
// would be too small to read once the keyboard covers half the screen").
// Individual inputs below still override this smaller where that zoom
// doesn't apply (admin-only compact fields), but this is the shared default
// so no new input silently reintroduces the zoom.
const inputStyle = { background:"#0c1426", color:"#fff", border:"1px solid #1f2a44", padding:"10px 12px", borderRadius:10, fontSize:16 };

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

// iPhone-Settings-style on/off row: label (+ optional description) on the
// left, a sliding switch on the right, the whole row tappable. Replaces the
// old pattern of two same-purpose buttons (or one button whose label swaps
// "Lock"/"Unlock") plus a separate status badge - the switch position IS the
// status, so nothing else has to restate it.
function AdminToggleRow({ label, description, checked, onChange, disabled, divider = true }) {
  return (
    <div
      role="switch"
      aria-checked={!!checked}
      aria-disabled={!!disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) onChange(!checked); }}
      onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onChange(!checked); } }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
        padding: "10px 2px", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        borderTop: divider ? "1px solid #1f2a44" : "none",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#eef2ff" }}>{label}</div>
        {description && <div style={{ fontSize: 12.5, color: "#9aa4c7", marginTop: 2, lineHeight: 1.35 }}>{description}</div>}
      </div>
      <span
        style={{
          flexShrink: 0, position: "relative", width: 46, height: 27, borderRadius: 999,
          background: checked ? "#30d158" : "#3a4568",
          transition: "background 150ms ease",
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: checked ? 21 : 2, width: 23, height: 23, borderRadius: "50%",
          background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.4)", transition: "left 150ms ease",
        }} />
      </span>
    </div>
  );
}

// Same row layout as AdminToggleRow (label + description on the left,
// divider on top) but for a one-shot action instead of a persistent on/off
// setting - the right side is whatever control(s) the caller passes in
// (typically a button, sometimes a couple of inputs) rather than a switch.
function AdminActionRow({ label, description, divider = true, children }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
      padding: "10px 2px", flexWrap: "wrap",
      borderTop: divider ? "1px solid #1f2a44" : "none",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#eef2ff" }}>{label}</div>
        {description && <div style={{ fontSize: 12.5, color: "#9aa4c7", marginTop: 2, lineHeight: 1.35 }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
        {children}
      </div>
    </div>
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
  let selectedGame = null;
  snap.forEach(d => {
    const isSelected = d.id === gameId;
    batch.set(d.ref, { gameday: isSelected }, { merge: true });
    if (isSelected) selectedGame = d.data();
  });
  await batch.commit();

  // Keep config/live.gamedayGameId in sync automatically when the game
  // being flagged belongs to the currently live week - the Firestore rule
  // requiring a valid tiebreaker on submission checks against this field,
  // and it used to only get updated by a separate manual "Sync" button
  // elsewhere in Admin. Forgetting that step for a new week would silently
  // reject everyone's picks submissions, since their tiebreaker would
  // correctly point at the new GameDay game while the rule still expected
  // the old one.
  try {
    const liveSnap = await getDoc(doc(db, "config", "live"));
    const live = liveSnap.exists() ? liveSnap.data() : null;
    if (live && Number(live.year) === Number(year) && Number(live.week) === Number(week) && selectedGame) {
      await setDoc(doc(db, "config", "live"), { gamedayGameId: gameId, gamedayHome: selectedGame.home }, { merge: true });
    }
  } catch (e) {
    console.error("setGameGameday: failed to sync config/live.gamedayGameId", e);
  }
}
async function setResult(gameId, winner, totalPoints, homePoints, awayPoints) {
  const payload = { winner: String(winner), updatedAt: serverTimestamp() };
  if (totalPoints !== undefined && totalPoints !== null && totalPoints !== "") {
    payload.totalPoints = Number(totalPoints);
  }
  if (Number.isFinite(homePoints)) payload.homePoints = homePoints;
  if (Number.isFinite(awayPoints)) payload.awayPoints = awayPoints;
  await setDoc(doc(db, "results", gameId), payload, { merge: true });
}
// Sentinel winner value for a canceled/postponed game marked "no contest" -
// truthy (so it counts as resolved for "all games final" / played-count
// checks everywhere) but guaranteed to never equal a real pick (g.home/g.away
// are always actual team name strings), so nobody scores on it. The
// companion push:true flag is what the UI actually keys off of to render
// "Push" instead of a team.
const PUSH_WINNER = "PUSH";
async function markResultAsPush(gameId) {
  await setDoc(doc(db, "results", gameId), { winner: PUSH_WINNER, push: true, updatedAt: serverTimestamp() }, { merge: true });
}
async function getResultsMap(gameIds) {
  const map = {};
  if (!gameIds.length) return map;
  // One getDoc() per game (up to ~40 for a full week) meant this alone was
  // firing off that many individual reads for the SDK to coordinate on every
  // load - a lot of chatter, especially over a slower mobile connection.
  // documentId() `in` queries batch up to 30 ids per request, so a full
  // week's worth collapses into 1-2 queries instead of ~40.
  const CHUNK = 30;
  const chunks = [];
  for (let i = 0; i < gameIds.length; i += CHUNK) chunks.push(gameIds.slice(i, i + CHUNK));
  const resultsCol = collection(db, "results");
  const snaps = await Promise.all(
    chunks.map(chunk => getDocs(query(resultsCol, where(documentId(), "in", chunk))))
  );
  for (const snap of snaps) {
    snap.forEach(d => { map[d.id] = d.data(); });
  }
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

// ---------- Partial-slate submissions ----------
// Any submission (partial or a normal complete one) can keep being edited,
// game by game, right up until each game's own kickoff - editDeadline (the
// earliest kickoff among a week's later day(s)) is what lets that continue
// past the pool-wide picksLocked flip at the very first kickoff of the week.
// A player can separately opt into submitting just the first day's games and
// finishing the rest later (see PicksPage's partialOptIn) - whether such a
// doc still "counts" is always derived from games+picks rather than stored:
// a doc is either complete (scores/counts like any normal submission) or,
// once editDeadline has passed still incomplete, forfeited (excluded
// everywhere, same as never having submitted - no pot credit, no $5 owed).
// Only ever forfeited if it was explicitly opted partial - a normal
// submission is always required to be complete up front, so it never has
// anything to forfeit.
function requiredGameIdsFor(games) {
  const list = Array.isArray(games) ? games : [];
  const needIncludedFlag = list.some(g => Object.prototype.hasOwnProperty.call(g, "included"));
  return (needIncludedFlag ? list.filter(g => !!g.included) : list).map(g => g.id);
}
function isPickDocComplete(games, picksDoc) {
  const list = Array.isArray(games) ? games : [];
  const byId = new Map(list.map(g => [g.id, g]));
  const picksOk = requiredGameIdsFor(games).every(id => {
    const g = byId.get(id);
    const v = picksDoc?.picks?.[id];
    return !!g && (v === g.home || v === g.away);
  });
  if (!picksOk) return false;
  const gd = list.find(g => g && g.gameday);
  if (!gd) return true;
  const tb = picksDoc?.tiebreaker;
  return !!tb && tb.gameId === gd.id && typeof tb.total === "number";
}
function editDeadlineMs(picksDoc) {
  const dl = picksDoc?.editDeadline;
  if (!dl) return null;
  if (typeof dl.toMillis === "function") return dl.toMillis();
  if (typeof dl.seconds === "number") return dl.seconds * 1000;
  const d = new Date(dl);
  return isNaN(d) ? null : d.getTime();
}
function isForfeitedPick(games, picksDoc) {
  if (!picksDoc || picksDoc.partial !== true) return false;
  const ms = editDeadlineMs(picksDoc);
  if (ms == null || Date.now() < ms) return false;
  return !isPickDocComplete(games, picksDoc);
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
  // getPicksForWeek() only needs year/week, not the games list, so there's
  // no reason it has to wait on the results fetches below - running it
  // alongside them instead of after cuts a full extra network round trip
  // off every load.
  const [rFromWeek, rFromGames, picks] = await Promise.all([
    getWeekResultsMap(year, week, g),
    getResultsMap(ids),
    getPicksForWeek(year, week)
  ]);
  const r = { ...(rFromWeek || {}), ...(rFromGames || {}) };

  // A partial-slate submission that's still incomplete past its own deadline
  // is forfeited - excluded from standings entirely, same as a no-show.
  const activePicks = picks.filter(p => !isForfeitedPick(g, p));

  const rows = activePicks.map(p => {
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
      partial: p.partial === true,
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

  // --- Weekly polls (one-off, this week only; results are admin-only for now) ---
  const [pollVoterId] = useState(() => {
    try {
      let id = localStorage.getItem("pollVoterId");
      if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("pollVoterId", id); }
      return id;
    } catch { return "anon-" + Math.random().toString(36).slice(2); }
  });
  const [tfChoice, setTfChoice] = useState(() => { try { return localStorage.getItem("poll_tf_games") || ""; } catch { return ""; } });
  const [gamesPerWeekChoice, setGamesPerWeekChoice] = useState(() => {
    try { return localStorage.getItem("poll_games_per_week_v2") || ""; } catch { return ""; }
  });
  const [pollMsg, setPollMsg] = useState("");
  const [appEnrollChoice, setAppEnrollChoice] = useState(() => { try { return localStorage.getItem("poll_app_enroll") || ""; } catch { return ""; } });

  // Poll answers are only kept locally (state + localStorage) as someone
  // fills out the form - they're not uploaded to Firestore until the actual
  // picks submission goes through (see onSubmitPicks), so a vote is always
  // tied to the name on that submission and never uploaded without one.
  const voteTf = (choice) => {
    setTfChoice(choice);
    try { localStorage.setItem("poll_tf_games", choice); } catch {}
  };

  const voteAppEnroll = (choice) => {
    setAppEnrollChoice(choice);
    try { localStorage.setItem("poll_app_enroll", choice); } catch {}
  };

  // Inline install/notification help shown when someone asks for instructions
  // on the app-enrollment poll question, reusing the same steps as the
  // header's install/notification prompts.
  const onIOS = isIOSDevice();
  const onAndroid = isAndroidDevice();
  const showIOSSteps = onIOS || !onAndroid;
  const showAndroidSteps = onAndroid || !onIOS;
  const androidInstallAvailable = useInstallPromptAvailable();
  const [enrollNotifState, setEnrollNotifState] = useState(
    (typeof Notification !== "undefined" && Notification.permission === "granted") ? "on" : "idle"
  );
  const handleEnrollEnableNotifications = async () => {
    setEnrollNotifState("working");
    try {
      await enablePushNotifications({ isAdmin });
      setEnrollNotifState("on");
    } catch (e) {
      setEnrollNotifState("idle");
      setPollMsg((e && e.message) ? e.message : "Couldn't enable notifications.");
    }
  };

  const voteGamesPerWeek = (choice) => {
    setGamesPerWeekChoice(choice);
    try { localStorage.setItem("poll_games_per_week_v2", choice); } catch {}
  };

  // Optional free-text suggestion - also kept local-only until submit.
  const [featureFeedback, setFeatureFeedback] = useState(() => { try { return localStorage.getItem("poll_feedback_text") || ""; } catch { return ""; } });
  const saveFeedback = () => {
    try { localStorage.setItem("poll_feedback_text", featureFeedback); } catch {}
  };

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
  // Only true once load() below has fetched the correctly-filtered
  // (includedOnly:true) game list. Before that, an earlier effect briefly
  // populates `games` with the unfiltered list while it waits on the live
  // week to resolve, which could flash games that were never actually
  // selected for this week - gated behind LoadingGate until this settles.
  const [gamesLoaded, setGamesLoaded] = useState(false);
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
        const counted = Array.isArray(arr) ? arr.filter(p => !isForfeitedPick(games, p)) : [];
        setPickCount(counted.length);
      } else {
        setPickCount(0);
      }
    } catch {
      setPickCount(0);
    }
  })();
}, [year, week, games]);
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
  // "Share with your friends" - native share sheet where available (mobile),
  // otherwise copy the link to the clipboard.
  const [shareState, setShareState] = useState("idle"); // idle | copied
  const handleShare = async () => {
    const url = window.location.origin + "/";
    try {
      if (navigator.share) {
        await navigator.share({ title: "CFB Pick'em", text: "Join my CFB Pick'em group!", url });
        return;
      }
    } catch (e) {
      return; // user cancelled the share sheet
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 2000);
    } catch (e) {}
  };
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
  const pickGroups = useMemo(() => {
    const groups = groupGamesByDate(displayGames || [], { timeZone: "America/New_York" });
    if (!gameday) return groups;
    // Pull the GameDay game out of its chronological date group and append it
    // as its own trailing group, so it's always the last game shown even when
    // a later game (e.g. Monday night) exists on the slate.
    const gdGroup = groups.find(grp => grp.items.some(g => g.id === gameday.id));
    if (!gdGroup) return groups;
    const withoutGameday = groups
      .map(grp => ({ ...grp, items: grp.items.filter(g => g.id !== gameday.id) }))
      .filter(grp => grp.items.length > 0);
    return [...withoutGameday, { key: gdGroup.key + "__gameday", header: "College GameDay", items: [gameday] }];
  }, [displayGames, gameday]);
  // Earliest included kickoff (for deadline label on Picks)
  const earliestGame = useMemo(() => {
    const arr = (displayGames || [])
      .map(g => ({ g, d: kickoffDate(g) }))
      .filter(x => x.d instanceof Date && !isNaN(x.d));
    arr.sort((a,b) => a.d - b.d);
    return arr[0]?.g || null;
  }, [displayGames]);

  // --- Partial-slate submissions ---
  // Chronological (not GameDay-reordered) date groups, used to define what
  // counts as "the first day's games" (required up front) vs. everything
  // later (deferrable under the partial opt-in below).
  const rawDateGroups = useMemo(
    () => groupGamesByDate(games || [], { timeZone: "America/New_York" }),
    [games]
  );
  const firstGroupIds = useMemo(
    () => new Set((rawDateGroups[0]?.items || []).map(g => g.id)),
    [rawDateGroups]
  );
  const laterGroups = useMemo(() => rawDateGroups.slice(1), [rawDateGroups]);
  const laterGroupEarliestGame = useMemo(() => {
    const arr = laterGroups.flatMap(grp => grp.items)
      .map(g => ({ g, d: kickoffDate(g) }))
      .filter(x => x.d instanceof Date && !isNaN(x.d));
    arr.sort((a, b) => a.d - b.d);
    return arr[0]?.g || null;
  }, [laterGroups]);
  // Re-checked periodically so "already started" locks update live without
  // requiring a page refresh.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  // A game is "started" the moment its own DAY'S first kickoff happens - all
  // of Friday's games lock together at Friday's first kickoff, not each one
  // individually at its own time.
  const gameGroupStartMs = useMemo(() => buildGameGroupStartMap(games), [games]);
  const gameHasStarted = (g) => {
    const ms = gameGroupStartMs.get(g.id);
    return ms != null && ms <= nowTick;
  };
  const firstGroupStartMs = rawDateGroups[0]?.items?.[0] ? gameGroupStartMs.get(rawDateGroups[0].items[0].id) : null;
  const firstGroupStarted = firstGroupStartMs != null && nowTick >= firstGroupStartMs;
  const [partialOptIn, setPartialOptIn] = useState(false);
  // Set from an already-loaded doc (auto-load-by-email or loadByCode) so
  // onSubmitPicks knows whether this edit is still inside its editDeadline,
  // even though the pool-wide picksLocked flag has already flipped true.
  // editDeadline applies to ANY submission with later-group games (not just
  // partial ones) - `partial` here only matters for whether the next save
  // is still allowed to leave later games unpicked without failing
  // validation, and for forfeiture risk.
  const [loadedPartial, setLoadedPartial] = useState(null); // { partial, editDeadline } | null
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
  const [submitting, setSubmitting] = useState(false);
  const loadedEditDeadlineMs = loadedPartial ? editDeadlineMs(loadedPartial) : null;
  const partialEditAllowed = editing
    && loadedEditDeadlineMs != null && nowTick < loadedEditDeadlineMs;
  const partialWindowExpired = editing
    && loadedEditDeadlineMs != null && nowTick >= loadedEditDeadlineMs;

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
        setLoadedPartial({ partial: d.partial === true, editDeadline: d.editDeadline || null });
        setPartialOptIn(d.partial === true);
      } else {
        setPicks({}); setTiebreaker({ gameId: null, total: "" });
        setLoadedPartial(null);
        setPartialOptIn(false);
      }
    }
    setGamesLoaded(true);
  };

  useEffect(() => {
  if (!(hasWeekValue(year) && hasWeekValue(week))) return;
  load();
  /* eslint-disable-next-line */
}, [year, week, email]);

  // One-time season-preferences survey - shown for Week 1 only, not every
  // week. Results already fed into real decisions (e.g. "we'll start picks
  // on Friday night"), so it doesn't need to keep asking.
  const showSeasonSurvey = Number(week) === 1;

    // --- Step 4: validation & submit gating (Pickems Coach) ---
  const validatePicks = (opts = {}) => {
    const errs = {};
    const needIncludedFlag = games.some(g => Object.prototype.hasOwnProperty.call(g, "included"));
    const allRequiredGames = needIncludedFlag ? games.filter(g => !!g.included) : games;
    // Opted into a partial slate: only the first day's games are required
    // right now - the rest can be finished later, before laterGroupEarliestGame.
    const wantsPartial = partialOptIn || loadedPartial?.partial === true;
    const requiredGames = wantsPartial
      ? allRequiredGames.filter(g => firstGroupIds.has(g.id))
      : allRequiredGames;

    if (!String(form.firstName || "").trim()) errs.firstName = "First name is required";
    if (!String(form.lastName  || "").trim()) errs.lastName  = "Last name is required";
    // Blank email used to pass silently through to Firestore (rules never
    // required it either) - it's what My Season joins "your row" against,
    // so a blank one broke that week's stats for that person. Confirmed
    // across 12 real submissions before this check existed.
    const emailTrim = String(form.email || "").trim();
    if (!emailTrim || !emailTrim.includes("@")) errs.email = "A valid email is required";
    if (!String(form.phone     || "").trim()) errs.phone     = "Phone is required";
    if (!String(form.venmo     || "").trim()) errs.venmo     = "Venmo is required";
    if (!form.venmoConfirmed) errs.venmoConfirmed = "Please confirm your Venmo is correct";

    const missingGames = [];
    for (const g of requiredGames) {
      const pick = picks && picks[g.id];
      // A game that's already kicked off can no longer be picked one way or
      // the other - don't hold up submission over it.
      if (!(pick === g.home || pick === g.away) && !gameHasStarted(g)) missingGames.push(g);
    }
    if (missingGames.length) {
      errs.picks = missingGames.length + " game" + (missingGames.length>1?"s":"") + " not selected";
    }

    if (showSeasonSurvey) {
      if (!tfChoice) errs.tfPoll = "Please answer the game-night question";
      if (!gamesPerWeekChoice) errs.gamesPerWeekPoll = "Please answer the games-per-week question";
      if (!appEnrollChoice) errs.appEnrollPoll = "Please answer the app enrollment question";
    }

    const ok = Object.keys(errs).length === 0;
    const parts = [];
    if (errs.firstName) parts.push("first name");
    if (errs.lastName) parts.push("last name");
    if (errs.email) parts.push("a valid email");
    if (errs.phone) parts.push("phone");
    if (errs.venmo) parts.push("venmo");
    if (errs.venmoConfirmed) parts.push("venmo confirmation");
    if (missingGames.length) parts.push(missingGames.length + " game picks");
    if (errs.tfPoll) parts.push("game-night poll answer");
    if (errs.gamesPerWeekPoll) parts.push("games-per-week poll answer");
    if (errs.appEnrollPoll) parts.push("app enrollment poll answer");
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

  const isValid = useMemo(function(){ return validatePicks({ silent: true }).ok; }, [form, picks, games, tfChoice, gamesPerWeekChoice, appEnrollChoice, partialOptIn, loadedPartial, nowTick]);

    // Keep validation errors updated after a submit attempt
  useEffect(() => {
    if (touchedSubmit) {
      const r = validatePicks({ silent: true });
      if (typeof setErrors === "function") setErrors(r.errors);
    }
  }, [form, picks, games, touchedSubmit, partialOptIn, loadedPartial, nowTick]);
// Writes picks straight to Firestore on submit - there used to be an
// intermediate "Confirm Your Picks" review page in between, but since picks
// can already be edited later via the code + last name (see loadByCode
// below), that extra step only added a screen that looked enough like the
// real receipt to leave people unsure whether they'd actually submitted.
// One click now goes straight through to the receipt.
const onSubmitPicks = async function(e){
  e.preventDefault();
  if (picksLocked && !partialEditAllowed) {
    setMsg(partialWindowExpired
      ? (loadedPartial?.partial === true
          ? "This slate's edit window has closed - it's being scored as submitted, with any unfinished games counted as missed."
          : "This slate's edit window has closed.")
      : "Submissions are locked right now.");
    return;
  }
  const result = validatePicks();
  if (!result.ok) {
    setMsg(result.message || "Please complete all required fields and picks.");
    if (result.focus) result.focus();
    return;
  }
  setSubmitting(true);
  setMsg("Saving...");
  try {
    // Reuse the 6-digit code when editing an existing submission; otherwise generate one.
    const nextCode = (editing && typeof code === "string" && /^\d{6}$/.test(code))
      ? code
      : String(Math.floor(100000 + Math.random() * 900000));
    setCode(nextCode);

    const normEmail = (s) => String(s||"").trim().toLowerCase();
    const normPhone = (s) => String(s||"").replace(/[^0-9]/g, "");
    const normVenmo = (s) => String(s||"").trim().toLowerCase().replace(/^@+/, "");

    const id = `${year}_W${week}_${nextCode}`;
    const gd = games.find(x => x && x.gameday);

    const payload = {
      id, year, week, code: nextCode,
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
    // editDeadline lets ANY submission (partial or a normal complete one)
    // keep being edited past the pool-wide lock, up until the later day's
    // games start - set once and carried forward unchanged after that.
    // partial is separate: only set on the opt-in path, since that's what
    // grants leaving later games unpicked for now (and puts the doc at risk
    // of forfeiture if still incomplete once editDeadline passes).
    const wantsPartialSubmit = partialOptIn || loadedPartial?.partial === true;
    if (laterGroupEarliestGame) {
      payload.editDeadline = loadedPartial?.editDeadline
        || Timestamp.fromDate(kickoffDate(laterGroupEarliestGame));
      if (wantsPartialSubmit) payload.partial = true;
    }
    // If this browser has notifications enabled, tag the submission with its
    // push token so reminder notifications can skip devices that already submitted.
    try {
      const pushToken = localStorage.getItem("pushToken");
      if (pushToken) {
        payload.pushToken = pushToken;
        setDoc(doc(db, "pushTokens", pushToken), { name: `${form.firstName || ""} ${form.lastName || ""}`.trim() }, { merge: true }).catch(()=>{});
      }
    } catch (e) {}

    // If GameDay itself falls in a later, deferred group, a partial submitter
    // isn't required to have a tiebreaker guess yet either - same as any
    // other later-group game, it's due when they come back to finish up.
    const wantsPartialSubmit0 = partialOptIn || loadedPartial?.partial === true;
    const gdDeferred = gd && wantsPartialSubmit0 && !firstGroupIds.has(gd.id);
    if (gd) {
      const tbTotal = tiebreaker && tiebreaker.total !== "" ? Number(tiebreaker.total) : NaN;
      if (Number.isNaN(tbTotal)) {
        if (!gdDeferred) { setMsg("Enter total points for the College GameDay tiebreaker."); setSubmitting(false); return; }
      } else {
        payload.tiebreaker = { gameId: gd.id, total: tbTotal };
      }
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
          tx.set(l.ref, { year, week, type: l.type, value: l.value, picksId: id, code: nextCode, createdAt: serverTimestamp() }, { merge: true });
        }
        tx.set(doc(db, "picks", id), payload, { merge: true });
      });
    } catch (e2) {
      const em = String((e2 && e2.message) || e2 || "");
      if (em === "DUPLICATE_LOCK") {
        setMsg("this email/number/venmo is already associated with a submission, if you feel this was reached in error contact zslay@live.com");
        setSubmitting(false);
        return;
      }
      throw e2;
    }

    // Poll answers and the feedback note are only uploaded now, at the
    // moment picks actually go through, tied to the name on this
    // submission - not live as someone clicks through the survey. Best
    // effort: never blocks the actual pick submission if this fails.
    try {
      if (pollVoterId) {
        const nameFields = { firstName: form.firstName || "", lastName: form.lastName || "" };
        const pollAnswers = { tf_games: tfChoice, games_per_week: gamesPerWeekChoice, app_enroll: appEnrollChoice };
        const writes = [];
        for (const pollId of ["tf_games", "games_per_week", "app_enroll"]) {
          const choice = pollAnswers[pollId];
          if (!choice) continue;
          writes.push(setDoc(doc(db, "pollVotes", `${pollId}__${pollVoterId}`), { pollId, choice, ...nameFields, updatedAt: serverTimestamp() }, { merge: true }).catch(()=>{}));
        }
        const feedbackText = (featureFeedback || "").trim();
        if (feedbackText) {
          writes.push(setDoc(doc(db, "feedback", pollVoterId), { text: feedbackText, ...nameFields, updatedAt: serverTimestamp() }, { merge: true }).catch(()=>{}));
        }
        await Promise.all(writes);
      }
    } catch (e3) {}

    try { if (draftKey) localStorage.removeItem(draftKey); } catch (_) {}
    localStorage.setItem("receipt", JSON.stringify({ year, week, code: nextCode, form, picks, tiebreaker: payload.tiebreaker || null }));
    setMsg("");
    setPage("receipt");
    window.history.pushState(null, "", "/receipt");
  } catch (e) {
    setMsg("Save failed: " + (e && e.message ? e.message : e));
  } finally {
    setSubmitting(false);
  }
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
        email: d.email || "",
        phone: d.phone || "", venmo: d.venmo || ""
      }));
      setPicks(d.picks || {});
        setTiebreaker(d.tiebreaker ? { gameId: d.tiebreaker.gameId || null, total: String(d.tiebreaker.total ?? "") } : { gameId: null, total: "" });
      setCode(c);
      setEditing(true);
      setLoadedPartial({ partial: d.partial === true, editDeadline: d.editDeadline || null });
      setPartialOptIn(d.partial === true);
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
      setMsg(`Checking picks for ${Y} / W${W}…`);

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
<LoadingGate ready={gamesLoaded}>
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
      <div style={{ marginTop:4, marginBottom:12, textAlign:"center" }}>
        <button
          type="button"
          onClick={handleShare}
          className={shareState === "copied" ? undefined : "share-cta"}
          style={{ background:"#6aa2ff", color:"#07152b", border:"none", borderRadius:999, padding:"5px 12px", height:"auto", width:"auto", fontSize:11.5, fontWeight:700, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:5 }}
        >
          <span aria-hidden="true">📤</span>
          {shareState === "copied" ? "Link copied!" : "Click here to share with your friends!"}
        </button>
      </div>
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
            setLoadedPartial(null);
            setPartialOptIn(false);
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
  {picksLocked && partialEditAllowed && (
    <StatusBadge tone="primary" style={{ marginLeft:2 }}>⏳ You can still edit later games</StatusBadge>
  )}
</div>
{picksLocked && partialEditAllowed && (
  <div style={{ marginTop:-4, marginBottom:10, fontSize:12.5, color:"#9aa4c7" }}>
    {rawDateGroups[0]?.header || "The first day's"} games are locked, but you can still edit games below before{" "}
    {laterGroupEarliestGame ? kickoffLabel(laterGroupEarliestGame, { timeZone: "America/New_York" }) : "the next kickoff"}.
  </div>
)}
{picksLocked && partialWindowExpired && (
  <div style={{ display:"flex", gap:8, alignItems:"flex-start", marginTop:-4, marginBottom:10, padding:"8px 12px", borderRadius:8, background:"rgba(240,180,41,0.12)", border:"1px solid rgba(240,180,41,0.4)", fontSize:13, color:"#f0d9a8" }}>
    <span aria-hidden="true">⏰</span>
    <span>
      {loadedPartial?.partial === true
        ? "This slate's edit window has closed and it's being scored as submitted — any remaining games are counted as missed."
        : "This slate's edit window has closed."}
    </span>
  </div>
)}
{picksLocked && (
  <button
    type="button"
    onClick={() => { window.history.pushState(null, "", "/leader"); setPage("leader"); }}
    style={{
      display: "block", width: "100%", marginTop: 8, marginBottom: 10,
      padding: "12px 16px", borderRadius: 10, border: "none",
      background: "#2a4fb8", color: "#fff", fontWeight: 700, fontSize: 14,
      cursor: "pointer"
    }}
  >
    Click Leaderboard to see Live Scores
  </button>
)}
<form onSubmit={onSubmitPicks} style={{ marginTop: 12 }}>
          <Row style={{ marginBottom: 14 }}>
  <Field style={{ flex: 1 }} label="First name"><input style={{ ...inputStyle, width: "100%" }} name="firstName" value={form.firstName} onChange={e=>setForm({...form, firstName:e.target.value})} onBlur={autofillFromHistory} required/></Field>
  <Field style={{ flex: 1 }} label="Last name"><input style={{ ...inputStyle, width: "100%" }} name="lastName" value={form.lastName} onChange={e=>setForm({...form, lastName:e.target.value})} onBlur={autofillFromHistory} required/></Field>
</Row>
          {isMobile ? (
            <>
              <Row style={{ marginBottom: 14 }}>
                <Field style={{ flex: 1 }} label="Email">
                  <input style={{ ...inputStyle, width: "100%" }} type="email" name="email" value={form.email || ""} onChange={e=>setForm({...form, email:e.target.value})} placeholder="you@example.com" required/>
                </Field>
              </Row>
              <Row style={{ marginBottom: 14 }}>
                <Field style={{ flex: 1 }} label="Phone">
                  <input style={{ ...inputStyle, width: "100%" }} name="phone" value={form.phone} onChange={e=>setForm({...form, phone:e.target.value})} placeholder="555-555-5555"/>
                </Field>
                <Field style={{ flex: 1 }} label="Venmo">
                  <input style={{ ...inputStyle, width: "100%" }} name="venmo" value={form.venmo} onChange={e=>setForm({...form, venmo:e.target.value})} placeholder="@username"/>
                </Field>
              </Row>
            </>
          ) : (
            <Row style={{ marginBottom: 14 }}>
              <Field style={{ flex: 1 }} label="Email">
                <input style={{ ...inputStyle, width: "100%" }} type="email" name="email" value={form.email || ""} onChange={e=>setForm({...form, email:e.target.value})} placeholder="you@example.com" required/>
              </Field>
              <Field style={{ flex: 1 }} label="Phone">
                <input style={{ ...inputStyle, width: "100%" }} name="phone" value={form.phone} onChange={e=>setForm({...form, phone:e.target.value})} placeholder="555-555-5555"/>
              </Field>
              <Field style={{ flex: 1 }} label="Venmo">
                <input style={{ ...inputStyle, width: "100%" }} name="venmo" value={form.venmo} onChange={e=>setForm({...form, venmo:e.target.value})} placeholder="@username"/>
              </Field>
            </Row>
          )}

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
          {laterGroups.length > 0 && !firstGroupStarted && !partialWindowExpired && (
            <div style={{ margin:"4px 0 18px", padding:"4px 14px", borderRadius:14, background:"linear-gradient(180deg,#131c33,#0f1729)", border:"1px solid #26335a" }}>
              <AdminToggleRow
                label="⏳ Submit a partial slate"
                description={
                  <>
                    Just lock in {rawDateGroups[0]?.header || "the first day's"} games now — come back with your code to finish
                    the rest before {laterGroupEarliestGame ? kickoffLabel(laterGroupEarliestGame, { timeZone: "America/New_York" }) : "the next kickoff"}.
                  </>
                }
                checked={partialOptIn}
                onChange={setPartialOptIn}
                divider={false}
              />
              {partialOptIn && (
                <div style={{ display:"flex", gap:8, alignItems:"flex-start", margin:"0 0 12px", padding:"8px 10px", borderRadius:10, background:"rgba(240,89,107,0.12)", border:"1px solid rgba(240,89,107,0.4)" }}>
                  <span aria-hidden="true">⚠️</span>
                  <span style={{ fontSize:12.5, color:"#f5b6be", lineHeight:1.4 }}>
                    If it isn't finished in time, this week's entry won't count — and you won't owe the $5.
                  </span>
                </div>
              )}
            </div>
          )}
          <div style={{ margintop:-4, display:"flex", flexDirection:"column", alignItems:"center" }}>
            {pickGroups.map(grp => (
              <section key={grp.key} style={{ margin: "24px 0 6px", width: "100%" }}>
                <div style={{ fontWeight:700, fontSize:16, opacity:.85, margin:"12px 0 8px" }}>{grp.header}</div>
                {grp.items.map(g => { const started = gameHasStarted(g); return (

              <div key={g.id} data-game-id={g.id} style={{ position:"relative",  border:"1px dashed #1f2a44", padding:12, borderRadius:12, margin:"10px auto", maxWidth: 720, width:"100%", marginBottom: 0, opacity: started ? 0.6 : 1 }}>
          {g.gameday && (
  <>
    <img src="/logos/collegegameday.png" alt="College GameDay" style={{ position:"absolute", top:6, left:6, width:badgeSize, height:badgeSize, opacity:0.95, pointerEvents:"none" }} />
    <img src="/logos/collegegameday.png" alt="" aria-hidden="true" style={{ position:"absolute", top:badgeTop, right:badgeRight, width:badgeSize, height:badgeSize, opacity:0.95, pointerEvents:"none" }} />
  </>
)}
          {started && (
            <StatusBadge tone="warning" style={{ position:"absolute", top:8, right:8 }}>
              🔒 Locked
            </StatusBadge>
          )}
                <div style={{ order:1, flex:1 }} />
                                    <Row role="radiogroup" style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap: 16, justifyItems:"center", alignItems:"center", justifyContent:"center" }} aria-label={'Pick winner for ' + teamLabel(g.away, g.awayRank) + ' at ' + teamLabel(g.home, g.homeRank)}>
                    <label role="radio" aria-checked={(picks[g.id]===g.away)} aria-disabled={started} onClick={() => { if (!started) setPicks({ ...picks, [g.id]: g.away }); }} tabIndex={0} onKeyDown={(e)=>{ if(!started && (e.key==="Enter"||e.key===" ")){ e.preventDefault(); setPicks({...picks, [g.id]: g.away}); }}} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, justifySelf:"end", cursor: started ? "not-allowed" : "pointer" }}>
                      <input type="radio" disabled={started} style={{position:"absolute",opacity:0,width:0,height:0}} name={g.id} checked={picks[g.id]===g.away} onChange={()=>{ if (!started) setPicks({...picks, [g.id]: g.away}); }}/>
                      <div className="logoBox" style={{ width:96, height:96, outline: (picks[g.id]===g.away) ? "4px solid #3b82f6" : undefined, outlineOffset:2, borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center" }}><TeamLogo school={g.away} size={96}/></div>
                      <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div>
                    </label><div aria-hidden="true" style={{ gridColumn:"2", alignSelf:"center", justifySelf:"center", fontWeight:800, color:"#fff", fontSize:28, lineHeight:"1", margin:"0 6px", pointerEvents:"none" }}>@</div>

                    <label role="radio" aria-checked={(picks[g.id]===g.home)} aria-disabled={started} onClick={() => { if (!started) setPicks({ ...picks, [g.id]: g.home }); }} tabIndex={0} onKeyDown={(e)=>{ if(!started && (e.key==="Enter"||e.key===" ")){ e.preventDefault(); setPicks({...picks, [g.id]: g.home}); }}} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, justifySelf:"start", cursor: started ? "not-allowed" : "pointer" }}>
                      <input type="radio" disabled={started} style={{position:"absolute",opacity:0,width:0,height:0}} name={g.id} checked={picks[g.id]===g.home} onChange={()=>{ if (!started) setPicks({...picks, [g.id]: g.home}); }}/>
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

                ); })}
              </section>
            ))}
          </div>

          {showSeasonSurvey && (
          <div style={{ marginTop:24, paddingTop:20, borderTop:"1px solid #1f2a44" }}>
            <h3 style={{ margin:"0 0 16px" }}>Quick Survey for this Season</h3>

            <div style={{ marginBottom:20 }}>
              <div style={{ fontWeight:600, marginBottom:2 }}>When should the first game of the week be? <span style={{ color:"#f0596b" }}>*</span></div>
              <div style={{ fontSize:12, opacity:.7, marginBottom:8 }}>Earlier games mean an earlier weekly deadline.</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {["Thursday", "Friday", "Saturday", "No preference"].map(opt => (
                  <label key={opt} style={{ display:"flex", flexDirection:"row", alignItems:"center", gap:8, cursor:"pointer", fontSize:14 }}>
                    <input type="radio" name="poll_tf_games" checked={tfChoice === opt} onChange={() => voteTf(opt)} />
                    {opt}
                  </label>
                ))}
              </div>
              {touchedSubmit && !tfChoice && <div style={{ color:"#f0596b", fontSize:12, marginTop:6 }}>Please pick an answer.</div>}
            </div>

            <div style={{ marginBottom:20 }}>
              <div style={{ fontWeight:600, marginBottom:8 }}>How many games do you want to pick from each week? (For reference this week has 40 games) <span style={{ color:"#f0596b" }}>*</span></div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {["Significantly fewer (around 20 games)", "Fewer (around 30 games)", "Keep the same", "More (around 50 games)", "Significantly more (around 60 games)"].map(opt => (
                  <label key={opt} style={{ display:"flex", flexDirection:"row", alignItems:"center", gap:8, cursor:"pointer", fontSize:14 }}>
                    <input type="radio" name="poll_games_per_week" checked={gamesPerWeekChoice === opt} onChange={() => voteGamesPerWeek(opt)} />
                    {opt}
                  </label>
                ))}
              </div>
              {touchedSubmit && !gamesPerWeekChoice && <div style={{ color:"#f0596b", fontSize:12, marginTop:6 }}>Please pick an answer.</div>}
            </div>

            <div>
              <div style={{ fontWeight:600, marginBottom:8 }}>Did you add the Pick 'Ems to your home screen on your phone and enroll in notifications? <span style={{ color:"#f0596b" }}>*</span></div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {["Yes", "No, but I would like instructions on how to"].map(opt => (
                  <label key={opt} style={{ display:"flex", flexDirection:"row", alignItems:"center", gap:8, cursor:"pointer", fontSize:14 }}>
                    <input type="radio" name="poll_app_enroll" checked={appEnrollChoice === opt} onChange={() => voteAppEnroll(opt)} />
                    {opt}
                  </label>
                ))}
              </div>
              {touchedSubmit && !appEnrollChoice && <div style={{ color:"#f0596b", fontSize:12, marginTop:6 }}>Please pick an answer.</div>}
              {appEnrollChoice === "No, but I would like instructions on how to" && (
                <div style={{ marginTop:12, padding:"12px 14px", borderRadius:10, background:"#0e1730", border:"1px solid #1f2a44" }}>
                  {showIOSSteps && (
                    <div style={{ marginBottom: showAndroidSteps ? 14 : 0 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:"#eef2ff", marginBottom:6 }}>On iPhone (must be on Safari)</div>
                      <ol style={{ margin:0, paddingLeft:20, fontSize:13, color:"#cfd8f0", lineHeight:1.6 }}>
                        <li>Tap the <b>Share</b> icon (square with an arrow up, or <b>&#8226;&#8226;&#8226;</b> on newer iOS)</li>
                        <li>Tap <b>View More</b> if you don't see &ldquo;Add to Home Screen&rdquo; right away</li>
                        <li>Tap <b>Add to Home Screen</b>, then <b>Add</b></li>
                        <li>Open the app from your home screen, then tap <b>Enable Notifications</b> below</li>
                      </ol>
                    </div>
                  )}
                  {showAndroidSteps && (
                    <div>
                      <div style={{ fontSize:13, fontWeight:700, color:"#eef2ff", marginBottom:6 }}>On Android (Chrome)</div>
                      {androidInstallAvailable ? (
                        <button
                          type="button"
                          onClick={async ()=>{ await triggerAndroidInstallPrompt(); }}
                          style={{ background:"#1a6b46", color:"#fff", border:0, padding:"8px 14px", borderRadius:10, fontWeight:600, cursor:"pointer", marginBottom:6 }}
                        >
                          Click Here to Install
                        </button>
                      ) : (
                        <ol style={{ margin:0, paddingLeft:20, fontSize:13, color:"#cfd8f0", lineHeight:1.6 }}>
                          <li>Tap the menu icon (&#8942;) in the top right</li>
                          <li>Tap <b>Add to Home screen</b> (or <b>Install app</b>)</li>
                          <li>Tap <b>Add</b> / <b>Install</b> to confirm, then tap <b>Enable Notifications</b> below</li>
                        </ol>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleEnrollEnableNotifications}
                    disabled={enrollNotifState === "working" || enrollNotifState === "on"}
                    style={{ marginTop:10, background: enrollNotifState === "on" ? "#1a6b46" : "#6aa2ff", color: enrollNotifState === "on" ? "#fff" : "#07152b", border:0, padding:"9px 14px", borderRadius:10, fontWeight:600, cursor:"pointer" }}
                  >
                    {enrollNotifState === "working" ? "Enabling…" : enrollNotifState === "on" ? "Notifications enabled" : "Enable Notifications"}
                  </button>
                </div>
              )}
            </div>

            {pollMsg && <div style={{ marginTop:10, fontSize:12, color:"#9aa4c7" }}>{pollMsg}</div>}

            <div style={{ marginTop:20 }}>
              <div style={{ fontWeight:600, marginBottom:2 }}>Provide additional thoughts below (Optional)</div>
              <div style={{ fontSize:12, opacity:.7, marginBottom:8 }}>Expand on your answers above, give feedback on the app, pitch a new idea, etc.</div>
              <textarea
                value={featureFeedback}
                onChange={(e) => setFeatureFeedback(e.target.value)}
                onBlur={saveFeedback}
                placeholder="Answer here"
                style={{ ...inputStyle, width:"100%", minHeight:70, fontFamily:"inherit", resize:"vertical" }}
              />
            </div>
          </div>
          )}

          <Row style={{ justifyContent: "flex-end", marginTop: 12 }}><div style={{ marginRight:"auto", display:"flex", alignItems:"center", gap:12 }}><input type="checkbox" aria-label="venmo" checked={form.venmoConfirmed} onChange={e=>setForm({...form, venmoConfirmed:e.target.checked})} /><span style={{ fontSize:12 }}>By checking this box, I confirm I have sent $5 to @ZackSlay on Venmo</span></div>
            <div style={{color:"#c0392b",fontSize:12,margin:"8px 0"}} role="alert">{touchedSubmit && !isValid && (errors.picks || "Please complete all required fields and picks.")}</div>
<button type="submit" disabled={!isValid || (picksLocked && !partialEditAllowed) || submitting}>{submitting ? "Saving…" : "Submit / Update Picks"}</button>
          <div style={{ color:'#9aa4c7', margintop:-4, fontSize:13 }}>{msg}</div>
          </Row>
        </form>

      {showRules && (
  <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999, padding:16, boxSizing:"border-box"}}>
    <div style={{ background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16, padding:16, maxWidth:720, width:"90%", maxHeight:"85vh", boxShadow:"0 10px 24px rgba(0,0,0,.35)", display:"flex", flexDirection:"column" }}>
      <h3 style={{ marginTop:0, marginBottom:8, flexShrink:0 }}>Rules</h3>
      <div style={{ lineHeight: 1.6, overflowY:"auto", minHeight:0, fontSize:13 }}>
  <h4 style={{ marginTop: 0 }}>Welcome to the 2026 Season!</h4>
  <ul style={{ paddingLeft: "1.25rem", margin: 0 }}>
    <li><strong>Weekly Picks:</strong> Each week you'll pick winners from a curated slate — marquee matchups, AP Top 25 games, all Florida FBS teams, plus a few randoms to keep it interesting.</li>
    <li><strong>Tiebreaker:</strong> Closest to the actual total combined points (over or under) wins. If still tied, the pot is split.</li>
    <li><strong>One Entry:</strong> Only one form per person per week. Need to change a pick before the deadline? Click <em>Edit here</em> and enter your code.</li>
    <li><strong>Canceled/Postponed Games:</strong> If a listed game is canceled or postponed and not completed within the scoring window, it's a <em>push</em> (no points awarded).</li>
    <li><strong>Deadline:</strong> New submissions lock at <strong>kickoff of the first game</strong> on the slate. After that, each day's games lock
      together at that day's own first kickoff — so with your code, you can keep editing a later day's games right up until that day's first kickoff
      {laterGroupEarliestGame ? <> (this week, that's <strong>{kickoffLabel(laterGroupEarliestGame, { timeZone: "America/New_York" })}</strong> for the last day's games)</> : null}.
      Can't finish everything before the first kickoff? Check the Partial Slate box to submit what you have now and fill in the rest later with your code —
      if it's still unfinished once its deadline passes, that entry doesn't count for the pot and you won't owe the $5.
    </li>
    <li><strong>Payment:</strong> Venmo <strong>$5</strong> each week to <strong>@ZackSlay</strong> (Zack Slay).</li>
    <li><strong>Payout:</strong> <strong>Winner-take-all.</strong> The highest score wins the entire pot. If there's a tie on points, the tiebreaker decides; if still tied, the pot is split.</li>
  </ul>
</div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:16, flexShrink:0 }}>
        <button type="button" onClick={()=>setShowRules(false)}>Close</button>
      </div>
    </div>
  </div>
)}
</Card>
</LoadingGate>
    </Container>
  );
}

// -------- LEADERBOARD (sticky first two columns, logos in headers + winners row) --------
function LeaderboardPage({ user, isAdmin, setPage }) {  // DEV: CFBD diagnostics — verify token retrieval/log (no CFBD API calls)
  const isMobile = useIsMobile();

  // One-time mobile-only popup pointing people at the chat panel's
  // notification opt-in (see ChatThreadBody/enableChatNotifications) -
  // desktop already has chat visible/obvious enough not to need this nudge.
  // Skips itself (and marks dismissed) if this device already opted in some
  // other way (e.g. toggled it on directly in the chat panel) before ever
  // seeing this popup.
  const [showChatNotifPopup, setShowChatNotifPopup] = useState(() => {
    if (typeof window === "undefined" || !isMobile) return false;
    try { return localStorage.getItem("chatNotifPopupDismissedForever") !== "1"; } catch (e) { return false; }
  });
  useEffect(() => {
    if (!showChatNotifPopup) return;
    let token = null;
    try { token = localStorage.getItem("pushToken"); } catch (e) {}
    if (!token) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, "pushTokens", token));
        if ((snap.data() || {}).chatNotifsEnabled === true) {
          try { localStorage.setItem("chatNotifPopupDismissedForever", "1"); } catch (e) {}
          setShowChatNotifPopup(false);
        }
      } catch (e) {}
    })();
    /* eslint-disable-next-line */
  }, []);
  const [chatNotifPopupBusy, setChatNotifPopupBusy] = useState(false);
  function dismissChatNotifPopup() {
    try { localStorage.setItem("chatNotifPopupDismissedForever", "1"); } catch (e) {}
    setShowChatNotifPopup(false);
  }
  async function handleEnableChatNotifFromPopup() {
    setChatNotifPopupBusy(true);
    try {
      await enableChatNotifications(isAdmin);
      dismissChatNotifPopup();
    } catch (e) {
      alert((e && e.message) ? e.message : "Couldn't enable notifications.");
    } finally {
      setChatNotifPopupBusy(false);
    }
  }
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
  const { map: sbMap, isPaused: sbPaused, refresh: sbRefresh } = useScoreboard(sbOpts);

  const [publicSbMap, setPublicSbMap] = useState(new Map());
  // Last time config/liveMap was written (by the CFBD cron or an admin's
  // relay) - epoch ms, so everyone (not just admins) can show "last updated".
  const [liveUpdatedAt, setLiveUpdatedAt] = useState(null);
// Everyone subscribes to a published scoreboard map for public/live viewing
useEffect(() => {
  try {
    const unsub = onSnapshot(doc(db, "config", "liveMap"), (s) => {
      try {
        const d = s?.data() || {};
        const obj = (d && d.map) ? d.map : {};
        // Convert plain object -> Map
        setPublicSbMap(new Map(Object.entries(obj || {})));
        setLiveUpdatedAt(Number.isFinite(+d.updatedAt) ? +d.updatedAt : null);
      } catch {}
    });
    return () => { try { unsub(); } catch {} };
  } catch {}
}, []);

// Publishing config/liveMap is handled entirely server-side now (the
// publishLiveMap cron), so "Last updated" ticks on one clean, predictable
// schedule instead of racing whichever admin happens to have this page open.
  const scoreMap = sbMap;

  // Public liveMap (read-only): used when user is NOT admin. Reads the same
  // config/liveMap.map the server cron writes every ~1 minute - this used to
  // read a separate "items" field that only an admin's own open tab ever
  // populated, so non-admins only saw live scores when an admin happened to
  // be viewing the page. Reading the server's map directly removes that
  // dependency, and its keys already match the away__home format the
  // Scorebug lookup below expects, so no conversion is needed.
  const [publicLiveMap, setPublicLiveMap] = React.useState(null);

  // Which upstream source the server's publishLiveMap cron actually used on
  // its last write (ESPN primary / CFBD fallback / stale) - unlike
  // publicLiveMap above, admins read this too, since it's about the
  // server's poll, not the admin's own direct CFBD tab.
  const [liveMapMeta, setLiveMapMeta] = React.useState(null);
  React.useEffect(() => {
    try {
      const ref = doc(db, "config", "liveMap");
      const unsub = onSnapshot(ref, (snap) => {
        const data = snap.data?.() ?? snap.data();
        setLiveMapMeta(data ? {
          source: data.source || null,
          espnGameCount: (typeof data.espnGameCount === "number") ? data.espnGameCount : null,
          updatedAt: data.updatedAt ?? null
        } : null);
      });
      return () => unsub && unsub();
    } catch (e) {
      if (import.meta?.env?.DEV) console.warn("[liveMap] source listener failed", e);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) return; // admins use direct CFBD map
    try {
      const ref = doc(db, "config", "liveMap");
      const unsub = onSnapshot(ref, (snap) => {
        const data = snap.data?.() ?? snap.data();
        const obj = (data && data.map) ? data.map : {};
        const m = new Map(Object.entries(obj));
        setPublicLiveMap(m);
        if (import.meta?.env?.DEV) console.debug("[liveMap] received items:", m.size); try { window._liveMap = m; window._uiScoreMap = m; } catch {}
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

  // Non-admins now read config/liveMap.map directly (see the publicLiveMap
  // effect above), which the server cron keeps fresh on its own - so there's
  // no need for an admin's browser to separately republish its own poll
  // results here anymore.
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
  // Set once a viewer manually picks a week (see the "Previous weeks"
  // select below) so this effect - and the config/live listener elsewhere
  // in this component - never clobbers that choice with the live week once
  // their own (possibly slow, e.g. mobile) fetch of config/live finally
  // resolves. Without this, picking Week 1 could still get silently
  // reverted back to the live week a moment later if that fetch was still
  // in flight when the pick happened.
  const userChangedWeekRef = useRef(false);
  useEffect(() => {
    if (!initFromLiveRef.current && !userChangedWeekRef.current && live?.year && live?.week) {
      setYear(live.year);
      setWeek(live.week);
      initFromLiveRef.current = true;
    }
  }, [live]);
  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
const pot = useMemo(() => (pickCount * 5), [pickCount]);

// Same out-of-order-response risk as loadAll()'s loadAllSeqRef - without a
// guard, switching weeks quickly could let a stale pick count from the
// previous week overwrite the correct one for the new week.
const pickCountSeqRef = useRef(0);
useEffect(() => {
  const seq = ++pickCountSeqRef.current;
  (async () => {
    try {
      if (hasWeekValue(year) && hasWeekValue(week)) {
        const arr = await getPicksForWeek(year, week);
        if (seq !== pickCountSeqRef.current) return;
        const counted = Array.isArray(arr) ? arr.filter(p => !isForfeitedPick(games, p)) : [];
        setPickCount(counted.length);
      } else {
        setPickCount(0);
      }
    } catch {
      if (seq !== pickCountSeqRef.current) return;
      setPickCount(0);
    }
  })();
}, [year, week, games]);
  // A separate INITIAL_LIVE_AUTOLOAD effect used to live here, with its own
  // independent config/live subscription that set year/week AND called
  // setGames() directly - duplicating what initFromLiveRef above already
  // does, except bypassing the boardLoaded/LoadingGate on the way (since it
  // wrote `games` straight from its own fetch, not through loadAll()) and
  // racing the user's own week choice if this fetch was still in flight
  // when they picked one - the "select Week 1, briefly see the live week,
  // then Week 1 shows" bug reported on mobile. initFromLiveRef + the
  // [year, week] effect that calls loadAll() already cover the "default to
  // the live week on first load" case correctly, so this was pure
  // duplication and safe to remove outright.

  // Put College GameDay at the end of the list (Leaderboard)
  const gameday = (Array.isArray(games) ? games.find(x => x && x.gameday) : null);
  const displayGames = gameday ? [...games.filter(x => x && x.id !== gameday.id), gameday] : games;
  // A whole day's games reveal together the moment that day's first game
  // kicks off - e.g. all Friday picks become visible at Friday's first
  // kickoff, not staggered by each game's own time.
  const gameGroupStartMap = useMemo(() => buildGameGroupStartMap(games), [games]);
  const [results, setResults] = useState({});
  // Auto-winner detection now runs server-side in the publishLiveMap Cloud
  // Function, so it works regardless of whether an admin has this page open.
  const [players, setPlayers] = useState([]);
  // Only true once loadAll() below has computed real standings for the
  // currently selected week - gated behind LoadingGate until this settles.
  const [boardLoaded, setBoardLoaded] = useState(false);

  // Computed once and dropped into both of this page's return branches below
  // (the locked/minimal view and the full board) rather than duplicated -
  // they're two separate early returns, not one shared render path. Gated on
  // boardLoaded so it never stacks on top of the loading state.
  const chatNotifPopupEl = showChatNotifPopup && boardLoaded && (
    <div style={{
      position:"fixed", inset:0, zIndex:100, background:"rgba(4,7,15,.72)",
      display:"flex", alignItems:"center", justifyContent:"center", padding:16
    }}>
      <div style={{
        background:"#121a2b", border:"1px solid #1f2a44", borderRadius:16,
        padding:"22px 24px", maxWidth:360, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.5)"
      }}>
        <div style={{ fontSize:28, marginBottom:8 }}>💬</div>
        <h3 style={{ margin:"0 0 8px", fontSize:17, color:"#eef2ff" }}>Get notified when people chat?</h3>
        <p style={{ margin:"0 0 16px", fontSize:14, color:"#9aa4c7", lineHeight:1.5 }}>
          Turn on push notifications for new chat messages - not game results or reminders. You can turn this off anytime from the chat panel.
        </p>
        <div style={{ display:"flex", gap:10 }}>
          <button
            onClick={handleEnableChatNotifFromPopup}
            disabled={chatNotifPopupBusy}
            style={{ flex:1, background:"#6aa2ff", color:"#07152b", border:0, padding:"10px 14px", borderRadius:10, fontWeight:600, cursor:"pointer" }}
          >
            {chatNotifPopupBusy ? "Enabling…" : "Enable"}
          </button>
          <button
            onClick={dismissChatNotifPopup}
            style={{ background:"transparent", color:"#9aa4c7", border:"1px solid #2a3655", padding:"10px 14px", borderRadius:10, cursor:"pointer" }}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
  // Bumped on every loadAll() call; lets a resolved fetch check whether a
  // newer one has since started so it can discard itself instead of
  // overwriting fresher data with stale results that just happened to
  // resolve later (see loadAll() below).
  const loadAllSeqRef = useRef(0);
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


  // Years dropdown: which seasons have anything to show (current + any
  // imported history), and any special label a week goes by (e.g. bowls/
  // conference-champs weeks) instead of a plain "Week N" - written once by
  // the historical-season import, read here on mount.
  const [seasonYears, setSeasonYears] = useState([]);
  const [weekLabels, setWeekLabels] = useState({});
  useEffect(() => {
    (async () => {
      try {
        const s = await getDoc(doc(db, "config", "seasons"));
        const d = s.exists() ? s.data() : {};
        setSeasonYears(Array.isArray(d.years) ? d.years : []);
        setWeekLabels(d.weekLabels || {});
      } catch (err) {
        console.error("config/seasons load failed", err);
      }
    })();
  }, []);
  // Always include the live year even if config/seasons (written once by the
  // historical import) hasn't been updated for it - so a brand new season
  // shows up in the selector without needing to remember to touch that doc.
  const yearsAvailable = useMemo(() => {
    const set = new Set(seasonYears.map(Number));
    if (hasWeekValue(live?.year)) set.add(Number(live.year));
    return [...set].sort((a, b) => b - a);
  }, [seasonYears, live]);

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
}, [year]);

  const weekLabelFor = (y, w) => weekLabels[`${y}_${w}`] || `Week ${w}`;

  // Switching years mirrors the same anti-flicker/anti-stale-overwrite
  // protections already in place for week switches (see the "Previous
  // weeks" selects' onChange) - reset boardLoaded and mark the change
  // synchronously in the same handler as setYear, then land on the new
  // year's most recent week rather than whatever week number happened to
  // be selected before (which may not even exist in the new year).
  const handleYearChange = async (newYear) => {
    setBoardLoaded(false);
    userChangedWeekRef.current = true;
    setYear(newYear);
    try {
      const q = query(collection(db, "games"), where("year", "==", Number(newYear)));
      const snap = await getDocs(q);
      const uniq = new Set();
      snap.forEach(d => { const w = d.data()?.week; if (Number.isFinite(+w)) uniq.add(Number(w)); });
      const weeks = [...uniq].sort((a, b) => a - b);
      setWeek(weeks.length ? weeks[weeks.length - 1] : 1);
    } catch (err) {
      console.error("handleYearChange: failed to load weeks for new year", err);
      setWeek(1);
    }
  };

  const [loadCode, setLoadCode] = useState("");
  const [loadLastName, setLoadLastName] = useState("");
  const [editing, setEditing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);


  // Compact widths (tweak here as you like)
  const NAME_COL_W = 130;
  const POINTS_COL_W = 60;

  
const GAME_COL_W = 140;
const loadAll = async () => {
  if (!(hasWeekValue(year) && hasWeekValue(week))) { return; }
  // Reset before fetching, not just on first load - otherwise switching
  // weeks left the previous week's games/standings on screen (LoadingGate
  // only hides content while boardLoaded is false) until the new data
  // came back, so picking a different week briefly flashed the old one.
  setBoardLoaded(false);
  setMsg("Loading...");
  // Guard against out-of-order responses: switching weeks quickly can leave
  // two of these in flight at once (one for the week just left, one for the
  // new pick), and network timing doesn't guarantee the older one resolves
  // first. Without this, an older fetch landing after the newer one silently
  // overwrote the correct games/standings with the previous week's - the
  // header still said the right week (that's set separately, synchronously)
  // but the table underneath didn't match it.
  const seq = ++loadAllSeqRef.current;
  const startedAt = Date.now();
  // Hold the Loading screen up for at least this long regardless of how
  // fast the fetch comes back, as a buffer on top of the seq check above -
  // extra insurance against any other still-unknown source of a stale
  // render landing right at the edge of a week switch.
  const MIN_LOADING_MS = 500;
  try {
    const { games: g, results: r, rows, playedGames } = await computeWeekStandings(year, week);
    if (seq !== loadAllSeqRef.current) return; // a newer load has since started - discard this stale response
    const remaining = MIN_LOADING_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    if (seq !== loadAllSeqRef.current) return; // re-check - a newer load could have started during that wait
    setGames(g);
    setResults(r);
    setPlayers(rows);
    setMsg(`Week ${week}  -  Included games: ${g.length}  -  Finished: ${playedGames}`);
    setBoardLoaded(true);
  } catch (e) {
    if (seq !== loadAllSeqRef.current) return;
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
  // These two refs back scheduleScrollSync(), used further down by the
  // sticky-column scroll-sync logic - they have to be declared here,
  // unconditionally, rather than down where they're used, because the
  // locked-leaderboard branch just below this returns early. Hooks (useRef
  // included) must run in the same order on every render of this component;
  // declaring them after a conditional early return meant the locked and
  // unlocked render paths called a different number of hooks, which crashed
  // React with "Rendered fewer hooks than expected" (visible as the
  // Leaderboard going blank for any locked-out viewer).
  const scrollSyncRafRef = useRef(null);
  const scrollSyncSourceRef = useRef(null);

  if (lbLocked && !isAdmin && Number(year) === Number(live?.year) && Number(week) === Number(live?.week)) {
      // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}…`);

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
        {chatNotifPopupEl}
        <Card>
          <Row style={{ justifyContent:"space-between", alignItems:"flex-start" }}>
            <h2 style={{ margin: 0 }}>CFB Pick'Ems {weekLabelFor(year, week)}</h2>
          </Row>
          <Row style={{ gap: 8 }}>
{yearsAvailable.length > 1 && (
  <Field label="Season">
    <select value={(year ?? '')} onChange={e => handleYearChange(Number(e.target.value))} style={inputStyle}>
      {yearsAvailable.map(y => (
        <option key={y} value={y}>{y}</option>
      ))}
    </select>
  </Field>
)}
<Field label="Previous weeks">
  <select value={(week ?? '')} onChange={e => { setBoardLoaded(false); userChangedWeekRef.current = true; setWeek(Number(e.target.value)); }} style={inputStyle}>
    {(weeksForYear.length ? weeksForYear : Array.from({ length: 21 }, (_, i) => i)).map(w => (
      <option key={w} value={w}>{weekLabelFor(year, w)}</option>
    ))}
  </select>
</Field>
          </Row>
          <div style={{ marginTop: 8, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700 }}>Leaderboard locked for Week {week}</div>
            <div>Leaderboard will be activated when the first game kicks off</div>
            <div>To submit or edit picks, visit the Picks page</div>
          </div>
        </Card>
      </Container>
    );
  }

  // The admin-only-picks toggle only needs to gate the live week - once a
  // week is in the past, everyone should be able to see how people picked.
  const isLiveWeek = Number(year) === Number(live?.year) && Number(week) === Number(live?.week);

  // transform:translateZ(0) (plus backface-visibility/WebkitBackfaceVisibility)
  // forces the sticky cell onto its own GPU compositing layer. Without it,
  // iOS Safari recalculates each sticky cell's position against the rest of
  // the page's layout on every scroll frame, which visibly wobbles/lags by
  // a pixel or two during a scroll on an actual phone - a well-known iOS
  // WebKit quirk with position:sticky inside a horizontally-scrolling
  // container, not something that shows up in a desktop browser.
  const stickyGpuFix = { transform: "translateZ(0)", WebkitBackfaceVisibility: "hidden", backfaceVisibility: "hidden" };
  const sticky1 = (extra = {}) => ({
  position: "sticky",
  left: 0,
  zIndex: 5,
  background: "#0b1220",
  width: NAME_COL_W,
  minWidth: NAME_COL_W,
  borderRight: "none",
  boxShadow: "inset -1px 0 0 0 #1f2a44",
  // Without this, a double-tap on mobile is ambiguous with the browser's
  // native double-tap-to-zoom gesture and doesn't reliably fire onDoubleClick
  // (used to jump the games table back to the start).
  touchAction: "manipulation",
  ...stickyGpuFix,
  ...extra
});
  // sticky2 (a second independently-sticky column at left:NAME_COL_W) used
  // to exist for the Points column - removed because two separately-sticky
  // elements at different left offsets in the same row is exactly the
  // pattern that wobbled on real iOS Safari, while the header/pot-box's
  // single merged sticky area (colSpan=2, one sticky element) never did.
  // Every row now merges Name+Points into one sticky1() cell instead,
  // matching the header's structure.

  const cell = { lineHeight:"1.15", border:"1px solid #1f2a44", padding:"4px 6px", whiteSpace:"nowrap", fontSize:11 };
  const headerCell = { ...cell, textAlign:"center", paddingTop: 12, paddingBottom: 12, lineHeight: 1.25, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontSize: "clamp(10px, 0.95vw, 12px)" };

  // Live-status lookup for a game, matching the Scorebug's own resolution
  // logic exactly (winners-map first for past weeks, then the merged live
  // map with a substring-match fallback for the current week) - shared so
  // the "Jump to live game" button and the Scorebug row never disagree
  // about what's currently live.
  const computeLiveForGame = (g) => {
    const r = results?.[g?.id] || null;
    const fromWinners = r ? {
      status: r.status || (r.winner ? "final" : null),
      period: (typeof r.period === "number" ? r.period : (r.status === "final" ? 4 : null)),
      clock: null,
      homePoints: (typeof r.homePoints === "number" ? r.homePoints : null),
      awayPoints: (typeof r.awayPoints === "number" ? r.awayPoints : null),
      possession: null
    } : null;

    const isCurrent = Number(year) === Number(live?.year) && Number(week) === Number(live?.week);
    if (!isCurrent) return fromWinners;

    const norm = (s) => {
      if (!s) return "";
      let t = String(s).toLowerCase();
      t = t.replace(/\ba\s*&\s*m\b|\ba\s*and\s*m\b/gi, "a&m");
      t = t.normalize("NFKD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ");
      return t.replace(/\s+/g,"");
    };
    const awayKey = norm(g?.away);
    const homeKey = norm(g?.home);
    const key = awayKey + "__" + homeKey;
    const uiMap = (() => {
      try { if (sbMap && typeof sbMap.size === "number" && sbMap.size > 0) return sbMap; } catch {}
      try { if (publicLiveMap && typeof publicLiveMap.size === "number" && publicLiveMap.size > 0) return publicLiveMap; } catch {}
      try { if (publicSbMap && typeof publicSbMap.size === "number" && publicSbMap.size > 0) return publicSbMap; } catch {}
      return new Map();
    })();
    let liveItem = (uiMap && uiMap.get) ? uiMap.get(key) : null;
    if (!liveItem && uiMap && uiMap.size) {
      try {
        const keys = Array.from(uiMap.keys());
        // The live map's keys are built from ESPN/CFBD's full team names
        // (school + mascot, e.g. "kansasjayhawks"), while our own game docs
        // only store the school name ("kansas") - so an exact key match
        // often misses and we need a looser fallback. A plain indexOf()
        // substring check is unsafe here though: e.g. "kansas" is a
        // substring of "arkansas", so a Missouri @ Kansas game could
        // wrongly match a stale "Arkansas-Pine Bluff @ Missouri" entry.
        // Requiring the school name to be a PREFIX of its half of the key
        // (school names always lead the mascot, never the other way round)
        // avoids that false positive while still tolerating the mascot
        // suffix mismatch.
        const guess = keys.find(k => {
          const sep = k.indexOf("__");
          if (sep === -1) return false;
          const aPart = k.slice(0, sep);
          const hPart = k.slice(sep + 2);
          return aPart.startsWith(awayKey) && hPart.startsWith(homeKey);
        });
        if (guess) liveItem = uiMap.get(guess);
      } catch {}
    }
    return liveItem || fromWinners;
  };

  // Scrolls the games table to the first in-progress game's column; if
  // nothing is currently live, scrolls back to the start instead.
  const scrollToLiveGame = () => {
    const grid = document.getElementById("lbGrid");
    if (!grid) return;
    // The mirrored top scrollbar's spacer only gets widened to match
    // #lbGrid's real scrollWidth inside #lbGrid's own onScroll handler,
    // *after* it syncs scrollLeft onto the top bar. A big instant jump
    // (rather than an incremental drag) races that: the top bar's scrollLeft
    // gets clamped against its still-narrow spacer, and that clamped value
    // echoes straight back and resets #lbGrid to 0. Widening the spacer here
    // first avoids the clamp entirely.
    const spacer = document.getElementById("lbTopSpacer");
    if (spacer) spacer.style.width = grid.scrollWidth + "px";
    const firstLive = (displayGames || []).find(g => {
      const s = String(computeLiveForGame(g)?.status || "").toLowerCase();
      return s === "in_progress" || s === "delayed";
    });
    // behavior:"auto" (instant), not "smooth" - the mirrored top scrollbar
    // re-syncs (and re-measures its spacer) on every single scroll event, and
    // a "smooth" animation fires dozens of those over its ~300-500ms, so that
    // sync fought the animation frame-by-frame - looked like barely-moving,
    // glitchy scrolling on mobile (confirmed on both Safari and Chrome, so a
    // JS timing issue, not a rendering-engine quirk). An instant jump is a
    // single scroll event, so there's nothing to fight.
    if (!firstLive) { grid.scrollTo({ left: 0, behavior: "auto" }); return; }
    const escapedId = (window.CSS && CSS.escape) ? CSS.escape(String(firstLive.id)) : String(firstLive.id);
    const cell = grid.querySelector(`[data-game-id="${escapedId}"]`);
    if (cell) {
      // Not scrollIntoView({inline:"start"}) - that aligns the column flush
      // against the scroll container's true left edge, which is exactly
      // where the sticky Name/Points columns sit on top of the content, so
      // the "live" column landed hidden behind them. Scroll past their
      // width instead, so the target column clears them and lands first.
      //
      // Mobile is the exception: a game column (140px) is wider than the
      // sliver of screen left over once the sticky columns eat their share
      // of a narrow phone viewport (~101px), so flush-left there always ran
      // the column off the right edge of the screen. Centering it in the
      // available space can't make a too-wide column fully fit either, but
      // it splits the unavoidable overflow evenly instead of dumping all of
      // it on one edge - worth the tradeoff on mobile only, since desktop
      // has plenty of room and flush-left (showing it first, plus whatever
      // else fits after it) reads better there.
      const gridRect = grid.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const cellLeftWithinContent = grid.scrollLeft + (cellRect.left - gridRect.left);
      const stickyWidth = NAME_COL_W + POINTS_COL_W;
      let targetScrollLeft;
      if (isMobile) {
        const availableWidth = grid.clientWidth - stickyWidth;
        targetScrollLeft = cellLeftWithinContent + (cellRect.width / 2) - stickyWidth - (availableWidth / 2);
      } else {
        targetScrollLeft = cellLeftWithinContent - stickyWidth;
      }
      grid.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: "auto" });
    } else {
      grid.scrollTo({ left: 0, behavior: "auto" });
    }
  };

  // Double-tapping the sticky Name/Points columns scrolls back to the
  // first game - the return trip to pair with "Jump to Live". Ignores a
  // double-click landing on a button inside that area (e.g. "Jump to
  // Live" itself), so mashing that button doesn't also reset the scroll.
  const scrollToStart = (e) => {
    if (e?.target?.closest && e.target.closest("button")) return;
    const grid = document.getElementById("lbGrid");
    if (grid) grid.scrollTo({ left: 0, behavior: "auto" });
  };

  // Keeps #lbGrid and its mirrored top scrollbar (#lbTopScroll) in sync.
  // Previously did the DOM writes directly in the onScroll handler, once
  // per raw scroll event - fine for a mouse wheel, but a real touch-drag on
  // a phone fires far more of those, so that work was competing with the
  // browser's own sticky-position compositing on every frame and showing up
  // as a very slight wobble in the sticky Name/Points columns. Coalescing
  // into at most one sync per animation frame (reading the live scrollLeft
  // at fire time, not whatever it was when the event was scheduled) cuts
  // that main-thread work down without changing the sync's behavior.
  const scheduleScrollSync = (source) => {
    scrollSyncSourceRef.current = source;
    if (scrollSyncRafRef.current) return;
    scrollSyncRafRef.current = requestAnimationFrame(() => {
      scrollSyncRafRef.current = null;
      const grid = document.getElementById("lbGrid");
      const top = document.getElementById("lbTopScroll");
      if (!grid || !top) return;
      if (scrollSyncSourceRef.current === "top") {
        if (grid.scrollLeft !== top.scrollLeft) grid.scrollLeft = top.scrollLeft;
      } else {
        // Widen the spacer *before* setting scrollLeft on it - #lbTopScroll
        // can only scroll as far as its own content is wide, so setting
        // scrollLeft first (while the spacer is still whatever width it was
        // last render) gets silently clamped back down.
        const spacer = document.getElementById("lbTopSpacer");
        if (spacer) {
          const w = grid.scrollWidth;
          if (spacer.style.width !== (w + "px")) spacer.style.width = w + "px";
        }
        if (top.scrollLeft !== grid.scrollLeft) top.scrollLeft = grid.scrollLeft;
      }
    });
  };


  const pickCellBase = { ...cell, textAlign:"center", width: GAME_COL_W, minWidth: GAME_COL_W, maxWidth: GAME_COL_W };
  const pickCellStyle = (gameId, choice) => { const base = { ...cell, textAlign:"center", width: 140, minWidth: 140 };
  const r = results[gameId];
  if (r?.push) return base; // no contest - nobody's pick counts for or against them
  const w = r?.winner;
  if (!w || !choice) return base;
  if (choice === w) return { ...base, background: "#00ff00", color: "#111" };
  return { ...base, background: "#ea9999", color: "#111" };
};

  // Winner cell with tiny logo
  const winnerCell = (g) => {
    const r = results[g.id];
    if (r?.push) return <span style={{ fontStyle:"italic", opacity:.8 }}>Push &mdash; No Points</span>;
    const w = r?.winner;
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
      setMsg(`Checking picks for ${Y} / W${W}…`);

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
      {chatNotifPopupEl}
      <LoadingGate ready={boardLoaded}>
      <Card>
        <Row style={{ justifyContent:"space-between", alignItems:"flex-end" }}>
          <h2 style={{ margin: 0 }}>CFB Pick'Ems {weekLabelFor(year, week)}</h2>
          <Row style={{ gap:8, alignItems:"flex-end" }}>
            {yearsAvailable.length > 1 && (
              <Field label="Season">
                <select value={(year ?? '')} onChange={e => handleYearChange(Number(e.target.value))} style={inputStyle}>
                  {yearsAvailable.map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Previous weeks">
              <select
                value={(week ?? '')}
                onChange={e => {
                  // Drop boardLoaded here too, not just inside loadAll() -
                  // otherwise this render (new week, but still last week's
                  // games/standings since the data fetch hasn't started yet)
                  // paints for a frame before the effect kicks off loadAll(),
                  // which is the flicker of the old week that was reported.
                  // Batching both updates in the same handler means the very
                  // next paint goes straight to the Loading screen.
                  setBoardLoaded(false);
                  // Also record that the viewer picked a week themselves, so
                  // the live-week default effect above can't clobber it if
                  // its own (possibly slow, e.g. mobile) config/live fetch
                  // is still in flight - see userChangedWeekRef.
                  userChangedWeekRef.current = true;
                  setWeek(Number(e.target.value));
                }}
                style={inputStyle}
              >
                {(weeksForYear.length ? weeksForYear : Array.from({ length: 21 }, (_, i) => i)).map(w => (
                  <option key={w} value={w}>{weekLabelFor(year, w)}</option>
                ))}
              </select>
            </Field>
          </Row>
        </Row>
        {isMobile && (
          <div style={{ fontSize:11, color:"#9aa4c7", margin:"6px 2px 0", textAlign:"center" }}>
            &harr; Swipe the table to see more games
          </div>
        )}
        <Row style={{ justifyContent:"space-between", alignItems:"flex-end" }}>


                    <div style={{ order:1, flex:1 }} /><div id="lbTopScroll" style={{  overflowX:"auto", height:10, marginBottom:0, width:"100%"  }} onMouseEnter={(e) => { const b = document.getElementById("lbGrid"); const s = document.getElementById("lbTopSpacer"); if (b && s) { const w = b.scrollWidth; if (s.style.width !== (w + "px")) s.style.width = (w + "px"); } }} onScroll={() => scheduleScrollSync("top")}>
  <div id="lbTopSpacer" style={{ height:1 }} />
</div>
<div id="lbGrid" style={{ marginTop:0, overflowX:"auto", border:"1px solid #1f2a44", borderRadius:12, WebkitOverflowScrolling:"touch" }}
     onScroll={() => scheduleScrollSync("grid")}>
{isAdmin && (
  <div className="scoreboard-admin-strip" /* SCOREBOARD ADMIN STRIP v1 */
       style={{ display:"flex", gap:12, alignItems:"center", flexWrap:"wrap", fontSize:12, margin:"8px 0",
                padding:"6px 10px", borderRadius:8, background:"rgba(16,20,28,.6)", color:"#fff",
                /* Pinned to the left edge (like the Name/Score columns below) so it stays
                   visible instead of scrolling away with the game columns on mobile. */
                position:"sticky", left:0, width:"max-content", maxWidth:"100%" }}>
    <span style={{opacity:.8}}>Scoreboard:</span>
    <strong>{(() => { const m = String(sbSource||"none").toLowerCase(); return m === "fixture" ? "Demo" : m === "cfbd" ? "Live" : "Off"; })()}</strong>
    <span style={{opacity:.8}}>Status:</span>
    <span>{(sbSource === "none" ? "Paused" : (sbPaused ? "Paused" : "Running"))}</span>
    <span style={{opacity:.8, marginLeft:12}}>Source:</span>
    <strong
      title={liveMapMeta?.updatedAt ? `Last server poll: ${new Date(liveMapMeta.updatedAt).toLocaleTimeString()}${liveMapMeta.espnGameCount != null ? ` · ESPN games seen: ${liveMapMeta.espnGameCount}` : ""}` : "No live-score poll data yet"}
      style={{ color: (liveMapMeta?.source === "espn") ? "#2ecc71" : (liveMapMeta?.source === "espn+cfbd") ? "#f0b429" : (liveMapMeta?.source === "cfbd-only") ? "#f0b429" : (liveMapMeta?.source === "stale") ? "#e74c3c" : "inherit" }}
    >
      {(() => {
        const s = liveMapMeta?.source;
        if (s === "espn") return "ESPN";
        if (s === "espn+cfbd") return "ESPN + CFBD (partial)";
        if (s === "cfbd-only") return "CFBD only";
        if (s === "stale") return "Stale";
        return "—";
      })()}
    </strong>
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
          {!lbPicksPublic && !isAdmin && isLiveWeek && (
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
                <th rowSpan={2} colSpan={2} onDoubleClick={scrollToStart} style={{ ...headerCell, ...sticky1(), width: NAME_COL_W + POINTS_COL_W, minWidth: NAME_COL_W + POINTS_COL_W, padding:"10px 10px", fontSize:11, lineHeight:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", verticalAlign:"middle" }}>
                  <div style={{ fontSize:"0.95rem", fontWeight:600, color:"#9aa4c7" }}>
                    Last updated:
                  </div>
                  <div style={{ fontSize:"1.3rem", fontWeight:800, color:"#cfd8f0" }}>
                    {(sbSource === "cfbd" && liveUpdatedAt)
                      ? new Intl.DateTimeFormat("en-US", { hour:"numeric", minute:"2-digit", hour12:true, timeZone:"America/New_York" }).format(new Date(liveUpdatedAt))
                      : "—"}
                  </div>
                  <button
                    type="button"
                    onClick={scrollToLiveGame}
                    title="Scroll the table to the first game currently in progress"
                    style={{ marginTop:4, padding:"3px 7px", borderRadius:6, border:"1px solid rgba(255,255,255,.25)", background:"transparent", color:"#fff", fontSize:10, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}
                  >
                    ⚡ Jump to Live Scores
                  </button>
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
    <td colSpan={2} onDoubleClick={scrollToStart} style={{ ...cell, ...sticky1(), width: NAME_COL_W + POINTS_COL_W, minWidth: NAME_COL_W + POINTS_COL_W, padding:"10px 10px" }}>
      {(!potHidden || isAdmin) && (<>
        <div style={{ fontSize:"1.1rem", fontWeight:600 }}>
          This Week&apos;s Pot{potHidden ? " (hidden)" : ""}:
        </div>
        <div style={{ fontSize:"1.9rem", fontWeight:800, lineHeight:1.3 }}>
          ${pot.toLocaleString()} 💰
        </div>
      </>)}
    </td>
    {displayGames.map(g => (
      <td key={"sb-" + g.id} style={{ ...cell, textAlign: "center" }}>
        <Scorebug
            awayId={g.away}
            homeId={g.home}
            kickoffLabel={kickoffLabel(g, { timeZone: "America/New_York" })}
            live={computeLiveForGame(g)}
          />
      </td>
    ))}
  </tr>
)}
              <tr>
                <td colSpan={2} onDoubleClick={scrollToStart} style={{ ...cell, ...sticky1({ width: NAME_COL_W + POINTS_COL_W, minWidth: NAME_COL_W + POINTS_COL_W, fontStyle:"italic", padding:0 }) }}>
                  <div style={{ display:"flex", alignItems:"stretch", height:"100%" }}>
                    <span style={{ flex:"1 1 auto", minWidth:0, padding:"4px 6px", display:"flex", alignItems:"center", gap:8, color:"#fff", fontWeight:700 }}>
                      <span>Completed Games</span>
                      <span style={{ fontStyle:"normal", fontSize:"1.4em", lineHeight:0, display:"inline-flex", alignItems:"center" }}>&rarr;</span>
                    </span>
                    <span style={{ width:POINTS_COL_W, minWidth:POINTS_COL_W, boxSizing:"border-box", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:600, fontStyle:"normal", borderLeft:"2px solid #1f2a44" }}>{playedCount}</span>
                  </div>
                </td>
                {displayGames.map(g => (

                  <td key={g.id} data-game-id={g.id} style={{ ...winnerCellStyleFn(results, cell, g), width: 140, minwidth: 140, fontStyle:"italic", fontSize: fitFontByLen(String(results[g.id]?.winner||"").length) }}>{winnerCell(g)}</td>
                
                ))}{gameday ? (<td key="tb_win" style={{ ...cell, textAlign:"center", fontStyle:"italic", width: 140, minwidth: 140 }}></td>) : null}
              </tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr key={p.id || p.code || p.email || p.name}>
                  <td colSpan={2} onDoubleClick={scrollToStart} style={{ ...cell, ...sticky1({ width: NAME_COL_W + POINTS_COL_W, minWidth: NAME_COL_W + POINTS_COL_W, padding:0 }) }}>
                    <div style={{ display:"flex", alignItems:"stretch", height:"100%" }}>
                      <span style={{ flex:"1 1 auto", minWidth:0, display:"flex", alignItems:"center", padding:"4px 6px" }}>
                        <span>
                          {p.isWinner && <span title={p.winNote || "Winner"} style={{ marginRight: 6 }}>🏆</span>}
                          {p.name}
                          {p.winNote && <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.75, marginTop: 2 }}>{p.winNote}</div>}
                        </span>
                      </span>
                      <span style={{ width:POINTS_COL_W, minWidth:POINTS_COL_W, boxSizing:"border-box", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, borderLeft:"2px solid #1f2a44" }}>{p.points}</span>
                    </div>
                  </td>
                  {displayGames.map(g => {
                    const canSeePicks = lbPicksPublic || isAdmin || !isLiveWeek;
                    const choice = p.picks?.[g.id];
                    // Even once the board is public, a whole day's picks stay
                    // hidden until that day's first kickoff happens (all
                    // Friday games reveal together at Friday's first kickoff,
                    // all Saturday games at Saturday's) - otherwise anyone
                    // still able to edit a later day's games (with their
                    // code) could see the field's picks for it before
                    // locking theirs in. Admins and non-live (past) weeks
                    // always see everything.
                    const groupStartMs = gameGroupStartMap.get(g.id);
                    const gameStarted = groupStartMs != null && groupStartMs <= Date.now();
                    const revealed = canSeePicks && (isAdmin || !isLiveWeek || gameStarted);
                    const label = !revealed ? "🔒" :
                      choice === g.home ? teamLabel(g.home, g.homeRank) :
                      choice === g.away ? teamLabel(g.away, g.awayRank) :
                      (choice || "-");
                    return (
                      <td key={g.id} data-game-id={g.id} style={{ ...pickCellStyle(g.id, revealed ? choice : null), width: 140, minwidth: 140 }}><div style={{display:"flex",justifyContent:"center"}}>{label}</div></td>
                    );
                  })}
                {gameday ? (
  <td key={"tb_"+(p.email||p.name||p.code||p.id)}
      style={{ ...cell, textAlign:"center", width: 140, minwidth: 140 }}>
    {(lbPicksPublic || isAdmin || !isLiveWeek) ? (p.tb ?? (p.tiebreaker?.total ?? p.tiebreaker ?? p.tieBreaker ?? p.tiebreak ?? p.tb ?? "")) : "🔒"}
  </td>
) : null}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Row>

</Card>
      </LoadingGate>
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

// Maps each game's id to the earliest kickoff among every game in its own
// calendar-date group (America/New_York) - e.g. every Friday game maps to
// Friday's own first kickoff, every Saturday game to Saturday's first
// kickoff. Used to lock/reveal a whole day's games together rather than
// each game individually by its own kickoff - "all Friday games lock the
// moment the first Friday game kicks off," not staggered by each game's
// own time. Shared by PicksPage (per-game edit lock) and LeaderboardPage
// (per-game reveal).
function buildGameGroupStartMap(games) {
  const groups = groupGamesByDate(Array.isArray(games) ? games : [], { timeZone: "America/New_York" });
  const map = new Map();
  for (const grp of groups) {
    const times = grp.items
      .map(g => kickoffDate(g))
      .filter(d => d instanceof Date && !isNaN(d))
      .map(d => d.getTime());
    const earliest = times.length ? Math.min(...times) : null;
    for (const g of grp.items) map.set(g.id, earliest);
  }
  return map;
}

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

/* === Weekly chat === */

// Builds the "known participant" roster used by chat's email-verification
// step, keeping every email ever seen per person (not collapsed to one) so
// a typed email can be checked against anything that person has ever
// submitted picks with. Uses the same buildRoster identity resolution as
// Player Profiles/Who Hasn't Submitted/My Season, so a rename or merge made
// there shows up in the chat name picker too - the display name is the
// player's edited name when they've been claimed, or the same "most
// recently submitted" name buildRoster shows everywhere else.
async function buildChatRoster() {
  const [picksSnap, playersSnap] = await Promise.all([
    getDocs(collection(db, "picks")),
    getDocs(collection(db, "players")),
  ]);
  const allPicks = []; picksSnap.forEach(d => allPicks.push(d.data()));
  const players = []; playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));

  const rosterData = buildRoster(allPicks, players);
  const roster = [];
  for (const row of rosterData.rows) {
    const displayName = `${row.firstName || ""} ${row.lastName || ""}`.trim();
    if (!displayName) continue;
    const emails = new Set();
    for (const p of docsForRosterRow(rosterData, row)) {
      const email = String(p.email || "").trim().toLowerCase();
      if (email) emails.add(email);
    }
    if (row.email) emails.add(String(row.email).trim().toLowerCase());
    roster.push({ displayName, emails });
  }
  roster.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return roster;
}

// First-run identity setup for a device with no known name yet (no linked
// push-token name). Picking a name from the roster and matching its email
// marks the device "verified"; typing an unrecognized name (a brand-new
// participant) still works, just without the verified badge. Either way,
// once chatDevices/{deviceId} is created the device is stuck with that name
// - see firestore.rules - so this only ever runs once per device.
function ChatIdentitySetup({ deviceId, onDone }) {
  const isMobile = useIsMobile();
  const [roster, setRoster] = useState(null);
  useEffect(() => {
    let cancelled = false;
    buildChatRoster().then(r => { if (!cancelled) setRoster(r); }).catch(() => { if (!cancelled) setRoster([]); });
    return () => { cancelled = true; };
  }, []);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [newPersonMode, setNewPersonMode] = useState(false);

  const matched = useMemo(() => {
    if (!roster) return null;
    const nl = name.trim().toLowerCase();
    if (!nl) return null;
    return roster.find(r => r.displayName.toLowerCase() === nl) || null;
  }, [roster, name]);

  const claim = async (finalName, verified) => {
    setSaving(true);
    setError("");
    try {
      const payload = { name: finalName, verified: !!verified, linkedFromPushToken: false, createdAt: serverTimestamp() };
      await setDoc(doc(db, "chatDevices", deviceId), payload);
      onDone(payload);
    } catch (e) {
      setError(e?.message || "Couldn't save - try again.");
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    const nm = name.trim();
    if (!nm) { setError("Enter a name."); return; }
    if (newPersonMode || !matched) { await claim(nm, false); return; }
    const el = email.trim().toLowerCase();
    if (!el) { setError("Enter the email you used for picks to verify it's you."); return; }
    if (matched.emails.has(el)) {
      await claim(matched.displayName, true);
    } else {
      setError(`That email doesn't match what's on file for ${matched.displayName}. Double-check it, or use "This isn't me" below.`);
    }
  };

  return (
    <>
      <div style={{ fontSize: 13, color: "#9aa4c7", marginBottom: 10 }}>
        Pick your name, then verify it's you with the email you've used for picks. Once set, this device can't post under a different name.
      </div>
      <Field label="Your name">
        <input
          style={{ ...inputStyle, fontSize: 16 }}
          list="chat-roster-names"
          value={name}
          onChange={e => { setName(e.target.value); setError(""); setNewPersonMode(false); }}
          placeholder="Start typing your name…"
          autoFocus={!isMobile}
        />
        <datalist id="chat-roster-names">
          {(roster || []).map(r => <option key={r.displayName} value={r.displayName} />)}
        </datalist>
      </Field>
      {matched && !newPersonMode && (
        <Field label="Email used for picks">
          <input
            style={{ ...inputStyle, fontSize: 16 }}
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(""); }}
            placeholder="you@example.com"
          />
        </Field>
      )}
      {error && <div style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <Row>
        <button style={adminBtn("primary")} disabled={saving || !name.trim()} onClick={submit}>
          {saving ? "Saving…" : "Join chat"}
        </button>
        {matched && !newPersonMode && (
          <button style={adminBtn("neutral")} onClick={() => setNewPersonMode(true)}>This isn't me</button>
        )}
      </Row>
    </>
  );
}

// Deterministic per-name color/initials so the same person always renders
// the same avatar across a session, without storing a color anywhere.
function chatAvatarColor(name) {
  let hash = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 55%, 42%)`;
}
function chatInitials(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}
function chatTimeLabel(ts) {
  const d = ts?.toDate ? ts.toDate() : null;
  return d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "😮", "😢"];

// Downscales/recompresses a chosen photo before upload - a raw phone photo
// can be 5-10MB+, which is slow to upload and wasteful to store for
// something shown at bubble size in a chat thread. imageOrientation:
// "from-image" bakes in EXIF rotation so the canvas output looks right
// without needing to read/apply EXIF tags manually.
async function compressImageForChat(file, maxDim = 1600, quality = 0.82) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    bitmap = await createImageBitmap(file);
  }
  let { width, height } = bitmap;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("Could not process that image.");
  return blob;
}

// Chat is one continuous thread, not scoped per week - this fixed key is
// the subcollection parent doc id everywhere (client and functions/index.js
// server-side banners) instead of `${year}_${week}`.
const CHAT_THREAD_KEY = "general";

// Shared by the chat panel's own toggle (ChatThreadBody) and the one-time
// mobile popup on the Leaderboard (LeaderboardPage) - registers this device
// for push (permission prompt + token, if it doesn't already have one) and
// tags the resulting token as opted into chat notifications. Returns the
// token so the caller can keep it around (e.g. to subscribe to its doc).
async function enableChatNotifications(isAdmin) {
  let token = null;
  try { token = localStorage.getItem("pushToken"); } catch (e) {}
  if (!token) token = await enablePushNotifications({ isAdmin });
  await setDoc(doc(db, "pushTokens", token), { chatNotifsEnabled: true }, { merge: true });
  return token;
}

function ChatThreadBody({ deviceId, identity, isAdmin, fillHeight }) {
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);

  // Opt-in push notifications for new chat messages - available to anyone
  // in the pool, deliberately separate from the admin-controlled reminder
  // notifications (which stay opt-out by default) and never fired for
  // system banners (see sendChatNotification in functions/index.js, gated
  // on chatNotifsEnabled living on this device's own pushTokens doc). If
  // this device has never enabled push at all, turning this on runs through
  // the same enablePushNotifications flow used elsewhere (permission prompt
  // + token registration) before tagging that new token as opted in.
  const [pushToken, setPushToken] = useState(() => {
    try { return localStorage.getItem("pushToken"); } catch { return null; }
  });
  const [chatNotifsEnabled, setChatNotifsEnabled] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  useEffect(() => {
    if (!pushToken) { setChatNotifsEnabled(false); return; }
    const unsub = onSnapshot(doc(db, "pushTokens", pushToken), s => {
      setChatNotifsEnabled(!!(s.data() || {}).chatNotifsEnabled);
    });
    return () => unsub();
  }, [pushToken]);
  const toggleChatNotifs = async (next) => {
    setNotifBusy(true);
    try {
      if (next) {
        const token = await enableChatNotifications(isAdmin);
        setPushToken(token);
      } else if (pushToken) {
        await setDoc(doc(db, "pushTokens", pushToken), { chatNotifsEnabled: false }, { merge: true });
      }
    } catch (e) {
      alert(e?.message || "Couldn't update notification settings.");
    } finally {
      setNotifBusy(false);
    }
  };

  useEffect(() => {
    const q = query(collection(db, "chatMessages", CHAT_THREAD_KEY, "messages"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, snap => setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "nearest" }); }, [messages.length]);

  // Consecutive messages from the same sender are grouped into one visual
  // "run" - only the first bubble gets the name+avatar, only the last gets
  // the timestamp and the tucked-in tail corner, same as a real chat app.
  // A system banner (posted server-side by a Cloud Function when an
  // automation fires - picks locking, a game going final, etc; see
  // postChatBanner in functions/index.js) always stands alone, never grouped
  // into a run with the real messages next to it.
  // "Mine" (and grouping consecutive bubbles together) is keyed by name, not
  // deviceId - the same locked name can legitimately post from more than one
  // device (phone + computer), and those should still read as "me" and
  // group together, not show up as if a different person sent them.
  const grouped = useMemo(() => messages.map((m, i) => ({
    ...m,
    mine: m.name === identity.name,
    isFirstInRun: i === 0 || messages[i - 1].name !== m.name || messages[i - 1].system || m.system,
    isLastInRun: i === messages.length - 1 || messages[i + 1].name !== m.name || messages[i + 1].system || m.system,
  })), [messages, identity.name]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await addDoc(collection(db, "chatMessages", CHAT_THREAD_KEY, "messages"), {
        deviceId, name: identity.name, verified: !!identity.verified, text: t, createdAt: serverTimestamp(),
      });
      setText("");
    } catch (e) {
      alert(e?.message || "Couldn't send - try again.");
    } finally {
      setSending(false);
    }
  };

  const pickImage = () => fileInputRef.current?.click();

  const sendImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Please choose an image file."); return; }
    setUploadingImage(true);
    try {
      const blob = await compressImageForChat(file);
      const path = `chatImages/${deviceId}_${Date.now()}.jpg`;
      const objRef = storageRef(storage, path);
      await uploadBytes(objRef, blob, { contentType: "image/jpeg" });
      const url = await getDownloadURL(objRef);
      await addDoc(collection(db, "chatMessages", CHAT_THREAD_KEY, "messages"), {
        deviceId, name: identity.name, verified: !!identity.verified,
        imageUrl: url, storagePath: path, createdAt: serverTimestamp(),
      });
    } catch (err) {
      alert(err?.message || "Couldn't send that photo - try again.");
    } finally {
      setUploadingImage(false);
    }
  };

  const remove = async (id) => {
    if (!confirm("Delete this message?")) return;
    try {
      const msg = messages.find(mm => mm.id === id);
      await deleteDoc(doc(db, "chatMessages", CHAT_THREAD_KEY, "messages", id));
      if (msg?.storagePath) deleteObject(storageRef(storage, msg.storagePath)).catch(() => {});
    } catch (e) { alert(e?.message || "Couldn't delete."); }
  };

  // Reactions key off name (not deviceId), same reasoning as "mine" above -
  // reacting from your phone should show as already-reacted on your
  // computer too. Uses arrayUnion/arrayRemove (not a read-modify-write) so
  // two people reacting to the same message at the same time can't clobber
  // each other.
  const [openReactionPicker, setOpenReactionPicker] = useState(null);
  const [showCustomEmojiInput, setShowCustomEmojiInput] = useState(false);
  const [customEmojiText, setCustomEmojiText] = useState("");
  const closePicker = () => { setOpenReactionPicker(null); setShowCustomEmojiInput(false); setCustomEmojiText(""); };
  // Signal-style split: the 🙂+ button + quick picker below is how you add
  // your own reaction (tap an emoji); tapping the badge that sits on the
  // message itself only ever shows who reacted - it never toggles anything,
  // so there's no ambiguity between "I want to see who reacted" and "I want
  // to react/un-react". Removing your own reaction happens from inside that
  // same breakdown view instead.
  const [reactionDetailMsgId, setReactionDetailMsgId] = useState(null);
  const toggleReaction = async (msgId, emoji) => {
    const e = String(emoji || "").trim();
    if (!e) return;
    const msg = messages.find(mm => mm.id === msgId);
    const already = (msg?.reactions?.[e] || []).includes(identity.name);
    closePicker();
    try {
      await updateDoc(doc(db, "chatMessages", CHAT_THREAD_KEY, "messages", msgId), {
        [`reactions.${e}`]: already ? arrayRemove(identity.name) : arrayUnion(identity.name),
      });
    } catch (err) {
      alert(err?.message || "Couldn't react - try again.");
    }
  };

  const Wrapper = fillHeight ? "div" : React.Fragment;
  const wrapperProps = fillHeight ? { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } } : {};

  return (
    <Wrapper {...wrapperProps}>
      <div style={{ flexShrink: 0, borderBottom: "1px solid #1f2a44", marginBottom: 8 }}>
        <AdminToggleRow
          divider={false}
          label="🔔 Notify me when people chat"
          description="Just new messages - not game results or reminders."
          checked={chatNotifsEnabled}
          onChange={toggleChatNotifs}
          disabled={notifBusy}
        />
      </div>
      <div style={fillHeight
        ? { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 2, marginBottom: 10, paddingRight: 4 }
        : { maxHeight: "48vh", overflowY: "auto", overscrollBehavior: "contain", display: "flex", flexDirection: "column", gap: 2, marginBottom: 10, paddingRight: 4 }}>
        {grouped.length === 0 && <div style={{ fontSize: 13, color: "#9aa4c7" }}>No messages yet — say something!</div>}
        {grouped.map(m => {
          if (m.system && m.kind === "game-final") {
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, margin: "10px 0" }}>
                <div
                  onClick={e => { if (isAdmin && e.detail === 3) remove(m.id); }}
                  title={isAdmin ? "Triple-click to delete" : undefined}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, background: "#141a30", border: "1px solid #2a3655",
                    borderRadius: 14, padding: "8px 14px",
                  }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#6b7797", letterSpacing: 0.5 }}>FINAL</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TeamLogo school={m.away} size={22} />
                    <span style={{ fontSize: 13, fontWeight: m.winner === m.away ? 700 : 400, color: m.winner === m.away ? "#fff" : "#8590b0" }}>{m.awayPoints}</span>
                  </div>
                  <span style={{ fontSize: 11, color: "#5b6a8f" }}>@</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: m.winner === m.home ? 700 : 400, color: m.winner === m.home ? "#fff" : "#8590b0" }}>{m.homePoints}</span>
                    <TeamLogo school={m.home} size={22} />
                  </div>
                </div>
              </div>
            );
          }
          if (m.system) {
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, margin: "10px 0" }}>
                <div
                  onClick={e => { if (isAdmin && e.detail === 3) remove(m.id); }}
                  title={isAdmin ? "Triple-click to delete" : undefined}
                  style={{
                    background: "#141a30", border: "1px solid #2a3655", color: "#9aa4c7",
                    fontSize: 11.5, fontWeight: 600, padding: "5px 12px", borderRadius: 999, textAlign: "center",
                  }}>
                  {m.text}
                </div>
              </div>
            );
          }
          const color = chatAvatarColor(m.name);
          const side = m.mine ? "Right" : "Left";
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: m.mine ? "row-reverse" : "row", alignItems: "flex-end", gap: 6, marginTop: m.isFirstInRun ? 10 : 2 }}>
              {!m.mine && (
                <div style={{
                  width: 26, height: 26, borderRadius: "50%", flexShrink: 0, marginBottom: 2,
                  display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, color: "#fff",
                  background: color, visibility: m.isFirstInRun ? "visible" : "hidden",
                }}>
                  {chatInitials(m.name)}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", alignItems: m.mine ? "flex-end" : "flex-start", maxWidth: "76%" }}>
                {m.isFirstInRun && !m.mine && (
                  <div style={{ fontSize: 11.5, fontWeight: 700, color, margin: "0 4px 2px" }}>
                    {m.name}{m.verified && <span title="Verified" style={{ marginLeft: 3 }}>✓</span>}
                  </div>
                )}
                {(() => {
                  const reactionEntries = Object.entries(m.reactions || {}).filter(([, names]) => names?.length > 0);
                  const totalReactions = reactionEntries.reduce((sum, [, names]) => sum + names.length, 0);
                  return (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 6, marginBottom: totalReactions > 0 ? 10 : 0 }}>
                  <div style={{ position: "relative" }}>
                    <div
                      onClick={e => { if (isAdmin && e.detail === 3) remove(m.id); }}
                      title={isAdmin ? "Triple-click to delete" : undefined}
                      style={{
                        background: m.mine ? "#2a4fb8" : "#1c2544",
                        color: "#fff",
                        padding: m.imageUrl ? 4 : "8px 12px",
                        borderRadius: 16,
                        [`borderTop${side}Radius`]: m.isFirstInRun ? 16 : 6,
                        [`borderBottom${side}Radius`]: m.isLastInRun ? 4 : 16,
                        fontSize: 13.5,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxWidth: m.imageUrl ? 220 : undefined,
                      }}>
                      {m.imageUrl && (
                        <img
                          src={m.imageUrl}
                          alt="Shared photo"
                          onClick={e => { e.stopPropagation(); setLightboxUrl(m.imageUrl); }}
                          style={{ display: "block", maxWidth: "100%", maxHeight: 260, borderRadius: 12, cursor: "zoom-in" }}
                        />
                      )}
                      {m.text && <div style={{ padding: m.imageUrl ? "6px 4px 2px" : 0 }}>{m.text}</div>}
                    </div>
                    {totalReactions > 0 && (
                      // Sits tucked into the bottom corner of the bubble
                      // itself, overlapping it, same as Signal/iMessage -
                      // not a separate row of pills floating below.
                      <button
                        onClick={() => setReactionDetailMsgId(m.id)}
                        style={{
                          position: "absolute", bottom: isMobile ? -10 : -16, right: -4,
                          display: "flex", alignItems: "center", gap: 2,
                          background: "#141a30", border: "2px solid #0e1424", borderRadius: 999,
                          padding: "2px 6px", fontSize: 11.5, cursor: "pointer",
                          boxShadow: "0 1px 4px rgba(0,0,0,.4)", color: "#eef2ff",
                        }}
                      >
                        {reactionEntries.slice(0, 3).map(([emoji]) => <span key={emoji}>{emoji}</span>)}
                        <span>{totalReactions}</span>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => openReactionPicker === m.id ? closePicker() : (setOpenReactionPicker(m.id), setShowCustomEmojiInput(false))}
                    title="React"
                    style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, padding: 2, flexShrink: 0, opacity: 0.4, filter: "grayscale(1)" }}
                  >
                    🙂+
                  </button>
                </div>
                  );
                })()}
                {openReactionPicker === m.id && (
                  // Inline, not absolutely positioned - the message list
                  // scrolls with overflow:auto, which would clip a floating
                  // popover near the bottom of the visible area.
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                    <div style={{
                      display: "flex", gap: 2, background: "#1c2544", border: "1px solid #2a3655", borderRadius: 12, padding: 4,
                    }}>
                      {QUICK_REACTIONS.map(e => (
                        <button key={e} onClick={() => toggleReaction(m.id, e)} style={{ background: "transparent", border: "none", fontSize: 17, cursor: "pointer", padding: "3px 5px", borderRadius: 6 }}>
                          {e}
                        </button>
                      ))}
                      <button
                        onClick={() => setShowCustomEmojiInput(v => !v)}
                        title="Any emoji"
                        style={{ background: showCustomEmojiInput ? "#2a3655" : "transparent", border: "none", color: "#cfd8f0", cursor: "pointer", fontSize: 15, fontWeight: 700, padding: "3px 8px", borderRadius: 6 }}
                      >
                        +
                      </button>
                    </div>
                    {showCustomEmojiInput && (
                      <div style={{ display: "flex", gap: 4 }}>
                        <input
                          style={{ ...inputStyle, width: 90, fontSize: 16, padding: "6px 8px" }}
                          value={customEmojiText}
                          onChange={e => setCustomEmojiText(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") toggleReaction(m.id, customEmojiText); }}
                          placeholder="Any emoji…"
                          maxLength={8}
                          autoFocus
                        />
                        <button
                          onClick={() => toggleReaction(m.id, customEmojiText)}
                          disabled={!customEmojiText.trim()}
                          style={{ ...adminBtn("primary"), padding: "6px 10px", fontSize: 13 }}
                        >
                          React
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {m.isLastInRun && chatTimeLabel(m.createdAt) && (
                  <div style={{ fontSize: 10, color: "#5b6a8f", margin: "2px 4px 0" }}>{chatTimeLabel(m.createdAt)}</div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div style={{ fontSize: 11, color: "#6b7797", margin: "0 2px 6px" }}>
        Chatting as {identity.name}{uploadingImage ? " — uploading photo…" : ""}
      </div>
      <Row>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={sendImage}
        />
        <button
          type="button"
          onClick={pickImage}
          disabled={uploadingImage}
          title="Send a photo"
          style={{ background: "transparent", border: "1px solid #2a3655", borderRadius: 10, padding: "8px 10px", cursor: "pointer", fontSize: 16, color: "#cfd8f0", flexShrink: 0, opacity: uploadingImage ? 0.6 : 1 }}
        >
          📷
        </button>
        <input
          style={{ ...inputStyle, flex: 1, fontSize: 16 }}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") send(); }}
          onFocus={() => {
            // Tapping in re-scrolls to the latest message, same as any chat
            // app - otherwise the keyboard sliding up can leave the last
            // message hidden behind it. Delayed a beat for the keyboard's
            // open animation (and the visualViewport resize above) to
            // actually finish shrinking the sheet first.
            setTimeout(() => bottomRef.current?.scrollIntoView({ block: "end" }), 300);
          }}
          placeholder="Type a message…"
          maxLength={500}
          autoFocus={!isMobile}
        />
        <button style={adminBtn("primary")} disabled={sending || !text.trim()} onClick={send}>Send</button>
      </Row>
      {reactionDetailMsgId && (() => {
        const msg = messages.find(mm => mm.id === reactionDetailMsgId);
        const entries = Object.entries(msg?.reactions || {}).filter(([, names]) => names?.length > 0);
        if (!entries.length) return null;
        return (
          <ModalOverlay>
            <Card style={{ padding: 18, width: "min(320px, 90vw)", margin: "0 auto" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>Reactions</h3>
                <button
                  onClick={() => setReactionDetailMsgId(null)}
                  style={{ background: "transparent", border: "none", color: "#cfd8f0", cursor: "pointer", fontSize: 18, padding: 4, lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "50vh", overflowY: "auto" }}>
                {entries.map(([emoji, names]) => (
                  <div key={emoji}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#9aa4c7", marginBottom: 6 }}>{emoji} {names.length}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {names.map(n => (
                        <div key={n} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 14, color: "#eef2ff" }}>
                          <span>{n}</span>
                          {n === identity.name && (
                            <button
                              onClick={() => { toggleReaction(reactionDetailMsgId, emoji); setReactionDetailMsgId(null); }}
                              style={{ background: "transparent", border: "none", color: "#f0596b", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </ModalOverlay>
        );
      })()}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}
        >
          <img src={lightboxUrl} alt="Shared photo" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
        </div>
      )}
    </Wrapper>
  );
}

// A 💬 icon near the top of the Header that pops open one continuous chat
// thread (not scoped per week - see CHAT_THREAD_KEY) in a modal. Identity
// resolution (device -> name) runs as soon as the icon mounts, not on open,
// so a returning device's badge count is accurate and opening the modal
// never has to wait on it. Reuses the push-notification token as the device
// id when one exists (so a device already known by name via pushTokens
// never has to ask again - see ChatIdentitySetup), otherwise a random id
// stashed in localStorage. Either way, once chatDevices/{deviceId} exists,
// this device is permanently locked to that name (admin can unlock).
function WeekChat({ isAdmin, open: openProp, onOpenChange }) {
  const isMobile = useIsMobile();
  // Optionally controlled from outside (Header uses this so the "new chat
  // feature" announcement modal's CTA can open the same chat modal) - falls
  // back to its own state when no parent wants to control it.
  const [openState, setOpenState] = useState(false);
  const open = openProp !== undefined ? openProp : openState;
  const setOpen = onOpenChange || setOpenState;

  // Lock background scroll while chat is open. overflow:hidden alone isn't
  // enough on iOS Safari - it ignores that for touch-driven scrolling, so a
  // drag on the message list still scrolls the page underneath. Pinning the
  // body itself with position:fixed (restoring the exact scroll offset on
  // close) is the reliable cross-browser fix.
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const prev = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
      overscrollBehavior: document.body.style.overscrollBehavior,
      htmlOverflow: document.documentElement.style.overflow,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    // Some iOS Safari versions still scroll-chain to <html> once <body> is
    // taken out of the normal flow by position:fixed - belt-and-suspenders.
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.left = prev.left;
      document.body.style.right = prev.right;
      document.body.style.width = prev.width;
      document.body.style.overflow = prev.overflow;
      document.body.style.overscrollBehavior = prev.overscrollBehavior;
      document.documentElement.style.overflow = prev.htmlOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // Reserve space for the on-screen keyboard inside the mobile full-screen
  // sheet, WITHOUT resizing the sheet's own fixed box. An earlier version
  // resized the whole box to visualViewport.height, but that resize lags a
  // frame or two behind iOS's own keyboard animation, so the real page
  // flashed into view underneath for a moment - which read as "the page
  // scrolls" when tapping the input. Padding the bottom of an
  // always-full-height box instead only reflows the *inside* (the message
  // list's flex:1 area shrinks, the input row stays glued above the
  // padding) - the box itself never moves or resizes, so there's nothing
  // to visibly lag. window.innerHeight (the layout viewport) stays fixed
  // across the keyboard opening, so the gap between it and the shrunken/
  // panned visual viewport is exactly the keyboard's on-screen height.
  const mobileSheetRef = useRef(null);
  useEffect(() => {
    if (!open || !isMobile) return;
    const vv = window.visualViewport;
    const el = mobileSheetRef.current;
    if (!vv || !el) return;
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.paddingBottom = kb + "px";
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      el.style.paddingBottom = "";
    };
  }, [open, isMobile]);
  const [count, setCount] = useState(0);
  const [deviceId, setDeviceId] = useState(null);
  const [identity, setIdentity] = useState(undefined); // undefined = loading, null = needs setup

  useEffect(() => {
    let pushToken = null;
    try { pushToken = localStorage.getItem("pushToken"); } catch {}
    let id = pushToken;
    if (!id) {
      try { id = localStorage.getItem("chatDeviceId"); } catch {}
      if (!id) {
        id = "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        try { localStorage.setItem("chatDeviceId", id); } catch {}
      }
    }
    setDeviceId(id);
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, "chatDevices", deviceId));
        if (cancelled) return;
        if (snap.exists()) { setIdentity(snap.data()); return; }

        let pushToken = null;
        try { pushToken = localStorage.getItem("pushToken"); } catch {}
        if (pushToken && pushToken === deviceId) {
          const pt = await getDoc(doc(db, "pushTokens", pushToken));
          const nm = (pt.exists() ? (pt.data().name || "") : "").trim();
          if (nm) {
            const payload = { name: nm, verified: true, linkedFromPushToken: true, createdAt: serverTimestamp() };
            await setDoc(doc(db, "chatDevices", deviceId), payload);
            if (!cancelled) setIdentity(payload);
            return;
          }
        }
        if (!cancelled) setIdentity(null);
      } catch (e) {
        if (!cancelled) setIdentity(null);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  // Unread count, not total count - a device's "seen" watermark is the
  // createdAt of the newest message it's had the modal open for. A ref (not
  // state) on purpose: it needs to advance on every snapshot while open
  // without retriggering this effect each time, which state would do.
  const lastSeenAtRef = useRef(0);
  useEffect(() => {
    try { lastSeenAtRef.current = Number(localStorage.getItem("chatLastSeenAt")) || 0; } catch {}
  }, []);
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "chatMessages", CHAT_THREAD_KEY, "messages"), snap => {
      let latest = lastSeenAtRef.current;
      let unread = 0;
      snap.forEach(d => {
        const ts = d.data().createdAt?.toMillis ? d.data().createdAt.toMillis() : Date.now();
        if (ts > latest) latest = ts;
        if (ts > lastSeenAtRef.current) unread++;
      });
      if (open) {
        // Actively viewing - advance the watermark to the newest message
        // seen so far instead of letting unread pile up while it's open.
        lastSeenAtRef.current = latest;
        try { localStorage.setItem("chatLastSeenAt", String(latest)); } catch {}
        setCount(0);
      } else {
        setCount(unread);
      }
    }, () => setCount(0));
    return () => unsub();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Chat"
        aria-label="Open chat"
        style={{
          position: "relative", background: "transparent", border: "none", color: "#eef2ff", padding: 4,
          fontSize: 19, cursor: "pointer", display: "grid", placeItems: "center", lineHeight: 1,
        }}
      >
        💬
        {count > 0 && (
          <span style={{
            position: "absolute", top: -6, right: -6, minWidth: 16, height: 16, padding: "0 3px", borderRadius: 8,
            background: "#2a4fb8", color: "#fff", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center", lineHeight: 1,
          }}>
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && isMobile && (
        // Full-screen sheet on mobile instead of the generic centered
        // ModalOverlay - that dialog treatment left a large dead gray gap
        // below the input on small screens. zIndex is deliberately below
        // ModalOverlay's (1000) so the Reactions breakdown popup, which is
        // still ModalOverlay-based inside ChatThreadBody, reliably stacks
        // above this sheet.
        <div ref={mobileSheetRef} style={{
          position: "fixed", top: 0, left: 0, right: 0, height: "100dvh", zIndex: 900, background: "#0b1220",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, padding: "14px 16px", borderBottom: "1px solid #1f2a44",
          }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>💬 Chat</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ background: "transparent", border: "none", color: "#cfd8f0", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 4 }}
            >
              ✕
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", padding: "10px 16px" }}>
            {identity === undefined || !deviceId ? null :
              identity === null ? <ChatIdentitySetup deviceId={deviceId} onDone={setIdentity} /> :
              <ChatThreadBody deviceId={deviceId} identity={identity} isAdmin={isAdmin} fillHeight />}
          </div>
        </div>
      )}
      {open && !isMobile && (
        <ModalOverlay>
          <Card style={{ padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>💬 Chat</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ background: "transparent", border: "none", color: "#cfd8f0", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4 }}
              >
                ✕
              </button>
            </div>
            {identity === undefined || !deviceId ? null :
              identity === null ? <ChatIdentitySetup deviceId={deviceId} onDone={setIdentity} /> :
              <ChatThreadBody deviceId={deviceId} identity={identity} isAdmin={isAdmin} />}
          </Card>
        </ModalOverlay>
      )}
    </>
  );
}

function AdminNotificationsPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
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

  // Needed to tell a forfeited partial slate (still incomplete past its own
  // deadline) apart from a normal complete submission - see isForfeitedPick.
  const [weekGames, setWeekGames] = useState([]);
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) { setWeekGames([]); return; }
    let cancelled = false;
    (async () => {
      try {
        let gs = await listGames({ year: Number(year), week: Number(week), includedOnly: true });
        if (!Array.isArray(gs) || gs.length === 0) gs = await listGames({ year: Number(year), week: Number(week), includedOnly: false });
        if (!cancelled) setWeekGames(gs || []);
      } catch (e) {
        if (!cancelled) setWeekGames([]);
      }
    })();
    return () => { cancelled = true; };
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

  const owedRows = rows.filter(p => !isForfeitedPick(weekGames, p));
  const paidCount = owedRows.filter(p => p.paid === true).length;

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
        <StatusBadge tone={paidCount === owedRows.length && owedRows.length > 0 ? "success" : "primary"}>
          {paidCount} / {owedRows.length} paid
        </StatusBadge>
        <StatusBadge tone="neutral">
          ${paidCount * ENTRY_FEE} / ${owedRows.length * ENTRY_FEE} collected
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
              const forfeited = isForfeitedPick(weekGames, p);
              return (
                <tr key={p.id} style={{ borderBottom:"1px solid #1f2a44", opacity: forfeited ? 0.65 : 1 }}>
                  <td style={{ padding:"8px 10px" }}>
                    {name}
                    {p.partial === true && !forfeited && (
                      <StatusBadge tone="primary" style={{ marginLeft:8, fontSize:10.5, padding:"2px 8px" }}>⏳ Partial</StatusBadge>
                    )}
                  </td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>{p.code}</td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>{p.venmo}</td>
                  <td style={{ padding:"8px 10px", opacity:.9 }}>
                    {forfeited ? <StatusBadge tone="danger">Forfeited</StatusBadge> : `$${ENTRY_FEE}`}
                  </td>
                  <td style={{ padding:"8px 10px" }}>
                    {forfeited
                      ? <span style={{ fontSize:12, opacity:.75 }}>—</span>
                      : <input type="checkbox" checked={p.paid === true} onChange={()=>togglePaid(p)} style={{ width:18, height:18, cursor:"pointer" }} />}
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

// Known name variants that should resolve to the same person (e.g. a
// nickname or alternate spelling used on a different week's submission).
// Keep in sync with the identical map in functions/index.js's personKey.
const NAME_ALIASES = {
  "jack_vardaramatos": "jacques_vardaramatos",
};

function personKey(p) {
  const n = `${(p.firstName || "").trim().toLowerCase()}_${(p.lastName || "").trim().toLowerCase()}`;
  const key = n.replace(/^_+|_+$/g, "") || null;
  return key ? (NAME_ALIASES[key] || key) : null;
}
// Placeholder text people type in the Venmo field when they actually paid
// through someone else ("yes", "-", "n/a", "sent through Michael"...) isn't
// a real handle, and different unrelated people reuse the same placeholder -
// treating it as an identity key would wrongly merge their picks together.
const VENMO_JUNK = new Set([
  "yes", "yea", "yeah", "y", "no", "n", "n/a", "na", "-", "none", "redacted",
  "paid", "cash", "cashapp", "venmo", "check", "tbd", "idk", "unknown", "?",
]);
function venmoKeyOf(p) {
  const v = String(p.venmo || "").trim().toLowerCase().replace(/^@+/, "");
  if (!v || /\s/.test(v) || VENMO_JUNK.has(v)) return null; // not a real handle
  return `v:${v}`;
}
// A stable email should union with name/Venmo just like they union with each
// other - someone who submits once as "chris" and again as "chris k" (a
// changed last name field, different Venmo note that week) is still the same
// person if both submissions carry the same email address.
function emailKeyOf(p) {
  const e = String(p.email || "").trim().toLowerCase();
  return e && e.includes("@") ? `e:${e}` : null;
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

// Builds the "who's ever played" roster from raw `picks` docs (clustered by
// name/Venmo/email, same as above), then overlays any `players` doc whose
// aliasKeys match a doc in that cluster - a persistent, admin-editable
// identity that survives reloads and DSU-root drift, unlike a raw cluster
// key. A cluster with no matching player doc falls back to plain picks-
// derived display (unclaimed/auto-detected) so nothing regresses for anyone
// the admin hasn't touched yet. `players` with zero picks history at all
// (pure invitees, or someone merged/renamed who hasn't submitted since)
// still get a row - clustering alone never produces one for them. Shared by
// every tab of PlayerManagementPage so there's one identity resolver, not
// several copies that can drift apart.
function buildRoster(picksDocs, players) {
  const dsu = makeDSU();
  const docs = [];
  for (const p of picksDocs) {
    const nk = personKey(p);
    const vk = venmoKeyOf(p);
    const ek = emailKeyOf(p);
    if (!nk && !vk) continue;
    if (nk && vk) dsu.union(nk, vk);
    if (ek) dsu.union(nk || vk, ek);
    docs.push({ p, key: nk || vk, nk, vk, ek });
  }

  const keyToPlayerId = new Map();
  for (const pl of players) for (const k of pl.aliasKeys || []) keyToPlayerId.set(k, pl.id);

  const byRoot = new Map();
  for (const rec of docs) {
    const root = dsu.find(rec.key);
    let slot = byRoot.get(root);
    if (!slot) { slot = { playerId: null, latest: null, _ms: -Infinity, keys: new Set() }; byRoot.set(root, slot); }
    const ms = rec.p.updatedAt?.toMillis ? rec.p.updatedAt.toMillis() : (rec.p.createdAt?.toMillis ? rec.p.createdAt.toMillis() : 0);
    if (ms >= slot._ms) { slot.latest = rec.p; slot._ms = ms; }
    if (rec.nk) slot.keys.add(rec.nk);
    if (rec.vk) slot.keys.add(rec.vk);
    if (rec.ek) slot.keys.add(rec.ek);
    if (!slot.playerId) slot.playerId = keyToPlayerId.get(rec.nk) || keyToPlayerId.get(rec.vk) || keyToPlayerId.get(rec.ek) || null;
  }

  // A merged player's aliasKeys can span multiple ORIGINAL auto-detected
  // clusters (that's the entire point of merging two people the automatic
  // name/Venmo/email matching couldn't tell were the same) - group those
  // roots by the identity they resolve to (the player id when claimed, else
  // the root itself) before building rows, so a merge collapses into one
  // row instead of one row per contributing cluster.
  const groups = new Map();
  for (const [root, slot] of byRoot) {
    const groupKey = slot.playerId || root;
    let g = groups.get(groupKey);
    if (!g) { g = { playerId: slot.playerId, dsuRoots: new Set(), keys: new Set(), latest: slot.latest, _ms: slot._ms }; groups.set(groupKey, g); }
    g.dsuRoots.add(root);
    for (const k of slot.keys) g.keys.add(k);
    if (slot._ms >= g._ms) { g.latest = slot.latest; g._ms = slot._ms; }
  }

  const rows = [];
  const usedPlayerIds = new Set();
  for (const g of groups.values()) {
    const pl = g.playerId ? players.find(x => x.id === g.playerId) : null;
    if (pl) {
      usedPlayerIds.add(pl.id);
      // A player doc field that's blank (e.g. one migrated from an old
      // "opt out" entry that was never actually edited with a name/contact
      // info) falls back to what's on the picks docs themselves, rather
      // than blanking out real, already-known info.
      const latest = g.latest || {};
      rows.push({
        rowId: pl.id, playerId: pl.id, dsuRoots: g.dsuRoots,
        firstName: pl.firstName || latest.firstName, lastName: pl.lastName || latest.lastName,
        phone: pl.phone || latest.phone, venmo: pl.venmo || latest.venmo, email: pl.email || latest.email || "",
        emailOptOut: !!pl.emailOptOut,
        // The player doc's own stored aliasKeys can be incomplete - e.g.
        // one migrated from an old contacts override only captured that
        // doc's own fields, not every name/Venmo/email variant across the
        // person's actual picks history. Enrich with everything their
        // matched picks cluster(s) show (g.keys) so matching (a push-
        // notification device registered under a slightly different
        // spelling, say) doesn't silently miss just because the stored
        // field was never backfilled.
        aliasKeys: [...new Set([...(pl.aliasKeys || []), ...g.keys])],
      });
    } else {
      const { firstName, lastName, phone, venmo, email } = g.latest;
      rows.push({ rowId: [...g.dsuRoots][0], playerId: null, dsuRoots: g.dsuRoots, firstName, lastName, phone, venmo, email: email || "", emailOptOut: false, aliasKeys: [...g.keys] });
    }
  }
  for (const pl of players) {
    if (usedPlayerIds.has(pl.id)) continue;
    rows.push({ rowId: pl.id, playerId: pl.id, dsuRoots: new Set(), firstName: pl.firstName, lastName: pl.lastName, phone: pl.phone, venmo: pl.venmo, email: pl.email, emailOptOut: !!pl.emailOptOut, aliasKeys: pl.aliasKeys || [] });
  }

  return { rows, dsu, docs };
}

// Every raw picks doc (from buildRoster's `docs`) that belongs to a given
// roster row. A claimed row's docs are whichever ones carry one of its
// aliasKeys - the merged identity, which the automatic name/Venmo/email
// clustering alone might not know is the same person (that's the whole
// point of a manual merge). An unclaimed row's docs are just its DSU
// cluster. Shared by findMySeason, computeAllTimePercentiles, and
// buildChatRoster so a Player Profiles rename/merge/opt-out is reflected
// everywhere identity comes up, not just Who Hasn't Submitted.
function docsForRosterRow(roster, row) {
  return roster.docs.filter(rec =>
    row.playerId
      ? (rec.nk && row.aliasKeys.includes(rec.nk)) || (rec.vk && row.aliasKeys.includes(rec.vk)) || (rec.ek && row.aliasKeys.includes(rec.ek))
      : row.dsuRoots.has(roster.dsu.find(rec.key))
  ).map(rec => rec.p);
}

// Live `players` collection - the persistent roster PlayerManagementPage's
// Roster tab edits, and buildRoster() overlays onto the raw picks-derived
// clusters.
function usePlayers(isAdmin) {
  const [players, setPlayers] = useState([]);
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "players"), (snap) => {
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      setPlayers(list);
    });
    return () => unsub();
  }, [isAdmin]);
  return players;
}

// Merges 2+ roster rows (from buildRoster) into one persistent `players`
// doc: unions every alias key so future picks docs under any of the merged
// identities still resolve to it, keeps opted-out if any merged row was,
// and reuses the first already-persisted player id as the survivor
// (deleting any other real player docs among the selection) so an existing
// profile's id - and anything that might reference it later - doesn't churn
// on every merge.
async function mergeRosterRows(selectedRows, finalFields) {
  const aliasKeys = [...new Set(selectedRows.flatMap(r => r.aliasKeys || []))];
  // Deduped - a row that already spans multiple original clusters (e.g.
  // re-selecting an already-merged person alongside someone else) would
  // otherwise list its own survivor id again in toDelete and delete itself
  // right after being written to.
  const existingPlayerIds = [...new Set(selectedRows.map(r => r.playerId).filter(Boolean))];
  const survivorId = existingPlayerIds[0] || null;
  const toDelete = existingPlayerIds.slice(1);
  const emailOptOut = selectedRows.some(r => r.emailOptOut);
  if (survivorId) {
    await setDoc(doc(db, "players", survivorId), { ...finalFields, aliasKeys, emailOptOut, updatedAt: serverTimestamp() }, { merge: true });
  } else {
    await setDoc(doc(collection(db, "players")), { ...finalFields, aliasKeys, emailOptOut, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
  await Promise.all(toDelete.map(id => deleteDoc(doc(db, "players", id))));
}

// Saves an edit to a roster row - updates its player doc if it already has
// one, or creates one (lazily claiming the auto-detected cluster, seeded
// with every alias key observed in it) the first time an admin touches a
// row that was still purely picks-derived.
async function savePlayerEdit(row, fields) {
  if (row.playerId) {
    await setDoc(doc(db, "players", row.playerId), { ...fields, updatedAt: serverTimestamp() }, { merge: true });
  } else {
    // emailOptOut defaults false but a caller (e.g. opting out an unclaimed
    // row for the first time) can still pass it explicitly - spread order
    // makes the default lose to anything the caller actually specifies.
    await setDoc(doc(collection(db, "players")), { emailOptOut: false, ...fields, aliasKeys: row.aliasKeys, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
}

// One-time conversion of the legacy `contacts` + `unassignedContacts`
// collections into `players` docs, so existing name overrides, opted-out
// people, and promoted invitees aren't lost when this page replaces them.
// Evaluates each person's old per-week optedOutWeeks map as of the current
// live week to pick a starting value for the new global emailOptOut switch.
// Runs once, gated by config/app.playersMigratedV1, triggered by an admin
// clicking the button in their own signed-in session (not run from here -
// see PlayerManagementPage's Roster tab).
async function migrateLegacyContactsToPlayers() {
  const [contactsSnap, unassignedSnap, liveSnap] = await Promise.all([
    getDocs(collection(db, "contacts")),
    getDocs(collection(db, "unassignedContacts")),
    getDoc(doc(db, "config", "live")),
  ]);
  const live = liveSnap.exists() ? liveSnap.data() : {};
  const weekOrdinal = (y, w) => Number(y) * 100 + Number(w);
  const resolveOptedOutAsOfNow = (optedOutWeeks) => {
    if (!optedOutWeeks || !hasWeekValue(live.year) || !hasWeekValue(live.week)) return false;
    const targetOrd = weekOrdinal(live.year, live.week);
    let best = false, bestOrd = -Infinity;
    for (const k of Object.keys(optedOutWeeks)) {
      const m = /^(\d+)_(\d+)$/.exec(k);
      if (!m) continue;
      const ord = weekOrdinal(m[1], m[2]);
      if (ord <= targetOrd && ord > bestOrd) { bestOrd = ord; best = !!optedOutWeeks[k]; }
    }
    return best;
  };

  const batch = writeBatch(db);
  let count = 0;
  contactsSnap.forEach(d => {
    const v = d.data() || {};
    const aliasKeys = [d.id, personKey({ firstName: v.firstName, lastName: v.lastName }), venmoKeyOf({ venmo: v.venmo }), emailKeyOf({ email: v.email })].filter(Boolean);
    batch.set(doc(collection(db, "players")), {
      firstName: v.firstName || "", lastName: v.lastName || "", phone: v.phone || "", venmo: v.venmo || "", email: v.email || "",
      aliasKeys: [...new Set(aliasKeys)],
      emailOptOut: resolveOptedOutAsOfNow(v.optedOutWeeks),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    count++;
  });
  unassignedSnap.forEach(d => {
    const v = d.data() || {};
    const parts = (v.name || "").trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || "", lastName = parts.slice(1).join(" ");
    const email = v.email || d.id;
    const aliasKeys = [emailKeyOf({ email }), personKey({ firstName, lastName }), venmoKeyOf({ venmo: v.venmo })].filter(Boolean);
    batch.set(doc(collection(db, "players")), {
      firstName, lastName, phone: v.phone || "", venmo: v.venmo || "", email,
      aliasKeys: [...new Set(aliasKeys)],
      emailOptOut: resolveOptedOutAsOfNow(v.optedOutWeeks),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    count++;
  });
  // Well within the 500-op batch limit at this roster's current size (~90
  // people combined) - not worth chunking for a one-time admin action.
  await batch.commit();
  await setDoc(doc(db, "config", "app"), { playersMigratedV1: true }, { merge: true });
  return count;
}

// The Player Management hub: everything about a *person* in one place,
// instead of scattered across "Who Hasn't Submitted", "Player Profiles", and
// two sections buried in Manage Notifications (Manage Devices, Chat Names).
// All four tabs share ONE picks+players load and ONE buildRoster() result
// (computed here, passed down as props) instead of each independently
// re-subscribing and re-deriving the same roster, which is what the four
// separate pages used to do.
function PlayerManagementPage({ user, isAdmin, setPage, initialTab = "roster" }) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState(initialTab);
  const [msg, setMsg] = useState("");

  const [live, setLive] = useState({ year: null, week: null });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);

  // Everyone who has ever submitted picks, any year/week - the roster every
  // tab below checks against, since the app has no separate participant
  // list. Names/contact info/opt-out come from `players` (see buildRoster)
  // wherever an admin has edited or merged that person; unedited people
  // fall back to raw picks data.
  const [picksDocs, setPicksDocs] = useState(null);
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "picks"), (snap) => {
      const arr = [];
      snap.forEach(d => arr.push(d.data()));
      setPicksDocs(arr);
    });
    return () => unsub();
  }, []);
  const players = usePlayers(isAdmin);
  const roster = useMemo(() => buildRoster(picksDocs || [], players), [picksDocs, players]);
  const loaded = picksDocs !== null;

  // Shared Year/Week - drives the Submitted status on the Roster tab, the
  // whole comparison on Who's Missing, and the Submitted badge on Devices.
  // Defaults to the live week once, then is independently adjustable so an
  // admin can check a past week without losing their place.
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
  const submittedRoots = useMemo(() => {
    const s = new Set();
    if (!hasWeekValue(year) || !hasWeekValue(week)) return s;
    for (const rec of roster.docs) {
      if (Number(rec.p.year) === Number(year) && Number(rec.p.week) === Number(week)) {
        s.add(roster.dsu.find(rec.key));
      }
    }
    return s;
  }, [roster, year, week]);

  // Push-notification devices - feeds the Devices tab's list *and* the
  // notified-vs-email signal every tab uses (Roster's Notify column, Who's
  // Missing's auto-exclusion). One subscription instead of the two (a
  // device list, plus a separate name-key set) the old separate pages each
  // kept.
  const [pushDevices, setPushDevices] = useState([]);
  const [notifiedNameKeys, setNotifiedNameKeys] = useState(new Set());
  const [notifiedPlayerIds, setNotifiedPlayerIds] = useState(new Set());
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "pushTokens"), (snap) => {
      const rows = [];
      const keys = new Set();
      const playerIds = new Set();
      snap.forEach(d => {
        const v = d.data() || {};
        rows.push({ token: d.id, ...v });
        if (v.blocked) return;
        const k = personKey({ firstName: (v.name || "").trim().split(/\s+/)[0], lastName: (v.name || "").trim().split(/\s+/).slice(1).join(" ") });
        if (k) keys.add(k);
        if (v.assignedPlayerId) playerIds.add(v.assignedPlayerId);
      });
      rows.sort((a, b) => {
        const byName = (a.name || "").localeCompare(b.name || "");
        if (byName) return byName;
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
      setPushDevices(rows);
      setNotifiedNameKeys(keys);
      setNotifiedPlayerIds(playerIds);
    }, () => setPushDevices([]));
    return () => unsub();
  }, [isAdmin]);

  const [chatDevices, setChatDevices] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "chatDevices"), (snap) => {
      const rows = [];
      snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setChatDevices(rows);
    }, () => setChatDevices([]));
    return () => unsub();
  }, []);

  const rosterOptions = useMemo(() =>
    [...roster.rows]
      .sort((a, b) => `${a.firstName || ""} ${a.lastName || ""}`.localeCompare(`${b.firstName || ""} ${b.lastName || ""}`))
      .map(r => ({ rowId: r.rowId, playerId: r.playerId, aliasKeys: r.aliasKeys, label: `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email || "(unnamed)" })),
    [roster]
  );
  // Lets an admin explicitly tie a device to a specific player - a direct,
  // permanent link that doesn't depend on name-matching at all, so it can't
  // be broken by a future rename and can't collide with someone else who
  // happens to share a name. Assigning to a row with no player doc yet
  // (still just an auto-detected picks cluster) claims it first, same
  // lazy-claim pattern as editing/opting-out an unclaimed row.
  async function assignDeviceToPlayer(token, rowId) {
    if (!rowId) {
      try { await setDoc(doc(db, "pushTokens", token), { assignedPlayerId: null }, { merge: true }); }
      catch (e) { setMsg("Failed to unassign device: " + (e?.message || String(e))); }
      return;
    }
    const row = roster.rows.find(r => r.rowId === rowId);
    if (!row) return;
    try {
      let playerId = row.playerId;
      if (!playerId) {
        const ref = doc(collection(db, "players"));
        await setDoc(ref, {
          firstName: row.firstName || "", lastName: row.lastName || "", phone: row.phone || "", venmo: row.venmo || "", email: row.email || "",
          aliasKeys: row.aliasKeys, emailOptOut: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        playerId = ref.id;
      }
      await setDoc(doc(db, "pushTokens", token), { assignedPlayerId: playerId }, { merge: true });
    } catch (e) {
      setMsg("Failed to assign device: " + (e?.message || String(e)));
    }
  }

  const TABS = [
    ["picks", "Picks"],
    ["roster", "Roster"],
    ["missing", "Who's Missing"],
    ["devices", "Devices"],
    ["chat", "Chat"],
  ];

  return (<Container maxWidth={1200} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ maxWidth: 1200, padding: isMobile ? 12 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0 }}>Player Management</h2>
        <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin"); setPage("admin"); }}>&larr; Back to Admin</button>
      </div>
      <p style={{ margin:"10px 0 0", fontSize:13, color:"#9aa4c7" }}>
        Everyone who's ever played or been invited - browse a week's submissions, edit names, merge duplicates, check who's missing, and manage their devices and chat identity, all in one place.
      </p>
      {msg && (
        <div style={{ marginTop:12, padding:"8px 12px", borderRadius:10, background:"rgba(106,162,255,.1)", border:"1px solid rgba(106,162,255,.3)", color:"#cfe0ff", fontSize:13 }}>{msg}</div>
      )}

      <Row style={{ marginTop:16, gap:16, alignItems:"flex-end", flexWrap:"wrap" }}>
        <Row style={{ gap:8 }}>
          {TABS.map(([key, label]) => (
            <button key={key} style={adminBtn(tab === key ? "primary" : "neutral")} onClick={() => setTab(key)}>{label}</button>
          ))}
        </Row>
        {tab !== "chat" && (
          <>
            <Field label="Year"><input style={{...inputStyle, width:"6rem"}} type="number" value={year ?? ""} onChange={e=>setYear(Number(e.target.value))} /></Field>
            <Field label="Week"><input style={{...inputStyle, width:"4rem"}} type="number" value={week ?? ""} onChange={e=>setWeek(Number(e.target.value))} /></Field>
          </>
        )}
      </Row>
    </Card>

    {tab === "picks" && (
      <PicksTab year={year} week={week} isMobile={isMobile} />
    )}
    {tab === "roster" && (
      <RosterTab roster={roster} loaded={loaded} notifiedNameKeys={notifiedNameKeys} notifiedPlayerIds={notifiedPlayerIds} submittedRoots={submittedRoots} year={year} week={week} isMobile={isMobile} />
    )}
    {tab === "missing" && (
      <MissingTab roster={roster} loaded={loaded} notifiedNameKeys={notifiedNameKeys} notifiedPlayerIds={notifiedPlayerIds} submittedRoots={submittedRoots} year={year} week={week} isMobile={isMobile} />
    )}
    {tab === "devices" && (
      <DevicesTab pushDevices={pushDevices} roster={roster} rosterOptions={rosterOptions} assignDeviceToPlayer={assignDeviceToPlayer} submittedRoots={submittedRoots} setMsg={setMsg} isMobile={isMobile} />
    )}
    {tab === "chat" && (
      <ChatTab chatDevices={chatDevices} setMsg={setMsg} />
    )}
  </Container>);
}

function formatPickTs(ts) {
  try {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : (typeof ts.seconds === "number" ? new Date(ts.seconds * 1000) : new Date(ts));
    if (!(d instanceof Date) || isNaN(+d)) return "";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" }).format(d);
  } catch { return ""; }
}

// Picks tab: live view of every picks submission for the shared Year/Week -
// inspect the full detail (including the raw picks object) or delete one.
// Deleting is only offered while that week's leaderboard is still locked;
// once it's live, real picks are permanently immutable, even for admins -
// see firestore.rules' picks delete rule.
function PicksTab({ year, week, isMobile }) {
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) { setRows([]); setMsg(""); return; }
    setMsg("Loading picks…");
    setRows([]);
    const q = query(collection(db, "picks"), where("year", "==", Number(year)), where("week", "==", Number(week)));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      all.sort((a, b) => (a.lastNameLower || "").localeCompare(b.lastNameLower || "") || (a.firstName || "").localeCompare(b.firstName || ""));
      setRows(all);
      setMsg(`Showing ${all.length} pick(s) for ${year} / W${week}`);
    }, (err) => {
      setMsg(`Error loading picks: ${err?.message || err}`);
    });
    return () => unsub();
  }, [year, week]);

  const [qtext, setQtext] = useState("");
  const filtered = useMemo(() => {
    const q = qtext.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(p => {
      const name = `${p.firstName || ""} ${p.lastName || ""}`.toLowerCase();
      const phone = (p.phone || "").toLowerCase();
      const venmo = (p.venmo || "").toLowerCase();
      const code = (p.code || "").toLowerCase();
      return name.includes(q) || phone.includes(q) || venmo.includes(q) || code.includes(q);
    });
  }, [rows, qtext]);

  const [selected, setSelected] = useState(null);
  const openPick = (p) => setSelected(p);
  const closePick = () => setSelected(null);

  const [leaderboardLocked, setLeaderboardLocked] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => {
      setLeaderboardLocked(!!(s.data() || {}).leaderboardLocked);
    });
    return () => unsub();
  }, []);
  const canDelete = leaderboardLocked || Number(year) >= 2090;

  async function handleDelete(p) {
    const name = `${p.firstName || ""} ${p.lastName || ""}`.trim() || p.email || p.code;
    if (!window.confirm(`Delete the pick for ${name} (code ${p.code})? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, "picks", p.id));
      if (selected?.id === p.id) closePick();
      setMsg(`Deleted pick for ${name}.`);
    } catch (e) {
      setMsg(`Failed to delete: ${e?.message || e}`);
    }
  }

  return (
    <Card style={{ maxWidth: 1200, marginTop: 16, padding: isMobile ? 12 : 16 }}>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "#9aa4c7" }}>
        Live view of every picks submission for the selected Year/Week above. Click a row for full detail. Deleting a pick only works while that week's leaderboard is still locked.
      </p>
      <Field label="Filter (name, code, phone, venmo)">
        <input style={{ ...inputStyle, width: isMobile ? "100%" : "18rem" }} value={qtext} onChange={e => setQtext(e.target.value)} placeholder="Start typing…" />
      </Field>
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: "#9aa4c7" }}>{msg}</div>}

      <div style={{ marginTop: 12, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44", position: "sticky", left: 0, background: "#121a2b", zIndex: 1 }}>Name</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Code</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Phone</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Email</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Venmo</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Confirmed</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Picks</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Created</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}>Updated</th>
              <th style={{ padding: "8px 10px", borderBottom: "1px solid #1f2a44" }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const name = `${p.firstName || ""} ${p.lastName || ""}`.trim() || p.email || "(no name)";
              const cnt = p.picks ? Object.keys(p.picks).length : 0;
              return (
                <tr key={p.id} style={{ borderBottom: "1px solid #1f2a44", cursor: "pointer" }} onClick={() => openPick(p)}>
                  <td style={{ padding: "8px 10px", position: "sticky", left: 0, background: "#0e1730", zIndex: 1 }}>{name}</td>
                  <td style={{ padding: "8px 10px", opacity: .9 }}>{p.code}</td>
                  <td style={{ padding: "8px 10px", opacity: .9 }}>{p.phone}</td>
                  <td style={{ padding: "8px 10px", opacity: .9 }}>{p.email || ""}</td>
                  <td style={{ padding: "8px 10px", opacity: .9 }}>{p.venmo}</td>
                  <td style={{ padding: "8px 10px" }}>{p.venmoConfirmed ? "Yes" : "No"}</td>
                  <td style={{ padding: "8px 10px" }}>{cnt}</td>
                  <td style={{ padding: "8px 10px", opacity: .9 }}>{formatPickTs(p.createdAt)}</td>
                  <td style={{ padding: "8px 10px", opacity: .9 }}>{formatPickTs(p.updatedAt)}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <Row style={{ gap: 6 }}>
                      <button style={{ ...adminBtn("neutral"), padding: "4px 8px", fontSize: 12 }} onClick={(e) => { e.stopPropagation(); openPick(p); }}>View</button>
                      {canDelete && (
                        <button style={{ ...adminBtn("danger"), padding: "4px 8px", fontSize: 12 }} onClick={(e) => { e.stopPropagation(); handleDelete(p); }}>Delete</button>
                      )}
                    </Row>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ padding: "16px 10px", opacity: .7 }}>{hasWeekValue(year) && hasWeekValue(week) ? "No picks for this week yet." : "Pick a Year/Week above."}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div role="dialog" aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) closePick(); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
          <div style={{ width: "min(520px, 100%)", height: "100%", background: "#0b1220", borderLeft: "1px solid #1f2a44", padding: 16, overflow: "auto" }}>
            <Row style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>Pick — {selected.firstName || ""} {selected.lastName || ""}</h3>
              <button style={adminBtn("neutral")} onClick={closePick}>Close</button>
            </Row>
            <div style={{ height: 12 }} />
            <Card>
              <Row style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Doc ID</div>
                  <code style={{ fontSize: 12, userSelect: "all" }}>{selected.id}</code>
                </div>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Code</div>
                  <div style={{ fontWeight: 600 }}>{selected.code}</div>
                </div>
              </Row>
              <div style={{ height: 12 }} />
              <div style={{ opacity: .8, fontSize: 12 }}>Name</div>
              <div>{(selected.firstName || "") + " " + (selected.lastName || "")}</div>
              <div style={{ height: 12 }} />
              <Row style={{ gap: 24, flexWrap: "wrap" }}>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Phone</div>
                  <div>{selected.phone || ""}</div>
                </div>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Email</div>
                  <div>{selected.email || ""}</div>
                </div>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Venmo</div>
                  <div>{selected.venmo || ""}</div>
                </div>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Confirmed</div>
                  <div>{selected.venmoConfirmed ? "Yes" : "No"}</div>
                </div>
              </Row>
              <div style={{ height: 12 }} />
              <Row style={{ gap: 24 }}>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Year / Week</div>
                  <div>{String(selected.year)} / W{String(selected.week)}</div>
                </div>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Created</div>
                  <div>{formatPickTs(selected.createdAt)}</div>
                </div>
                <div>
                  <div style={{ opacity: .8, fontSize: 12 }}>Updated</div>
                  <div>{formatPickTs(selected.updatedAt)}</div>
                </div>
              </Row>
            </Card>
            <div style={{ height: 12 }} />
            <Card>
              <h4 style={{ marginTop: 0 }}>Picks</h4>
              <div style={{ fontSize: 13, opacity: .9 }}>
                {selected.picks ? (
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "transparent", padding: 0, margin: 0 }}>
{JSON.stringify(selected.picks, null, 2)}
                  </pre>
                ) : (
                  <em>No picks object found.</em>
                )}
              </div>
            </Card>
            <div style={{ height: 12 }} />
            <Row style={{ justifyContent: "space-between" }}>
              <div style={{ opacity: .7, fontSize: 12 }}>
                {canDelete ? "Deletable while the leaderboard is locked." : "Locked from deletion — the leaderboard is live."}
              </div>
              {canDelete && (
                <button style={adminBtn("danger")} onClick={() => handleDelete(selected)}>Delete Pick</button>
              )}
            </Row>
          </div>
        </div>
      )}
    </Card>
  );
}

// Roster tab: rename anyone (including people who've never been touched
// before - editing an auto-detected row claims it, see
// buildRoster/savePlayerEdit), merge duplicate identities the automatic
// name/Venmo/email matching couldn't catch, toggle email reminders, and
// invite new people who haven't played yet. Everything here writes to
// `players`, which every tab (and My Season/Overall Leaderboard/chat)
// overlays onto the raw picks-derived roster.
function RosterTab({ roster, loaded, notifiedNameKeys, notifiedPlayerIds, submittedRoots, year, week, isMobile }) {
  // One-time conversion of the legacy contacts/unassignedContacts data,
  // gated behind an explicit button (not auto-run) so the migration is
  // visible and verifiable, and behind a flag so it can't run twice.
  const [migrated, setMigrated] = useState(undefined); // undefined = loading
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => setMigrated(!!(s.data() || {}).playersMigratedV1));
    return () => unsub();
  }, []);
  const [migrating, setMigrating] = useState(false);
  const runMigration = async () => {
    setMigrating(true);
    try {
      const count = await migrateLegacyContactsToPlayers();
      alert(`Migrated ${count} legacy contact(s) into Player Profiles.`);
    } catch (err) {
      alert("Migration failed: " + (err?.message || String(err)));
    } finally {
      setMigrating(false);
    }
  };

  const [search, setSearch] = useState("");

  // Which columns to show - Name and the Edit action are always there;
  // everything else can be hidden to fit the table into less width.
  // Remembered per-browser so the choice sticks across visits.
  const [hiddenCols, setHiddenCols] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("playerProfilesHiddenCols") || "[]")); } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem("playerProfilesHiddenCols", JSON.stringify([...hiddenCols])); } catch {}
  }, [hiddenCols]);
  const toggleColVisible = (key) => {
    setHiddenCols(s => { const next = new Set(s); next.has(key) ? next.delete(key) : next.add(key); return next; });
  };
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const visibleColumns = HIDEABLE_COLUMNS.filter(c => !hiddenCols.has(c.key));

  // Click a column header to sort by it, click again to flip direction -
  // defaults to name ascending, same as the old fixed sort.
  const [sortBy, setSortBy] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("asc"); }
  };

  const filteredRows = useMemo(() => {
    const withFlags = roster.rows.map(r => {
      // Checked against every alias the merged identity has ever gone by,
      // not just its current display name - a rename/merge shouldn't
      // silently drop a push-notification match that was already working
      // under an earlier spelling.
      const nameKey = personKey({ firstName: r.firstName, lastName: r.lastName });
      const notified = (r.aliasKeys || []).some(k => notifiedNameKeys.has(k)) || !!(nameKey && notifiedNameKeys.has(nameKey)) || (r.playerId && notifiedPlayerIds.has(r.playerId));
      const submitted = [...r.dsuRoots].some(root => submittedRoots.has(root));
      return { ...r, notified, submitted };
    });

    const cmp = (a, b) => {
      let av, bv;
      switch (sortBy) {
        case "email": av = (a.email || "").toLowerCase(); bv = (b.email || "").toLowerCase(); break;
        case "phone": av = a.phone || ""; bv = b.phone || ""; break;
        case "venmo": av = (a.venmo || "").toLowerCase(); bv = (b.venmo || "").toLowerCase(); break;
        case "notify": av = a.notified ? 2 : a.emailOptOut ? 0 : 1; bv = b.notified ? 2 : b.emailOptOut ? 0 : 1; break;
        case "submitted": av = a.submitted ? 1 : 0; bv = b.submitted ? 1 : 0; break;
        case "name":
        default:
          av = `${a.firstName || ""} ${a.lastName || ""}`.trim().toLowerCase();
          bv = `${b.firstName || ""} ${b.lastName || ""}`.trim().toLowerCase();
      }
      const raw = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? raw : -raw;
    };
    const sorted = withFlags.sort(cmp);

    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(r =>
      `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) ||
      String(r.email || "").toLowerCase().includes(q) ||
      String(r.venmo || "").toLowerCase().includes(q)
    );
  }, [roster, search, notifiedNameKeys, notifiedPlayerIds, submittedRoots, sortBy, sortDir]);

  // Guards every mutating action below against a double-click/double-submit
  // firing the same write twice (confirmed cause of a real merge bug - two
  // near-simultaneous clicks created two player docs, one with a botched
  // alias set, before the first write's result had come back to disable
  // anything). Buttons that mutate are disabled while this is true.
  const [busy, setBusy] = useState(false);
  const runMutation = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const [editingRowId, setEditingRowId] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: "", phone: "", venmo: "", email: "" });
  const startEdit = (row) => {
    setEditingRowId(row.rowId);
    setEditDraft({ name: `${row.firstName || ""} ${row.lastName || ""}`.trim(), phone: row.phone || "", venmo: row.venmo || "", email: row.email || "" });
  };
  const cancelEdit = () => setEditingRowId(null);
  const saveEdit = (row) => runMutation(async () => {
    const parts = editDraft.name.trim().split(/\s+/).filter(Boolean);
    try {
      await savePlayerEdit(row, {
        firstName: parts[0] || "", lastName: parts.slice(1).join(" "),
        phone: editDraft.phone.trim(), venmo: editDraft.venmo.trim(), email: editDraft.email.trim(),
      });
      setEditingRowId(null);
    } catch (err) {
      alert("Couldn't save changes: " + (err?.message || String(err)));
    }
  });

  const toggleEmailOptOut = (row) => runMutation(async () => {
    try {
      if (row.playerId) {
        await setDoc(doc(db, "players", row.playerId), { emailOptOut: !row.emailOptOut, updatedAt: serverTimestamp() }, { merge: true });
      } else {
        await savePlayerEdit(row, { firstName: row.firstName || "", lastName: row.lastName || "", phone: row.phone || "", venmo: row.venmo || "", email: row.email || "", emailOptOut: true });
      }
    } catch (err) {
      alert("Couldn't update opt-out: " + (err?.message || String(err)));
    }
  });

  // Merge: select 2+ rows, confirm the surviving name/phone/venmo/email in a
  // small modal (defaults to the first selection's values), then write one
  // player doc carrying every selected row's alias keys - see
  // mergeRosterRows for how the survivor is chosen.
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSelected = (rowId) => {
    setSelectedIds(s => { const next = new Set(s); next.has(rowId) ? next.delete(rowId) : next.add(rowId); return next; });
  };
  const selectedRows = useMemo(() => filteredRows.filter(r => selectedIds.has(r.rowId)), [filteredRows, selectedIds]);
  const [mergeDraft, setMergeDraft] = useState(null); // { name, phone, venmo, email } | null
  const openMergeModal = () => {
    if (selectedRows.length < 2) return;
    const first = selectedRows[0];
    setMergeDraft({ name: `${first.firstName || ""} ${first.lastName || ""}`.trim(), phone: first.phone || "", venmo: first.venmo || "", email: first.email || "" });
  };
  const confirmMerge = () => runMutation(async () => {
    const parts = mergeDraft.name.trim().split(/\s+/).filter(Boolean);
    try {
      await mergeRosterRows(selectedRows, {
        firstName: parts[0] || "", lastName: parts.slice(1).join(" "),
        phone: mergeDraft.phone.trim(), venmo: mergeDraft.venmo.trim(), email: mergeDraft.email.trim(),
      });
      setSelectedIds(new Set());
      setMergeDraft(null);
    } catch (err) {
      alert("Couldn't merge: " + (err?.message || String(err)));
    }
  });

  // Deletes the player doc itself - only ever offered for rows that have one
  // (an unclaimed, purely picks-derived row has nothing persisted to
  // delete). This does NOT touch their actual picks submissions, so someone
  // who's played before reappears as an unclaimed row afterward, just
  // without whatever name edit/merge/opt-out was set here; only someone
  // with zero picks history (a pure invitee) actually disappears from the
  // roster entirely.
  const deletePlayer = (row) => runMutation(async () => {
    if (!row.playerId) return;
    const label = `${row.firstName || ""} ${row.lastName || ""}`.trim() || row.email || "this player";
    const warning = row.dsuRoots.size > 0
      ? `Delete ${label}'s profile? They've submitted picks before, so they'll still show up (under their raw picks info) - this only clears the name edit / merge / opt-out you've set here.`
      : `Delete ${label}? They have no picks history, so this removes them from the roster entirely.`;
    if (!window.confirm(warning)) return;
    try {
      await deleteDoc(doc(db, "players", row.playerId));
      setSelectedIds(s => { if (!s.has(row.rowId)) return s; const next = new Set(s); next.delete(row.rowId); return next; });
    } catch (err) {
      alert("Couldn't delete: " + (err?.message || String(err)));
    }
  });

  // Same paste-emails intake the old Unassigned Emails section had, now
  // writing straight to `players` instead of a separate collection - there's
  // no more "promoted" step, everyone here is equally in the roster.
  const [addDraft, setAddDraft] = useState("");
  const addPlayers = () => runMutation(async () => {
    const knownEmails = new Set(roster.rows.map(r => String(r.email || "").trim().toLowerCase()).filter(Boolean));
    const emails = [...new Set(addDraft.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(s => s && s.includes("@")))]
      .filter(e => !knownEmails.has(e));
    if (emails.length === 0) { setAddDraft(""); return; }
    try {
      await Promise.all(emails.map(e => setDoc(doc(collection(db, "players")), {
        firstName: "", lastName: "", phone: "", venmo: "", email: e,
        aliasKeys: [emailKeyOf({ email: e })].filter(Boolean),
        emailOptOut: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      })));
      setAddDraft("");
    } catch (err) {
      alert("Couldn't add: " + (err?.message || String(err)));
    }
  });

  // One cell renderer per column key, shared by the header-driven table body
  // below so hiding a column (see HIDEABLE_COLUMNS/hiddenCols) doesn't need
  // its own separate branch - the body just skips whatever's not in
  // visibleColumns.
  const renderDataCell = (row, colKey) => {
    switch (colKey) {
      case "name": return `${row.firstName || ""} ${row.lastName || ""}`.trim() || "—";
      case "email": return row.email || "—";
      case "phone": return row.phone || "—";
      case "venmo": return row.venmo || "—";
      case "notify": return row.notified ? (
        <StatusBadge tone="neutral">📱 Phone</StatusBadge>
      ) : (
        <button
          style={{ ...adminBtn(row.emailOptOut ? "neutral" : "success"), padding:"4px 8px", fontSize:12 }}
          title={row.emailOptOut ? "Excluded from email reminders — click to opt back in" : "Currently receives email reminders — click to opt out"}
          onClick={() => toggleEmailOptOut(row)}
          disabled={busy}
        >
          {row.emailOptOut ? "Opted out" : "✉️ Email"}
        </button>
      );
      case "submitted": return hasWeekValue(year) && hasWeekValue(week) ? (
        row.submitted ? <StatusBadge tone="success">✓ Submitted</StatusBadge> : <span style={{ opacity:.4, fontSize:12 }}>—</span>
      ) : null;
      default: return null;
    }
  };
  const renderEditCell = (colKey) => {
    switch (colKey) {
      case "name": return <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:140 }} placeholder="name" value={editDraft.name} onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} />;
      case "email": return <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:160 }} type="email" placeholder="email" value={editDraft.email} onChange={e => setEditDraft(d => ({ ...d, email: e.target.value }))} />;
      case "phone": return <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:120 }} placeholder="phone" value={editDraft.phone} onChange={e => setEditDraft(d => ({ ...d, phone: e.target.value }))} />;
      case "venmo": return <input style={{ ...inputStyle, padding:"4px 8px", fontSize:12, width:120 }} placeholder="venmo" value={editDraft.venmo} onChange={e => setEditDraft(d => ({ ...d, venmo: e.target.value }))} />;
      default: return null;
    }
  };

  return (<>
    <Card style={{ maxWidth: 1200, marginTop: 16, padding: isMobile ? 12 : 16 }}>
      {migrated === false && (
        <div style={{ marginBottom:14, padding:"10px 12px", borderRadius:10, background:"rgba(240,180,41,.1)", border:"1px solid rgba(240,180,41,.3)", color:"#f0b429", fontSize:13, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
          <span>One-time setup: import existing contact overrides, opt-outs, and promoted invitees into Player Profiles.</span>
          <button style={adminBtn("warning")} onClick={runMigration} disabled={migrating}>{migrating ? "Migrating…" : "Run one-time migration"}</button>
        </div>
      )}
      <Row style={{ gap:16, alignItems:"flex-end", flexWrap:"wrap" }}>
        <Field label="Search"><input style={{...inputStyle, width:240}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name, email, or venmo…" /></Field>
        <button style={adminBtn("neutral")} onClick={() => setShowColumnMenu(s => !s)}>Columns {showColumnMenu ? "▲" : "▼"}</button>
        {selectedRows.length >= 2 && (
          <button style={adminBtn("primary")} onClick={openMergeModal}>Merge Selected ({selectedRows.length})</button>
        )}
      </Row>

      {showColumnMenu && (
        <div style={{ marginTop:10, padding:"10px 12px", borderRadius:10, border:"1px solid #2a3655", background:"#141a30", display:"flex", gap:16, flexWrap:"wrap" }}>
          {HIDEABLE_COLUMNS.filter(c => c.key !== "name").map(c => (
            <label key={c.key} style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color:"#cfd8f0", cursor:"pointer" }}>
              <input type="checkbox" checked={!hiddenCols.has(c.key)} onChange={() => toggleColVisible(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}

      <div style={{ marginTop:14, overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:420, fontSize:13 }}>
          <thead>
            <tr style={{ textAlign:"left" }}>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44", width:28 }}></th>
              {visibleColumns.map(({ key, label }) => (
                <th
                  key={key}
                  style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44", cursor:"pointer", userSelect:"none", whiteSpace:"nowrap" }}
                  onClick={() => toggleSort(key)}
                  title={`Sort by ${label}`}
                >
                  {label}{sortBy === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44", position:"sticky", right:0, background:"#121a2b", boxShadow:"-4px 0 6px -4px rgba(0,0,0,.4)" }}></th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(row => {
              const isEditing = editingRowId === row.rowId;
              return (
                <tr key={row.rowId} style={{ borderBottom:"1px solid #1f2a44" }}>
                  <td style={{ padding:"8px 10px" }}>
                    {!isEditing && <input type="checkbox" checked={selectedIds.has(row.rowId)} onChange={() => toggleSelected(row.rowId)} style={{ cursor:"pointer" }} />}
                  </td>
                  {visibleColumns.map(({ key }) => (
                    <td key={key} style={{ padding:"8px 10px", opacity: key === "name" || isEditing ? 1 : .9 }}>
                      {isEditing ? renderEditCell(key) : renderDataCell(row, key)}
                    </td>
                  ))}
                  <td style={{ padding:"8px 10px", position:"sticky", right:0, background:"#121a2b", boxShadow:"-4px 0 6px -4px rgba(0,0,0,.4)" }}>
                    {isEditing ? (
                      <div style={{ display:"flex", gap:6 }}>
                        <button style={{ ...adminBtn("success"), padding:"4px 8px", fontSize:12 }} onClick={() => saveEdit(row)} disabled={busy}>Save</button>
                        <button style={{ ...adminBtn("neutral"), padding:"4px 8px", fontSize:12 }} onClick={cancelEdit}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display:"flex", gap:6 }}>
                        <button style={{ ...adminBtn("neutral"), padding:"4px 8px", fontSize:12 }} onClick={() => startEdit(row)}>Edit</button>
                        {row.playerId && (
                          <button style={{ ...adminBtn("danger"), padding:"4px 8px", fontSize:12 }} onClick={() => deletePlayer(row)} disabled={busy}>Delete</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {loaded && filteredRows.length === 0 && (
              <tr><td colSpan={visibleColumns.length + 2} style={{ padding:"16px 10px", opacity:.7 }}>No matches.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>

    <Card style={{ maxWidth: 1200, marginTop: 16, padding: isMobile ? 12 : 16 }}>
      <h3 style={{ margin: 0 }}>Add New Player</h3>
      <p style={{ margin: "10px 0 0", fontSize: 13, color: "#9aa4c7" }}>
        For invitees who haven't played yet. Paste any number of emails below (comma, space, or newline separated) - fill in their name afterward with Edit.
      </p>
      <Row style={{ marginTop: 14, gap: 10, alignItems: "flex-start" }}>
        <textarea
          style={{ ...inputStyle, flex: 1, minHeight: 70, fontFamily: "inherit", resize: "vertical" }}
          placeholder="jane@example.com, john@example.com..."
          value={addDraft}
          onChange={e => setAddDraft(e.target.value)}
        />
        <button style={adminBtn("primary")} onClick={addPlayers} disabled={busy}>Add</button>
      </Row>
    </Card>

    {mergeDraft && (
      <ModalOverlay>
        <Card style={{ padding:18, width:"min(420px, 92vw)", margin:"0 auto" }}>
          <h3 style={{ margin:"0 0 4px", fontSize:16 }}>Merge {selectedRows.length} players into one</h3>
          <p style={{ margin:"0 0 14px", fontSize:12, color:"#9aa4c7" }}>
            {selectedRows.map(r => `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email || "—").join(" + ")}
          </p>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            <Field label="Name"><input style={inputStyle} value={mergeDraft.name} onChange={e=>setMergeDraft(d=>({...d, name:e.target.value}))} /></Field>
            <Field label="Email"><input style={inputStyle} type="email" value={mergeDraft.email} onChange={e=>setMergeDraft(d=>({...d, email:e.target.value}))} /></Field>
            <Field label="Phone"><input style={inputStyle} value={mergeDraft.phone} onChange={e=>setMergeDraft(d=>({...d, phone:e.target.value}))} /></Field>
            <Field label="Venmo"><input style={inputStyle} value={mergeDraft.venmo} onChange={e=>setMergeDraft(d=>({...d, venmo:e.target.value}))} /></Field>
          </div>
          <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:16 }}>
            <button style={adminBtn("neutral")} onClick={() => setMergeDraft(null)} disabled={busy}>Cancel</button>
            <button style={adminBtn("primary")} onClick={confirmMerge} disabled={busy}>{busy ? "Merging…" : "Merge"}</button>
          </div>
        </Card>
      </ModalOverlay>
    )}
  </>);
}

// Who's Missing tab: today's submissions vs. everyone who's ever played, by
// name - plus the two Gmail-draft reminder buttons.
function MissingTab({ roster, loaded, notifiedNameKeys, notifiedPlayerIds, submittedRoots, year, week, isMobile }) {
  // This week's earliest kickoff, so the intro email draft can quote the
  // real submission deadline instead of a hardcoded date.
  const [weekGames, setWeekGames] = useState([]);
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) { setWeekGames([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const gs = await listGames({ year, week, includedOnly: true });
        if (!cancelled) setWeekGames(gs || []);
      } catch (e) {
        if (!cancelled) setWeekGames([]);
      }
    })();
    return () => { cancelled = true; };
  }, [year, week]);
  const earliestGame = useMemo(() => {
    const arr = (weekGames || [])
      .map(g => ({ g, d: kickoffDate(g) }))
      .filter(x => x.d instanceof Date && !isNaN(x.d));
    arr.sort((a,b) => a.d - b.d);
    return arr[0]?.g || null;
  }, [weekGames]);
  const deadlineLabel = earliestGame ? kickoffLabel(earliestGame, { timeZone: "America/New_York" }) : "TBD";

  const missing = useMemo(() => {
    return roster.rows
      .filter(r => ![...r.dsuRoots].some(root => submittedRoots.has(root)))
      .map(r => {
        const nameKey = personKey({ firstName: r.firstName, lastName: r.lastName });
        const notified = (r.aliasKeys || []).some(k => notifiedNameKeys.has(k)) || !!(nameKey && notifiedNameKeys.has(nameKey)) || (r.playerId && notifiedPlayerIds.has(r.playerId));
        return { ...r, notified, excluded: r.emailOptOut || notified };
      })
      .sort((a, b) => (a.lastName || "").localeCompare(b.lastName || "") || (a.firstName || "").localeCompare(b.firstName || ""));
  }, [roster, submittedRoots, notifiedNameKeys, notifiedPlayerIds]);

  const totalEver = roster.rows.length;
  const submittedCount = totalEver - missing.length;

  const missingEmails = useMemo(() => [...new Set(missing.filter(p => !p.excluded).map(p => String(p.email || "").trim()).filter(Boolean))], [missing]);

  const openGmailDraft = () => {
    if (missingEmails.length === 0) { alert("No email addresses on file for anyone missing."); return; }
    const subject = `Reminder: Submit your Week ${week} picks!`;
    const body = `Hey! Just a friendly reminder that you haven't submitted your picks for Week ${week} yet.\n\nGet them in here: https://cfbpickems.web.app\n\nDon't wait until the last minute!\n\n- Zack`;
    const url = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&bcc=${encodeURIComponent(missingEmails.join(","))}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const openIntroEmailDraft = () => {
    if (missingEmails.length === 0) { alert("No email addresses on file for anyone missing."); return; }
    if (deadlineLabel === "TBD") { alert("Couldn't determine this week's deadline yet (games haven't loaded). Try again in a moment."); return; }
    const subject = `CFB Pick 'Ems: Week 1 is officially open!`;
    const body = `COLLEGE FOOTBALL is BACK!\n\nWeek 1 is finally here, and the CFB Pick 'Ems is officially open.\n\nNew link — update your bookmarks:\nhttps://cfbpickems.web.app\n\nGet your picks in before ${deadlineLabel}.\n\nThe app has some brand new features to make it easier!:\n\n• Autosave — your picks save automatically as you go, so no more losing everything because you closed the tab\n• Autofill — returning players should see their information autofilled after entering their first and last name\n• Add to Home Screen — drop the site on your phone's home screen and it opens like a real app. No more digging for the link every week.\n• Notifications — turn on push notifications right in the app for picks opening, deadlines, and results.\n\nSpeaking of notifications — if you'd rather get reminders as app notifications instead of email this year, just let me know and I'll switch you over.\n\nIf you're receiving this email and have already enrolled in notifications, click the bell icon on the app and send me a screenshot of the device code.\n\nIf you want to be opted out just reply "STOP".\n\nAlright, let's have a great season. Good luck!\n\n- Zack`;
    const url = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&bcc=${encodeURIComponent(missingEmails.join(","))}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Card style={{ maxWidth: 900, marginTop: 16, padding: isMobile ? 12 : 16 }}>
      <p style={{ margin:"0 0 10px", fontSize:13, color:"#9aa4c7" }}>
        Compares this week's submissions against everyone who's ever played, by name.
      </p>
      {loaded && (
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
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
          {missing.length > 0 && (
            <button style={adminBtn("neutral")} onClick={openIntroEmailDraft} title="Opens a Gmail compose window with the season-opening intro email, BCC'd to everyone missing an email on file — nothing sends automatically">
              ✉️ Email Intro
            </button>
          )}
        </div>
      )}

      <div style={{ marginTop:14, overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:420 }}>
          <thead>
            <tr style={{ textAlign:"left" }}>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Name</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Email</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Phone</th>
              <th style={{ padding:"8px 10px", borderBottom:"1px solid #1f2a44" }}>Venmo</th>
            </tr>
          </thead>
          <tbody>
            {missing.map(p => (
              <tr key={p.rowId} style={{ borderBottom:"1px solid #1f2a44" }}>
                <td style={{ padding:"8px 10px" }}>{`${p.firstName || ""} ${p.lastName || ""}`.trim()}</td>
                <td style={{ padding:"8px 10px", opacity: p.excluded ? 0.5 : .9 }}>
                  {p.email || "—"}
                  {p.notified
                    ? <span style={{ marginLeft:6, fontSize:11, color:"#6aa2ff" }} title="Has push notifications enabled — treated as opted out of email">🔔 opted out (phone)</span>
                    : p.emailOptOut && <span style={{ marginLeft:6, fontSize:11, color:"#f0b429" }}>(opted out)</span>}
                </td>
                <td style={{ padding:"8px 10px", opacity:.9 }}>{p.phone}</td>
                <td style={{ padding:"8px 10px", opacity:.9 }}>{p.venmo}</td>
              </tr>
            ))}
            {loaded && missing.length === 0 && (
              <tr><td colSpan={4} style={{ padding:"16px 10px", opacity:.7 }}>Everyone who's ever played has submitted for {year} / W{week}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// Devices tab: every push-notification device - rename, block, message,
// tie to a player, or clean up stale ones.
function DevicesTab({ pushDevices, roster, rosterOptions, assignDeviceToPlayer, submittedRoots, setMsg, isMobile }) {
  const deviceBtnHalf = isMobile ? { flexBasis: "calc(50% - 4px)" } : undefined;

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
  async function toggleDeviceAdmin(token, isAdminFlag) {
    try {
      await setDoc(doc(db, "pushTokens", token), { isAdmin: isAdminFlag }, { merge: true });
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

  // Whether this device's person has submitted for the currently-selected
  // week - matched the same way notified-matching works (assignedPlayerId
  // first, else by name), then checked against the shared submittedRoots
  // set, instead of a separate per-week token/name query.
  const deviceSubmitted = (d) => {
    let row = null;
    if (d.assignedPlayerId) row = roster.rows.find(r => r.playerId === d.assignedPlayerId);
    if (!row && d.name) {
      const parts = d.name.trim().split(/\s+/).filter(Boolean);
      const nk = personKey({ firstName: parts[0], lastName: parts.slice(1).join(" ") });
      if (nk) row = roster.rows.find(r => (r.aliasKeys || []).includes(nk));
    }
    if (!row) return false;
    return [...row.dsuRoots].some(root => submittedRoots.has(root));
  };

  // Per-device targeted notification (vs. the broadcast "Send a Notification"
  // on the Notifications page) - same notificationOutbox trigger, but tagged
  // with a targetToken so the Cloud Function delivers to just that one
  // device.
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

  return (
    <Card style={{ maxWidth: 1200, marginTop: 16, padding: isMobile ? 12 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginBottom:12 }}>
        <p style={{ margin:0, fontSize:13, color:"#9aa4c7" }}>
          Every device that's enabled notifications. Devices are only labeled with a name once that browser submits picks &mdash; otherwise they show as unknown. Blocking a device stops every notification (automated and custom) from reaching it.
        </p>
        <StatusBadge tone="neutral">{pushDevices.length} registered</StatusBadge>
      </div>
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
            const submitted = deviceSubmitted(d);
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
                    <div style={{ marginTop:6, display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:11, color:"#9aa4c7" }}>Notifies as:</span>
                      <select
                        style={{ ...inputStyle, padding:"3px 6px", fontSize:12, maxWidth:220 }}
                        value={d.assignedPlayerId || ""}
                        onChange={e => assignDeviceToPlayer(d.token, e.target.value || null)}
                        title="Directly ties this device to a Player Profile, independent of name-matching - use this for an unknown device, or one whose name doesn't match anyone cleanly"
                      >
                        <option value="">— auto (by name match) —</option>
                        {rosterOptions.map(o => <option key={o.rowId} value={o.rowId}>{o.label}</option>)}
                      </select>
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
    </Card>
  );
}

// Chat tab: every device that's claimed a chat display name (locked per
// firestore.rules once created) - rename/unlock a stuck one, or block a
// message-spamming one.
function ChatTab({ chatDevices, setMsg }) {
  const [editingChatDeviceId, setEditingChatDeviceId] = useState(null);
  const [chatDeviceNameDraft, setChatDeviceNameDraft] = useState("");
  async function renameChatDevice(id) {
    try {
      await setDoc(doc(db, "chatDevices", id), { name: chatDeviceNameDraft.trim() }, { merge: true });
      setEditingChatDeviceId(null);
    } catch (e) {
      setMsg("Failed to rename chat name: " + (e?.message || String(e)));
    }
  }
  async function unlockChatDevice(id, label) {
    if (!window.confirm(`Unlock ${label || "this device"}? It'll be asked to pick a name again next time it opens chat.`)) return;
    try {
      await deleteDoc(doc(db, "chatDevices", id));
    } catch (e) {
      setMsg("Failed to unlock device: " + (e?.message || String(e)));
    }
  }
  // Blocked devices keep their claimed name (so past messages still show
  // correctly) but the create rule rejects any new message from them - see
  // firestore.rules' chatMessages create rule, which checks this flag.
  async function toggleChatDeviceBlocked(id, blocked) {
    try {
      await setDoc(doc(db, "chatDevices", id), { blocked }, { merge: true });
    } catch (e) {
      setMsg("Failed to update chat device: " + (e?.message || String(e)));
    }
  }

  return (
    <Card style={{ maxWidth: 900, marginTop: 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginBottom:10 }}>
        <p style={{ margin: 0, fontSize: 13, color: "#9aa4c7" }}>
          Each device locks to a name the first time it uses chat. Rename or unlock a stuck one here, or block a device to stop it posting (it keeps its name and past messages - only new messages are rejected).
        </p>
        <StatusBadge tone="neutral">{chatDevices.length} claimed</StatusBadge>
      </div>
      {chatDevices.length === 0 ? (
        <p style={{ fontSize: 13, color: "#9aa4c7" }}>No one has used chat yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {chatDevices.map(d => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 8px", background: "#141a30", borderRadius: 8, flexWrap: "wrap" }}>
              {editingChatDeviceId === d.id ? (
                <Row style={{ flex: 1 }}>
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    value={chatDeviceNameDraft}
                    onChange={e => setChatDeviceNameDraft(e.target.value)}
                    autoFocus
                  />
                  <button style={adminBtn("primary")} onClick={() => renameChatDevice(d.id)}>Save</button>
                  <button style={adminBtn("neutral")} onClick={() => setEditingChatDeviceId(null)}>Cancel</button>
                </Row>
              ) : (
                <>
                  <div style={{ fontSize: 13 }}>
                    {d.name}
                    {d.verified && <span title="Verified via email" style={{ marginLeft: 4 }}>✓</span>}
                    {d.linkedFromPushToken && <span style={{ marginLeft: 6, opacity: 0.6 }}>(from notifications)</span>}
                    {d.blocked && <StatusBadge tone="danger" style={{ marginLeft: 8 }}>Blocked</StatusBadge>}
                  </div>
                  <Row>
                    <button style={adminBtn("neutral")} onClick={() => { setEditingChatDeviceId(d.id); setChatDeviceNameDraft(d.name || ""); }}>Rename</button>
                    <button style={adminBtn(d.blocked ? "primary" : "warning")} onClick={() => toggleChatDeviceBlocked(d.id, !d.blocked)}>
                      {d.blocked ? "Unblock" : "Block"}
                    </button>
                    <button style={adminBtn("danger")} onClick={() => unlockChatDevice(d.id, d.name)}>Unlock</button>
                  </Row>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Sortable/hideable columns on the Roster tab's table, in display order.
// Name is intentionally not in this list - it's the one column that's
// always shown, everything else can be toggled off to fit the table into
// less width.
const HIDEABLE_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "venmo", label: "Venmo" },
  { key: "notify", label: "Notify" },
  { key: "submitted", label: "Submitted" },
];

// Look up everything a person has ever submitted, across all years/weeks -
// there's no login/account system, so this is the only way to tie someone's
// weeks together. Uses the same buildRoster identity resolution as Player
// Profiles/Who Hasn't Submitted (name/Venmo/email clustering, overlaid with
// any `players` doc), so a manual merge there (e.g. two differently-spelled
// submissions the automatic matching couldn't tell were the same person)
// surfaces someone's full season here too, not just whichever spelling they
// happen to search with.
async function findMySeason({ firstName, lastName, venmo }) {
  const ln = (lastName || "").trim().toLowerCase();
  if (!ln) throw new Error("Enter your last name.");

  const targetKey = venmoKeyOf({ venmo }) || personKey({ firstName, lastName });
  if (!targetKey) throw new Error("Enter your first and last name.");

  const [picksSnap, playersSnap] = await Promise.all([
    getDocs(collection(db, "picks")),
    getDocs(collection(db, "players")),
  ]);
  const allPicks = []; picksSnap.forEach(d => allPicks.push(d.data()));
  const players = []; playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));

  const roster = buildRoster(allPicks, players);
  const targetRoot = roster.dsu.find(targetKey);
  const row = roster.rows.find(r => r.playerId ? r.aliasKeys.includes(targetKey) : r.dsuRoots.has(targetRoot));
  if (!row) return { weeks: [] };
  const mine = docsForRosterRow(roster, row);
  if (mine.length === 0) return { weeks: [] };

  // One entry per year/week (in case of duplicate submissions, keep the latest).
  const byWeek = new Map();
  for (const p of mine) {
    const wk = `${p.year}_${p.week}`;
    const ms = p.updatedAt?.toMillis ? p.updatedAt.toMillis() : (p.createdAt?.toMillis ? p.createdAt.toMillis() : 0);
    const existing = byWeek.get(wk);
    if (!existing || ms >= existing._ms) byWeek.set(wk, { year: Number(p.year), week: Number(p.week), email: p.email, _ms: ms });
  }
  const weekRefs = [...byWeek.values()].sort((a, b) => a.year - b.year || a.week - b.week);

  const weeks = await Promise.all(weekRefs.map(async (wr) => {
    const { rows, totalGames } = await computeWeekStandings(wr.year, wr.week);
    const mineRow = rows.find(r => r.email && wr.email && r.email === wr.email) || null;
    // A tied-for-1st week (pot split) credits a fractional win - e.g. 0.5
    // apiece for a two-way tie - instead of a full win each.
    const coWinnerCount = rows.filter(r => r.isWinner).length || 1;
    // Standard competition ranking (ties share a place) - same formula used
    // by computeAllTimePercentiles for the all-time stat.
    const place = mineRow ? 1 + rows.filter(x => x.points > mineRow.points).length : null;
    return {
      year: wr.year, week: wr.week,
      points: mineRow?.points ?? null,
      totalGames,
      place,
      fieldSize: rows.length,
      isWinner: !!mineRow?.isWinner,
      winCredit: mineRow?.isWinner ? 1 / coWinnerCount : 0,
      winNote: mineRow?.winNote || null,
    };
  }));
  weeks.sort((a, b) => b.year - a.year || b.week - a.week); // most recent first
  return { weeks };
}

// Cross-referenced by both MySeasonPage (one person's percentile) and
// OverallLeaderboardPage (everyone's ranking): each person's "average
// finish" is the mean of (place/fieldSize) across every week they've
// played - place uses the same standard competition ranking (ties share a
// place) computeWeekStandings already sorts rows by - so a 5th out of 10
// and an 8th out of 20 both mean "finished in the top half." Lower is
// better. Ranked against everyone else who's played more than 5 weeks.
// yearFilter: null/omitted ranks all-time (weeksPlayed > 5, existing
// behavior). A specific year ranks just that season - >=3 weeks played,
// except when that year is the currently-live one, where anyone who's
// played at all is included (a season in progress hasn't had a chance to
// reach 3 weeks yet).
async function computeAllTimePercentiles({ yearFilter = null, currentYear = null, minPlayedOverride = null } = {}) {
  const [picksSnap, playersSnap] = await Promise.all([
    getDocs(collection(db, "picks")),
    getDocs(collection(db, "players")),
  ]);
  const allPicks = [];
  picksSnap.forEach(d => allPicks.push(d.data()));
  const players = [];
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
  const keyToPlayerId = new Map();
  for (const pl of players) for (const k of pl.aliasKeys || []) keyToPlayerId.set(k, pl.id);

  const dsu = makeDSU();
  for (const p of allPicks) {
    const nk = personKey(p);
    const vk = venmoKeyOf(p);
    const ek = emailKeyOf(p);
    if (!nk && !vk) continue;
    if (nk && vk) dsu.union(nk, vk);
    if (ek) dsu.union(nk || vk, ek);
  }

  const weekKeys = new Map();
  for (const p of allPicks) {
    if (!hasWeekValue(p.year) || !hasWeekValue(p.week)) continue;
    if (yearFilter != null && Number(p.year) !== Number(yearFilter)) continue;
    const wk = `${p.year}_${p.week}`;
    if (!weekKeys.has(wk)) weekKeys.set(wk, { year: Number(p.year), week: Number(p.week) });
  }

  const weekStandings = await Promise.all(
    [...weekKeys.values()].map(async ({ year, week }) => ({ year, week, ...(await computeWeekStandings(year, week)) }))
  );

  const agg = new Map(); // dsu root -> aggregate
  for (const { year, week, rows } of weekStandings) {
    const fieldSize = rows.length;
    if (!fieldSize) continue;
    // A week with multiple co-winners (pot split) credits each of them a
    // fractional win (e.g. 0.5 apiece for a two-way tie) instead of a full
    // win each, so the total credited per week always sums to 1.
    const winnerNames = rows.filter(x => x.isWinner).map(x => x.name);
    const coWinnerCount = winnerNames.length || 1;
    for (const r of rows) {
      const nk = personKey(r);
      const vk = venmoKeyOf(r);
      const ek = emailKeyOf(r);
      const key = nk || vk;
      if (!key) continue;
      const root = dsu.find(key);
      const place = 1 + rows.filter(x => x.points > r.points).length;
      if (!agg.has(root)) agg.set(root, { nameCounts: new Map(), weeksPlayed: 0, weeksWon: 0, ratioSum: 0, keys: new Set(), wonWeeks: [] });
      const a = agg.get(root);
      a.weeksPlayed += 1;
      if (r.isWinner) {
        a.weeksWon += 1 / coWinnerCount;
        a.wonWeeks.push({
          year, week,
          coWinners: winnerNames.filter(n => n !== r.name),
          winNote: r.winNote || null,
        });
      }
      a.ratioSum += place / fieldSize;
      if (nk) a.keys.add(nk);
      if (vk) a.keys.add(vk);
      if (ek) a.keys.add(ek);
      // Display name is whichever spelling they used most often - a single
      // joke entry (e.g. "bigsot money 1000000") shouldn't outrank the name
      // used on every other week just because it's a longer string.
      if (r.name) a.nameCounts.set(r.name, (a.nameCounts.get(r.name) || 0) + 1);
    }
  }

  // Overlay `players` on top of the automatic clustering above - two agg
  // entries that are the same real person per a manual merge (which the
  // automatic name/Venmo/email matching alone couldn't tell) combine into
  // one leaderboard entry instead of showing up as two.
  const merged = new Map(); // playerId-or-root -> combined aggregate
  for (const [root, a] of agg) {
    let playerId = null;
    for (const k of a.keys) { const pid = keyToPlayerId.get(k); if (pid) { playerId = pid; break; } }
    const mergeKey = playerId || root;
    const existing = merged.get(mergeKey);
    if (!existing) {
      merged.set(mergeKey, { playerId, nameCounts: new Map(a.nameCounts), weeksPlayed: a.weeksPlayed, weeksWon: a.weeksWon, ratioSum: a.ratioSum, keys: new Set(a.keys), wonWeeks: [...a.wonWeeks] });
    } else {
      existing.weeksPlayed += a.weeksPlayed;
      existing.weeksWon += a.weeksWon;
      existing.ratioSum += a.ratioSum;
      existing.wonWeeks.push(...a.wonWeeks);
      for (const k of a.keys) existing.keys.add(k);
      for (const [nm, c] of a.nameCounts) existing.nameCounts.set(nm, (existing.nameCounts.get(nm) || 0) + c);
    }
  }

  const list = [...merged.values()]
    .map(a => {
      let name = "", bestCount = -1;
      for (const [nm, c] of a.nameCounts) {
        if (c > bestCount || (c === bestCount && nm.length > name.length)) { name = nm; bestCount = c; }
      }
      // A matched player's own edited name wins over the "most common
      // spelling" heuristic above - that heuristic only exists to pick a
      // sane default for people nobody's renamed yet.
      if (a.playerId) {
        const pl = players.find(x => x.id === a.playerId);
        const plName = pl ? `${pl.firstName || ""} ${pl.lastName || ""}`.trim() : "";
        if (plName) name = plName;
      }
      return {
        name, weeksPlayed: a.weeksPlayed, weeksWon: Math.round(a.weeksWon * 100) / 100,
        avgFinishPct: (a.ratioSum / a.weeksPlayed) * 100,
        keys: a.keys,
        wonWeeks: a.wonWeeks.sort((x, y) => y.year - x.year || y.week - x.week),
      };
    });

  const minPlayed = minPlayedOverride != null ? minPlayedOverride
    : yearFilter == null ? 5 : (currentYear != null && Number(yearFilter) === Number(currentYear)) ? 0 : 2;
  const filtered = list
    .filter(p => p.weeksPlayed > minPlayed)
    .sort((a, b) => a.avgFinishPct - b.avgFinishPct);

  const n = filtered.length;
  filtered.forEach((p, i) => {
    p.rank = i + 1;
    p.percentile = n > 1 ? Math.round(100 * (1 - (p.rank - 1) / (n - 1))) : 100;
  });

  return filtered;
}

function ordinalSuffix(n) {
  const v = Math.abs(n) % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (Math.abs(n) % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// Same red/amber/green grading the old per-week record bar used, just keyed
// off where they placed in the field that week instead of pick percentage.
function placeColor(place, fieldSize) {
  if (place == null || !fieldSize) return "#8590b0";
  const frac = place / fieldSize;
  return frac <= 0.34 ? "#3ecf8e" : frac <= 0.67 ? "#f0b429" : "#f0596b";
}

function MySeasonStatTile({ tone, value, label }) {
  const t = ADMIN_TONES[tone] || ADMIN_TONES.neutral;
  return (
    <div style={{
      flex: "0 1 150px", minWidth: 130, maxWidth: 200, borderRadius: 14, padding: "14px 16px",
      background: `${t.dot}14`, border: `1px solid ${t.dot}40`,
    }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: "#fff", lineHeight: 1.1 }}>{value}</div>
      <div style={{ marginTop: 4, fontSize: 12.5, color: t.dot, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function MySeasonPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [venmo, setVenmo] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [weeks, setWeeks] = useState(null);
  const [percentileInfo, setPercentileInfo] = useState(null); // { percentile, rank, total } | null

  // Special-week display names ("Conference Champs", "Bowls", etc.), same
  // source LeaderboardPage's Year/Week selector reads from.
  const [weekLabels, setWeekLabels] = useState({});
  useEffect(() => {
    (async () => {
      try {
        const s = await getDoc(doc(db, "config", "seasons"));
        setWeekLabels(s.exists() ? (s.data().weekLabels || {}) : {});
      } catch (err) {
        console.error("config/seasons load failed", err);
      }
    })();
  }, []);
  const weekLabelFor = (y, w) => weekLabels[`${y}_${w}`] || `Week ${w}`;

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus("loading"); setError(""); setWeeks(null); setPercentileInfo(null);
    try {
      const [result, allTime] = await Promise.all([
        findMySeason({ firstName, lastName, venmo }),
        computeAllTimePercentiles(),
      ]);
      setWeeks(result.weeks);
      const nk = personKey({ firstName, lastName });
      const vk = venmoKeyOf({ venmo });
      const mine = allTime.find(p => (nk && p.keys.has(nk)) || (vk && p.keys.has(vk)));
      setPercentileInfo(mine ? { percentile: mine.percentile, rank: mine.rank, total: allTime.length } : null);
      setStatus("done");
    } catch (err) {
      setError(err?.message || "Something went wrong looking that up.");
      setStatus("error");
    }
  };

  const weeksWon = weeks ? Math.round(weeks.reduce((sum, w) => sum + (w.winCredit || 0), 0) * 100) / 100 : 0;

  // Longest win streak runs over weeks actually played, in chronological
  // order - a bye doesn't break it, but a played-and-lost week does.
  const longestWinStreak = useMemo(() => {
    if (!weeks) return 0;
    const chrono = [...weeks].sort((a, b) => a.year - b.year || a.week - b.week);
    let best = 0, cur = 0;
    for (const w of chrono) { cur = w.isWinner ? cur + 1 : 0; if (cur > best) best = cur; }
    return best;
  }, [weeks]);

  // Weeks already arrive most-recent-first from findMySeason; group them by
  // year for display so each season reads as its own block.
  const byYear = useMemo(() => {
    const m = new Map();
    for (const w of weeks || []) {
      if (!m.has(w.year)) m.set(w.year, []);
      m.get(w.year).push(w);
    }
    return [...m.entries()]; // years already descending, since weeks are
  }, [weeks]);

  return (<Container maxWidth={760} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ padding: isMobile ? 12 : 16 }}>
      <h2 style={{ margin: 0, fontSize: 24 }}>🏈 My Season</h2>
      <p style={{ margin: "8px 0 0", fontSize: 13, color: "#9aa4c7", lineHeight: 1.5 }}>
        See every week you've played, your record, and any weeks you've won. We match you by name and Venmo — the same edit code you use each week doesn't carry over between weeks.
      </p>

      <form onSubmit={onSubmit}>
        {isMobile ? (
          <>
            <Row style={{ marginTop: 18, gap: 14 }}>
              <Field style={{ flex: 1 }} label="First name"><input style={{ ...inputStyle, width: "100%" }} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" /></Field>
              <Field style={{ flex: 1 }} label="Last name"><input style={{ ...inputStyle, width: "100%" }} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Smith" /></Field>
            </Row>
            <Row style={{ marginTop: 14, gap: 14 }}>
              <Field style={{ flex: 1 }} label="Venmo (optional)"><input style={{ ...inputStyle, width: "100%" }} value={venmo} onChange={e => setVenmo(e.target.value)} placeholder="@jane-smith" /></Field>
            </Row>
          </>
        ) : (
          <Row style={{ marginTop: 18, gap: 14 }}>
            <Field style={{ flex: 1 }} label="First name"><input style={{ ...inputStyle, width: "100%" }} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jane" /></Field>
            <Field style={{ flex: 1 }} label="Last name"><input style={{ ...inputStyle, width: "100%" }} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Smith" /></Field>
            <Field style={{ flex: 1 }} label="Venmo (optional)"><input style={{ ...inputStyle, width: "100%" }} value={venmo} onChange={e => setVenmo(e.target.value)} placeholder="@jane-smith" /></Field>
          </Row>
        )}
        <button type="submit" style={{ marginTop: 14, padding: "10px 20px", borderRadius: 10, border: "1px solid #1f2a44", background: "#6aa2ff", color: "#07152b", fontWeight: 700, fontSize: 14.5, cursor: "pointer" }} disabled={status === "loading"}>
          {status === "loading" ? "Looking…" : "Find My Season"}
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
          <div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <MySeasonStatTile tone="neutral" value={weeks.length} label={`WEEK${weeks.length === 1 ? "" : "S"} PLAYED`} />
            <MySeasonStatTile tone={weeksWon > 0 ? "success" : "neutral"} value={`🏆 ${weeksWon}`} label={`WEEK${weeksWon === 1 ? "" : "S"} WON`} />
            <MySeasonStatTile tone={longestWinStreak > 1 ? "warning" : "neutral"} value={longestWinStreak > 1 ? `🔥 ${longestWinStreak}` : longestWinStreak} label="LONGEST WIN STREAK" />
            <MySeasonStatTile
              tone="purple"
              value={percentileInfo ? `${percentileInfo.percentile}${ordinalSuffix(percentileInfo.percentile)}` : "—"}
              label={percentileInfo ? `ALL-TIME PERCENTILE · #${percentileInfo.rank} OF ${percentileInfo.total}` : "ALL-TIME PERCENTILE (6+ WEEKS NEEDED)"}
            />
          </div>

          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 18 }}>
            {byYear.map(([year, yearWeeks]) => (
              <div key={year}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#eef2ff", letterSpacing: .3 }}>{year}</span>
                  <span style={{ flex: 1, height: 1, background: "#1f2a44" }} />
                  <span style={{ fontSize: 12, color: "#6b7797" }}>{yearWeeks.length} week{yearWeeks.length === 1 ? "" : "s"}</span>
                </div>
                <div style={{ borderRadius: 14, border: "1px solid #1f2a44", overflow: "hidden", background: "#0e1730" }}>
                  {yearWeeks.map((w, i) => {
                    const pct = w.points != null && w.totalGames ? Math.round((w.points / w.totalGames) * 100) : null;
                    return (
                      <div
                        key={`${w.year}_${w.week}`}
                        style={{
                          display: "flex", alignItems: "center", gap: isMobile ? 10 : 16,
                          padding: isMobile ? "10px 12px" : "11px 16px",
                          borderTop: i === 0 ? "none" : "1px solid #1f2a44",
                          background: w.isWinner ? "rgba(62,207,142,.07)" : "transparent",
                        }}
                      >
                        <div style={{ flex: "0 0 auto", minWidth: isMobile ? 84 : 130, display: "flex", alignItems: "center", gap: 6 }}>
                          {w.isWinner && <span title={w.winNote || "Winner"} style={{ fontSize: 15 }}>🏆</span>}
                          <span style={{ fontSize: isMobile ? 13 : 14, fontWeight: 600, color: "#cfd8f0" }}>{weekLabelFor(w.year, w.week)}</span>
                        </div>
                        <div style={{ flex: "1 1 auto", minWidth: 40, fontSize: isMobile ? 13 : 14, fontWeight: 700, color: placeColor(w.place, w.fieldSize) }}>
                          {w.place != null ? `${w.place}${ordinalSuffix(w.place)} of ${w.fieldSize}` : "—"}
                        </div>
                        <div style={{ flex: "0 0 auto", minWidth: isMobile ? 56 : 64, textAlign: "right", fontSize: isMobile ? 13 : 14, fontWeight: 700, color: "#fff" }}>
                          {w.points ?? "-"}/{w.totalGames}
                        </div>
                        {!isMobile && (
                          <div style={{ flex: "0 0 auto", minWidth: 42, textAlign: "right", fontSize: 12.5, color: "#6b7797" }}>
                            {pct != null ? `${pct}%` : "—"}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  </Container>);
}

function OverallLeaderboardPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const [status, setStatus] = useState("loading"); // loading | done | error
  const [list, setList] = useState([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null); // the row whose won-weeks modal is open
  // "finish" ranks by average finish (existing behavior, with its usual
  // weeks-played floor). "wins" ranks by total weeks won and drops that
  // floor entirely - anyone with at least one win qualifies, no matter how
  // few weeks they've played.
  const [rankBy, setRankBy] = useState("finish");

  // Special-week display names ("Conference Champs", "Bowls", etc.) and the
  // list of seasons with anything to show, same source the Leaderboard's
  // Year/Week selector reads from.
  const [weekLabels, setWeekLabels] = useState({});
  const [seasonYears, setSeasonYears] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const s = await getDoc(doc(db, "config", "seasons"));
        const d = s.exists() ? s.data() : {};
        setWeekLabels(d.weekLabels || {});
        setSeasonYears(Array.isArray(d.years) ? d.years : []);
      } catch (err) {
        console.error("config/seasons load failed", err);
      }
    })();
  }, []);
  const weekLabelFor = (y, w) => weekLabels[`${y}_${w}`] || `Week ${w}`;

  const [live, setLive] = useState({ year: null, week: null });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);
  const currentYear = hasWeekValue(live?.year) ? Number(live.year) : null;
  const yearsAvailable = useMemo(() => {
    const set = new Set(seasonYears.map(Number));
    if (currentYear != null) set.add(currentYear);
    return [...set].sort((a, b) => b - a);
  }, [seasonYears, currentYear]);

  // "overall" ranks every season combined; a specific year defaults in once
  // the live year is known, so first paint shows this season's standings.
  const [selectedYear, setSelectedYear] = useState(null);
  const seededYearRef = useRef(false);
  useEffect(() => {
    if (seededYearRef.current) return;
    if (currentYear != null) { setSelectedYear(currentYear); seededYearRef.current = true; }
  }, [currentYear]);

  useEffect(() => {
    if (selectedYear === null && !seededYearRef.current) return; // wait for the default to seed
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        // Wins mode drops the usual weeks-played floor (minPlayedOverride:0)
        // so anyone with at least one win qualifies, then re-filters/sorts
        // by wins below - see displayList.
        const result = await computeAllTimePercentiles({
          yearFilter: selectedYear, currentYear,
          minPlayedOverride: rankBy === "wins" ? 0 : null,
        });
        if (!cancelled) { setList(result); setStatus("done"); }
      } catch (err) {
        if (!cancelled) { setError(err?.message || "Something went wrong loading the leaderboard."); setStatus("error"); }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedYear, currentYear, rankBy]);

  // Wins mode re-ranks the same data by total weeks won (ties broken by the
  // usual average-finish metric) and only keeps people with at least one
  // win - a completely different qualifying bar than finish mode's weeks-
  // played floor, so rank/percentile from computeAllTimePercentiles don't
  // apply here and get recomputed fresh.
  const displayList = useMemo(() => {
    if (rankBy !== "wins") return list;
    return list
      .filter(p => p.weeksWon > 0)
      .sort((a, b) => b.weeksWon - a.weeksWon || a.avgFinishPct - b.avgFinishPct)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }, [list, rankBy]);

  const medal = (rank) => rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
  const medalColor = (rank) => rank === 1 ? "#f0b429" : rank === 2 ? "#cbd5e1" : rank === 3 ? "#cd7f32" : "#6b7797";
  const minPlayedLabel = selectedYear === null ? "more than 5 weeks played"
    : (currentYear != null && selectedYear === currentYear) ? "played at least once this year"
    : "at least 3 weeks played that year";

  return (<Container maxWidth={760} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ padding: isMobile ? 12 : 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: isMobile ? 20 : 24 }}>🏆 Overall Leaderboard</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#9aa4c7" }}>
            Rank by
            <select
              value={rankBy}
              onChange={e => setRankBy(e.target.value)}
              style={{ ...inputStyle, padding: "8px 10px", fontSize: 13.5 }}
            >
              <option value="finish">Average finish</option>
              <option value="wins">All-time wins</option>
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#9aa4c7" }}>
            Season
            <select
              value={selectedYear === null ? "overall" : selectedYear}
              onChange={e => setSelectedYear(e.target.value === "overall" ? null : Number(e.target.value))}
              style={{ ...inputStyle, padding: "8px 10px", fontSize: 13.5 }}
            >
              <option value="overall">Overall (all-time)</option>
              {yearsAvailable.map(y => (
                <option key={y} value={y}>{y}{currentYear != null && y === currentYear ? " (current)" : ""}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <p style={{ margin: "10px 0 0", fontSize: isMobile ? 12 : 13, color: "#9aa4c7", lineHeight: 1.45 }}>
        {rankBy === "wins"
          ? "Ranked by total weeks won. Only players with at least one win are shown."
          : <>Ranked by average finish across every week played — a 5th out of 10 counts the same as a 10th out of 20 (both mean you finished ahead of half the field), so it's fair across seasons with different-sized pools. Only players with {minPlayedLabel} are ranked.</>}
      </p>

      {status === "loading" && (
        <div style={{ marginTop: 24, textAlign: "center", color: "#9aa4c7", fontSize: 14, padding: "20px 0" }}>Crunching everyone's numbers…</div>
      )}

      {status === "error" && (
        <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 10, background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", color: "#fca5a5", fontSize: 13 }}>{error}</div>
      )}

      {status === "done" && displayList.length === 0 && (
        <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 10, background: "rgba(240,180,41,.1)", border: "1px solid rgba(240,180,41,.3)", color: "#f0b429", fontSize: 13 }}>
          {rankBy === "wins" ? "Nobody has won a week yet." : `Nobody has ${minPlayedLabel} yet.`}
        </div>
      )}

      {status === "done" && displayList.length > 0 && (
        <div style={{ marginTop: 18, borderRadius: 14, border: "1px solid #1f2a44", overflow: "hidden", background: "#0e1730" }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 16, padding: isMobile ? "7px 8px" : "8px 16px", borderBottom: "1px solid #1f2a44", fontSize: isMobile ? 10 : 11, color: "#6b7797", fontWeight: 700, letterSpacing: .3 }}>
            <div style={{ flex: "0 0 auto", width: isMobile ? 22 : 40 }} />
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>PLAYER</div>
            <div style={{ flex: "0 0 auto", minWidth: isMobile ? 38 : 60, textAlign: "right" }}>PLAYED</div>
            <div style={{ flex: "0 0 auto", minWidth: isMobile ? 28 : 46, textAlign: "right" }}>WON</div>
            <div style={{ flex: "0 0 auto", minWidth: isMobile ? 40 : 78, textAlign: "right" }}>AVG FINISH</div>
          </div>
          {displayList.map((p, i) => (
            <div
              key={`${p.name}_${i}`}
              style={{
                display: "flex", alignItems: "center", gap: isMobile ? 6 : 16,
                padding: isMobile ? "9px 8px" : "11px 16px",
                borderTop: i === 0 ? "none" : "1px solid #1f2a44",
                background: p.rank <= 3 ? "rgba(240,180,41,.06)" : "transparent",
              }}
            >
              <div style={{ flex: "0 0 auto", width: isMobile ? 22 : 40, textAlign: "center", fontSize: p.rank <= 3 ? (isMobile ? 16 : 18) : (isMobile ? 12.5 : 14), fontWeight: 800, color: medalColor(p.rank) }}>
                {medal(p.rank)}
              </div>
              <div style={{ flex: "1 1 auto", minWidth: 0, fontSize: isMobile ? 13 : 14.5, fontWeight: 700, color: "#eef2ff", lineHeight: 1.25, wordBreak: "break-word" }}>
                {p.name}
              </div>
              <div style={{ flex: "0 0 auto", minWidth: isMobile ? 38 : 60, textAlign: "right", fontSize: isMobile ? 11.5 : 13, color: "#9aa4c7", fontWeight: 600, whiteSpace: "nowrap" }}>
                {p.weeksPlayed} wks
              </div>
              <div
                onClick={() => { if (p.weeksWon > 0) setSelected(p); }}
                title={p.weeksWon > 0 ? "See which weeks" : undefined}
                style={{
                  flex: "0 0 auto", minWidth: isMobile ? 28 : 46, textAlign: "right", fontSize: isMobile ? 12 : 13,
                  color: "#f0b429", fontWeight: 700, whiteSpace: "nowrap",
                  cursor: p.weeksWon > 0 ? "pointer" : "default",
                  textDecoration: p.weeksWon > 0 ? "underline" : "none", textDecorationStyle: "dotted", textUnderlineOffset: 3,
                }}
              >
                🏆 {p.weeksWon}
              </div>
              <div
                title="On average, this player finishes in the top X% of that week's field - lower is better"
                style={{
                  flex: "0 0 auto", minWidth: isMobile ? 40 : 78, textAlign: "right", fontWeight: 800,
                  fontSize: isMobile ? 12.5 : 14.5, color: "#b48aef", whiteSpace: "nowrap",
                }}
              >
                Top {Math.max(1, Math.round(p.avgFinishPct))}%
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>

    {selected && (
      <ModalOverlay>
        <Card style={{ padding: isMobile ? 14 : 20 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: isMobile ? 17 : 19 }}>🏆 {selected.name}</h3>
              <div style={{ marginTop: 4, fontSize: 12.5, color: "#9aa4c7" }}>
                {selected.weeksWon} week{selected.weeksWon === 1 ? "" : "s"} won
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{ background: "transparent", border: "1px solid #2a3655", color: "#cfd8f0", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 15, lineHeight: 1 }}
            >
              ✕
            </button>
          </div>

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8, maxHeight: "60vh", overflowY: "auto" }}>
            {selected.wonWeeks.map((w, i) => (
              <div key={`${w.year}_${w.week}`} style={{ padding: "10px 12px", borderRadius: 10, background: "#0e1730", border: "1px solid #1f2a44" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: isMobile ? 13.5 : 14.5, color: "#eef2ff" }}>{w.year} {weekLabelFor(w.year, w.week)}</span>
                  {w.coWinners.length > 0 && (
                    <span style={{ fontSize: 11.5, color: "#f0b429", fontWeight: 600, whiteSpace: "nowrap" }}>
                      split with {w.coWinners.join(", ")}
                    </span>
                  )}
                </div>
                {w.winNote && (
                  <div style={{ marginTop: 3, fontSize: 11.5, color: "#6b7797" }}>{w.winNote}</div>
                )}
              </div>
            ))}
          </div>
        </Card>
      </ModalOverlay>
    )}
  </Container>);
}

// Occasional/dev tools that aren't part of weekly admin operations - split
// out of AdminPage (which had grown into one long scroll of every admin
// section) so the weekly-workflow page stays focused on what's actually
// touched every week, while these stay reachable but out of the way.
function AdminToolsPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  const stackRow = isMobile ? { flexDirection: "column", alignItems: "stretch" } : undefined;

  const [live, setLive] = useState({ year: null, week: null });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "live"), (s) => setLive(s.data() || {}));
    return () => unsub();
  }, []);
  const [year, setYear] = useState(null);
  const [week, setWeek] = useState(null);
  const seededFromLiveRef = useRef(false);
  useEffect(() => {
    if (seededFromLiveRef.current) return;
    if (hasWeekValue(live?.year) && hasWeekValue(live?.week)) {
      setYear(Number(live.year));
      setWeek(Number(live.week));
      seededFromLiveRef.current = true;
    }
  }, [live]);

  const [games, setGames] = useState([]);
  useEffect(() => {
    if (!hasWeekValue(year) || !hasWeekValue(week)) return;
    (async () => {
      try { setGames(await listGames({ year, week, includedOnly: false })); }
      catch (e) { console.error(e); }
    })();
  }, [year, week]);

  const [msg, setMsg] = useState("");

  const [scoreboardCfg, setScoreboardCfg] = useState({});
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "config", "app"), (s) => setScoreboardCfg((s.data() || {}).scoreboard || {}));
    return () => unsub();
  }, []);

  // Does the 2099/W1 test sandbox currently exist?
  const [dummyWeekExists, setDummyWeekExists] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "games"), where("year","==",2099), where("week","==",1)),
      (snap) => setDummyWeekExists(!snap.empty)
    );
    return () => unsub();
  }, []);

  const [localFixture, setLocalFixture] = useState(() => {
    try { return localStorage.getItem("sbLocalFixture") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("sbLocalFixture", localFixture ? "1" : "0"); } catch {}
  }, [localFixture]);

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

  if (year == null || week == null) { return (<Container maxWidth={720}><Header user={user} isAdmin={isAdmin} setPage={setPage} /><Card><p>Loading live week&hellip;</p></Card></Container>); }
  return (<Container maxWidth={900} padding={isMobile ? 12 : 24}>
    <Header user={user} isAdmin={isAdmin} setPage={setPage} />
    <Card style={{ maxWidth: 900, padding: isMobile ? 12 : 16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0 }}>Tools</h2>
        <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin"); setPage("admin"); }}>&larr; Back to Admin</button>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 13, color: "#9aa4c7" }}>
        Occasional/dev tools, not part of weekly operations - testing the scoreboard without live games, and bulk-importing picks from a spreadsheet.
      </p>

      <Row style={{ marginTop:16, gap:16 }}>
        <Field label="Year"><input style={{...inputStyle, width:"6rem"}} type="number" value={year ?? ""} onChange={e=>setYear(Number(e.target.value))} /></Field>
        <Field label="Week"><input style={{...inputStyle, width:"4rem"}} type="number" value={week ?? ""} onChange={e=>setWeek(Number(e.target.value))} /></Field>
      </Row>

      {msg && (
        <div style={{ marginTop:12, padding:"8px 12px", borderRadius:10, background:"rgba(106,162,255,.1)", border:"1px solid rgba(106,162,255,.3)", color:"#cfe0ff", fontSize:13 }}>{msg}</div>
      )}

      <AdminSection title="Testing Mode (without live games)" tone="neutral" right={
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <StatusBadge tone={dummyWeekExists ? "success" : "neutral"}>Sandbox: {dummyWeekExists ? "Active" : "Empty"}</StatusBadge>
          <StatusBadge tone={scoreboardCfg.testMode ? "primary" : (scoreboardCfg.mode === "on" ? "success" : "neutral")}>
            Scoreboard: {scoreboardCfg.testMode ? "Demo" : (scoreboardCfg.mode === "on" ? "Live" : "Off")}
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

      <BulkImportPicksPreview year={year} week={week} />
    </Card>
  </Container>);
}

function AdminPage({ user, isAdmin, setPage }) {
  const isMobile = useIsMobile();
  // On mobile, action-button groups stack full-width (one per row) instead of
  // wrapping mid-row - align-items:stretch fills each button to the row's
  // width since neither Row nor adminBtn() set an explicit width.
  const stackRow = isMobile ? { flexDirection: "column", alignItems: "stretch" } : undefined;
  const [live, setLive] = useState({ year: null, week: null });
  const [year, setYear] = useState(null);
  const [week, setWeek] = useState(null);

  // Weekly poll results (admin-only for now - see PicksPage for the voting UI)
  const [pollVotes, setPollVotes] = useState([]);
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "pollVotes"), (snap) => {
      setPollVotes(snap.docs.map(d => d.data()));
    });
    return () => unsub();
  }, [isAdmin]);
  const tallyPoll = (pollId, field) => {
    const counts = {};
    for (const v of pollVotes) {
      if (v.pollId !== pollId) continue;
      const vals = field === "choices" ? (Array.isArray(v.choices) ? v.choices : []) : [v.choice].filter(Boolean);
      for (const val of vals) counts[val] = (counts[val] || 0) + 1;
    }
    return counts;
  };
  const pollVoterCount = (pollId) => pollVotes.filter(v => v.pollId === pollId).length;
  const pollVotersFor = (pollId) => pollVotes
    .filter(v => v.pollId === pollId)
    .map(v => ({
      name: `${v.firstName || ""} ${v.lastName || ""}`.trim() || "(no name on file)",
      choice: v.choice || (Array.isArray(v.choices) ? v.choices.join(", ") : ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Optional free-text suggestions from the same section on the Picks page
  const [feedbackNotes, setFeedbackNotes] = useState([]);
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "feedback"), (snap) => {
      setFeedbackNotes(snap.docs.map(d => d.data()).filter(f => f.text));
    });
    return () => unsub();
  }, [isAdmin]);

  // Live results map (by game id) so the Set Winner button can highlight once
  // a game is actually resolved (real winner or a push) - lets the admin spot
  // at a glance which games still need attention.
  const [results, setResults] = useState({});
  useEffect(() => {
    if (!isAdmin) return;
    const unsub = onSnapshot(collection(db, "results"), (snap) => {
      const map = {};
      snap.forEach(d => { map[d.id] = d.data(); });
      setResults(map);
    });
    return () => unsub();
  }, [isAdmin]);

  const [games, setGames] = useState([]);
  const [pickCount, setPickCount] = useState(0);
  const [msg, setMsg] = useState("");
  const [weeksForYear, setWeeksForYear] = useState([]);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [appCfg, setAppCfg] = useState({ leaderboardLocked: false, leaderboardPicksPublic: false, picksLocked: false, potHidden: false });
  const pot = useMemo(() => (pickCount * 5), [pickCount]);

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
          const counted = Array.isArray(arr) ? arr.filter(p => !isForfeitedPick(games, p)) : [];
          setPickCount(counted.length);
        } else {
          setPickCount(0);
        }
      } catch {
        setPickCount(0);
      }
    })();
  }, [year, week, games]);

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

  let totalPoints, homePoints, awayPoints;
  // Capture the final score, not just the winner, on every manual override -
  // otherwise the Leaderboard's scorebug is left showing "FINAL" with no
  // score digits for this game (this is how the auto-cron score breakdown
  // used to go missing: it only asked for a score on the GameDay tiebreaker
  // game). Optional - cancel/leave blank to save just the winner if the
  // score isn't known yet.
  const scoreStr = window.prompt(`Final score (optional) for ${g.away} @ ${g.home}\nEnter as AWAY-HOME, e.g. "24-31":`);
  if (scoreStr) {
    const m = String(scoreStr).trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      awayPoints = Number(m[1]);
      homePoints = Number(m[2]);
      totalPoints = awayPoints + homePoints;
    } else {
      setMsg('Score not saved (expected "AWAY-HOME", e.g. "24-31") - winner still recorded.');
    }
  }

  if (g.gameday && totalPoints === undefined) {
    // This is the week's tiebreaker game and no score was entered above -
    // still need at least the combined total to save the GameDay result.
    const totalStr = window.prompt(`Combined final score for the GameDay tiebreaker (${g.away} + ${g.home} points):`);
    if (totalStr === null) { setMsg("Cancelled: total points required to save the GameDay result."); return; }
    const n = Number(totalStr);
    if (!Number.isFinite(n)) { setMsg("Cancelled: enter a valid number for total points."); return; }
    totalPoints = n;
  }

  await setResult(g.id, w, totalPoints, homePoints, awayPoints);
  setMsg("Saved result. Refresh Leaderboard to update.");
};

  // For a canceled/postponed game that will never get a real final score:
  // records it as resolved (so the week can still be marked complete and a
  // pot winner declared) without awarding anyone points for it, matching the
  // "push" rule on the Rules page.
  const markAsPush = async (g) => {
    if (!window.confirm(`Mark ${g.away} @ ${g.home} as a push (no contest)?\n\nNobody will score on this game, but it'll count as resolved for declaring the week's pot winner.`)) return;
    await markResultAsPush(g.id);
    setMsg(`Marked ${g.away} @ ${g.home} as a push. Refresh Leaderboard to update.`);
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

    // Clear selected week if it has NO picks (safety guard)
  const clearWeekIfNoPicks = async () => {
    try {
      const Y = Number(year), W = Number(week);
      setMsg(`Checking picks for ${Y} / W${W}…`);

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
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/payments"); setPage("adminpayments"); }}>Payment Tracking</button>
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/players"); setPage("adminplayers"); }}>Player Management</button>
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/notifications"); setPage("adminnotifications"); }}>Notifications</button>
            <button style={adminBtn("neutral")} onClick={() => { window.history.pushState(null, "", "/admin/tools"); setPage("admintools"); }}>Tools</button>
          </Row>
        </div>
        {msg && (
          <div style={{ marginTop:12, padding:"8px 12px", borderRadius:10, background:"rgba(106,162,255,.1)", border:"1px solid rgba(106,162,255,.3)", color:"#cfe0ff", fontSize:13 }}>{msg}</div>
        )}

        {Number(live?.week) === 1 && (
        <AdminSection title="Weekly Poll Results" tone="neutral" right={<StatusBadge tone="neutral">Not shown to voters yet</StatusBadge>}>
          <div style={{ marginBottom:16 }}>
            <div style={{ fontWeight:600, marginBottom:6 }}>
              When should the first game of the week be? <span style={{ opacity:.6, fontWeight:400 }}>({pollVoterCount("tf_games")} votes)</span>
            </div>
            {Object.entries(tallyPoll("tf_games", "choice")).sort((a,b) => b[1]-a[1]).map(([opt, count]) => (
              <div key={opt} style={{ fontSize:13, padding:"2px 0" }}>{opt}: <strong>{count}</strong></div>
            ))}
            {pollVoterCount("tf_games") === 0 && <div style={{ fontSize:13, opacity:.6 }}>No votes yet.</div>}
            {pollVoterCount("tf_games") > 0 && (
              <details style={{ marginTop:6 }}>
                <summary style={{ fontSize:12, opacity:.7, cursor:"pointer" }}>See who voted for what</summary>
                {pollVotersFor("tf_games").map((v, i) => (
                  <div key={i} style={{ fontSize:13, padding:"2px 0 2px 10px" }}>{v.name}: {v.choice}</div>
                ))}
              </details>
            )}
          </div>
          <div>
            <div style={{ fontWeight:600, marginBottom:6 }}>
              How many games do you want to pick from each week? <span style={{ opacity:.6, fontWeight:400 }}>({pollVoterCount("games_per_week")} votes)</span>
            </div>
            {Object.entries(tallyPoll("games_per_week", "choice")).sort((a,b) => b[1]-a[1]).map(([opt, count]) => (
              <div key={opt} style={{ fontSize:13, padding:"2px 0" }}>{opt}: <strong>{count}</strong></div>
            ))}
            {pollVoterCount("games_per_week") === 0 && <div style={{ fontSize:13, opacity:.6 }}>No votes yet.</div>}
            {pollVoterCount("games_per_week") > 0 && (
              <details style={{ marginTop:6 }}>
                <summary style={{ fontSize:12, opacity:.7, cursor:"pointer" }}>See who voted for what</summary>
                {pollVotersFor("games_per_week").map((v, i) => (
                  <div key={i} style={{ fontSize:13, padding:"2px 0 2px 10px" }}>{v.name}: {v.choice}</div>
                ))}
              </details>
            )}
          </div>
          <div style={{ marginTop:16 }}>
            <div style={{ fontWeight:600, marginBottom:6 }}>
              Did you add the Pick 'Ems to your home screen and enroll in notifications? <span style={{ opacity:.6, fontWeight:400 }}>({pollVoterCount("app_enroll")} votes)</span>
            </div>
            {Object.entries(tallyPoll("app_enroll", "choice")).sort((a,b) => b[1]-a[1]).map(([opt, count]) => (
              <div key={opt} style={{ fontSize:13, padding:"2px 0" }}>{opt}: <strong>{count}</strong></div>
            ))}
            {pollVoterCount("app_enroll") === 0 && <div style={{ fontSize:13, opacity:.6 }}>No votes yet.</div>}
            {pollVoterCount("app_enroll") > 0 && (
              <details style={{ marginTop:6 }}>
                <summary style={{ fontSize:12, opacity:.7, cursor:"pointer" }}>See who voted for what</summary>
                {pollVotersFor("app_enroll").map((v, i) => (
                  <div key={i} style={{ fontSize:13, padding:"2px 0 2px 10px" }}>{v.name}: {v.choice}</div>
                ))}
              </details>
            )}
          </div>
          <div style={{ marginTop:16 }}>
            <div style={{ fontWeight:600, marginBottom:6 }}>
              Suggestions / feedback <span style={{ opacity:.6, fontWeight:400 }}>({feedbackNotes.length})</span>
            </div>
            {feedbackNotes.map((f, i) => (
              <div key={i} style={{ fontSize:13, padding:"6px 10px", marginBottom:6, background:"#0e1730", border:"1px solid #1f2a44", borderRadius:8 }}>
                <div style={{ fontWeight:600, marginBottom:2 }}>{`${f.firstName || ""} ${f.lastName || ""}`.trim() || "(no name on file)"}</div>
                {f.text}
              </div>
            ))}
            {feedbackNotes.length === 0 && <div style={{ fontSize:13, opacity:.6 }}>None yet.</div>}
          </div>
        </AdminSection>
        )}

        <AdminSection title="Live Week" tone="primary" right={<StatusBadge tone="primary">Live: {live?.year ?? "-"} / W{live?.week ?? "-"}</StatusBadge>}>
          <AdminActionRow
            divider={false}
            label="Selected Week"
            description="Which year/week the actions below apply to - defaults to whatever's live."
          >
            <input style={{...inputStyle, width:"4.5rem", padding:"6px 8px", fontSize:13}} type="number" value={(year ?? '')} onChange={e=>setYear(Number(e.target.value))} aria-label="Year" />
            <input style={{...inputStyle, width:"3rem", padding:"6px 8px", fontSize:13}} type="number" value={(week ?? '')} onChange={e=>setWeek(Number(e.target.value))} aria-label="Week" />
            <button style={adminBtn("neutral", { padding:"6px 10px", fontSize:12.5 })} onClick={async()=>setGames(await listGames({ year, week, includedOnly: false }))}>Load</button>
          </AdminActionRow>

          <AdminActionRow
            label="Make This the Live Week"
            description="What players see on Picks, Leaderboard, etc. right now."
          >
            <button style={adminBtn("primary", { padding:"7px 14px", fontSize:13 })} onClick={async()=>{ try { await setDoc(doc(db,"config","live"), { year, week }, { merge:true });
await setDoc(doc(db,"config","app"), { currentYear: year, currentWeek: week, updatedAt: serverTimestamp() }, { merge:true }); setMsg(`Live week set to ${year} / W${week} (config/live + config/app)`); } catch(e) { console.error(e); setMsg("Failed to set live week"); } }}>Set Live Week</button>
          </AdminActionRow>

          <AdminActionRow
            label="Opening Notification"
            description={`Pushes a "Week ${week ?? ""} is open" alert to everyone.`}
          >
            <button style={adminBtn("success", { padding:"7px 14px", fontSize:13 })} onClick={async()=>{ try { await addDoc(collection(db,"notificationOutbox"), { title: `🏈 Week ${week} is open`, body: "Picks are open — submit yours on the Picks page.", createdAt: serverTimestamp() }); setMsg(`Push notification sent to everyone for Week ${week}.`); } catch(e) { console.error(e); setMsg("Failed to send notification"); } }}>Notify Players</button>
          </AdminActionRow>

          <AdminActionRow
            label="GameDay Tiebreaker"
            description="Syncs the live tiebreaker game from whichever game is flagged 🏈 in Games below."
          >
            <button style={adminBtn("neutral", { padding:"7px 14px", fontSize:13 })} onClick={async()=>{
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
            }}>Sync</button>
          </AdminActionRow>

          <AdminActionRow
            label="Clear Week"
            description="Deletes this week's games and results. Only works while no picks exist yet."
          >
            <button style={adminBtn("danger", { padding:"6px 12px", fontSize:12.5 })} onClick={clearWeekIfNoPicks}>Clear</button>
          </AdminActionRow>
        </AdminSection>

        <AdminSection title="Submissions" tone="warning">
          <AdminToggleRow
            divider={false}
            label="Submissions Open"
            description="Players can submit or edit their picks right now."
            checked={!appCfg.picksLocked}
            onChange={async (next) => {
              try {
                await setDoc(doc(db, "config", "app"), { picksLocked: !next, updatedAt: serverTimestamp() }, { merge: true });
                setMsg(next ? "Submissions unlocked." : "Submissions locked.");
              } catch (e) {
                setMsg("Failed: " + (e?.message || String(e)));
              }
            }}
          />
          <AdminToggleRow
            label="Auto-Lock at Kickoff"
            description="Automatically locks picks and opens the leaderboard once the first game starts. Turn off to make a manual unlock stick during a game."
            checked={appCfg.scoreboard?.autoLockPicks !== false}
            onChange={async (next) => {
              try {
                await setDoc(doc(db, "config", "app"), { scoreboard: { autoLockPicks: next }, updatedAt: serverTimestamp() }, { merge: true });
                setMsg(`Auto-lock-at-kickoff turned ${next ? "ON" : "OFF"}.`);
              } catch (e) {
                setMsg("Failed: " + (e?.message || String(e)));
              }
            }}
          />
        </AdminSection>

        <AdminSection title="Leaderboard" tone="warning">
          <AdminToggleRow
            divider={false}
            label="Leaderboard Locked"
            description="Freezes the current week's leaderboard - no further picks or result changes affect it."
            checked={!!appCfg.leaderboardLocked}
            onChange={toggleLeaderboardLock}
          />
          <AdminToggleRow
            label="Public Picks"
            description="Anyone can see everyone's picks for the week. Turn off to keep picks visible to admins only."
            checked={!!appCfg.leaderboardPicksPublic}
            onChange={toggleLeaderboardPicks}
          />
          <AdminToggleRow
            label="Show Pot to Everyone"
            description="Turn off to hide the pot amount from everyone except admins."
            checked={!appCfg.potHidden}
            onChange={togglePotHidden}
          />
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
        <div style={{ fontSize:12, opacity:.65, marginBottom:10, textAlign:"right" }}>
          🏈 College GameDay tiebreaker &nbsp;&middot;&nbsp; 🏆 Set Winner &nbsp;&middot;&nbsp; 🚫 Mark as Push (no contest)
        </div>
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
        position:"relative",
        display:"flex", flexDirection:"row", alignItems: isMobile ? "flex-start" : "center",
        gap:12, flexWrap:"nowrap",
        border: g.included ? "1px solid #2ecc71" : "1px dashed #1f2a44",
        padding:12, borderRadius:12, margin:"10px auto",
        maxWidth: 1200, width:"100%", cursor:"pointer",
        boxShadow: g.included ? "0 0 0 2px #2ecc71 inset" : "none",
        background: g.included ? "rgba(46,204,113,0.08)" : "transparent",
        transition:"box-shadow 120ms ease, background 120ms ease, border-color 120ms ease"
      }}
    >
      {!isMobile && (g.formattedSpread || g.overUnder != null) && (
        <div style={{ position:"absolute", top:6, right:10, fontSize:11, color:"#9aa4c7", whiteSpace:"nowrap" }}>
          {g.formattedSpread || ""}{g.formattedSpread && g.overUnder != null ? " · " : ""}{g.overUnder != null ? `O/U ${g.overUnder}` : ""}
        </div>
      )}
      <div style={{ marginBottom: 16, textAlign:"left", whiteSpace: isMobile ? "normal" : "nowrap", overflow: isMobile ? "visible" : "hidden", textOverflow: isMobile ? "clip" : "ellipsis", minWidth:0, flex: isMobile ? "1 1 auto" : undefined }}>
        <strong style={{ display:"inline-flex", flexWrap:"wrap", justifyContent: isMobile ? "flex-start" : "center", alignItems:"center", width:"100%", textAlign:"center", rowGap:"0", lineHeight: 1.24, fontWeight:700, fontSize: fitFontByLen(((teamLabelNoMascot(g.away,g.awayRank)||"").length + (teamLabelNoMascot(g.home,g.homeRank)||"").length)), gap:6 }}>
          <TeamLogo school={g.away} size={48} /> <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div> @ <TeamLogo school={g.home} size={48} /> <div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>
        </strong>
        {isMobile && (g.formattedSpread || g.overUnder != null) && (
          <div style={{ marginTop:4, fontSize:12, color:"#9aa4c7", textAlign:"left" }}>
            {g.formattedSpread || ""}{g.formattedSpread && g.overUnder != null ? " · " : ""}{g.overUnder != null ? `O/U ${g.overUnder}` : ""}
          </div>
        )}
      </div>
      <div style={{ display:"flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "flex-end" : "center", gap: isMobile ? 6 : 12, marginLeft:"auto", flexShrink:0 }}>
  <span style={{ whiteSpace:"nowrap", opacity: 0.9, fontSize:13, fontWeight:600 }}>{timeLabelOnly(g,{ timeZone:"America/New_York" })}</span>
    <button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); setGameGameday(g.year, g.week, g.id).then(async ()=>{ setGames(await listGames({ year, week, includedOnly: false })); setMsg("Set College GameDay to " + teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank)); }); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); setGameGameday(g.year, g.week, g.id).then(async ()=>{ setGames(await listGames({ year, week, includedOnly: false })); setMsg("Set College GameDay to " + teamLabelNoMascot(g.away, g.awayRank) + " @ " + teamLabelNoMascot(g.home, g.homeRank)); }); }}}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer", color:"#fff", marginRight: isMobile ? 0 : 8, background: g.gameday ? "rgba(241,196,15,0.1)" : "transparent", boxShadow: g.gameday ? "0 0 0 2px #f1c40f inset" : "none" }}
    aria-label={"Set College GameDay for " + teamLabelNoMascot(g.away, g.awayRank) + " at " + teamLabelNoMascot(g.home, g.homeRank)}
    title={g.gameday ? "College GameDay (selected)" : "Set as College GameDay"}
  >
    {"🏈"}
  </button><button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); chooseWinner(g); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); chooseWinner(g);} }}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer", color:"#fff", background: results[g.id]?.winner ? "rgba(46,204,113,0.15)" : "transparent", boxShadow: results[g.id]?.winner ? "0 0 0 2px #2ecc71 inset" : "none" }}
    aria-label={`Set winner for $<div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.away, g.awayRank)}</div> at $<div style={{ width:96, textAlign:"center", fontWeight:700, fontSize:13, lineHeight:1.15, whiteSpace:"normal", overflowWrap:"anywhere" }}>{teamLabelNoMascot(g.home, g.homeRank)}</div>`}
    title={results[g.id]?.winner ? `Resolved: ${results[g.id].push ? "Push (no contest)" : results[g.id].winner}` : "Set winner"}
  >
    {"🏆"}
  </button><button
    type="button"
    onClick={(e)=>{ e.stopPropagation(); markAsPush(g); }}
    onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); markAsPush(g);} }}
    style={{ padding:"6px 10px", borderRadius:10, border:"1px solid #1f2a44", cursor:"pointer", marginLeft: isMobile ? 0 : 8, color:"#fff", background:"transparent" }}
    aria-label={`Mark ${g.away} at ${g.home} as a push (no contest)`}
    title="Canceled or postponed with no makeup - resolves the game with no points awarded to anyone"
  >
    {"🚫"}
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
      if (p === "picks" || p === "leader" || p === "admin" || p === "myseason" || p === "overall") { setPage(p); return; }
      if (p === "admin/picks") { setPage("adminpicks"); return; }
      if (p === "admin/notifications") { setPage("adminnotifications"); return; }
      if (p === "admin/payments") { setPage("adminpayments"); return; }
      if (p === "admin/missing") { setPage("adminmissing"); return; }
      if (p === "admin/players") { setPage("adminplayers"); return; }
      if (p === "admin/tools") { setPage("admintools"); return; }
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
      {(page === "picks" || page === "receipt") && <PicksPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "leader" && <LeaderboardPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "myseason" && <MySeasonPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "overall" && <OverallLeaderboardPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "admin" && <AdminPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminpicks" && <PlayerManagementPage user={user} isAdmin={isAdmin} setPage={setPage} initialTab="picks" />}
      {page === "adminnotifications" && <AdminNotificationsPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminpayments" && <AdminPaymentsPage user={user} isAdmin={isAdmin} setPage={setPage} />}
      {page === "adminmissing" && <PlayerManagementPage user={user} isAdmin={isAdmin} setPage={setPage} initialTab="missing" />}
      {page === "adminplayers" && <PlayerManagementPage user={user} isAdmin={isAdmin} setPage={setPage} initialTab="roster" />}
      {page === "admintools" && <AdminToolsPage user={user} isAdmin={isAdmin} setPage={setPage} />}
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















































































































































