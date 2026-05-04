$ErrorActionPreference = "Stop"

$REPO_URL = "https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot.git"
$DEFAULT_DIR = "Pterodactyl-Discord-Bridge-Bot"

function Show-PrereqHelp {
    Write-Host ""
    Write-Host "Install the missing prerequisites, then run this bootstrap command again." -ForegroundColor White
    Write-Host ""
    Write-Host "  Required:"
    Write-Host "    - Git"
    Write-Host "    - Node.js 20 or newer"
    Write-Host "    - npm, which normally comes with Node.js"
    Write-Host ""
    Write-Host "  Optional for Docker Compose hosting:"
    Write-Host "    - Docker Desktop"
    Write-Host ""
    Write-Host "  Windows winget commands:"
    Write-Host "    winget install --id Git.Git -e"
    Write-Host "    winget install --id OpenJS.NodeJS.LTS -e"
    Write-Host "    winget install --id Docker.DockerDesktop -e"
    Write-Host ""
    Write-Host "  Downloads:"
    Write-Host "    Git:     https://git-scm.com/downloads"
    Write-Host "    Node.js: https://nodejs.org"
    Write-Host "    Docker:  https://docs.docker.com/desktop/install/windows-install/"
    Write-Host ""
}

function Confirm-ContinueWithoutOptionalTool($toolName, $why) {
    Write-Host "Warning: $toolName is not installed." -ForegroundColor Yellow
    Write-Host "  $why"
    $answer = Read-Host "  Continue without $toolName? [Y/n]"
    if ([string]::IsNullOrWhiteSpace($answer)) {
        $answer = "Y"
    }
    if ($answer -notmatch "^[Yy]") {
        Show-PrereqHelp
        exit 1
    }
    Write-Host ""
}

function Test-RequiredPrereqs {
    $missing = $false

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "Error: git is not installed." -ForegroundColor Red
        $missing = $true
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Error: Node.js is not installed." -ForegroundColor Red
        $missing = $true
    }
    else {
        $nodeMajor = [int](node -e "console.log(parseInt(process.version.slice(1)))")
        if ($nodeMajor -lt 20) {
            Write-Host "Error: Node.js >= 20 required. Current: $(node --version)" -ForegroundColor Red
            $missing = $true
        }
    }

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "Error: npm is not installed. It should come with Node.js." -ForegroundColor Red
        $missing = $true
    }

    return -not $missing
}

function Install-RequiredPrereqs {
    Write-Host ""
    Write-Host "One or more required tools are missing or too old." -ForegroundColor Yellow
    $answer = Read-Host "  Try to install Git, Node.js 20+, and npm now? [y/N]"
    if ($answer -notmatch "^[Yy]") {
        Show-PrereqHelp
        exit 1
    }

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "Automatic prerequisite install requires winget." -ForegroundColor Red
        Show-PrereqHelp
        exit 1
    }

    Write-Host ""
    Write-Host "  Installing prerequisites with winget..." -ForegroundColor DarkGray
    winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Pterodactyl Discord Bridge Bot — Bootstrap     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Prereq checks ─────────────────────────────────────────────────────────────

if (-not (Test-RequiredPrereqs)) {
    Install-RequiredPrereqs
    Write-Host ""
    Write-Host "  Rechecking prerequisites..." -ForegroundColor DarkGray
    if (-not (Test-RequiredPrereqs)) {
        Show-PrereqHelp
        exit 1
    }
}

Write-Host "  OK  git  $(git --version)" -ForegroundColor Green
Write-Host "  OK  node $(node --version)" -ForegroundColor Green
Write-Host "  OK  npm  $(npm --version)" -ForegroundColor Green
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Confirm-ContinueWithoutOptionalTool "Docker" "Docker is only needed if you plan to run the bot with Docker Compose. You can still use npm start without Docker."
}
else {
    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Confirm-ContinueWithoutOptionalTool "Docker Compose" "Docker Compose is only needed for docker compose up --build -d."
    }
}
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
