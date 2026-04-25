import { Global, Module } from '@nestjs/common';
import { UazapiClient } from './uazapi.client';

@Global()
@Module({
  providers: [UazapiClient],
  exports: [UazapiClient],
})
export class UazapiModule {}
