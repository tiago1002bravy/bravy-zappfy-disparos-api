import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Client } from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  private client: Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'zappfy-disparos';
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY ?? 'zappfy',
      secretKey: process.env.MINIO_SECRET_KEY ?? 'zappfy123',
    });
  }

  // === URL pública assinada (proxy via API) ===
  // Permite que <img src> carregue mídia sem expor MinIO publicamente.
  // Token = HMAC(JWT_SECRET, "mediaId:exp:variant") → validado no endpoint público.

  private signSecret(): string {
    return process.env.JWT_SECRET ?? 'change-me-in-prod';
  }

  /** Gera token HMAC-SHA256 truncado pra um recurso de mídia. */
  signMediaToken(mediaId: string, expSec: number, variant: 'raw' | 'thumb'): string {
    const payload = `${mediaId}:${expSec}:${variant}`;
    return createHmac('sha256', this.signSecret()).update(payload).digest('hex');
  }

  /** Valida token. Retorna true se íntegro e não expirado. */
  verifyMediaToken(
    mediaId: string,
    expSec: number,
    variant: 'raw' | 'thumb',
    sig: string,
  ): boolean {
    if (!Number.isFinite(expSec) || expSec * 1000 < Date.now()) return false;
    const expected = this.signMediaToken(mediaId, expSec, variant);
    if (expected.length !== sig.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
      return false;
    }
  }

  /** URL relativa da API pra o endpoint de proxy. Frontend monta absoluta com NEXT_PUBLIC_API_URL. */
  buildSignedRawUrl(mediaId: string, variant: 'raw' | 'thumb', expiresInSec = 3600): string {
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const sig = this.signMediaToken(mediaId, exp, variant);
    return `/media/raw/${mediaId}?exp=${exp}&sig=${sig}&v=${variant}`;
  }

  async onModuleInit() {
    const exists = await this.client.bucketExists(this.bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
    }
  }

  async putObject(key: string, body: Buffer, mime: string) {
    await this.client.putObject(this.bucket, key, body, body.length, {
      'Content-Type': mime,
    });
  }

  async removeObject(key: string) {
    await this.client.removeObject(this.bucket, key);
  }

  /** URL temporária pra leitura. expiresSeconds default 1 hora. */
  presignedGetUrl(key: string, expiresSeconds = 3600) {
    return this.client.presignedGetObject(this.bucket, key, expiresSeconds);
  }

  async getObjectStream(key: string) {
    return this.client.getObject(this.bucket, key);
  }

  async objectAsDataUri(key: string, mime: string): Promise<string> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    const b64 = Buffer.concat(chunks).toString('base64');
    return `data:${mime};base64,${b64}`;
  }
}
