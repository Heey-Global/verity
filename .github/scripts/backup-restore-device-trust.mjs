import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

/** @typedef {{status: number | undefined, body: Record<string, string>}} ApiResponse */
/** @typedef {(path: string, body?: unknown, token?: string, headers?: Record<string, string>) => Promise<ApiResponse>} PinnedApi */

/** The mobile transport pins the uncompressed P-256 point, rather than the certificate/SPKI.
 * @param {string | Buffer} certificate
 */
export function certificatePin(certificate) {
  const key = new X509Certificate(certificate).publicKey.export({ format: 'jwk' });
  assert.equal(key.crv, 'P-256');
  assert.equal(typeof key.x, 'string');
  assert.equal(typeof key.y, 'string');
  if (!key.x || !key.y) throw new Error('Invalid TLS public point');
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(key.x, 'base64url'),
    Buffer.from(key.y, 'base64url'),
  ]);
  assert.equal(point.length, 65);
  return 'sha256-' + createHash('sha256').update(point).digest('base64url');
}

/** Complete normal TLS hostname/chain verification and the saved pin before sending credentials.
 * @param {{address: string, ca: Buffer, pin: string, port?: number}} options
 * @returns {PinnedApi}
 */
export function pinnedApi({ address, ca, pin, port = 8082 }) {
  return (path, body, token, headers = {}) =>
    new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          hostname: address,
          port,
          servername: 'localhost',
          ca,
          // Never reuse an authenticated socket with a different trust binding.
          agent: false,
          checkServerIdentity(host, certificate) {
            const invalid = checkServerIdentity(host, certificate);
            if (invalid) return invalid;
            if (certificatePin(certificate.raw) !== pin) return new Error('TLS pin mismatch');
          },
          path,
          method: bytes ? 'POST' : 'GET',
          timeout: 30000,
          headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(bytes
              ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length }
              : {}),
            ...headers,
          },
        },
        (response) => {
          /** @type {Buffer[]} */
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('API timeout')));
      req.end(bytes);
    });
}

/** @param {PinnedApi} api
 * @param {{serverId: string, identityKey: string}} expected
 */
export async function verifyPairingProof(api, expected) {
  const challenge = randomBytes(32).toString('base64url');
  const result = await api('/pair/identity?challenge=' + challenge);
  assert.equal(result.status, 200);
  assert.equal(result.body.serverId, expected.serverId);
  assert.equal(result.body.identityKey, expected.identityKey);
  if (typeof result.body.signature !== 'string') throw new Error('Missing pairing signature');
  assert.equal(
    verify(
      null,
      Buffer.from(`verity.device-pairing.v1\0${expected.serverId}\0${challenge}`),
      createPublicKey({
        key: Buffer.from(expected.identityKey, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(result.body.signature, 'base64url'),
    ),
    true,
    'saved pairing identity must authenticate a fresh challenge',
  );
}
