import { Module } from '@nestjs/common';
import { ShortlinksController, PublicShortlinkController } from './shortlinks.controller';
import { ShortlinksService } from './shortlinks.service';
import { ShortlinksResolver } from './shortlinks.resolver';
import { GeoResolverService } from './geo-resolver.service';
import { GroupEventsController } from './group-events.controller';
import { GroupEventsService } from './group-events.service';

@Module({
  controllers: [ShortlinksController, PublicShortlinkController, GroupEventsController],
  providers: [ShortlinksService, ShortlinksResolver, GeoResolverService, GroupEventsService],
})
export class ShortlinksModule {}
