import { Module } from '@nestjs/common';
import { FlowHooksController, FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';

@Module({
  controllers: [FlowsController, FlowHooksController],
  providers: [FlowsService],
  exports: [FlowsService],
})
export class FlowsModule {}
