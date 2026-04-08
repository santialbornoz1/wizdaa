import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeOffController } from '../../src/modules/timeoff/timeoff.controller';
import { TimeOffService } from '../../src/modules/timeoff/timeoff.service';
import { SyncHistory } from '../../src/modules/sync/entities/sync-history.entity';
import { RequestStatus } from '../../src/common/enums';

const mockTimeOffService = {
  createRequest: jest.fn(),
  getMyRequests: jest.fn(),
  getPendingManagerRequests: jest.fn(),
  approveRequest: jest.fn(),
  rejectRequest: jest.fn(),
  cancelRequest: jest.fn(),
};

const mockSyncHistoryRepo = {
  find: jest.fn(),
};

describe('TimeOffController', () => {
  let controller: TimeOffController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimeOffController],
      providers: [
        { provide: TimeOffService, useValue: mockTimeOffService },
        { provide: getRepositoryToken(SyncHistory), useValue: mockSyncHistoryRepo },
      ],
    }).compile();

    controller = module.get(TimeOffController);
    jest.clearAllMocks();
  });

  describe('POST /requests', () => {
    it('should delegate to service and return created request', async () => {
      const dto = {
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        daysRequested: 2,
        type: 'VACATION',
      };
      const expected = { id: 'req-1', ...dto, status: RequestStatus.PENDING_SYNC };
      mockTimeOffService.createRequest.mockResolvedValueOnce(expected);

      const result = await controller.createRequest(dto as any);
      expect(result).toEqual(expected);
      expect(mockTimeOffService.createRequest).toHaveBeenCalledWith(dto);
    });
  });

  describe('GET /requests/me', () => {
    it('should return requests for employee', async () => {
      const requests = [{ id: 'req-1', employeeId: 'maria.garcia' }];
      mockTimeOffService.getMyRequests.mockResolvedValueOnce(requests);

      const result = await controller.getMyRequests('maria.garcia', undefined);
      expect(result).toEqual(requests);
    });

    it('should throw 400 if employeeId is missing', async () => {
      await expect(controller.getMyRequests('', undefined)).rejects.toThrow(HttpException);
    });
  });

  describe('GET /activity', () => {
    it('should return merged timeline of requests and sync events', async () => {
      const requests = [{
        id: 'req-1',
        employeeId: 'maria.garcia',
        createdAt: new Date('2026-04-08'),
      }];
      const syncEvents = [{
        id: 'sync-1',
        type: 'BATCH',
        status: 'SUCCESS',
        employeeId: 'maria.garcia',
        createdAt: new Date('2026-04-07'),
      }];

      mockTimeOffService.getMyRequests.mockResolvedValueOnce(requests);
      mockSyncHistoryRepo.find.mockResolvedValueOnce(syncEvents);

      const result = await controller.getActivity('maria.garcia', 'buenos-aires');
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('request');
      expect(result[1].type).toBe('sync');
    });

    it('should throw 400 if employeeId is missing', async () => {
      await expect(controller.getActivity('', 'buenos-aires')).rejects.toThrow(HttpException);
    });
  });

  describe('PATCH /requests/:id/cancel', () => {
    it('should delegate to service', async () => {
      const expected = { id: 'req-1', status: RequestStatus.CANCELLATION_PENDING };
      mockTimeOffService.cancelRequest.mockResolvedValueOnce(expected);

      const result = await controller.cancelRequest('req-1');
      expect(result).toEqual(expected);
    });
  });

  describe('GET /admin/requests/pending', () => {
    it('should return pending requests', async () => {
      const pending = [{ id: 'req-1', status: RequestStatus.WAITING_MANAGER_APPROVAL }];
      mockTimeOffService.getPendingManagerRequests.mockResolvedValueOnce(pending);

      const result = await controller.getPendingRequests();
      expect(result).toEqual(pending);
    });
  });

  describe('PATCH /admin/requests/:id/approve', () => {
    it('should delegate to service', async () => {
      const expected = { id: 'req-1', status: RequestStatus.APPROVED };
      mockTimeOffService.approveRequest.mockResolvedValueOnce(expected);

      const result = await controller.approveRequest('req-1');
      expect(result).toEqual(expected);
    });
  });

  describe('PATCH /admin/requests/:id/reject', () => {
    it('should delegate to service with reason', async () => {
      const expected = { id: 'req-1', status: RequestStatus.REJECTED, rejectionReason: 'No budget' };
      mockTimeOffService.rejectRequest.mockResolvedValueOnce(expected);

      const result = await controller.rejectRequest('req-1', { reason: 'No budget' });
      expect(result).toEqual(expected);
      expect(mockTimeOffService.rejectRequest).toHaveBeenCalledWith('req-1', 'No budget');
    });

    it('should work without reason', async () => {
      mockTimeOffService.rejectRequest.mockResolvedValueOnce({ id: 'req-1' });

      await controller.rejectRequest('req-1', {});
      expect(mockTimeOffService.rejectRequest).toHaveBeenCalledWith('req-1', undefined);
    });
  });
});
