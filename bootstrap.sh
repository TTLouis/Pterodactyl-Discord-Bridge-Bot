#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot.git"
DEFAULT_DIR="Pterodactyl-Discord-Bridge-Bot"

bold="\033[1m"
cyan="\033[36m"
green="\033[32m"
yellow="\033[33m"
red="\033[31m"
dim="\033[2m"
reset="\033[0m"

show_prereq_help() {
  echo ""
  echo -e "${bold}Install the missing prerequisites, then run this bootstrap command again.${reset}"
  echo ""
  echo "  Required:"
  echo "    - Git"
  echo "    - Node.js 20 or newer"
  echo "    - npm, which normally comes with Node.js"
  echo ""
  echo "  Optional for Docker Compose hosting:"
  echo "    - Docker"
  echo "    - Docker Compose"
  echo ""

  if command -v apt-get &>/dev/null; then
    echo "  Debian/Ubuntu:"
    echo "    sudo apt-get update && sudo apt-get install -y git"
    echo "    Install Node.js 20 LTS from https://nodejs.org or NodeSource."
    echo "    Install Docker from https://docs.docker.com/engine/install/"
  elif command -v dnf &>/dev/null; then
    echo "  Fedora/RHEL:"
    echo "    sudo dnf install -y git nodejs npm"
    echo "    Install Docker from https://docs.docker.com/engine/install/"
  elif command -v brew &>/dev/null; then
    echo "  macOS/Homebrew:"
    echo "    brew install git node"
    echo "    brew install --cask docker"
  else
    echo "  Downloads:"
    echo "    Git:     https://git-scm.com/downloads"
    echo "    Node.js: https://nodejs.org"
    echo "    Docker:  https://docs.docker.com/get-docker/"
  fi
  echo ""
}

install_required_prereqs() {
  echo ""
  echo -e "${yellow}One or more required tools are missing or too old.${reset}"
  read -rp "  Try to install Git, Node.js 20+, and npm now? [y/N]: " INSTALL_PREREQS
  INSTALL_PREREQS="${INSTALL_PREREQS:-N}"
  if [[ ! "$INSTALL_PREREQS" =~ ^[Yy] ]]; then
    show_prereq_help
    exit 1
  fi

  if command -v apt-get &>/dev/null; then
    echo ""
    echo -e "  Installing prerequisites with apt..."
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg git
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    echo ""
    echo -e "  Installing prerequisites with dnf..."
    sudo dnf install -y git nodejs npm
  elif command -v brew &>/dev/null; then
    echo ""
    echo -e "  Installing prerequisites with Homebrew..."
    brew install git node
  else
    echo -e "${red}Automatic prerequisite install is not supported on this system.${reset}"
    show_prereq_help
    exit 1
  fi
}

validate_prereqs() {
  local missing=0

  if ! command -v git &>/dev/null; then
    echo -e "${red}Error: git is not installed.${reset}"
    missing=1
  fi

  if ! command -v node &>/dev/null; then
    echo -e "${red}Error: Node.js is not installed.${reset}"
    missing=1
  else
    NODE_MAJOR=$(node -e "console.log(parseInt(process.version.slice(1)))")
    if [ "$NODE_MAJOR" -lt 20 ]; then
      echo -e "${red}Error: Node.js >= 20 required. Current: $(node --version)${reset}"
      missing=1
    fi
  fi

  if ! command -v npm &>/dev/null; then
    echo -e "${red}Error: npm is not installed. It should come with Node.js.${reset}"
    missing=1
  fi

  return "$missing"
}

warn_optional_docker() {
  if ! command -v docker &>/dev/null; then
    echo -e "${yellow}Warning: Docker is not installed.${reset}"
    echo "  Docker is only needed if you plan to run the bot with Docker Compose."
    echo "  You can still use npm start without Docker."
    read -rp "  Continue without Docker? [Y/n]: " CONTINUE_WITHOUT_DOCKER
    CONTINUE_WITHOUT_DOCKER="${CONTINUE_WITHOUT_DOCKER:-Y}"
    if [[ ! "$CONTINUE_WITHOUT_DOCKER" =~ ^[Yy] ]]; then
      show_prereq_help
      exit 1
    fi
    echo ""
    return
  fi

  if ! docker compose version &>/dev/null; then
    echo -e "${yellow}Warning: Docker is installed, but Docker Compose is not available.${reset}"
    echo "  Docker Compose is only needed for docker compose up --build -d."
    read -rp "  Continue without Docker Compose? [Y/n]: " CONTINUE_WITHOUT_COMPOSE
    CONTINUE_WITHOUT_COMPOSE="${CONTINUE_WITHOUT_COMPOSE:-Y}"
    if [[ ! "$CONTINUE_WITHOUT_COMPOSE" =~ ^[Yy] ]]; then
      show_prereq_help
      exit 1
    fi
    echo ""
  fi
}

echo ""
echo -e "${bold}${cyan}╔══════════════════════════════════════════════════╗"
echo -e "║   Pterodactyl Discord Bridge Bot — Bootstrap     ║"
echo -e "╚══════════════════════════════════════════════════╝${reset}"
echo ""

# ── Prereq checks ─────────────────────────────────────────────────────────────

if ! validate_prereqs; then
  install_required_prereqs
  echo ""
  echo -e "  Rechecking prerequisites..."
  if ! validate_prereqs; then
    show_prereq_help
    exit 1
  fi
fi

echo -e "  ${green}✔${reset} git  $(git --version)"
echo -e "  ${green}✔${reset} node $(node --version)"
echo -e "  ${green}✔${reset} npm  $(npm --version)"
warn_optional_docker
echo ""

# ── Clone ──────────────────────────────────────────────────────────────────────

read -rp "  Install directory [$DEFAULT_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"

if [ -d "$INSTALL_DIR" ]; then
  echo -e "${red}Error: '$INSTALL_DIR' already exists. Remove it or choose a different name.${reset}"
  exit 1
fi

echo ""
echo -e "  Cloning repository..."
git clone "$REPO_URL" "$INSTALL_DIR" --quiet
echo -e "  ${green}✔${reset} Cloned into $INSTALL_DIR"

cd "$INSTALL_DIR"

# ── Install ────────────────────────────────────────────────────────────────────

echo ""
echo -e "  Installing dependencies..."
npm install --silent
echo -e "  ${green}✔${reset} Dependencies installed"

# ── Setup wizard ───────────────────────────────────────────────────────────────

echo ""
node setup.js
