#!/usr/bin/env bash
# certbot PRE-hook: open port 80 for the ACME HTTP-01 challenge. Runs once before a renewal is
# attempted (only when a certificate is actually due). The post-hook closes it again.
ufw allow 80/tcp >/dev/null 2>&1 || true
