#!/usr/bin/env bash
#
# RADAR — unattended installer for Ubuntu (amd64 / arm64).
#
# Installs all services (PostgreSQL, the RADAR API, and the web UI behind nginx/TLS) with the
# principle of least privilege: a dedicated non-login `radar` system account, a hardened
# systemd sandbox, a non-superuser database role owning only the radar database, root-only
# secret sources exposed to the service via a tmpfs, and code the service cannot modify.
#
# Run from an extracted release bundle:
#     tar xzf radar-<version>-linux-<arch>.tar.gz
#     cd radar-<version>-linux-<arch>
#     sudo ./deploy/install.sh
#
# Fully unattended. The ONLY post-install steps are:
#   1. Drop your real TLS certificate at /etc/radar/tls/{fullchain.pem,privkey.pem}
#      (a self-signed pair is seeded so HTTPS works immediately), then `systemctl reload nginx`.
#   2. Configure OIDC/Entra in /etc/radar/radar.env, then `systemctl restart radar-api`
#      (until then, protected API routes return 401 by design).
#
set -euo pipefail

RADAR_USER="radar"
OPT_DIR="/opt/radar"
ETC_DIR="/etc/radar"
SECRETS_DIR="${ETC_DIR}/secrets"
TLS_DIR="${ETC_DIR}/tls"
DB_NAME="radar"
DB_ROLE="radar"
NODE_MAJOR="22"

log()  { printf '\033[1;34m[radar]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[radar]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[radar] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

BUNDLE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --skip-cert: don't set up Let's Encrypt (TLS is terminated upstream — e.g. Cloudflare Tunnel /
# cloudflared / an external load balancer). A self-signed cert is still seeded so nginx serves 443
# for the local origin connection.
SKIP_CERT=0
for arg in "$@"; do
  case "$arg" in
    --skip-cert|--no-letsencrypt|--behind-proxy) SKIP_CERT=1 ;;
    -h|--help) echo "usage: install.sh [--skip-cert]"; exit 0 ;;
  esac
done

# --- 0. Preflight ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ]        || die "must be run as root (use sudo)."
command -v apt-get >/dev/null || die "this installer supports Debian/Ubuntu (apt-get not found)."
[ -d "${BUNDLE_ROOT}/apps/api/dist" ] || die "run this from an extracted release bundle (apps/api/dist not found)."
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in amd64|arm64) ;; *) die "unsupported architecture: ${ARCH} (need amd64 or arm64)." ;; esac
log "Installing RADAR on Ubuntu ${ARCH}."

export DEBIAN_FRONTEND=noninteractive

