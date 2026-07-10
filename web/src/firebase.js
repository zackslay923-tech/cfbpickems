// web/src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBjEhQs6kmYhD0TbCqVHdhRE5b1n2motnk",
  authDomain: "pickems-2k25.firebaseapp.com",
  projectId: "pickems-2k25",
  storageBucket: "pickems-2k25.firebasestorage.app", // ok to leave as-is
  messagingSenderId: "382904529891",
  appId: "1:382904529891:web:a5420c75700a9ccd4da6d6"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
export const googleLogin = () => signInWithPopup(auth, provider);
export const logout = () => signOut(auth);
export const onAuth = (cb) => onAuthStateChanged(auth, cb);

