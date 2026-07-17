#!/usr/bin/env bash
# certbot POST-hook: close port 80 again after the renewal attempt. Runs whether or not the
# renewal succeeded, so port 80 is never left open.
ufw delete allow 80/tcp >/dev/null 2>&1 || true
