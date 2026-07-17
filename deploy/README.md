# RADAR — production install

A fully unattended install of **all services** (PostgreSQL, the RADAR API, and the web UI
behind nginx/TLS) on **Ubuntu (amd64 or arm64)**, built to the **principle of least privilege**.

## What the release pipeline produces

`.github/workflows/release.yml` runs when a GitHub Release is **published**. It builds and
verifies the monorepo on both architectures and attaches a self-contained bundle to the release:

```
radar-<version>-linux-amd64.tar.gz   (+ .sha256)
radar-<version>-linux-arm64.tar.gz   (+ .sha256)
```

Each bundle contains the built API + web UI, the production `node_modules` (pure-JS, no native
modules), the database migrations, and the `deploy/` installer/units/config.

## Install

```bash
# on the target Ubuntu host (as a sudo-capable user)
tar xzf radar-<version>-linux-<arch>.tar.gz
cd radar-<version>-linux-<arch>
sudo ./deploy/install.sh
```

The installer is **non-interactive**. It:

- installs Node 22 (NodeSource), PostgreSQL and nginx;
- creates a dedicated **non-login `radar` system account**;
- lays out root-owned, service-read-only code in `/opt/radar`;
- creates a **non-superuser** PostgreSQL role owning only the `radar` database;
- generates the runtime **master key** and DB password (root-only sources in
  `/etc/radar/secrets`, exposed to the service via a tmpfs `/run/secrets`);
- runs migrations, installs **hardened** systemd units, configures nginx with a **self-signed**
  cert, and locks the firewall to `22/80/443`.

## The only two manual steps

1. **TLS certificate** — replace the seeded self-signed pair, then reload nginx:
   ```bash
   sudo cp fullchain.pem privkey.pem /etc/radar/tls/
   sudo systemctl reload nginx
   ```
2. **Authentication (OIDC / Microsoft Entra ID)** — the API refuses dev-auth in production, so
   protected routes return `401` until OIDC is configured. Edit `/etc/radar/radar.env`:
   ```
   OIDC_ENABLED=true
   OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
   OIDC_AUDIENCE=<application-client-id>
   OIDC_ALLOWED_TENANT_ID=<tenant-id>
   ```
   then `sudo systemctl restart radar-api`.

Optional live integrations (NS1, CloudVision, Prometheus) are configured in
`/etc/radar/radar.env` with their secrets dropped into `/etc/radar/secrets/` — see the comments
in that file and `.env.example`.

## Least-privilege summary

| Concern | Design |
|---|---|
| Service account | `radar`, `--system`, `/usr/sbin/nologin`, no home |
| Code | `/opt/radar` root-owned; service can read/execute, **not write** |
| Filesystem | `ProtectSystem=strict`, no `ReadWritePaths` (state lives in Postgres), `PrivateTmp` |
| Capabilities | `CapabilityBoundingSet=` (empty), `NoNewPrivileges`, `MemoryDenyWriteExecute` |
| Syscalls | `SystemCallFilter=@system-service` minus `@privileged/@resources/@obsolete` |
| Database | `radar` role is `NOSUPERUSER NOCREATEDB NOCREATEROLE`, owns only its DB |
| Secrets | Root-only sources in `/etc/radar/secrets` → tmpfs `/run/secrets/*` (0400, `radar`-only) |
| Network | API binds `127.0.0.1` only; nginx is the sole public listener; ufw `22/80/443` |

## Outbound connectivity

RADAR is read-only to these upstreams and only reaches the ones you configure a connector for.
`ufw` leaves egress open by default, so a standard install needs nothing extra; on a host with a
restrictive **outbound** policy, allow HTTPS (443) to the hosts for the features you enable:

| Host | Used by | Needed when |
|---|---|---|
| `api.nsone.net` | NS1 steering config (live mode) | `RADAR_MODE=live` / NS1 connector |
| `stat.ripe.net` | ASN → network-owner resolution (Network breakdown) | Always useful; **degrades gracefully** to "unresolved" if blocked |
| `www.arista.io` (CVaaS) | CloudVision network telemetry | CloudVision connector |
| `api.cloudflare.com` | Cloudflare Load Balancing | Cloudflare connector |
| `api.fastly.com`, `rt.fastly.com` | Fastly commercial-CDN telemetry | Fastly connector |
| `*.amazonaws.com` (S3) | Akamai DataStream 2 logs | Akamai connector |

Authoritative-DNS observation (Tier-2) additionally needs outbound UDP/TCP 53 to the NS1
nameservers. All of these fail soft — a blocked host disables its feature, it never crashes the API.

## Manage

```bash
systemctl status radar-api radar-migrate nginx postgresql
journalctl -u radar-api -f
```

Upgrading: extract the new bundle and re-run `sudo ./deploy/install.sh` — it redeploys the code,
re-runs migrations (idempotent), and keeps your `/etc/radar/radar.env`, secrets and TLS cert.
