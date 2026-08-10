import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { WorkspaceRequestsModule } from './modules/workspace-requests/workspace-requests.module';
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
import { ZappfyModule } from './modules/zappfy/zappfy.module';
import { MetaModule } from './modules/meta/meta.module';
import { HealthModule } from './modules/health/health.module';
import { InstancesModule } from './modules/instances/instances.module';
import { StatsModule } from './modules/stats/stats.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { WabaTemplatesModule } from './modules/waba-templates/waba-templates.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { FlowsModule } from './modules/flows/flows.module';
import { QueueModule } from './queue/queue.module';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'default', ttl: 60_000, limit: 120 },
    ]),
    PrismaModule,
    ZappfyModule,
    MetaModule,
    QueueModule,
    AuthModule,
    ApiKeysModule,
    TenantsModule,
    UsersModule,
    WorkspaceRequestsModule,
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
    HealthModule,
    InstancesModule,
    StatsModule,
    ContactsModule,
    WabaTemplatesModule,
    CampaignsModule,
    FlowsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
