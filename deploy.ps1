param(
  [switch]$NoPull
)

$ErrorActionPreference = "Stop"
$log = "deploy-log-{0}.txt" -f (Get-Date -Format "yyyyMMdd-HHmm")
Start-Transcript -Path $log -Force | Out-Null

function Require-Cmd($cmd) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $cmd"
  }
}

Write-Host "== Verifying prerequisites =="
Require-Cmd git
Require-Cmd node
Require-Cmd npm
Require-Cmd firebase

Write-Host "== Repo status =="
git status -s

if (-not $NoPull) {
  Write-Host "== Pulling latest from origin/main =="
  git switch main
  git pull --ff-only
} else {
  Write-Host "== Skipping pull (NoPull) =="
}

Write-Host "== Installing web deps (npm ci) =="
Push-Location ".\web"
npm ci

Write-Host "== Building (npm run build) =="
npm run build

Pop-Location

Write-Host "== Deploying to Firebase Hosting =="
firebase deploy --only hosting

Stop-Transcript | Out-Null
Write-Host "`nDone. Full log: $log"
try {
  Start-Process $log
} catch {}
