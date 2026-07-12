// Read-only UDP DNS transport (the only networked part of DNS observation). Sends ONE query
// with a bounded timeout, no aggressive retry. Injectable everywhere else so the observation
// and comparison logic is tested without real network. Never captures packets or logs
// resolver payloads.
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { decodeResponse, encodeQuery } from './dns-wire.js';
import type { DnsQuery, DnsTransport, DnsTransportResult } from './types.js';

export class UdpDnsTransport implements DnsTransport {
  constructor(private readonly idFor: () => number = () => Math.floor(Math.random() * 65535)) {}

  query(q: DnsQuery): Promise<DnsTransportResult> {
    const family = isIP(q.resolverIp);
    if (family === 0) return Promise.reject(new Error('Invalid resolver IP'));
    const id = this.idFor();
    const message = encodeQuery({ id, qname: q.qname, qtype: q.qtype, ecsSubnet: q.ecsSubnet });

    return new Promise<DnsTransportResult>((resolve, reject) => {
      const socket = createSocket(family === 6 ? 'udp6' : 'udp4');
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // already closed
        }
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new Error('DNS query timed out'))), q.timeoutMs);

      socket.on('message', (buf: Buffer) => {
        const decoded = decodeResponse(buf);
        done(() =>
          resolve({
            responseCode: decoded.responseCode,
            answers: decoded.answers,
            ttl: decoded.ttl,
            ecsHonoured: decoded.ecsScopePrefixLength !== undefined && decoded.ecsScopePrefixLength > 0,
          }),
        );
      });
      socket.on('error', (err: Error) => done(() => reject(err)));
      socket.send(message, q.port ?? 53, q.resolverIp, (err) => {
        if (err) done(() => reject(err));
      });
    });
  }
}
