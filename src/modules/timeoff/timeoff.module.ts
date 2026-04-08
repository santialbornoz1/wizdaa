import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { TimeOffRequest } from './entities/timeoff-request.entity';
import { Balance } from '../balances/entities/balance.entity';
import { SyncHistory } from '../sync/entities/sync-history.entity';
import { TimeOffController } from './timeoff.controller';
import { TimeOffService } from './timeoff.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, Balance, SyncHistory]),
    BullModule.registerQueue({ name: 'hcm-sync' }),
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
