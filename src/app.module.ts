import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BalancesModule } from './modules/balances/balances.module';
import { TimeOffModule } from './modules/timeoff/timeoff.module';
import { SyncModule } from './modules/sync/sync.module';
import { HealthModule } from './modules/health/health.module';
import { Balance } from './modules/balances/entities/balance.entity';
import { TimeOffRequest } from './modules/timeoff/entities/timeoff-request.entity';
import { SyncHistory } from './modules/sync/entities/sync-history.entity';
import { EventsModule } from './common/events/events.module';

@Module({
  imports: [
    EventsModule,
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DB_PATH || './timeoff.db',
      entities: [Balance, TimeOffRequest, SyncHistory],
      synchronize: true,
      extra: {
        journal_mode: 'WAL',
      },
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),
    BalancesModule,
    TimeOffModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}
