import { Global, Module } from '@nestjs/common';
import { ZappfyClient } from './zappfy.client';

@Global()
@Module({
  providers: [ZappfyClient],
  exports: [ZappfyClient],
})
export class ZappfyModule {}
