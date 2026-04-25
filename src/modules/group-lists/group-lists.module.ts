import { Global, Module } from '@nestjs/common';
import { GroupListsController } from './group-lists.controller';
import { GroupListsService } from './group-lists.service';

@Global()
@Module({
  controllers: [GroupListsController],
  providers: [GroupListsService],
  exports: [GroupListsService],
})
export class GroupListsModule {}
