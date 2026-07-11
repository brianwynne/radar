// RADAR authorisation model — framework-independent. Explicit permissions; role
// inheritance implemented once (Engineer ⊃ Viewing Engineer ⊃ NOC Viewer).
// Routes check permissions, never role names.

export type RadarRole = 'NOC_VIEWER' | 'VIEWING_ENGINEER' | 'ENGINEER';

export type RadarPermission =
  | 'dashboard.read'
  | 'steering.summary.read'
  | 'topology.summary.read'
  | 'dns.explain.read'
  | 'ns1.detail.read'
  | 'ns1.raw.read'
  | 'simulation.run'
  | 'snapshot.read'
  | 'snapshot.create'
  | 'topology.manage'
  | 'mapping.manage'
  | 'threshold.manage'
  | 'audit.read';

export const RADAR_ROLES: readonly RadarRole[] = ['NOC_VIEWER', 'VIEWING_ENGINEER', 'ENGINEER'];

/** Permissions granted *directly* by each role (not counting inheritance). */
const DIRECT: Record<RadarRole, RadarPermission[]> = {
  NOC_VIEWER: ['dashboard.read', 'steering.summary.read', 'topology.summary.read'],
  VIEWING_ENGINEER: ['dns.explain.read', 'ns1.detail.read', 'ns1.raw.read', 'simulation.run', 'snapshot.read', 'audit.read'],
  ENGINEER: ['snapshot.create', 'topology.manage', 'mapping.manage', 'threshold.manage'],
};

/** The single inheritance chain: each role inherits the one before it. */
const INHERITS: Record<RadarRole, RadarRole | null> = {
  NOC_VIEWER: null,
  VIEWING_ENGINEER: 'NOC_VIEWER',
  ENGINEER: 'VIEWING_ENGINEER',
};

/** Effective permissions for a role, following the inheritance chain once. */
export function permissionsForRole(role: RadarRole): RadarPermission[] {
  const set = new Set<RadarPermission>();
  let r: RadarRole | null = role;
  while (r) {
    for (const p of DIRECT[r]) set.add(p);
    r = INHERITS[r];
  }
  return [...set];
}

/** Union of effective permissions for a set of roles, in stable order. */
export function permissionsForRoles(roles: RadarRole[]): RadarPermission[] {
  const set = new Set<RadarPermission>();
  for (const role of roles) for (const p of permissionsForRole(role)) set.add(p);
  return [...set].sort();
}
