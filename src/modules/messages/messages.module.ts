import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MediaModule } from '../media/media.module';
import { SchedulesModule } from '../schedules/schedules.module';

@Module({
  imports: [MediaModule, SchedulesModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
