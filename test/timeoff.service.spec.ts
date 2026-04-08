import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { TimeOffService } from '../src/modules/timeoff/timeoff.service';
import { TimeOffRequest } from '../src/modules/timeoff/entities/timeoff-request.entity';
import { Balance } from '../src/modules/balances/entities/balance.entity';
import { RequestStatus } from '../src/common/enums';
import { testDbModule, testEntitiesModule } from './helpers/test-db.helper';
import { createMockQueue } from './helpers/mock-queue.helper';
import { EventsGateway } from '../src/common/events/events.gateway';

const mockEventsGateway = {
  emitBalanceUpdate: jest.fn(),
  emitRequestUpdate: jest.fn(),
};

describe('TimeOffService', () => {
  let module: TestingModule;
  let service: TimeOffService;
  let balanceRepo: Repository<Balance>;
  let requestRepo: Repository<TimeOffRequest>;
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(async () => {
    mockQueue = createMockQueue();

    module = await Test.createTestingModule({
      imports: [testDbModule(), testEntitiesModule()],
      providers: [
        TimeOffService,
        { provide: getQueueToken('hcm-sync'), useValue: mockQueue },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get(TimeOffService);
    balanceRepo = module.get(getRepositoryToken(Balance));
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));

    // Seed test balance
    await balanceRepo.save({
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      totalDays: 20,
      usedDays: 0,
      availableDays: 20,
    });
  });

  afterEach(async () => {
    await module.close();
  });

  describe('createRequest - Transactional Outbox', () => {
    it('should create a request as PENDING_SYNC and deduct local balance atomically', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
      });

      expect(request.status).toBe(RequestStatus.PENDING_SYNC);
      expect(request.daysRequested).toBe(2);

      // Verify balance was deducted
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(18);
      expect(balance!.usedDays).toBe(2);

      // Verify HCM sync was enqueued
      expect(mockQueue.add).toHaveBeenCalledWith(
        'sync-request',
        expect.objectContaining({
          requestId: request.id,
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          days: 2,
        }),
        expect.objectContaining({
          attempts: 10,
          backoff: { type: 'exponential', delay: 2000 },
        }),
      );
    });

    it('should reject if insufficient balance', async () => {
      await expect(
        service.createRequest({
          employeeId: 'maria.garcia',
          locationId: 'buenos-aires',
          startDate: '2026-05-01',
          endDate: '2026-05-30',
          daysRequested: 25,
        }),
      ).rejects.toThrow();

      // Verify balance unchanged
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(20);
    });

    it('should reject if employee/location not found', async () => {
      await expect(
        service.createRequest({
          employeeId: 'unknown.user',
          locationId: 'buenos-aires',
          startDate: '2026-05-01',
          endDate: '2026-05-02',
          daysRequested: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Idempotency Key', () => {
    it('should return the same request when called twice with the same idempotency key', async () => {
      const dto = {
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION' as const,
        idempotencyKey: 'unique-key-123',
      };

      const first = await service.createRequest(dto);
      const second = await service.createRequest(dto);

      expect(first.id).toBe(second.id);
      expect(first.idempotencyKey).toBe('unique-key-123');

      // Balance should only be deducted once
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(18);
      expect(balance!.usedDays).toBe(2);

      // HCM sync should only be enqueued once
      const syncCalls = mockQueue.add.mock.calls.filter(
        (call: any[]) => call[0] === 'sync-request',
      );
      expect(syncCalls).toHaveLength(1);
    });

    it('should create separate requests when no idempotency key is provided', async () => {
      const dto = {
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      };

      const first = await service.createRequest(dto);
      const second = await service.createRequest(dto);

      expect(first.id).not.toBe(second.id);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(16);
      expect(balance!.usedDays).toBe(4);
    });

    it('should allow different idempotency keys to create separate requests', async () => {
      const base = {
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      };

      const first = await service.createRequest({ ...base, idempotencyKey: 'key-a' });
      const second = await service.createRequest({ ...base, idempotencyKey: 'key-b' });

      expect(first.id).not.toBe(second.id);
    });
  });

  describe('Race Condition: concurrent requests depleting balance', () => {
    it('should prevent double-spending when two requests are created concurrently', async () => {
      const req1 = service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-11',
        daysRequested: 15,
      });

      const req2 = service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-06-01',
        endDate: '2026-06-11',
        daysRequested: 15,
      });

      const results = await Promise.allSettled([req1, req2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      // At least one should succeed, and at most one can fail due to insufficient balance
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // The total deducted should never exceed 20
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBeGreaterThanOrEqual(0);
      expect(balance!.usedDays).toBeLessThanOrEqual(20);
    });
  });

  describe('Manager approve/reject flow', () => {
    it('should allow manager to approve a WAITING_MANAGER_APPROVAL request', async () => {
      // Create and manually set to WAITING_MANAGER_APPROVAL (simulating HCM sync completed)
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      await requestRepo.update(request.id, {
        status: RequestStatus.WAITING_MANAGER_APPROVAL,
        hcmTransactionId: 'hcm-tx-123',
      });

      const approved = await service.approveRequest(request.id);
      expect(approved.status).toBe(RequestStatus.APPROVED);
    });

    it('should not allow approving a PENDING_SYNC request', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      await expect(service.approveRequest(request.id)).rejects.toThrow(
        /Must be WAITING_MANAGER_APPROVAL/,
      );
    });

    it('should restore balance and enqueue HCM rollback on manager rejection of synced request', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 3,
      });

      // Simulate HCM confirmation
      await requestRepo.update(request.id, {
        status: RequestStatus.WAITING_MANAGER_APPROVAL,
        hcmTransactionId: 'hcm-tx-456',
      });

      const rejected = await service.rejectRequest(request.id, 'Not authorized');
      expect(rejected.status).toBe(RequestStatus.REJECTED);
      expect(rejected.rejectionReason).toBe('Not authorized');

      // Balance should be restored
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(20);
      expect(balance!.usedDays).toBe(0);

      // HCM rollback should be enqueued
      expect(mockQueue.add).toHaveBeenCalledWith(
        'rollback-request',
        expect.objectContaining({
          requestId: request.id,
          days: 3,
        }),
        expect.any(Object),
      );
    });
  });

  describe('Cancellation flow', () => {
    it('should set CANCELLATION_PENDING and enqueue HCM cancel', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      const cancelled = await service.cancelRequest(request.id);
      expect(cancelled.status).toBe(RequestStatus.CANCELLATION_PENDING);

      // Days NOT yet restored (waiting for HCM confirmation)
      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(18); // Still deducted

      expect(mockQueue.add).toHaveBeenCalledWith(
        'cancel-request',
        expect.objectContaining({ requestId: request.id }),
        expect.any(Object),
      );
    });

    it('should not cancel a COMPLETED request', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      await requestRepo.update(request.id, { status: RequestStatus.COMPLETED });

      await expect(service.cancelRequest(request.id)).rejects.toThrow(/Cannot cancel/);
    });
  });

  describe('getMyRequests', () => {
    it('should return requests filtered by employeeId', async () => {
      await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      const results = await service.getMyRequests('maria.garcia');
      expect(results).toHaveLength(1);
      expect(results[0].employeeId).toBe('maria.garcia');
    });

    it('should return empty for unknown employee', async () => {
      const results = await service.getMyRequests('unknown.user');
      expect(results).toHaveLength(0);
    });

    it('should filter by status when provided', async () => {
      await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      const pending = await service.getMyRequests('maria.garcia', 'PENDING_SYNC');
      expect(pending).toHaveLength(1);

      const approved = await service.getMyRequests('maria.garcia', 'APPROVED');
      expect(approved).toHaveLength(0);
    });
  });

  describe('getPendingManagerRequests', () => {
    it('should return WAITING_MANAGER_APPROVAL requests with isConsistentWithHcm flag', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      await requestRepo.update(request.id, {
        status: RequestStatus.WAITING_MANAGER_APPROVAL,
        hcmTransactionId: 'hcm-tx-123',
      });

      const pending = await service.getPendingManagerRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0].isConsistentWithHcm).toBe(true);
    });

    it('should flag isConsistentWithHcm as false when no hcmTransactionId', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      await requestRepo.update(request.id, {
        status: RequestStatus.WAITING_MANAGER_APPROVAL,
      });

      const pending = await service.getPendingManagerRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0].isConsistentWithHcm).toBe(false);
    });
  });

  describe('getRequestById', () => {
    it('should return a request by ID', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      const found = await service.getRequestById(request.id);
      expect(found).toBeTruthy();
      expect(found!.id).toBe(request.id);
    });

    it('should return null for non-existent ID', async () => {
      const found = await service.getRequestById('non-existent-uuid');
      expect(found).toBeNull();
    });
  });

  describe('Error handling: non-existent request IDs', () => {
    it('should throw 404 when approving non-existent request', async () => {
      await expect(service.approveRequest('non-existent')).rejects.toThrow(/not found/);
    });

    it('should throw 404 when rejecting non-existent request', async () => {
      await expect(service.rejectRequest('non-existent', 'reason')).rejects.toThrow(/not found/);
    });

    it('should throw 404 when cancelling non-existent request', async () => {
      await expect(service.cancelRequest('non-existent')).rejects.toThrow(/not found/);
    });

    it('should throw 409 when rejecting a COMPLETED request', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      await requestRepo.update(request.id, { status: RequestStatus.COMPLETED });

      await expect(service.rejectRequest(request.id, 'reason')).rejects.toThrow(/Cannot reject/);
    });

    it('should not enqueue rollback when rejecting a PENDING_SYNC request (not yet confirmed by HCM)', async () => {
      const request = await service.createRequest({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
      });

      // Request is PENDING_SYNC (not yet confirmed by HCM)
      mockQueue.add.mockClear();
      await service.rejectRequest(request.id);

      // Should NOT enqueue rollback since HCM never confirmed
      const rollbackCalls = mockQueue.add.mock.calls.filter(
        (call: any[]) => call[0] === 'rollback-request',
      );
      expect(rollbackCalls).toHaveLength(0);
    });
  });
});
