#!/usr/bin/env bash
set -e

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
die()     { echo -e "${RED}✗${RESET}  $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Rowan Hub — Installer${RESET}"
echo -e "  rowanhub.co.uk"
echo ""

# ── Checks ────────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root (or with sudo)."
[[ "$(uname -s)" != "Linux" ]] && die "Linux only."

if ! command -v apt-get &>/dev/null; then
  die "This installer requires a Debian/Ubuntu system with apt."
fi

INSTALL_DIR="${ROWAN_HUB_DIR:-/opt/rowan-hub}"

if [[ -d "$INSTALL_DIR" ]]; then
  warn "Rowan Hub is already installed at $INSTALL_DIR"
  echo ""
  read -rp "  Upgrade in place? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  UPGRADE=1
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
header "Checking dependencies…"

apt-get update -qq

# avahi
if ! systemctl is-active --quiet avahi-daemon 2>/dev/null; then
  info "Installing avahi-daemon…"
  apt-get install -y -qq avahi-daemon
  systemctl enable avahi-daemon --quiet
  systemctl start avahi-daemon
  success "avahi-daemon installed and started"
else
  success "avahi-daemon running"
fi

# git
if ! command -v git &>/dev/null; then
  info "Installing git…"
  apt-get install -y -qq git
  success "git installed"
else
  success "git $(git --version | awk '{print $3}')"
fi

# Node.js 20+
NODE_OK=0
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  [[ $NODE_VER -ge 20 ]] && NODE_OK=1
fi

if [[ $NODE_OK -eq 0 ]]; then
  info "Installing Node.js 20 (via NodeSource)…"
  apt-get install -y -qq curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version)"
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2…"
  npm install -g pm2 --quiet
  success "PM2 installed"
else
  success "PM2 $(pm2 --version)"
fi

# ── Clone / update ────────────────────────────────────────────────────────────
header "Installing Rowan Hub…"

if [[ -n "$UPGRADE" ]]; then
  info "Pulling latest from GitHub…"
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" checkout --quiet main
  git -C "$INSTALL_DIR" pull --quiet origin main
  success "Updated to $(git -C "$INSTALL_DIR" describe --tags --always)"
else
  info "Cloning to $INSTALL_DIR…"
  git clone --quiet https://github.com/ArchiveHunter/rowan-hub.git "$INSTALL_DIR"
  success "Cloned $(git -C "$INSTALL_DIR" describe --tags --always)"
fi

cd "$INSTALL_DIR"

info "Installing npm dependencies…"
npm install --omit=dev --quiet
success "Dependencies installed"

# ── Config ────────────────────────────────────────────────────────────────────
if [[ ! -f config.yaml ]]; then
  cp config.example.yaml config.yaml
  success "config.yaml created from template"
  FIRST_RUN=1
else
  success "config.yaml already exists — keeping your settings"
fi

# ── PM2 ───────────────────────────────────────────────────────────────────────
header "Starting Rowan Hub…"

if [[ -n "$UPGRADE" ]]; then
  pm2 restart rowan-hub --update-env 2>/dev/null || pm2 start ecosystem.config.js
else
  pm2 start ecosystem.config.js
fi

pm2 save --quiet
success "Rowan Hub running via PM2"

# Set up startup on boot (only on fresh install to avoid duplicate entries)
if [[ -z "$UPGRADE" ]]; then
  pm2 startup --hp /root 2>/dev/null | grep "sudo" | bash 2>/dev/null || true
  success "PM2 startup configured"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}${BOLD}  Rowan Hub is running!${RESET}"
echo ""
echo -e "  Web UI  →  ${BOLD}http://${LOCAL_IP}:3088${RESET}"
echo -e "  HTTPS   →  ${BOLD}https://${LOCAL_IP}:3443${RESET}  (push notifications, PWA install)"
echo ""

if [[ -n "$FIRST_RUN" ]]; then
  echo -e "  ${YELLOW}Next step:${RESET} edit ${BOLD}${INSTALL_DIR}/config.yaml${RESET}"
  echo -e "  Add your bridge settings and devices, then:"
  echo -e "  ${BOLD}pm2 restart rowan-hub${RESET}"
  echo ""
fi

echo -e "  Logs:     ${BOLD}pm2 logs rowan-hub${RESET}"
echo -e "  Status:   ${BOLD}pm2 status${RESET}"
echo ""
