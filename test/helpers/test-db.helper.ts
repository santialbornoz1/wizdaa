import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from '../../src/modules/balances/entities/balance.entity';
import { TimeOffRequest } from '../../src/modules/timeoff/entities/timeoff-request.entity';
import { SyncHistory } from '../../src/modules/sync/entities/sync-history.entity';

export const testDbModule = () =>
  TypeOrmModule.forRoot({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Balance, TimeOffRequest, SyncHistory],
    synchronize: true,
  });

export const testEntitiesModule = () =>
  TypeOrmModule.forFeature([Balance, TimeOffRequest, SyncHistory]);
