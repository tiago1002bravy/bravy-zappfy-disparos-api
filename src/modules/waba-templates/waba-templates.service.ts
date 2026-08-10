import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';
import { decryptToken } from '../../common/crypto.util';
import { CloudApiClient, CloudApiTemplateComponent } from '../meta/cloud-api.client';

export interface TemplateView {
  id: string;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string | null;
  variableCount: number;
  headerType: string; // NONE | TEXT | IMAGE | VIDEO | DOCUMENT
  hasButtons: boolean;
  syncedAt: Date;
}

export function deriveTemplateView(t: {
  id: string;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: Prisma.JsonValue;
  syncedAt: Date;
}): TemplateView {
  const components = (Array.isArray(t.components) ? t.components : []) as unknown as CloudApiTemplateComponent[];
  const body = components.find((c) => c.type?.toUpperCase() === 'BODY');
  const header = components.find((c) => c.type?.toUpperCase() === 'HEADER');
  const buttons = components.find((c) => c.type?.toUpperCase() === 'BUTTONS');
  const bodyText = body?.text ?? null;
  const variableCount = bodyText ? new Set(bodyText.match(/\{\{\d+\}\}/g) ?? []).size : 0;
  return {
    id: t.id,
    wabaId: t.wabaId,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    bodyText,
    variableCount,
    headerType: header ? (header.format ?? 'TEXT') : 'NONE',
    hasButtons: Boolean(buttons?.buttons?.length),
    syncedAt: t.syncedAt,
  };
}

@Injectable()
export class WabaTemplatesService {
  constructor(
    private prisma: PrismaService,
    private cloudApi: CloudApiClient,
  ) {}

  async list(status?: string) {
    const templates = await this.prisma.wabaTemplate.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return templates.map(deriveTemplateView);
  }

  async sync() {
    const tenantId = requireTenantId();
    const instances = await this.prisma.instance.findMany({
      where: { provider: 'CLOUD_API', active: true, wabaId: { not: null } },
      select: { wabaId: true, instanceTokenEnc: true },
    });
    if (instances.length === 0) {
      throw new BadRequestException('Nenhuma instância Cloud API ativa com WABA ID cadastrado');
    }

    // 1 token por WABA (qualquer instância da mesma WABA serve)
    const byWaba = new Map<string, string>();
    for (const inst of instances) {
      if (inst.wabaId && !byWaba.has(inst.wabaId)) byWaba.set(inst.wabaId, inst.instanceTokenEnc);
    }

    let added = 0;
    let updated = 0;
    const byStatus: Record<string, number> = {};
    const now = new Date();

    for (const [wabaId, tokenEnc] of byWaba) {
      const token = decryptToken(tokenEnc);
      const templates = await this.cloudApi.listTemplates(token, wabaId);
      for (const t of templates) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        const existing = await this.prisma.wabaTemplate.findFirst({
          where: { wabaId, name: t.name, language: t.language },
        });
        if (existing) {
          await this.prisma.wabaTemplate.update({
            where: { id: existing.id },
            data: {
              externalId: t.id || existing.externalId,
              category: t.category,
              status: t.status,
              components: t.components as unknown as Prisma.InputJsonValue,
              syncedAt: now,
            },
          });
          updated += 1;
        } else {
          await this.prisma.wabaTemplate.create({
            data: {
              tenantId,
              wabaId,
              externalId: t.id || null,
              name: t.name,
              language: t.language,
              category: t.category,
              status: t.status,
              components: t.components as unknown as Prisma.InputJsonValue,
              syncedAt: now,
            },
          });
          added += 1;
        }
      }
    }

    return { added, updated, byStatus };
  }

  async subscribeWebhook(instanceId: string) {
    const inst = await this.prisma.instance.findFirst({ where: { id: instanceId } });
    if (!inst) throw new NotFoundException('Instance not found');
    if (inst.provider !== 'CLOUD_API' || !inst.wabaId) {
      throw new BadRequestException('Instância não é Cloud API ou não tem WABA ID');
    }
    const token = decryptToken(inst.instanceTokenEnc);
    return this.cloudApi.subscribeApp(token, inst.wabaId);
  }
}
