import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { MediaModule } from './modules/media/media.module';
import { GroupsModule } from './modules/groups/groups.module';
import { GroupListsModule } from './modules/group-lists/group-lists.module';
import { ShortlinksModule } from './modules/shortlinks/shortlinks.module';
import { MessagesModule } from './modules/messages/messages.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { GroupUpdateSchedulesModule } from './modules/group-update-schedules/group-update-schedules.module';
import { ExecutionsModule } from './modules/executions/executions.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { CronModule } from './modules/cron/cron.module';
import { UazapiModule } from './modules/uazapi/uazapi.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    UazapiModule,
    QueueModule,
    AuthModule,
    ApiKeysModule,
    TenantsModule,
    MediaModule,
    GroupsModule,
    GroupListsModule,
    ShortlinksModule,
    MessagesModule,
    SchedulesModule,
    GroupUpdateSchedulesModule,
    ExecutionsModule,
    CalendarModule,
    CronModule,
  ],
})
export class AppModule {}
