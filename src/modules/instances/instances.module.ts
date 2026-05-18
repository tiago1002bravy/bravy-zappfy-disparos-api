import { Module } from '@nestjs/common';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { ZappfyClient } from '../zappfy/zappfy.client';

@Module({
  controllers: [InstancesController],
  providers: [InstancesService, ZappfyClient],
})
export class InstancesModule {}
