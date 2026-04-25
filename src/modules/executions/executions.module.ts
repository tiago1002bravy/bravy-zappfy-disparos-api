import { Module } from '@nestjs/common';
import { ExecutionsController } from './executions.controller';

@Module({ controllers: [ExecutionsController] })
export class ExecutionsModule {}
