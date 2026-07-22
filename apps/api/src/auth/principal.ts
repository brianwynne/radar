// The authenticated caller, independent of any transport or IdP. Fastify attaches a
// RadarPrincipal (or null) to each request; guards read only this. Real OIDC will
// build the same shape with authenticationMethod: 'oidc'.
import type { RadarPermission, RadarRole } from './permissions.js';
import { permissionsForRoles } from './permissions.js';

export interface RadarPrincipal {
  subject: string;
  displayName?: string;
  email?: string;
  roles: RadarRole[];
  permissions: RadarPermission[];
  authenticationMethod: 'dev' | 'oidc' | 'cf-access';
}

/** Build a principal, deriving effective permissions from its roles. */
export function buildPrincipal(input: {
  subject: string;
  displayName?: string;
  email?: string;
  roles: RadarRole[];
  authenticationMethod: 'dev' | 'oidc' | 'cf-access';
}): RadarPrincipal {
  return { ...input, permissions: permissionsForRoles(input.roles) };
}
