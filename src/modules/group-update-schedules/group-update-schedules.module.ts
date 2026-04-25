import { Module } from '@nestjs/common';
import { GroupUpdateSchedulesController } from './group-update-schedules.controller';
import { GroupUpdateSchedulesService } from './group-update-schedules.service';

@Module({
  controllers: [GroupUpdateSchedulesController],
  providers: [GroupUpdateSchedulesService],
})
export class GroupUpdateSchedulesModule {}
