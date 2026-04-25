import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function key(): Buffer {
  const k = process.env.INSTANCE_TOKEN_ENC_KEY;
  if (!k || k.length !== 64) {
    throw new Error('INSTANCE_TOKEN_ENC_KEY missing or not 64 hex chars (32 bytes)');
  }
  return Buffer.from(k, 'hex');
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(payload: string): string {
  const [ivB64, tagB64, encB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Invalid encrypted token payload');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const plain = `zd_${raw}`;
  const prefix = plain.slice(0, 11);
  const hash = sha256(plain);
  return { plain, prefix, hash };
}
