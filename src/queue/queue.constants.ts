export const QUEUE_SEND_MESSAGE = 'send-message';
export const QUEUE_SEND_MESSAGE_SINGLE = 'send-message-single';
export const QUEUE_SEND_MESSAGE_FINALIZE = 'send-message-finalize';
export const QUEUE_UPDATE_GROUP = 'update-group';

export interface SendMessageJobData {
  scheduleId: string;
  tenantId: string;
}

export interface SendMessageSingleJobData {
  scheduleId: string;
  tenantId: string;
  groupRemoteId: string;
}

export interface SendMessageFinalizeJobData {
  scheduleId: string;
  tenantId: string;
  type: 'ONCE' | 'DAILY' | 'WEEKLY' | 'CUSTOM_CRON';
  expectedCount: number;
}

export interface UpdateGroupJobData {
  groupUpdateScheduleId: string;
  tenantId: string;
}

export const QUEUE_SYNC_CONTACTS = 'sync-contacts';

export interface ContactSyncJobData {
  full?: boolean;
  // Presente no trigger manual (sincroniza só o tenant); ausente no repeatable (varre todos)
  tenantId?: string;
}

export const QUEUE_CAMPAIGN_DISPATCH = 'campaign-dispatch';
export const QUEUE_CAMPAIGN_SEND = 'campaign-send-single';

export interface CampaignDispatchJobData {
  campaignId: string;
  tenantId: string;
}

export interface CampaignSendJobData {
  campaignMessageId: string;
  campaignId: string;
  tenantId: string;
}
