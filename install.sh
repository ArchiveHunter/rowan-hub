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
  # stdin is the piped script under `curl | sudo bash` — ask on the terminal instead
  read -rp "  Upgrade in place? [y/N] " ans < /dev/tty || ans=""
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

# mosquitto (installed but not started — user enables via the MQTT page in the web UI)
if ! command -v mosquitto &>/dev/null; then
  info "Installing Mosquitto MQTT broker…"
  apt-get install -y -qq mosquitto
  systemctl disable mosquitto --quiet 2>/dev/null || true
  systemctl stop mosquitto 2>/dev/null || true
  success "Mosquitto installed (disabled — enable from the MQTT page in the web UI)"
else
  success "Mosquitto $(mosquitto -h 2>&1 | head -1 | awk '{print $3}')"
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

# ── Service user ──────────────────────────────────────────────────────────────
# Rowan Hub runs unprivileged; only the MQTT broker helper below runs as root.
SERVICE_USER=rowanhub
if ! id -u "$SERVICE_USER" &>/dev/null; then
  useradd --system --user-group --home-dir "$INSTALL_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  success "Created service user $SERVICE_USER"
else
  success "Service user $SERVICE_USER exists"
fi
as_user() { runuser -u "$SERVICE_USER" -- "$@"; }

# ── Clone / update ────────────────────────────────────────────────────────────
header "Installing Rowan Hub…"

if [[ -n "$UPGRADE" ]]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"   # older versions ran as root
  info "Pulling latest from GitHub…"
  as_user git -C "$INSTALL_DIR" fetch --quiet origin
  as_user git -C "$INSTALL_DIR" checkout --quiet main
  as_user git -C "$INSTALL_DIR" pull --quiet --ff-only origin main
  success "Updated to $(as_user git -C "$INSTALL_DIR" describe --tags --always)"
else
  info "Cloning to $INSTALL_DIR…"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$INSTALL_DIR"
  as_user git clone --quiet https://github.com/ArchiveHunter/rowan-hub.git "$INSTALL_DIR"
  success "Cloned $(as_user git -C "$INSTALL_DIR" describe --tags --always)"
fi

cd "$INSTALL_DIR"

info "Installing npm dependencies…"
as_user env HOME="$INSTALL_DIR" npm_config_cache="$INSTALL_DIR/.npm-cache" \
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --quiet
success "Dependencies installed"

# ── MQTT broker helper (the only part that needs root) ───────────────────────
install -o root -g root -m 755 scripts/rowan-hub-mosquitto /usr/local/sbin/rowan-hub-mosquitto
cat > /etc/sudoers.d/rowan-hub <<SUDOERS
$SERVICE_USER ALL=(root) NOPASSWD: /usr/local/sbin/rowan-hub-mosquitto start, /usr/local/sbin/rowan-hub-mosquitto stop
SUDOERS
chmod 440 /etc/sudoers.d/rowan-hub
visudo -cf /etc/sudoers.d/rowan-hub >/dev/null || { rm -f /etc/sudoers.d/rowan-hub; die "sudoers rule failed validation"; }
# Pre-1.2 broker config allowed anonymous access — remove it; Rowan Hub rewrites it with a password
if grep -qs "allow_anonymous true" /etc/mosquitto/conf.d/rowan-hub.conf; then
  rm -f /etc/mosquitto/conf.d/rowan-hub.conf
  systemctl stop mosquitto 2>/dev/null || true
  warn "Removed old anonymous MQTT broker config — MQTT devices need the new username/password (see MQTT page)"
fi
success "MQTT broker helper installed"

# ── Config ────────────────────────────────────────────────────────────────────
if [[ ! -f config.yaml ]]; then
  cp config.example.yaml config.yaml
  success "config.yaml created from template"
  FIRST_RUN=1
else
  success "config.yaml already exists — keeping your settings"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 600 config.yaml

# ── PM2 ───────────────────────────────────────────────────────────────────────
header "Starting Rowan Hub…"

# delete + start (not restart) so PM2 picks up the service user from ecosystem.config.js
pm2 delete rowan-hub &>/dev/null || true
pm2 start ecosystem.config.js

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
  echo -e "  ${YELLOW}Next step:${RESET} open the Web UI to run the setup wizard"
  echo -e "  (create your login, name the bridge and set your location)."
  echo ""
elif [[ -n "$UPGRADE" ]]; then
  echo -e "  ${YELLOW}Note:${RESET} if you haven't created a login yet, the Web UI will ask you to now."
  echo ""
fi

echo -e "  Logs:     ${BOLD}pm2 logs rowan-hub${RESET}"
echo -e "  Status:   ${BOLD}pm2 status${RESET}"
echo ""
