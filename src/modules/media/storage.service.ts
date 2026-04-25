import { Injectable, OnModuleInit } from '@nestjs/common';
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
