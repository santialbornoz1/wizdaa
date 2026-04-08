import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TerminusModule } from '@nestjs/terminus';
import { ScheduleModule } from '@nestjs/schedule';
import { Balance } from '../../src/modules/balances/entities/balance.entity';
import { TimeOffRequest } from '../../src/modules/timeoff/entities/timeoff-request.entity';
import { SyncHistory } from '../../src/modules/sync/entities/sync-history.entity';
import { BalancesController } from '../../src/modules/balances/balances.controller';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { TimeOffController } from '../../src/modules/timeoff/timeoff.controller';
import { TimeOffService } from '../../src/modules/timeoff/timeoff.service';
import { HealthController } from '../../src/modules/health/health.controller';
import { AutoCompleteService } from '../../src/modules/sync/auto-complete.service';
import { EventsGateway } from '../../src/common/events/events.gateway';

jest.mock('axios');

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'mock-job' }),
  getJobCounts: jest.fn().mockResolvedValue({}),
};

const mockEventsGateway = {
  emitBalanceUpdate: jest.fn(),
  emitRequestUpdate: jest.fn(),
  server: { emit: jest.fn() },
};

describe('App E2E Tests', () => {
  let app: INestApplication;

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
        TerminusModule,
        ScheduleModule.forRoot(),
      ],
      controllers: [BalancesController, TimeOffController, HealthController],
      providers: [
        BalancesService,
        TimeOffService,
        AutoCompleteService,
        { provide: 'BullQueue_hcm-sync', useValue: mockQueue },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    // Seed
    const balancesService = app.get(BalancesService);
    await balancesService.upsertFromHcm('maria.garcia', 'buenos-aires', 20, 0);
    await balancesService.upsertFromHcm('james.smith', 'buenos-aires', 15, 0);
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Health ---

  describe('GET /api/v1/health', () => {
    it('should return healthy status', () => {
      return request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.info.database.status).toBe('up');
        });
    });
  });

  // --- Balances ---

  describe('GET /api/v1/balances', () => {
    it('should return balance for valid employee', () => {
      return request(app.getHttpServer())
        .get('/api/v1/balances')
        .query({ employeeId: 'maria.garcia', locationId: 'buenos-aires' })
        .expect(200)
        .expect((res) => {
          expect(res.body.totalDays).toBe(20);
          expect(res.body.availableDays).toBe(20);
        });
    });

    it('should return 400 if employeeId missing', () => {
      return request(app.getHttpServer())
        .get('/api/v1/balances')
        .query({ locationId: 'buenos-aires' })
        .expect(400);
    });

    it('should return 404 for unknown employee', () => {
      return request(app.getHttpServer())
        .get('/api/v1/balances')
        .query({ employeeId: 'unknown', locationId: 'unknown' })
        .expect(404);
    });
  });

  // --- Create Request ---

  describe('POST /api/v1/requests', () => {
    it('should create a time-off request and return 201', () => {
      return request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          startDate: '2026-05-01',
          endDate: '2026-05-03',
          daysRequested: 2,
          type: 'VACATION',
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.status).toBe('PENDING_SYNC');
          expect(res.body.daysRequested).toBe(2);
          expect(res.body.id).toBeTruthy();
        });
    });

    it('should return 409 on insufficient balance', () => {
      return request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({
          employeeId: 'james.smith',
          locationId: 'buenos-aires',
          startDate: '2026-05-01',
          endDate: '2026-06-30',
          daysRequested: 999,
          type: 'VACATION',
        })
        .expect(409);
    });

    it('should return 400 on invalid body (missing required fields)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({ employeeId: 'maria.garcia' })
        .expect(400);
    });

    it('should return 404 for unknown employee', () => {
      return request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({
          employeeId: 'unknown.user',
          locationId: 'nowhere',
          startDate: '2026-05-01',
          endDate: '2026-05-03',
          daysRequested: 1,
          type: 'VACATION',
        })
        .expect(404);
    });
  });

  // --- My Requests ---

  describe('GET /api/v1/requests/me', () => {
    it('should return requests for employee', () => {
      return request(app.getHttpServer())
        .get('/api/v1/requests/me')
        .query({ employeeId: 'maria.garcia' })
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThanOrEqual(1);
        });
    });

    it('should return 400 if employeeId missing', () => {
      return request(app.getHttpServer())
        .get('/api/v1/requests/me')
        .expect(400);
    });
  });

  // --- Activity ---

  describe('GET /api/v1/activity', () => {
    it('should return activity timeline', () => {
      return request(app.getHttpServer())
        .get('/api/v1/activity')
        .query({ employeeId: 'maria.garcia', locationId: 'buenos-aires' })
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  // --- Manager endpoints ---

  describe('GET /api/v1/admin/requests/pending', () => {
    it('should return pending requests array', () => {
      return request(app.getHttpServer())
        .get('/api/v1/admin/requests/pending')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe('PATCH /api/v1/admin/requests/:id/approve', () => {
    it('should return 404 for non-existent request', () => {
      return request(app.getHttpServer())
        .patch('/api/v1/admin/requests/non-existent-uuid/approve')
        .expect(404);
    });
  });

  describe('PATCH /api/v1/admin/requests/:id/reject', () => {
    it('should return 404 for non-existent request', () => {
      return request(app.getHttpServer())
        .patch('/api/v1/admin/requests/non-existent-uuid/reject')
        .send({ reason: 'test' })
        .expect(404);
    });
  });

  describe('PATCH /api/v1/requests/:id/cancel', () => {
    it('should return 404 for non-existent request', () => {
      return request(app.getHttpServer())
        .patch('/api/v1/requests/non-existent-uuid/cancel')
        .expect(404);
    });
  });

  // --- Full lifecycle E2E ---

  describe('Full request lifecycle', () => {
    let requestId: string;

    it('should create → cancel a request end-to-end', async () => {
      // 1. Create
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .send({
          employeeId: 'james.smith',
          locationId: 'buenos-aires',
          startDate: '2026-08-01',
          endDate: '2026-08-03',
          daysRequested: 2,
          type: 'PERSONAL',
        })
        .expect(201);

      requestId = createRes.body.id;
      expect(createRes.body.status).toBe('PENDING_SYNC');

      // 2. Verify it shows in my requests
      const myRes = await request(app.getHttpServer())
        .get('/api/v1/requests/me')
        .query({ employeeId: 'james.smith' })
        .expect(200);

      expect(myRes.body.some((r: any) => r.id === requestId)).toBe(true);

      // 3. Cancel
      const cancelRes = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/cancel`)
        .expect(200);

      expect(cancelRes.body.status).toBe('CANCELLATION_PENDING');
    });
  });
});
