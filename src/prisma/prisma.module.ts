import { Global, Module } from '@nestjs/common';
import { PrismaService, tenantExtension } from './prisma.service';

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => {
        const base = new PrismaService();
        return base.$extends(tenantExtension()) as unknown as PrismaService;
      },
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
