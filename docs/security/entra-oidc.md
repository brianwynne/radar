# RADAR Authentication — Microsoft Entra ID (OIDC) & Global Secure Access

RADAR production access uses **two separate, complementary trust boundaries**. RADAR
implements only the second; the first is a deployment/network concern and must not
appear in application code.

## 1. Network reachability — Entra Global Secure Access (deployment concern)

**Microsoft Entra Global Secure Access / Private Access** controls *whether a user or
managed device can reach radar-web / radar-api at all* (identity- and device-aware
network access, Conditional Access, private connectors). This is configured in Entra and
the network, **outside RADAR**.

- RADAR contains **no** GSA-specific code, SDKs, protocols or connector deployment. GSA
  is transparent to the application.
- RADAR must not infer identity, roles or authorisation from GSA. A request that reaches
  RADAR is still fully authenticated and authorised by boundary 2.

## 2. Identity & authorisation — Entra ID OIDC (RADAR implements this)

**Microsoft Entra ID (OIDC/OAuth2)** authenticates the user and supplies **application
role** claims. radar-api validates a bearer access token on every protected request and
maps Entra app roles to the locked RADAR roles; the central RADAR role hierarchy then
derives permissions.

```
client → obtains an Entra access token for the RADAR API (audience = RADAR)
       → Authorization: Bearer <access-token>
radar-api → validates signature/issuer/audience/expiry/tenant (jose, RS256 allow-list)
          → maps Entra app roles → RADAR roles → RadarPrincipal (authenticationMethod: 'oidc')
          → existing requireAuthentication / requirePermission guards enforce access
```

It is standards-compliant OIDC/JWT (Keycloak or any compliant provider also works). It
does **not** use Microsoft Graph, Entra `groups` claims, or directory-role claims for
login or authorisation in v1.

### Entra app registration (operator setup, summary)

1. Register the **RADAR API** application; set an Application ID URI (e.g. `api://radar`)
   — this is `OIDC_AUDIENCE`.
2. Define three **app roles** on that application:
   - `RADAR.NOCViewer` → `NOC_VIEWER`
   - `RADAR.ViewingEngineer` → `VIEWING_ENGINEER`
   - `RADAR.Engineer` → `ENGINEER`
   Assign users/groups to these app roles in Entra.
3. The RADAR frontend (a separate future commit) registers as a client that requests an
   access token for `api://radar` (authorization-code + PKCE). radar-api itself is a
   resource server and needs **no client secret**.

### Configuration

| Variable | Purpose |
|---|---|
| `OIDC_ENABLED` | Turn on OIDC bearer validation (production). |
| `OIDC_ISSUER_URL` | Entra v2 issuer `https://login.microsoftonline.com/<tenant>/v2.0`. |
| `OIDC_AUDIENCE` | RADAR API audience (`api://radar`). |
| `OIDC_ALLOWED_TENANT_ID` | Single-tenant restriction; other tenants are rejected. |
| `OIDC_JWKS_URI` | Optional override; otherwise discovered from the issuer. |
| `OIDC_*_CLAIM` | Claim names (defaults: `oid`/`sub`, `name`, `preferred_username`, `roles`, `tid`). |
| `OIDC_ROLE_*` | External app-role names → RADAR roles. |

Configuration fails fast if OIDC is enabled but incomplete.

### Validation (what radar-api enforces)

Using a mature JOSE library (no hand-rolled crypto), with a fixed **RS256 allow-list**
(the validator, not the token header, decides trusted algorithms), and remote JWKS with
caching + rotation:

- signature, algorithm, issuer, audience, expiry, not-before;
- **tenant** (`tid` == `OIDC_ALLOWED_TENANT_ID`) — mandatory, even if everything else is
  valid;
- a stable subject (`oid`, falling back to `sub`).

Rejected (→ **401**): malformed/unsigned/`alg=none`/unsupported-alg/bad-signature/
expired/not-yet-valid/wrong-issuer/wrong-audience/wrong-tenant/missing-subject tokens.

**No recognised RADAR app role** is *not* a rejection: authentication has **succeeded**
but authorisation has not — the principal has empty roles, `/me` returns 200 with no
permissions, and any permissioned route returns **403**. RADAR never assigns a default
role (not even `NOC_VIEWER`).

### Signing-algorithm policy

- **RS256 is the only currently supported algorithm**, because Microsoft Entra ID is the
  production provider and signs with RS256.
- Supporting another provider that uses a different signing algorithm requires an
  **explicit, reviewed change to the validator configuration** (the allow-list), not a
  runtime toggle.
- RADAR **must never accept an algorithm selected solely by an incoming token header**.
  The validator's allow-list is authoritative; a token claiming a different `alg` is
  rejected.

### Authentication precedence (never a fallback chain)

1. `RADAR_DEV_AUTH=true` → only the fixed dev principal; OIDC is not attempted; the
   production safety gate still applies.
2. else `OIDC_ENABLED=true` → bearer validation; no anonymous and no dev fallback; a
   failed token yields 401 (never a dev principal).
3. else → protected routes return 401; readiness reports `auth: unconfigured`.

### Out of scope for this commit

Frontend login screens, browser sessions, refresh-token storage, Microsoft Graph, GSA
connector code, PostgreSQL, NS1, telemetry and any write functionality.
