import { Module } from '@nestjs/common';
import { ShortlinksController, PublicShortlinkController } from './shortlinks.controller';
import { ShortlinksService } from './shortlinks.service';

@Module({
  controllers: [ShortlinksController, PublicShortlinkController],
  providers: [ShortlinksService],
})
export class ShortlinksModule {}
