#!/usr/bin/env bash
# certbot DEPLOY-hook: runs only after a certificate is successfully issued or renewed. Installs
# the cert where nginx expects it (/etc/radar/tls) so the nginx config never has to change, then
# reloads nginx. certbot sets RENEWED_LINEAGE to the live directory of the affected certificate.
set -euo pipefail
TLS_DIR=/etc/radar/tls
[ -n "${RENEWED_LINEAGE:-}" ] || exit 0
install -o root -g root     -m 0644 "${RENEWED_LINEAGE}/fullchain.pem" "${TLS_DIR}/fullchain.pem"
install -o root -g www-data -m 0640 "${RENEWED_LINEAGE}/privkey.pem"   "${TLS_DIR}/privkey.pem"
systemctl reload nginx 2>/dev/null || systemctl restart nginx
