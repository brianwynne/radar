import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probe } from '../../src/stream-assurance/probe.js';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/echo-host') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`host=${req.headers.host}`); return; }
    if (req.url === '/big') { res.writeHead(200); res.end(Buffer.alloc(100 * 1024, 0x41)); return; }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 500); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('connect-to probe', () => {
  it('preserves the public Host header while connecting to the target', async () => {
    const res = await probe({ publicUrl: 'http://live.rte.ie/echo-host', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.ie' });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('host=live.rte.ie');
  });

  it('can forward a DIFFERENT Host than the public URL (the incident lever)', async () => {
    const res = await probe({ publicUrl: 'http://live.rte.ie/echo-host', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.host' });
    expect(Buffer.from(res.body).toString()).toBe('host=live.rte.host');
  });

  it('bounds the response body at maxBytes', async () => {
    const res = await probe({ publicUrl: 'http://x/big', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'x', maxBytes: 1024 });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1024);
  });

  it('times out slow responses', async () => {
    await expect(
      probe({ publicUrl: 'http://x/slow', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'x', timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });
});
