$ErrorActionPreference = "Stop"

$REPO_URL = "https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot.git"
$DEFAULT_DIR = "Pterodactyl-Discord-Bridge-Bot"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Pterodactyl Discord Bridge Bot — Bootstrap     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Prereq checks ─────────────────────────────────────────────────────────────

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Error: git is not installed. Install it and re-run this script." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js is not installed. Install Node >= 20 and re-run." -ForegroundColor Red
    Write-Host "  https://nodejs.org" -ForegroundColor DarkGray
    exit 1
}

$nodeMajor = [int](node -e "console.log(parseInt(process.version.slice(1)))")
if ($nodeMajor -lt 20) {
    Write-Host "Error: Node.js >= 20 required. Current: $(node --version)" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Error: npm is not installed. It should come with Node.js." -ForegroundColor Red
    exit 1
}

Write-Host "  OK  git  $(git --version)" -ForegroundColor Green
Write-Host "  OK  node $(node --version)" -ForegroundColor Green
Write-Host ""

# ── Clone ──────────────────────────────────────────────────────────────────────

$installDir = Read-Host "  Install directory [$DEFAULT_DIR]"
if ([string]::IsNullOrWhiteSpace($installDir)) {
    $installDir = $DEFAULT_DIR
}

if (Test-Path $installDir) {
    Write-Host "Error: '$installDir' already exists. Remove it or choose a different name." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Cloning repository..." -ForegroundColor DarkGray
git clone $REPO_URL $installDir --quiet
Write-Host "  Cloned into $installDir" -ForegroundColor Green

Set-Location $installDir

# ── Install ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Installing dependencies..." -ForegroundColor DarkGray
npm install --silent
Write-Host "  Dependencies installed" -ForegroundColor Green

# ── Setup wizard ───────────────────────────────────────────────────────────────

Write-Host ""
node setup.js
