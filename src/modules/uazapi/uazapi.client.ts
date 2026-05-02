import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface UazapiGroup {
  id: string;
  name: string;
  description?: string;
  pictureUrl?: string;
  participantsCount?: number;
}

export interface UazapiSendTextOpts {
  number: string; // group remote id (ex: 123@g.us)
  text: string;
  /** "all" pra mencionar todos OU CSV de números "5511999999999,5511888888888" */
  mentions?: string;
}

export type UazapiMediaType =
  | 'image'
  | 'video'
  | 'audio'
  | 'ptt'
  | 'myaudio'
  | 'ptv'
  | 'document'
  | 'sticker';

export interface UazapiSendMediaOpts {
  number: string;
  /** URL pública OU data URI base64 (data:mime;base64,...) OU base64 puro */
  file: string;
  mime: string;
  /** Se omitido, detecta pelo mime. Use ptt pra áudio "gravado". */
  type?: UazapiMediaType;
  caption?: string;
  filename?: string;
  mentions?: string;
}

export interface UazapiGroupInfo {
  id: string;
  name: string;
  participants: string[]; // phone numbers normalizados
  inviteLink?: string;
}

export interface UazapiUpdateGroupOpts {
  groupId: string;
  name?: string;
  description?: string;
  pictureUrl?: string;
}

const BASE = process.env.UAZAPI_BASE_URL ?? 'https://free.uazapi.com';

/**
 * Cliente Uazapi. Cada chamada recebe `instanceToken` (header `token`).
 * O `instanceName` é opcional (algumas rotas só precisam do token).
 */
@Injectable()
export class UazapiClient {
  private readonly log = new Logger('UazapiClient');

  private http(token: string): AxiosInstance {
    return axios.create({
      baseURL: BASE,
      timeout: 90_000,
      headers: { token, 'Content-Type': 'application/json' },
    });
  }

  async createGroup(
    token: string,
    name: string,
    participants: string[],
  ): Promise<UazapiGroup> {
    const { data } = await this.http(token).post('/group/create', {
      name,
      participants,
    });
    const g = data?.group ?? data;
    return {
      id: String(g.JID ?? g.id ?? ''),
      name: String(g.Name ?? g.name ?? name),
      description: g.Topic ?? g.description,
      pictureUrl: g.imgUrl ?? g.pictureUrl,
      participantsCount: g.ParticipantCount ?? g.participantsCount,
    };
  }

  async listGroups(token: string): Promise<UazapiGroup[]> {
    const { data } = await this.http(token).post('/group/list', {});
    const arr = Array.isArray(data) ? data : (data?.groups ?? []);
    return arr.map((g: Record<string, unknown>) => ({
      id: String(g.id ?? g.JID ?? g.jid ?? ''),
      name: String(g.name ?? g.subject ?? g.Name ?? ''),
      description: (g.description as string) ?? (g.desc as string),
      pictureUrl: (g.imgUrl as string) ?? (g.pictureUrl as string),
      participantsCount: (g.participantsCount as number) ?? undefined,
    }));
  }

  async sendText(token: string, opts: UazapiSendTextOpts) {
    const body: Record<string, unknown> = {
      number: opts.number,
      text: opts.text,
    };
    if (opts.mentions) body.mentions = opts.mentions;
    const { data } = await this.http(token).post('/send/text', body);
    return data;
  }

  async sendMedia(token: string, opts: UazapiSendMediaOpts) {
    const type: UazapiMediaType =
      opts.type ??
      (opts.mime.startsWith('image/')
        ? 'image'
        : opts.mime.startsWith('video/')
          ? 'video'
          : opts.mime.startsWith('audio/')
            ? 'audio'
            : 'document');
    const body: Record<string, unknown> = {
      number: opts.number,
      type,
      file: opts.file,
      text: opts.caption,
      docName: opts.filename,
    };
    if (opts.mentions) body.mentions = opts.mentions;
    const { data } = await this.http(token).post('/send/media', body);
    return data;
  }

  /**
   * Pega info do grupo, incluindo participantes e invite link (opcional).
   */
  async getGroupInfo(
    token: string,
    groupId: string,
    opts: { getInviteLink?: boolean; force?: boolean } = {},
  ): Promise<UazapiGroupInfo> {
    const { data } = await this.http(token).post('/group/info', {
      groupjid: groupId,
      getInviteLink: opts.getInviteLink ?? false,
      force: opts.force ?? false,
    });
    const g = data?.group ?? data;
    const participants = (g?.Participants ?? g?.participants ?? []) as Array<Record<string, unknown>>;
    const numbers = participants
      .map((p) => {
        const pn = (p.PhoneNumber as string) ?? (p.JID as string) ?? (p.jid as string) ?? '';
        return String(pn).replace(/@.*$/, '').replace(/\D/g, '');
      })
      .filter((n) => n.length >= 10 && n.length <= 15);
    return {
      id: String(g?.JID ?? g?.id ?? groupId),
      name: String(g?.Name ?? g?.name ?? ''),
      participants: numbers,
      inviteLink:
        (g?.invite_link as string) ??
        (g?.InviteLink as string) ??
        (g?.inviteLink as string) ??
        (data?.inviteLink as string) ??
        undefined,
    };
  }

  async updateGroupName(token: string, groupId: string, name: string) {
    const { data } = await this.http(token).post('/group/updateName', {
      groupjid: groupId,
      name,
    });
    return data;
  }

  async updateGroupDescription(token: string, groupId: string, description: string) {
    const { data } = await this.http(token).post('/group/updateDescription', {
      groupjid: groupId,
      description,
    });
    return data;
  }

  async updateGroupPicture(token: string, groupId: string, pictureFile: string) {
    const { data } = await this.http(token).post('/group/updateImage', {
      groupjid: groupId,
      image: pictureFile,
    });
    return data;
  }

  /** locked=true → só admins editam info do grupo (nome/foto/descrição). */
  async updateGroupLocked(token: string, groupId: string, locked: boolean) {
    const { data } = await this.http(token).post('/group/updateLocked', {
      groupjid: groupId,
      locked,
    });
    return data;
  }

  /** announce=true → só admins enviam mensagem no grupo. */
  async updateGroupAnnounce(token: string, groupId: string, announce: boolean) {
    const { data } = await this.http(token).post('/group/updateAnnounce', {
      groupjid: groupId,
      announce,
    });
    return data;
  }

  /**
   * Envia uma enquete (poll) via /send/menu.
   * choices: array de opções (strings simples)
   * selectableCount: quantas opções podem ser marcadas (default 1)
   */
  async sendPoll(
    token: string,
    opts: {
      number: string;
      text: string;
      choices: string[];
      selectableCount?: number;
    },
  ) {
    const body: Record<string, unknown> = {
      number: opts.number,
      type: 'poll',
      text: opts.text,
      choices: opts.choices,
      selectableCount: opts.selectableCount ?? 1,
    };
    const { data } = await this.http(token).post('/send/menu', body);
    return data;
  }

  async updateGroupParticipants(
    token: string,
    groupId: string,
    action: 'add' | 'remove' | 'promote' | 'demote' | 'approve' | 'reject',
    participants: string[],
  ) {
    if (!participants.length) return { groupUpdated: [] };
    const { data } = await this.http(token).post('/group/updateParticipants', {
      groupjid: groupId,
      action,
      participants,
    });
    return data;
  }
}
