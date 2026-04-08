import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { SyncProcessor } from '../src/modules/sync/sync.processor';
import { TimeOffRequest } from '../src/modules/timeoff/entities/timeoff-request.entity';
import { SyncHistory } from '../src/modules/sync/entities/sync-history.entity';
import { Balance } from '../src/modules/balances/entities/balance.entity';
import { RequestStatus } from '../src/common/enums';
import { testDbModule, testEntitiesModule } from './helpers/test-db.helper';
import { EventsGateway } from '../src/common/events/events.gateway';

const mockEventsGateway = {
  emitBalanceUpdate: jest.fn(),
  emitRequestUpdate: jest.fn(),
};

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('SyncProcessor', () => {
  let module: TestingModule;
  let processor: SyncProcessor;
  let requestRepo: Repository<TimeOffRequest>;
  let balanceRepo: Repository<Balance>;
  let syncHistoryRepo: Repository<SyncHistory>;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [testDbModule(), testEntitiesModule()],
      providers: [
        SyncProcessor,
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    processor = module.get(SyncProcessor);
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
    balanceRepo = module.get(getRepositoryToken(Balance));
    syncHistoryRepo = module.get(getRepositoryToken(SyncHistory));

    // Seed
    await balanceRepo.save({
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      totalDays: 20,
      usedDays: 5,
      availableDays: 15,
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  describe('HCM Sync - Success Path', () => {
    it('should update request to WAITING_MANAGER_APPROVAL on HCM confirmation', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
        status: RequestStatus.PENDING_SYNC,
      });

      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, transactionId: 'hcm-tx-001', remainingBalance: 13 },
      });

      const job = {
        name: 'sync-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 2,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.status).toBe(RequestStatus.WAITING_MANAGER_APPROVAL);
      expect(updated!.hcmTransactionId).toBe('hcm-tx-001');

      // Sync history should record success
      const history = await syncHistoryRepo.find({ where: { requestId: request.id } });
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('SUCCESS');
    });
  });

  describe('HCM Downtime - Retry with Exponential Backoff', () => {
    it('should throw on 504 to trigger BullMQ retry', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
        status: RequestStatus.PENDING_SYNC,
      });

      const axiosError = new Error('Gateway Timeout') as any;
      axiosError.response = { status: 504, data: { error: 'HCM_UNAVAILABLE' } };
      mockedAxios.post.mockRejectedValueOnce(axiosError);

      const job = {
        name: 'sync-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 2,
        },
        attemptsMade: 0,
      } as any;

      // Should throw to trigger retry
      await expect(processor.process(job)).rejects.toThrow();

      // Request should remain PENDING_SYNC
      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.status).toBe(RequestStatus.PENDING_SYNC);

      // Sync history should record RETRYING
      const history = await syncHistoryRepo.find({ where: { requestId: request.id } });
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('RETRYING');
    });

    it('should not retry on 400 (permanent HCM rejection) and restore balance', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
        status: RequestStatus.PENDING_SYNC,
      });

      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: 'INVALID_DIMENSIONS', message: 'Invalid employee/location combination' },
        },
        message: 'Bad Request',
      });

      const job = {
        name: 'sync-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 2,
        },
        attemptsMade: 0,
      } as any;

      // Should NOT throw (permanent failure, no retry)
      await processor.process(job);

      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.status).toBe(RequestStatus.REJECTED);
      expect(updated!.rejectionReason).toBe('Invalid employee/location combination');

      // Balance should be restored
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(17); // 15 + 2 restored
      expect(balance!.usedDays).toBe(3); // 5 - 2 restored
    });

    it('should use default rejection reason when HCM error has no message', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
        status: RequestStatus.PENDING_SYNC,
      });

      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: {}, // No message field
        },
        message: 'Bad Request',
      });

      const job = {
        name: 'sync-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 2,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.rejectionReason).toBe('Rejected by HCM');
    });

    it('should not retry on 409 (insufficient HCM balance) and restore balance', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
        status: RequestStatus.PENDING_SYNC,
      });

      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { error: 'INSUFFICIENT_BALANCE', message: 'Only 0 days available in HCM', available: 0 },
        },
        message: 'Conflict',
      });

      const job = {
        name: 'sync-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 2,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.status).toBe(RequestStatus.REJECTED);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(17);
    });
  });

  describe('Rollback flow', () => {
    it('should call HCM rollback endpoint and log success', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, transactionId: 'hcm-tx-rb-001' },
      });

      const job = {
        name: 'rollback-request',
        data: {
          requestId: 'req-001',
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 3,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/hcm/api/v1/time-off/rollback'),
        expect.objectContaining({ days: 3 }),
        expect.any(Object),
      );

      const history = await syncHistoryRepo.find();
      expect(history[0].type).toBe('ROLLBACK');
      expect(history[0].status).toBe('SUCCESS');
    });
  });

  describe('Cancel flow', () => {
    it('should rollback in HCM, restore local balance, and set CANCELLED', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3,
        type: 'VACATION',
        status: RequestStatus.CANCELLATION_PENDING,
      });

      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, transactionId: 'hcm-tx-cancel-001' },
      });

      const job = {
        name: 'cancel-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 3,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.status).toBe(RequestStatus.CANCELLED);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      // 15 + 3 restored = 18
      expect(balance!.availableDays).toBe(18);
      expect(balance!.usedDays).toBe(2);
    });
  });

  describe('Rollback error handling', () => {
    it('should throw on rollback failure to trigger BullMQ retry', async () => {
      const axiosError = new Error('Connection refused') as any;
      axiosError.response = { status: 504 };
      mockedAxios.post.mockRejectedValueOnce(axiosError);

      const job = {
        name: 'rollback-request',
        data: {
          requestId: 'req-001',
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 3,
        },
        attemptsMade: 1,
      } as any;

      await expect(processor.process(job)).rejects.toThrow();

      const history = await syncHistoryRepo.find();
      expect(history[0].status).toBe('RETRYING');
    });
  });

  describe('Cancel error handling', () => {
    it('should throw on cancel failure to trigger BullMQ retry', async () => {
      const request = await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3,
        type: 'VACATION',
        status: RequestStatus.CANCELLATION_PENDING,
      });

      const axiosError = new Error('Timeout') as any;
      axiosError.response = { status: 504 };
      mockedAxios.post.mockRejectedValueOnce(axiosError);

      const job = {
        name: 'cancel-request',
        data: {
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 3,
        },
        attemptsMade: 0,
      } as any;

      await expect(processor.process(job)).rejects.toThrow();

      // Request should still be CANCELLATION_PENDING
      const updated = await requestRepo.findOne({ where: { id: request.id } });
      expect(updated!.status).toBe(RequestStatus.CANCELLATION_PENDING);
    });
  });

  describe('Unknown job name', () => {
    it('should handle unknown job name gracefully without throwing', async () => {
      const job = {
        name: 'unknown-job-type',
        data: {},
        attemptsMade: 0,
      } as any;

      // Should not throw
      await processor.process(job);
    });
  });

  describe('Batch upsert', () => {
    it('should upsert balance preserving pending request deductions', async () => {
      // Create a pending request
      await requestRepo.save({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
        status: RequestStatus.PENDING_SYNC,
      });

      const job = {
        name: 'batch-upsert',
        data: {
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          totalDays: 25, // HCM says 25 total (e.g., after bonus)
          usedDays: 5,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      // availableDays = 25 - 5 - 2 (pending) = 18
      expect(balance!.totalDays).toBe(25);
      expect(balance!.usedDays).toBe(5);
      expect(balance!.availableDays).toBe(18);
    });

    it('should create new balance if not existing', async () => {
      const job = {
        name: 'batch-upsert',
        data: {
          employeeId: 'ana.martinez',
          locationId: 'sao-paulo',
          totalDays: 10,
          usedDays: 0,
        },
        attemptsMade: 0,
      } as any;

      await processor.process(job);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'ana.martinez', locationId: 'sao-paulo' },
      });
      expect(balance).toBeTruthy();
      expect(balance!.totalDays).toBe(10);
      expect(balance!.availableDays).toBe(10);
    });
  });

  describe('Batch upsert error handling', () => {
    it('should log FAILED and throw on batch upsert error', async () => {
      // Force an error by mocking the balanceRepo to throw
      jest.spyOn(balanceRepo, 'findOne').mockRejectedValueOnce(new Error('DB write failed'));

      const job = {
        name: 'batch-upsert',
        data: {
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          totalDays: 25,
          usedDays: 5,
        },
        attemptsMade: 0,
      } as any;

      await expect(processor.process(job)).rejects.toThrow('DB write failed');

      const history = await syncHistoryRepo.find();
      expect(history.some((h) => h.status === 'FAILED')).toBe(true);
    });
  });
});
