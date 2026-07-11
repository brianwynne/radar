# RADAR Security Documentation

RADAR production access relies on three independent, layered controls — none replaces
another:

1. **Network reachability** — Microsoft Entra Global Secure Access / Private Access
   ([global-secure-access.md](global-secure-access.md)). A deployment/network concern;
   RADAR contains no GSA code.
2. **Authentication** — Microsoft Entra ID OIDC bearer-token validation
   ([entra-oidc.md](entra-oidc.md)). RADAR validates the token and derives a principal.
3. **Authorisation** — RADAR permission-based RBAC ([../role-permission-matrix.md](../role-permission-matrix.md)),
   enforced server-side.

Related: [../threat-model.md](../threat-model.md) (STRIDE), and the read-only NS1
posture in [../ns1/assumptions.md](../ns1/assumptions.md).
