#!/usr/bin/env bash
set -euo pipefail

PACKAGE_URL="https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/archive/refs/heads/main.zip"
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
  echo "    - Node.js 20 or newer"
  echo "    - npm, which normally comes with Node.js"
  echo "    - unzip"
  echo ""
  echo "  Optional for Docker Compose hosting:"
  echo "    - Docker"
  echo "    - Docker Compose"
  echo ""

  if command -v apt-get &>/dev/null; then
    echo "  Debian/Ubuntu:"
    echo "    sudo apt-get update && sudo apt-get install -y unzip"
    echo "    Install Node.js 20 LTS from https://nodejs.org or NodeSource."
    echo "    Install Docker from https://docs.docker.com/engine/install/"
  elif command -v dnf &>/dev/null; then
    echo "  Fedora/RHEL:"
    echo "    sudo dnf install -y nodejs npm unzip"
    echo "    Install Docker from https://docs.docker.com/engine/install/"
  elif command -v brew &>/dev/null; then
    echo "  macOS/Homebrew:"
    echo "    brew install node"
    echo "    brew install --cask docker"
  else
    echo "  Downloads:"
    echo "    Node.js: https://nodejs.org"
    echo "    Docker:  https://docs.docker.com/get-docker/"
  fi
  echo ""
}

install_required_prereqs() {
  echo ""
  echo -e "${yellow}One or more required tools are missing or too old.${reset}"
  read -rp "  Try to install Node.js 20+, npm, and unzip now? [y/N]: " INSTALL_PREREQS
  INSTALL_PREREQS="${INSTALL_PREREQS:-N}"
  if [[ ! "$INSTALL_PREREQS" =~ ^[Yy] ]]; then
    show_prereq_help
    exit 1
  fi

  if command -v apt-get &>/dev/null; then
    echo ""
    echo -e "  Installing prerequisites with apt..."
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg unzip
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    echo ""
    echo -e "  Installing prerequisites with dnf..."
    sudo dnf install -y nodejs npm unzip
  elif command -v brew &>/dev/null; then
    echo ""
    echo -e "  Installing prerequisites with Homebrew..."
    brew install node
  else
    echo -e "${red}Automatic prerequisite install is not supported on this system.${reset}"
    show_prereq_help
    exit 1
  fi
}

validate_prereqs() {
  local missing=0

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

  if ! command -v unzip &>/dev/null; then
    echo -e "${red}Error: unzip is not installed.${reset}"
    missing=1
  fi

  return "$missing"
}

download_file() {
  local url="$1"
  local output="$2"

  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$output"
  elif command -v wget &>/dev/null; then
    wget -q -O "$output" "$url"
  else
    echo -e "${red}Error: curl or wget is required to download the release package.${reset}"
    exit 1
  fi
}

install_docker() {
  if command -v apt-get &>/dev/null; then
    echo -e "  Installing Docker with apt..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo apt-get install -y docker-compose-plugin
    sudo systemctl enable --now docker
  elif command -v dnf &>/dev/null; then
    echo -e "  Installing Docker with dnf..."
    sudo dnf install -y docker docker-compose-plugin
    sudo systemctl enable --now docker
  elif command -v brew &>/dev/null; then
    echo -e "  Installing Docker Desktop with Homebrew..."
    brew install --cask docker
    echo -e "${yellow}  Open Docker Desktop once to finish setup, then re-run this script.${reset}"
    exit 0
  else
    echo -e "${red}Automatic Docker install is not supported on this system.${reset}"
    show_prereq_help
    exit 1
  fi
}

install_docker_compose() {
  if command -v apt-get &>/dev/null; then
    echo -e "  Installing Docker Compose plugin with apt..."
    sudo apt-get install -y docker-compose-plugin
  elif command -v dnf &>/dev/null; then
    echo -e "  Installing Docker Compose plugin with dnf..."
    sudo dnf install -y docker-compose-plugin
  else
    echo -e "${red}Automatic Docker Compose install is not supported on this system.${reset}"
    show_prereq_help
    exit 1
  fi
}

warn_optional_docker() {
  if ! command -v docker &>/dev/null; then
    echo -e "${yellow}Warning: Docker is not installed.${reset}"
    echo "  Docker is only needed if you plan to run the bot with Docker Compose."
    echo "  You can still use npm start without Docker."
    read -rp "  Install Docker now? [y/N]: " INSTALL_DOCKER
    INSTALL_DOCKER="${INSTALL_DOCKER:-N}"
    if [[ "$INSTALL_DOCKER" =~ ^[Yy] ]]; then
      install_docker
      echo ""
      if command -v docker &>/dev/null; then
        echo -e "  ${green}✔${reset} Docker $(docker --version)"
      fi
    else
      read -rp "  Continue without Docker? [Y/n]: " CONTINUE_WITHOUT_DOCKER
      CONTINUE_WITHOUT_DOCKER="${CONTINUE_WITHOUT_DOCKER:-Y}"
      if [[ ! "$CONTINUE_WITHOUT_DOCKER" =~ ^[Yy] ]]; then
        show_prereq_help
        exit 1
      fi
    fi
    echo ""
    return
  fi

  if ! docker compose version &>/dev/null; then
    echo -e "${yellow}Warning: Docker is installed, but Docker Compose is not available.${reset}"
    echo "  Docker Compose is only needed for docker compose up --build -d."
    read -rp "  Install Docker Compose plugin now? [y/N]: " INSTALL_COMPOSE
    INSTALL_COMPOSE="${INSTALL_COMPOSE:-N}"
    if [[ "$INSTALL_COMPOSE" =~ ^[Yy] ]]; then
      install_docker_compose
      echo ""
      if docker compose version &>/dev/null; then
        echo -e "  ${green}✔${reset} $(docker compose version)"
      fi
    else
      read -rp "  Continue without Docker Compose? [Y/n]: " CONTINUE_WITHOUT_COMPOSE
      CONTINUE_WITHOUT_COMPOSE="${CONTINUE_WITHOUT_COMPOSE:-Y}"
      if [[ ! "$CONTINUE_WITHOUT_COMPOSE" =~ ^[Yy] ]]; then
        show_prereq_help
        exit 1
      fi
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

echo -e "  ${green}✔${reset} node $(node --version)"
echo -e "  ${green}✔${reset} npm  $(npm --version)"
echo -e "  ${green}✔${reset} unzip $(unzip -v | head -n 1)"
warn_optional_docker
echo ""

# ── Download ───────────────────────────────────────────────────────────────────

read -rp "  Install directory [$DEFAULT_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"

if [ -d "$INSTALL_DIR" ]; then
  echo -e "${red}Error: '$INSTALL_DIR' already exists. Remove it or choose a different name.${reset}"
  exit 1
fi

echo ""
echo -e "  Downloading release package..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
download_file "$PACKAGE_URL" "$TMP_DIR/package.zip"
unzip -q "$TMP_DIR/package.zip" -d "$TMP_DIR/package"
PACKAGE_ROOT="$(find "$TMP_DIR/package" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$PACKAGE_ROOT" ]; then
  echo -e "${red}Error: release package did not contain a project directory.${reset}"
  exit 1
fi
mv "$PACKAGE_ROOT" "$INSTALL_DIR"
echo -e "  ${green}✔${reset} Installed files into $INSTALL_DIR"

cd "$INSTALL_DIR"

# ── Install ────────────────────────────────────────────────────────────────────

echo ""
echo -e "  Installing dependencies..."
npm install
echo -e "  ${green}✔${reset} Dependencies installed"

# ── Setup wizard ───────────────────────────────────────────────────────────────

echo ""
node setup.js