# --- 1. System packages (Node 22 via NodeSource; PostgreSQL, nginx from Ubuntu) -------------
log "Installing system packages…"
apt-get update -qq
PKGS="ca-certificates curl gnupg openssl ufw postgresql nginx"
[ "$SKIP_CERT" -eq 0 ] && PKGS="$PKGS certbot"
apt-get install -y -qq $PKGS >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR} (NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
log "Using node $(node -v) at ${NODE_BIN}."

# --- 2. Least-privilege service account -----------------------------------------------------
if ! id -u "$RADAR_USER" >/dev/null 2>&1; then
  log "Creating system account '${RADAR_USER}' (no login, no home)."
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$RADAR_USER"
fi

# --- 3. Filesystem layout (least privilege) -------------------------------------------------
# Code: root-owned, world-readable, NOT writable by the service.
# Config/secrets: root-owned; radar can read only radar.env (via group), never the secret sources.
log "Laying out ${OPT_DIR} and ${ETC_DIR}…"
install -d -o root -g root -m 0755 "$OPT_DIR"
install -d -o root -g root -m 0750 "$ETC_DIR"
install -d -o root -g root -m 0700 "$SECRETS_DIR"
install -d -o root -g root -m 0755 "$TLS_DIR"

# Deploy the code bundle (mirror; keep the previous copy's config untouched).
rm -rf "${OPT_DIR}.new"
cp -a "$BUNDLE_ROOT" "${OPT_DIR}.new"
rm -rf "${OPT_DIR}.old"
[ -e "$OPT_DIR" ] && mv "$OPT_DIR" "${OPT_DIR}.old" 2>/dev/null || true
mv "${OPT_DIR}.new" "$OPT_DIR"
rm -rf "${OPT_DIR}.old"
chown -R root:root "$OPT_DIR"
find "$OPT_DIR" -type d -exec chmod 0755 {} +
find "$OPT_DIR" -type f -exec chmod 0644 {} +
chmod 0755 "${OPT_DIR}/deploy/install.sh"

# --- 4. PostgreSQL: non-superuser role + owned database -------------------------------------
systemctl enable --now postgresql >/dev/null 2>&1 || true
if [ ! -f "${SECRETS_DIR}/db_password" ]; then
  log "Creating PostgreSQL role '${DB_ROLE}' and database '${DB_NAME}'…"
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_ROLE}') THEN
    CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${DB_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE ${DB_ROLE} PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
    || sudo -u postgres createdb -O "$DB_ROLE" "$DB_NAME"
  umask 077; printf '%s' "$DB_PASS" > "${SECRETS_DIR}/db_password"
  chmod 0400 "${SECRETS_DIR}/db_password"
else
  log "Reusing existing database credentials."
  DB_PASS="$(cat "${SECRETS_DIR}/db_password")"
fi

# --- 5. Secrets: runtime master key (root-only source; tmpfs copy for the service) ----------
if [ ! -f "${SECRETS_DIR}/radar_master_key" ]; then
  log "Generating the runtime master key…"
  umask 077; openssl rand -base64 48 > "${SECRETS_DIR}/radar_master_key"
fi
chmod 0400 "${SECRETS_DIR}/radar_master_key"
chown root:root "${SECRETS_DIR}"/*

install -o root -g root -m 0644 "${OPT_DIR}/deploy/tmpfiles.d/radar.conf" /etc/tmpfiles.d/radar.conf
# Optional secret sources may be absent on a fresh install, so tolerate their skipped copies;
# the master key (always present) is verified explicitly.
systemd-tmpfiles --create /etc/tmpfiles.d/radar.conf || true
[ -f /run/secrets/radar_master_key ] || die "failed to provision the master key to /run/secrets."

# --- 6. API environment (root:radar 0640 — readable by the service, never world) ------------
if [ ! -f "${ETC_DIR}/radar.env" ]; then
  log "Writing ${ETC_DIR}/radar.env…"
  DB_URL="postgresql://${DB_ROLE}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
  sed "s#__DATABASE_URL__#${DB_URL}#" "${OPT_DIR}/deploy/radar.env.template" > "${ETC_DIR}/radar.env"
  chown root:"$RADAR_USER" "${ETC_DIR}/radar.env"
  chmod 0640 "${ETC_DIR}/radar.env"
else
  log "Keeping existing ${ETC_DIR}/radar.env (edit it to change configuration)."
fi

# --- 7. TLS: seed a self-signed certificate so HTTPS works immediately ----------------------
if [ ! -f "${TLS_DIR}/fullchain.pem" ] || [ ! -f "${TLS_DIR}/privkey.pem" ]; then
  log "Seeding a self-signed TLS certificate (replace with your real cert)…"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "${TLS_DIR}/privkey.pem" -out "${TLS_DIR}/fullchain.pem" \
    -subj "/CN=radar.local" -addext "subjectAltName=DNS:radar.local" >/dev/null 2>&1
  chmod 0644 "${TLS_DIR}/fullchain.pem"; chmod 0640 "${TLS_DIR}/privkey.pem"
  chown root:www-data "${TLS_DIR}/privkey.pem"
fi

# --- 8. systemd units ----------------------------------------------------------------------
log "Installing systemd units…"
install -o root -g root -m 0644 "${OPT_DIR}/deploy/systemd/radar-migrate.service" /etc/systemd/system/radar-migrate.service
install -o root -g root -m 0644 "${OPT_DIR}/deploy/systemd/radar-api.service"     /etc/systemd/system/radar-api.service
systemctl daemon-reload
systemctl enable radar-migrate.service radar-api.service >/dev/null 2>&1 || true

# --- 8b. Management CLI + login banner ------------------------------------------------------
log "Installing the 'radar' CLI and login banner…"
install -o root -g root -m 0755 "${OPT_DIR}/deploy/radar" /usr/local/bin/radar
install -d -o root -g root -m 0755 /etc/update-motd.d
install -o root -g root -m 0755 "${OPT_DIR}/deploy/motd/99-radar" /etc/update-motd.d/99-radar
# Record the installed version for `radar version`/status and the banner (the bundle ships VERSION;
# fall back to the API package version for a dev-tree install).
if [ -f "${BUNDLE_ROOT}/VERSION" ]; then
  install -o root -g root -m 0644 "${BUNDLE_ROOT}/VERSION" "${OPT_DIR}/VERSION"
else
  node -p "require('${OPT_DIR}/apps/api/package.json').version" 2>/dev/null > "${OPT_DIR}/VERSION" || true
fi

# --- 9. nginx site + Let's Encrypt (certbot) -----------------------------------------------
log "Configuring nginx…"
install -o root -g root -m 0644 "${OPT_DIR}/deploy/nginx/radar.conf" /etc/nginx/sites-available/radar.conf
ln -sf /etc/nginx/sites-available/radar.conf /etc/nginx/sites-enabled/radar.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true

# ACME webroot (nginx serves the HTTP-01 challenge from here on port 80) + renewal hooks that
# open port 80 only for the duration of a renewal and install the renewed cert for nginx.
rm -f "${ETC_DIR}/.tls-external"
if [ "$SKIP_CERT" -eq 0 ]; then
  log "Setting up Let's Encrypt (certbot) renewal hooks…"
  install -d -o root -g root -m 0755 /var/www/certbot
  for phase in pre post deploy; do
    install -d -o root -g root -m 0755 "/etc/letsencrypt/renewal-hooks/${phase}"
    for hook in "${OPT_DIR}/deploy/letsencrypt/renewal-hooks/${phase}"/*.sh; do
      [ -e "$hook" ] && install -o root -g root -m 0755 "$hook" "/etc/letsencrypt/renewal-hooks/${phase}/$(basename "$hook")"
    done
  done
  systemctl enable certbot.timer >/dev/null 2>&1 || true   # twice-daily `certbot renew`
else
  log "Skipping Let's Encrypt — TLS is terminated upstream (self-signed cert kept for the origin)."
  : > "${ETC_DIR}/.tls-external"   # marker: suppress the TLS setup nag in the login banner
fi

# --- 10. Firewall (allow SSH first so we never lock ourselves out) --------------------------
if [ "$SKIP_CERT" -eq 0 ]; then
  log "Configuring ufw (22, 443; 80 opens only during cert renewal)…"
  ufw allow 22/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw delete allow 80/tcp >/dev/null 2>&1 || true   # ensure 80 is not left open from a prior install
else
  # Behind an upstream proxy/tunnel (cloudflared): it connects out and reaches nginx over loopback,
  # which ufw never blocks — so only SSH needs an inbound rule. 443 stays allowed as a direct
  # fallback; remove it manually (ufw delete allow 443/tcp) if you want the box fully tunnel-only.
  log "Configuring ufw (22, 443; TLS upstream — no port 80)…"
  ufw allow 22/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw delete allow 80/tcp >/dev/null 2>&1 || true
fi
ufw --force enable >/dev/null

# --- 11. Start & verify --------------------------------------------------------------------
log "Starting services…"
systemctl restart radar-migrate.service
systemctl restart radar-api.service
systemctl reload nginx || systemctl restart nginx

# Wait for the API health endpoint.
ok=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3000/api/v1/health/live" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { warn "API did not report healthy in time — check: journalctl -u radar-api -n 50"; }

cat <<DONE

$( [ -n "$ok" ] && echo "✓ RADAR is installed and running." || echo "⚠ RADAR installed; API health check pending (see logs)." )

  Web UI : https://<this-host>/         (self-signed cert — browser warning until you add yours)
  API    : http://127.0.0.1:3000/api/v1/health/live  (loopback only, behind nginx)

  Manage : radar status | radar logs -f | radar restart | radar upgrade [--version vX.Y.Z]
           (login banner shows this too; `radar help` for all commands)

  Remaining manual steps:
$( [ "$SKIP_CERT" -eq 0 ] && cat <<TLS
   1) TLS  — issue a Let's Encrypt certificate (opens port 80 only for the challenge, then
             closes it; auto-renews the same way):
                sudo radar cert --domain radar.example.ie --email you@example.ie
             (until then a self-signed cert is in place, so HTTPS already works)
TLS
[ "$SKIP_CERT" -ne 0 ] && echo "   1) TLS  — skipped (terminated upstream, e.g. cloudflared). nginx serves 443 with a
             self-signed cert for the origin; point your tunnel at https://localhost (noTLSVerify)." )
   2) AUTH — set OIDC_* in /etc/radar/radar.env (Entra app registration),
             then: sudo systemctl restart radar-api
             (until configured, protected API routes correctly return 401)

DONE
