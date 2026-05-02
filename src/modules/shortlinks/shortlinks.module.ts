import { Module } from '@nestjs/common';
import { ShortlinksController, PublicShortlinkController } from './shortlinks.controller';
import { ShortlinksService } from './shortlinks.service';
import { ShortlinksResolver } from './shortlinks.resolver';
import { GeoResolverService } from './geo-resolver.service';

@Module({
  controllers: [ShortlinksController, PublicShortlinkController],
  providers: [ShortlinksService, ShortlinksResolver, GeoResolverService],
})
export class ShortlinksModule {}
