import { Module } from '@nestjs/common';
import { WabaTemplatesController } from './waba-templates.controller';
import { WabaTemplatesService } from './waba-templates.service';

@Module({
  controllers: [WabaTemplatesController],
  providers: [WabaTemplatesService],
  exports: [WabaTemplatesService],
})
export class WabaTemplatesModule {}
