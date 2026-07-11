# RADAR Security — Microsoft Entra Global Secure Access deployment boundary

Global Secure Access (GSA) is a **deployment and network-access concern only**. RADAR
contains no GSA-specific application code or SDK, and GSA never substitutes for
authentication or authorisation inside RADAR.

## Intended production access path

```
Managed RTÉ user / device
  → Microsoft Entra Global Secure Access
  → Entra Private Access
  → Private Network Connector group
  → RADAR reverse proxy / ingress
  → radar-web
  → radar-api
```

## Three independent controls (none replaces another)

1. **Global Secure Access controls network reachability** — whether a user/device can
   reach RADAR at all.
2. **Entra ID OIDC authenticates the user** — validated bearer access token
   ([entra-oidc.md](entra-oidc.md)).
3. **RADAR permission-based RBAC authorises actions** — roles → permissions, enforced
   server-side.

These are layered, complementary controls; **none of them replaces either of the
others**. A request that passes GSA is still fully authenticated (2) and authorised (3)
by RADAR.

## Application constraints

5. RADAR contains **no GSA-specific application code or SDK**. GSA is transparent to the
   app.
6. RADAR remains **platform-independent and containerised**; GSA changes nothing about
   how RADAR is built or run.

## Entra Private Access configuration (operator responsibility)

7. The **RADAR FQDN and TCP port** are configured as an Entra Private Access
   **application segment**.
8. The **connector group** must be able to **resolve and reach RADAR privately** (DNS +
   network path to the reverse proxy / ingress).
9. Deploy **at least two connectors** for production resilience.
10. **Connectors initiate outbound connections** to the Entra service; no inbound port is
    exposed publicly for the connectors.
11. **Direct access that bypasses GSA should be blocked** where operationally practical
    (network policy / firewall so RADAR is reachable only via the private path).

## Transport, proxy and URL hardening

12. **TLS remains enabled** from the access path to the RADAR reverse proxy.
13. **Forwarded headers** (`X-Forwarded-For`, `X-Forwarded-Proto`, `Host`) are trusted
    **only from explicitly configured proxy addresses**; RADAR does not trust forwarded
    headers from arbitrary sources.
14. The **external RADAR base URL is configured explicitly** and is **not derived from an
    arbitrary `Host` header** (prevents host-header injection / open-redirect style
    issues).
15. **Health endpoints** (`/api/v1/health/*`) should be reachable **only by trusted
    platform infrastructure** where practical (orchestrator/ingress health checks), not
    exposed on the public path.

## Recommended Conditional Access assumptions (configured in Entra, not RADAR)

- require **MFA**;
- require a **compliant or managed device** where RTÉ policy permits;
- limit access to **explicitly assigned RADAR users or groups**;
- **block legacy authentication**;
- apply **sign-in risk** controls per RTÉ policy;
- require the **approved Global Secure Access path** where appropriate.

## Not RADAR's responsibility

RADAR does **not** implement or automate GSA, Entra Private Access or Conditional Access.
These are configured by RTÉ platform/identity teams in Entra and the network. RADAR only
consumes the outcome: a reachable request bearing a valid Entra access token.
