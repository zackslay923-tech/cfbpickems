import { collection, getDocs, query, where } from "firebase/firestore";

// TEMP: Public path proxies to raw picks to restore Leaderboard visibility.
// When sanitized mirror is ready, switch this back to collection(db, "picks_public").
export async function getPublicPicksForWeek(db, year, week) {
  const snap = await getDocs(query(
    collection(db, "picks"),
    where("year", "==", year),
    where("week", "==", week)
  ));
  return snap.docs.map(d => d.data());
}

