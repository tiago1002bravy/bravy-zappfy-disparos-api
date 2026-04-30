import { Module } from '@nestjs/common';
import { WorkspaceRequestsController } from './workspace-requests.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [WorkspaceRequestsController],
})
export class WorkspaceRequestsModule {}
