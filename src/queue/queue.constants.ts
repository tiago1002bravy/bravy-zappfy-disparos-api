export const QUEUE_SEND_MESSAGE = 'send-message';
export const QUEUE_UPDATE_GROUP = 'update-group';

export interface SendMessageJobData {
  scheduleId: string;
  tenantId: string;
}

export interface UpdateGroupJobData {
  groupUpdateScheduleId: string;
  tenantId: string;
}
