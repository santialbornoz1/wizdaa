import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncController } from './sync.controller';
import { SyncProcessor } from './sync.processor';
import { AutoCompleteService } from './auto-complete.service';
import { SyncHistory } from './entities/sync-history.entity';
import { TimeOffRequest } from '../timeoff/entities/timeoff-request.entity';
import { Balance } from '../balances/entities/balance.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncHistory, TimeOffRequest, Balance]),
    BullModule.registerQueue({ name: 'hcm-sync' }),
    ScheduleModule.forRoot(),
  ],
  controllers: [SyncController],
  providers: [SyncProcessor, AutoCompleteService],
})
export class SyncModule {}
