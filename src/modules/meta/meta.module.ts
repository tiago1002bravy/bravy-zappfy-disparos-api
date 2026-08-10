import { Global, Module } from '@nestjs/common';
import { CloudApiClient } from './cloud-api.client';
import { MetaWebhookController } from './meta-webhook.controller';
import { MetaWebhookService } from './meta-webhook.service';

@Global()
@Module({
  controllers: [MetaWebhookController],
  providers: [CloudApiClient, MetaWebhookService],
  exports: [CloudApiClient],
})
export class MetaModule {}
