import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { requirePermission } from '../src/auth/guards.js';
import { permissionsForRole } from '../src/auth/permissions.js';

/** Build an app with two test-only guarded routes (not part of the API surface). */
async function makeApp(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env }));
  app.get('/api/v1/_test/engineer-only', { preHandler: requirePermission('topology.manage') }, async () => ({ ok: true }));
  app.get('/api/v1/_test/noc', { preHandler: requirePermission('dashboard.read') }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

const dev = (role: string): Record<string, string> => ({
  RADAR_DEV_AUTH: 'true',
  RADAR_DEV_ROLE: role,
  RADAR_DEV_USER_ID: 'dev-engineer',
  RADAR_DEV_USER_NAME: 'Development Engineer',
  RADAR_DEV_USER_EMAIL: 'dev-engineer@example.invalid',
});

describe('permission inheritance', () => {
  it('Viewing Engineer inherits NOC Viewer, without engineer-only permissions', () => {
    const perms = permissionsForRole('VIEWING_ENGINEER');
    expect(perms).toContain('dashboard.read'); // from NOC_VIEWER
    expect(perms).toContain('dns.explain.read'); // VIEWING_ENGINEER
    expect(perms).not.toContain('topology.manage'); // ENGINEER-only
  });

  it('Engineer inherits Viewing Engineer and NOC Viewer', () => {
    const perms = permissionsForRole('ENGINEER');
    expect(perms).toEqual(
      expect.arrayContaining(['dashboard.read', 'dns.explain.read', 'topology.manage', 'snapshot.create']),
    );
  });
});

describe('development authentication', () => {
  it('GET /api/v1/me returns the configured dev principal with inherited permissions', async () => {
    const app = await makeApp(dev('ENGINEER'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subject).toBe('dev-engineer');
    expect(body.displayName).toBe('Development Engineer');
    expect(body.roles).toEqual(['ENGINEER']);
    expect(body.authenticationMethod).toBe('dev');
    expect(body.developmentAuthentication).toBe(true);
    expect(body.permissions).toContain('dashboard.read'); // inherited from NOC
    expect(body.permissions).toContain('snapshot.create'); // engineer
    await app.close();
  });

  it('returns 401 when development authentication is disabled (fail closed)', async () => {
    const app = await makeApp({ RADAR_DEV_AUTH: 'false' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
    expect(res.headers['x-correlation-id']).toBeDefined();
    await app.close();
  });
});

describe('permission enforcement', () => {
  it('NOC Viewer is denied an engineer-only permission (403) but allowed a NOC permission (200)', async () => {
    const app = await makeApp(dev('NOC_VIEWER'));
    const denied = await app.inject({ method: 'GET', url: '/api/v1/_test/engineer-only' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FORBIDDEN');
    const ok = await app.inject({ method: 'GET', url: '/api/v1/_test/noc' });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('Engineer is allowed an engineer-only permission (200)', async () => {
    const app = await makeApp(dev('ENGINEER'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/_test/engineer-only' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('Viewing Engineer is denied manage permissions (403)', async () => {
    const app = await makeApp(dev('VIEWING_ENGINEER'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/_test/engineer-only' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('development principal cannot be overridden by the request', () => {
  it('ignores role/identity headers — the configured dev principal is the only principal', async () => {
    const app = await makeApp(dev('NOC_VIEWER'));
    const escalation = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/engineer-only',
      headers: { authorization: 'Bearer ENGINEER', 'x-radar-role': 'ENGINEER', 'x-user': 'attacker' },
    });
    expect(escalation.statusCode).toBe(403);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-radar-role': 'ENGINEER' } });
    expect(me.json().roles).toEqual(['NOC_VIEWER']);
    expect(me.json().subject).toBe('dev-engineer');
    await app.close();
  });
});

describe('development role default', () => {
  it('defaults to NOC_VIEWER (least privilege) when RADAR_DEV_ROLE is unset', () => {
    expect(loadConfig({ RADAR_DEV_AUTH: 'true' }).devUser.role).toBe('NOC_VIEWER');
  });
});

describe('production safety', () => {
  it('refuses to start with RADAR_DEV_AUTH=true in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', RADAR_DEV_AUTH: 'true' })).toThrow(/production/i);
  });

  it('allows dev-auth in production only with the explicit override', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', RADAR_DEV_AUTH: 'true', RADAR_ALLOW_DEV_AUTH_IN_PRODUCTION: 'true' }),
    ).not.toThrow();
  });
});
