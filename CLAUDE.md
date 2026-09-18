# CFB Pick'em

Weekly college-football pick'em pool (~30 players, $5 entry, winner-take-all). Owner: Zack Slay.

## Stack and layout
- `web/` — React + Vite. Almost everything lives in one big file, `web/src/App.jsx`. Components: `PicksPage`, `LeaderboardPage`, `AdminPaymentsPage`, `PlayerManagementPage` (tabs: Roster, Who's Missing, Devices, Chat), `Header` (site-wide announcement banner).
- `functions/` — Firebase Cloud Functions (Node 22, 2nd gen, `us-east4`). `publishLiveMap` polls scores every minute; `autoLockAtKickoff` locks the week; `sendChatNotification`, reminders, etc.
- `firestore.rules`, `storage.rules`, `firebase.json` at the repo root. Firebase project: `pickems-2k25`. Two hosting sites serve the same `web/dist`: `pickems-2k25.web.app` and `cfbpickems.web.app`.

## Build and deploy
- Build: `cd web && npm ci && npm run build`. There is no test suite; verify by building and using the app in a browser (`npm run dev`).
- **Pushing to `main` deploys automatically** (`.github/workflows/deploy.yml`: hosting + functions + Firestore rules, needs the `GCP_SA_KEY` repo secret). Treat every push to `main` as a production deploy of a live app with real money.
- Manual hosting deploy from a machine with Firebase login: `firebase deploy --only hosting`.
- Never commit `.env*` or `.claude/settings.local.json`.

## Rules of the pool (implemented behavior — keep these in sync with the Rules modal and the Header banner)
- New submissions lock when the week's very first game kicks off (`autoLockAtKickoff` sets `config/app.picksLocked`, opens the leaderboard, makes picks public).
- Games are grouped by calendar day (America/New_York) via `groupGamesByDate`. A whole day's games lock/reveal together at that day's first kickoff (`buildGameGroupStartMap`), not per game.
- Every submission for a week with later-day games gets `editDeadline` (earliest kickoff of the later day). Until then the owner of a doc can keep editing later-day picks with their 6-digit code, even after `picksLocked`. The Firestore update rule enforces the deadline for the whole document; locking earlier-day picks is enforced only in the UI.
- Partial slate is opt-in (`partial: true`): only the first day's games are required up front. If still incomplete after `editDeadline`, the entry is forfeited: excluded from the pot, standings, and Payment Tracking (`isForfeitedPick`, derived on the fly; nothing stored).
- The leaderboard shows 🔒 for a day's picks until that day's first kickoff (admins and past weeks see everything).

## Data model notes
- `picks/{year}_W{week}_{code}`; per-week uniqueness via `keys/*` lock docs (email/phone/venmo). `paid` is toggled by an admin on Payment Tracking.
- `config/live` = current year/week; `config/app` = locks and notification settings.
- Years >= 2090 are a test sandbox (admin can delete there); real-season picks are immutable once the leaderboard opens.
- Admin = a doc in `admins/{uid}`. Most write actions on old or locked weeks need it. On a phone, sign in by tapping the "CFB Pick'em" logo 5 times.

## Gotchas
- Hooks in big components: declare `useState` before any `const` that reads it (a temporal-dead-zone crash happened before). `LeaderboardPage` has two separate `return` branches (locked view and full board); shared UI must go in both.
- Don't flip `config/app.picksLocked` or other live config without asking. The owner sometimes locks submissions manually while editing the slate.
- Scoreboard polling deliberately keeps running past its usual time window while any game lacks a winner (`hasGameNeedingTracking` in `functions/index.js`).
- Logos/icons are served with long-lived cache headers (`firebase.json`); logo filenames are cache-busted via `ASSET_VER` in `TeamLogo.jsx`.
- Sending texts, emails, or push notifications to real players is a user-visible action. Confirm first.
