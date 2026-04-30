#!/bin/bash
# ════════════════════════════════════════════════════════════════════════════════
#  BitMine Web UI — Deployment Script
#  Supports: Ubuntu 20.04+ / Debian 11+
#
#  Usage (first time):
#    git clone https://github.com/YOUR_USERNAME/keyhunt.updated.git /opt/keyhunt
#    cd /opt/keyhunt && bash deploy.sh
#
#  Usage (update):
#    cd /opt/keyhunt && git pull && bash deploy.sh
# ════════════════════════════════════════════════════════════════════════════════
set -e

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
info() { echo -e "${CYAN}[→]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

echo -e "\n${GREEN}╔══════════════════════════════════════╗"
echo -e "║   BitMine Web UI — Deploy Script     ║"
echo -e "╚══════════════════════════════════════╝${NC}\n"

# ── Must run as root ──────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Please run as root: sudo bash deploy.sh"

# ── Resolve install directory ─────────────────────────────────────────────────
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
info "Install directory: $INSTALL_DIR"

# ── Step 1: System dependencies ───────────────────────────────────────────────
echo -e "\n${CYAN}[1/6] System dependencies${NC}"

if command -v apt-get &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq git g++ make curl ufw
  ok "Installed via apt"
elif command -v yum &>/dev/null; then
  yum install -y -q git gcc-c++ make curl
  ok "Installed via yum"
else
  warn "Unknown package manager — make sure git, g++, make, curl are installed"
fi

# ── Step 2: Node.js ───────────────────────────────────────────────────────────
echo -e "\n${CYAN}[2/6] Node.js${NC}"

if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  ok "Node.js already installed: $NODE_VER"
else
  info "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
  ok "Node.js $(node --version) installed"
fi

# ── Step 3: Compile keyhunt ───────────────────────────────────────────────────
echo -e "\n${CYAN}[3/6] Compile keyhunt${NC}"
cd "$INSTALL_DIR"

if [[ -f keyhunt ]]; then
  warn "Binary already exists — recompiling for this CPU..."
  make clean 2>/dev/null || true
fi

info "Compiling (this takes ~30 seconds)..."
make 2>&1 | tail -3
[[ -f keyhunt ]] || die "Compilation failed — binary not found"
ok "keyhunt compiled: $(./keyhunt 2>&1 | head -1 || true)"

# ── Step 4: Frontend dependencies ─────────────────────────────────────────────
echo -e "\n${CYAN}[4/6] Frontend dependencies${NC}"
cd "$INSTALL_DIR/frontend"
npm install --omit=dev --silent
ok "npm packages installed"

# ── Step 5: PM2 ───────────────────────────────────────────────────────────────
echo -e "\n${CYAN}[5/6] PM2 process manager${NC}"

if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2 --silent
  ok "PM2 installed"
else
  ok "PM2 already installed: $(pm2 --version)"
fi

# Stop old instance if running
pm2 stop  bitmine-ui 2>/dev/null && info "Stopped old instance" || true
pm2 delete bitmine-ui 2>/dev/null || true

# Start fresh
pm2 start ecosystem.config.js
pm2 save

# Set up systemd so PM2 restarts on reboot
info "Configuring PM2 startup (systemd)..."
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root 2>&1 | grep "sudo" | tail -1)
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD" 2>/dev/null || warn "Could not auto-run startup command. Run manually: $STARTUP_CMD"
fi
ok "PM2 configured"

# ── Step 6: Firewall ──────────────────────────────────────────────────────────
echo -e "\n${CYAN}[6/6] Firewall (ufw)${NC}"

if command -v ufw &>/dev/null; then
  ufw allow 22/tcp   comment 'SSH'   >/dev/null 2>&1 || true
  ufw allow 3000/tcp comment 'BitMine UI' >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ok "Firewall: ports 22 and 3000 open"
else
  warn "ufw not found — make sure port 3000 is open in your cloud firewall"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "\n${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deployment complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e ""
echo -e "  Dashboard →  ${CYAN}http://${SERVER_IP}:3000${NC}"
echo -e "  PM2 status:  ${YELLOW}pm2 status${NC}"
echo -e "  PM2 logs:    ${YELLOW}pm2 logs bitmine-ui${NC}"
echo -e "  Update:      ${YELLOW}git pull && bash deploy.sh${NC}"
echo -e ""
echo -e "  In the dashboard set:"
echo -e "  Binary Path  →  ${INSTALL_DIR}/keyhunt"
echo -e "  Work Dir     →  ${INSTALL_DIR}"
echo -e ""
