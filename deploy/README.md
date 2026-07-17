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

### One-command bootstrap (recommended)

On a bare Ubuntu host, this pulls the release bundle for the host's architecture from GitHub,
verifies its checksum, and runs the installer — no manual download or `scp`:

```bash
curl -fsSL https://raw.githubusercontent.com/brianwynne/radar/main/deploy/bootstrap.sh \
  | sudo bash -s -- --version v0.1.0-rc2
```

- Omit `--version` to install the newest release (pre-releases included).
- Add **`--skip-cert`** when TLS is terminated upstream (Cloudflare Tunnel / cloudflared / a proxy) —
  see *TLS* below.
- After it finishes (unless `--skip-cert`): `sudo radar cert --domain <fqdn> --email <addr>`.

While the repo is private, pass a token instead (also saved for future `radar upgrade`):

```bash
export GH=<github-token>
curl -fsSL -H "Authorization: Bearer $GH" -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/brianwynne/radar/contents/deploy/bootstrap.sh?ref=main" \
  | sudo GITHUB_TOKEN="$GH" bash -s -- --version v0.1.0-rc2
```

### Manual (from a downloaded bundle)

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
| `acme-v02.api.letsencrypt.org` | TLS certificate issuance/renewal (certbot) | `radar cert` + auto-renew (also needs inbound 80 open during the challenge — handled automatically) |

Authoritative-DNS observation (Tier-2) additionally needs outbound UDP/TCP 53 to the NS1
nameservers. All of these fail soft — a blocked host disables its feature, it never crashes the API.

## Manage — the `radar` CLI

The installer drops a `radar` command on `PATH` and a login banner (MOTD) that shows version,
health and the common commands on every SSH login.

```bash
radar status                          # service, health and installed version
radar logs -f                         # follow the API journal (journalctl args pass through)
radar restart | start | stop          # control the API service
radar version                         # installed version
radar upgrade [--version vX.Y.Z]      # download, verify (sha256) and apply a release (latest if omitted)
radar rollback                        # reinstall the previously-installed version
radar cert --domain <fqdn> [--email <addr>]   # issue a Let's Encrypt cert (see TLS below)
radar set-token [<token>]             # store a GitHub token for a private-repo release download
radar help
```

### TLS (Let's Encrypt / certbot)

Port 80 is **closed at the firewall** in normal operation; it is opened **only for the duration of
an ACME challenge**. Issue the first certificate with:

```bash
sudo radar cert --domain radar.example.ie --email you@example.ie   # add --staging to dry-run
```

This opens port 80, runs `certbot certonly --webroot` (nginx serves the `.well-known/acme-challenge`
from `/var/www/certbot`), then closes port 80 again. The cert is installed to `/etc/radar/tls/` and
nginx reloads. **Renewals are automatic** via `certbot.timer`, and certbot's renewal hooks repeat
the same open-80 → renew → close-80 dance and reload nginx — installed to
`/etc/letsencrypt/renewal-hooks/{pre,post,deploy}/`. Until you issue a real cert, the seeded
self-signed pair keeps HTTPS working (with a browser warning).

**TLS terminated upstream (cloudflared / a proxy / a load balancer):** install with **`--skip-cert`**.
certbot and the renewal hooks are not set up, the login banner won't nag about TLS, and no port 80
is involved. nginx still serves 443 locally with the self-signed cert, so point your tunnel at
`https://localhost` (with `noTLSVerify: true`, since the origin cert is self-signed) or at
`http://localhost` if you add a plain-HTTP server block. With cloudflared the tunnel dials **out** to
Cloudflare, so no inbound ports are needed at all — the EC2 security group can drop 80/443 entirely
and keep only SSH.

### Upgrading

```bash
sudo radar upgrade --version v0.1.0        # or omit --version for the latest published release
```

`upgrade` fetches the matching `radar-<tag>-linux-<arch>.tar.gz` release asset, verifies its
checksum, and runs the bundle's own idempotent `install.sh`: the code in `/opt/radar` is swapped,
migrations re-run, and services restart — while `/etc/radar/radar.env`, secrets, TLS cert and the
database are kept. `radar rollback` reinstalls the version you were on before the last upgrade.

Private repo: the release assets require a GitHub token — set it once with `sudo radar set-token`
(stored root-only at `/etc/radar/.github-token`) or export `GITHUB_TOKEN`.

The equivalent manual path still works: extract a bundle and run `sudo ./deploy/install.sh`.
