// web/src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, serverTimestamp } from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";

const firebaseConfig = {
  apiKey: "AIzaSyBjEhQs6kmYhD0TbCqVHdhRE5b1n2motnk",
  authDomain: "pickems-2k25.firebaseapp.com",
  projectId: "pickems-2k25",
  storageBucket: "pickems-2k25.firebasestorage.app", // ok to leave as-is
  messagingSenderId: "382904529891",
  appId: "1:382904529891:web:a5420c75700a9ccd4da6d6"
};

// Web Push certificate key pair, from Firebase Console > Project Settings >
// Cloud Messaging > Web configuration > Web Push certificates.
const VAPID_KEY = "BOonwzies3d69Wg4OeSSXdK0nQ7N10XS0Hj49kvKgAkjWcCCC-2qcRlvmPdQmHvqX5tiE4Po3GIyN1j22XDYeI8";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
export const googleLogin = () => signInWithPopup(auth, provider);
export const logout = () => signOut(auth);
export const onAuth = (cb) => onAuthStateChanged(auth, cb);

// Rough, dependency-free "OS · Browser" label from the user agent - not
// meant to be precise, just enough for an admin to tell devices apart in
// Manage Devices (e.g. distinguishing two "Unknown device" rows) without
// storing anything more identifying than that.
function describeDevice() {
  try {
    const ua = navigator.userAgent || "";
    let os = "Unknown OS";
    if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if (/Android/.test(ua)) os = "Android";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
    else if (/Linux/.test(ua)) os = "Linux";

    let browser = "Unknown browser";
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/OPR\//.test(ua)) browser = "Opera";
    else if (/CriOS\//.test(ua)) browser = "Chrome"; // Chrome on iOS
    else if (/FxiOS\//.test(ua)) browser = "Firefox"; // Firefox on iOS
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Safari\//.test(ua)) browser = "Safari";

    return `${os} · ${browser}`;
  } catch (e) {
    return "Unknown device";
  }
}

// Push notifications: request permission, register this device's token, and
// keep listening for messages that arrive while the tab is open (background
// messages while the tab is closed are handled by firebase-messaging-sw.js).
export async function enablePushNotifications({ isAdmin = false } = {}) {
  if (!(await isSupported())) throw new Error("Push notifications aren't supported in this browser.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");

  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const messaging = getMessaging(app);
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) throw new Error("Could not get a push token for this device.");

  // Tagging isAdmin here (only when actually signed in as admin) is what lets
  // admin-only alerts (e.g. a stuck game with no recorded winner) go to just
  // this device instead of broadcasting to the whole pool.
  await setDoc(doc(db, "pushTokens", token), {
    token, createdAt: serverTimestamp(), device: describeDevice(), ...(isAdmin ? { isAdmin: true } : {})
  }, { merge: true });
  try { localStorage.setItem("pushToken", token); } catch (e) {}

  // Sent as a data-only message on purpose - see the matching comment in
  // firebase-messaging-sw.js for why (avoids a duplicate notification).
  onMessage(messaging, (payload) => {
    const { title, body } = payload.data || {};
    if (title) new Notification(title, { body, icon: "/icons/icon-192.png" });
  });

  return token;
}

