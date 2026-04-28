import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';
import { requireTenantId } from '../../common/tenant-context';

const ACCEPTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'text/plain',
  'text/csv',
]);

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

@Injectable()
export class MediaService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  async upload(file: Express.Multer.File) {
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      throw new BadRequestException(`Mime type ${file.mimetype} not allowed`);
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File too large (max 50MB)');
    }
    const tenantId = requireTenantId();
    const ext = file.mimetype.split('/')[1] ?? 'bin';
    const id = randomUUID();
    const key = `${tenantId}/${id}.${ext}`;

    await this.storage.putObject(key, file.buffer, file.mimetype);

    let thumbKey: string | undefined;
    if (file.mimetype.startsWith('image/') && file.mimetype !== 'image/gif') {
      try {
        const thumb = await sharp(file.buffer).resize(256, 256, { fit: 'inside' }).webp().toBuffer();
        thumbKey = `${tenantId}/${id}-thumb.webp`;
        await this.storage.putObject(thumbKey, thumb, 'image/webp');
      } catch {
        // ignora falha de thumb
      }
    }

    return this.prisma.mediaAsset.create({
      data: {
        tenantId,
        s3Key: key,
        mime: file.mimetype,
        size: file.size,
        thumbKey,
      },
    });
  }

  async list() {
    const items = await this.prisma.mediaAsset.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return items.map((m) => ({
      ...m,
      url: this.storage.buildSignedRawUrl(m.id, 'raw'),
      thumbUrl: m.thumbKey ? this.storage.buildSignedRawUrl(m.id, 'thumb') : null,
    }));
  }

  async getOne(id: string) {
    const m = await this.prisma.mediaAsset.findFirst({ where: { id } });
    if (!m) throw new NotFoundException('Media not found');
    return {
      ...m,
      url: this.storage.buildSignedRawUrl(m.id, 'raw'),
      thumbUrl: m.thumbKey ? this.storage.buildSignedRawUrl(m.id, 'thumb') : null,
    };
  }

  async remove(id: string) {
    const m = await this.prisma.mediaAsset.findFirst({ where: { id } });
    if (!m) throw new NotFoundException('Media not found');
    await this.storage.removeObject(m.s3Key).catch(() => undefined);
    if (m.thumbKey) await this.storage.removeObject(m.thumbKey).catch(() => undefined);
    return this.prisma.mediaAsset.delete({ where: { id } });
  }

  /**
   * Endpoint público de proxy: valida assinatura, busca o objeto no MinIO e retorna stream.
   * Não exige tenant context — assinatura HMAC com TTL faz o gate.
   */
  async streamSignedMedia(
    id: string,
    expSec: number,
    variant: 'raw' | 'thumb',
    sig: string,
  ): Promise<
    | { found: true; mime: string; length: number | null; stream: NodeJS.ReadableStream }
    | { found: false }
    | null
  > {
    if (!this.storage.verifyMediaToken(id, expSec, variant, sig)) return null;

    const m = await this.prisma.mediaAsset.findFirst({ where: { id } });
    if (!m) return { found: false };

    const key = variant === 'thumb' ? m.thumbKey ?? m.s3Key : m.s3Key;
    const mime = variant === 'thumb' && m.thumbKey ? 'image/webp' : m.mime;
    const stream = await this.storage.getObjectStream(key);
    const length = (stream as { length?: number } | null)?.length ?? null;
    return { found: true, mime, length, stream };
  }
}
