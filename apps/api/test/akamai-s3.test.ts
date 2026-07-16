// Akamai S3 source: the inline SigV4 signer is verified against AWS's own published S3 "GET Object"
// known-answer vector (from the AWS SigV4 documentation), and the ListObjectsV2 XML parser against a
// sample response. This proves the S3 read path without contacting AWS.
import { describe, it, expect } from 'vitest';
import { signV4, parseListXml } from '../src/akamai/s3-client.js';

describe('SigV4 signer (AWS published S3 GET Object vector)', () => {
  it('reproduces AWS’s documented signature', () => {
    const auth = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: {},
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('never embeds the secret key in the header', () => {
    const auth = signV4({
      method: 'GET', host: 'b.s3.us-east-1.amazonaws.com', path: '/', query: { 'list-type': '2' },
      headers: { host: 'b.s3.us-east-1.amazonaws.com', 'x-amz-content-sha256': 'x', 'x-amz-date': '20260101T000000Z' },
      payloadHash: 'x', region: 'us-east-1', service: 's3', accessKeyId: 'AKID', secretKey: 'super-secret', amzDate: '20260101T000000Z',
    });
    expect(auth).not.toContain('super-secret');
  });
});

describe('parseListXml', () => {
  it('extracts object keys, sizes and the continuation token', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <Contents><Key>logs/ds/2026/07/16/part-001.json.gz</Key><LastModified>2026-07-16T21:00:00.000Z</LastModified><Size>4096</Size></Contents>
      <Contents><Key>logs/ds/2026/07/16/part-002.json.gz</Key><LastModified>2026-07-16T21:00:30.000Z</LastModified><Size>8192</Size></Contents>
      <NextContinuationToken>tok&amp;123</NextContinuationToken>
    </ListBucketResult>`;
    const r = parseListXml(xml);
    expect(r.objects.map((o) => o.key)).toEqual(['logs/ds/2026/07/16/part-001.json.gz', 'logs/ds/2026/07/16/part-002.json.gz']);
    expect(r.objects[1].size).toBe(8192);
    expect(r.nextToken).toBe('tok&123'); // XML-decoded
  });

  it('returns no token when not truncated', () => {
    expect(parseListXml('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>').nextToken).toBeNull();
  });
});
