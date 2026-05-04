#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot.git"
DEFAULT_DIR="Pterodactyl-Discord-Bridge-Bot"

bold="\033[1m"
cyan="\033[36m"
green="\033[32m"
red="\033[31m"
dim="\033[2m"
reset="\033[0m"

echo ""
echo -e "${bold}${cyan}╔══════════════════════════════════════════════════╗"
echo -e "║   Pterodactyl Discord Bridge Bot — Bootstrap     ║"
echo -e "╚══════════════════════════════════════════════════╝${reset}"
echo ""

# ── Prereq checks ─────────────────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  echo -e "${red}Error: git is not installed. Install it and re-run this script.${reset}"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo -e "${red}Error: Node.js is not installed. Install Node >= 20 and re-run.${reset}"
  echo -e "${dim}  https://nodejs.org${reset}"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.version.slice(1)))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${red}Error: Node.js >= 20 required. Current: $(node --version)${reset}"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo -e "${red}Error: npm is not installed. It should come with Node.js.${reset}"
  exit 1
fi

echo -e "  ${green}✔${reset} git  $(git --version)"
echo -e "  ${green}✔${reset} node $(node --version)"
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
