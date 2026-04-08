import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Balance } from '../../src/modules/balances/entities/balance.entity';
import { TimeOffRequest } from '../../src/modules/timeoff/entities/timeoff-request.entity';
import { SyncHistory } from '../../src/modules/sync/entities/sync-history.entity';
import { BalancesController } from '../../src/modules/balances/balances.controller';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { TimeOffController } from '../../src/modules/timeoff/timeoff.controller';
import { TimeOffService } from '../../src/modules/timeoff/timeoff.service';
import { AutoCompleteService } from '../../src/modules/sync/auto-complete.service';
import { EventsModule } from '../../src/common/events/events.module';

jest.mock('axios');

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'mock-job' }),
  getJobCounts: jest.fn().mockResolvedValue({}),
};

describe('WebSocket E2E Tests', () => {
  let app: INestApplication;
  let clientSocket: Socket;
  let port: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Balance, TimeOffRequest, SyncHistory],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([Balance, TimeOffRequest, SyncHistory]),
        EventsModule,
        ScheduleModule.forRoot(),
      ],
      controllers: [BalancesController, TimeOffController],
      providers: [
        BalancesService,
        TimeOffService,
        AutoCompleteService,
        { provide: 'BullQueue_hcm-sync', useValue: mockQueue },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    const server = await app.listen(0);
    port = server.address().port;

    // Seed
    const balancesService = app.get(BalancesService);
    await balancesService.upsertFromHcm('maria.garcia', 'buenos-aires', 20, 0);
  });

  afterAll(async () => {
    if (clientSocket?.connected) clientSocket.disconnect();
    await app.close();
  });

  afterEach(() => {
    if (clientSocket?.connected) clientSocket.disconnect();
  });

  it('should connect to WebSocket server via Socket.IO', (done) => {
    clientSocket = io(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    clientSocket.on('connect', () => {
      expect(clientSocket.connected).toBe(true);
      done();
    });

    clientSocket.on('connect_error', (err) => {
      done(err);
    });
  });

  it('should receive request:updated event when creating a time-off request', (done) => {
    clientSocket = io(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    clientSocket.on('connect', () => {
      clientSocket.on('request:updated', (data) => {
        expect(data.employeeId).toBe('maria.garcia');
        expect(data.status).toBe('PENDING_SYNC');
        expect(data.event).toBe('created');
        done();
      });

      // Trigger via HTTP
      request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          startDate: '2026-09-01',
          endDate: '2026-09-03',
          daysRequested: 2,
          type: 'VACATION',
        })
        .end(() => {});
    });
  });

  it('should receive balance:updated event when balance is modified', (done) => {
    clientSocket = io(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    clientSocket.on('connect', async () => {
      clientSocket.on('balance:updated', (data) => {
        expect(data.employeeId).toBe('maria.garcia');
        expect(data.locationId).toBe('buenos-aires');
        expect(data.totalDays).toBe(30);
        done();
      });

      // Trigger balance update
      const balancesService = app.get(BalancesService);
      await balancesService.upsertFromHcm('maria.garcia', 'buenos-aires', 30, 0);
    });
  });
});
