import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { BalancesService } from '../src/modules/balances/balances.service';
import { Balance } from '../src/modules/balances/entities/balance.entity';
import { testDbModule } from './helpers/test-db.helper';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from '../src/modules/timeoff/entities/timeoff-request.entity';
import { SyncHistory } from '../src/modules/sync/entities/sync-history.entity';
import { EventsGateway } from '../src/common/events/events.gateway';

const mockEventsGateway = {
  emitBalanceUpdate: jest.fn(),
  emitRequestUpdate: jest.fn(),
};

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BalancesService', () => {
  let module: TestingModule;
  let service: BalancesService;
  let balanceRepo: Repository<Balance>;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        testDbModule(),
        TypeOrmModule.forFeature([Balance, TimeOffRequest, SyncHistory]),
      ],
      providers: [
        BalancesService,
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get(BalancesService);
    balanceRepo = module.get(getRepositoryToken(Balance));

    await balanceRepo.save({
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      totalDays: 20,
      usedDays: 0,
      availableDays: 20,
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  describe('getBalance (stale-while-revalidate)', () => {
    it('should return local balance immediately', async () => {
      // Mock HCM to be slow/matching
      mockedAxios.get.mockResolvedValueOnce({
        data: { totalDays: 20, usedDays: 0, availableDays: 20 },
      });

      const balance = await service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance).toBeTruthy();
      expect(balance!.totalDays).toBe(20);
    });

    it('should return null for unknown employee', async () => {
      const balance = await service.getBalance('unknown.user', 'buenos-aires');
      expect(balance).toBeNull();
    });
  });

  describe('Self-Healing: HCM discrepancy detection', () => {
    it('should update local balance when HCM has different values (e.g., after bonus)', async () => {
      // Simulate HCM having a bonus (25 total instead of 20)
      mockedAxios.get.mockResolvedValueOnce({
        data: { totalDays: 25, usedDays: 0, availableDays: 25 },
      });

      await service.getBalance('maria.garcia', 'buenos-aires');

      // Wait for async revalidation to complete
      await new Promise((r) => setTimeout(r, 200));

      const updated = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(updated!.totalDays).toBe(25);
      expect(updated!.availableDays).toBe(25);
      expect(updated!.lastSyncedAt).toBeTruthy();
    });

    it('should not update if HCM matches local', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { totalDays: 20, usedDays: 0, availableDays: 20 },
      });

      await service.getBalance('maria.garcia', 'buenos-aires');
      await new Promise((r) => setTimeout(r, 200));

      const after = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      // totalDays should remain the same
      expect(after!.totalDays).toBe(20);
    });

    it('should gracefully handle HCM being unreachable during revalidation', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const balance = await service.getBalance('maria.garcia', 'buenos-aires');

      // Should still return the stale local balance
      expect(balance).toBeTruthy();
      expect(balance!.totalDays).toBe(20);
    });

    it('should log warning when revalidation promise rejects unexpectedly', async () => {
      // HCM returns data but the DB save inside revalidateWithHcm fails
      // This causes the outer .catch() to fire since the error escapes the internal try/catch
      mockedAxios.get.mockResolvedValueOnce({
        data: { totalDays: 30, usedDays: 0, availableDays: 30 },
      });

      // Spy on the private revalidateWithHcm to make it reject
      // We override it to simulate an unhandled rejection
      jest.spyOn(service as any, 'revalidateWithHcm').mockRejectedValueOnce(
        new Error('Unexpected DB crash'),
      );

      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      await service.getBalance('maria.garcia', 'buenos-aires');

      // Wait for the async .catch() to fire
      await new Promise((r) => setTimeout(r, 200));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Background revalidation failed for maria.garcia@buenos-aires'),
      );
    });
  });

  describe('Revalidation edge case: balance deleted between read and revalidation', () => {
    it('should handle balance being deleted during async revalidation gracefully', async () => {
      // HCM returns valid data
      mockedAxios.get.mockResolvedValueOnce({
        data: { totalDays: 25, usedDays: 0, availableDays: 25 },
      });

      // First findOne call (in getBalance) returns the real balance
      // Second findOne call (inside revalidateWithHcm) returns null — simulates deletion mid-flight
      const originalFindOne = balanceRepo.findOne.bind(balanceRepo);
      let callCount = 0;
      jest.spyOn(balanceRepo, 'findOne').mockImplementation(async (options) => {
        callCount++;
        if (callCount <= 1) {
          return originalFindOne(options as any);
        }
        // Second call (inside revalidateWithHcm) — balance was deleted
        return null;
      });

      const balance = await service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance).toBeTruthy();

      // Wait for async revalidation to hit the `if (!localBalance) return` branch
      await new Promise((r) => setTimeout(r, 200));

      // Should not have thrown — the early return handles it gracefully
    });
  });

  describe('upsertFromHcm', () => {
    it('should update existing balance', async () => {
      await service.upsertFromHcm('maria.garcia', 'buenos-aires', 25, 3);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.totalDays).toBe(25);
      expect(balance!.usedDays).toBe(3);
      expect(balance!.availableDays).toBe(22);
    });

    it('should create new balance if not existing', async () => {
      await service.upsertFromHcm('ana.martinez', 'sao-paulo', 15, 0);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'ana.martinez', locationId: 'sao-paulo' },
      });
      expect(balance).toBeTruthy();
      expect(balance!.totalDays).toBe(15);
    });
  });

  describe('deductDays / restoreDays', () => {
    it('should deduct days correctly', async () => {
      await service.deductDays('maria.garcia', 'buenos-aires', 5);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(15);
      expect(balance!.usedDays).toBe(5);
    });

    it('should throw on insufficient balance for deduction', async () => {
      await expect(service.deductDays('maria.garcia', 'buenos-aires', 25)).rejects.toThrow(/Insufficient balance/);
    });

    it('should throw when deducting from non-existent employee', async () => {
      await expect(service.deductDays('unknown.user', 'buenos-aires', 1)).rejects.toThrow(/No balance found/);
    });

    it('should restore days correctly', async () => {
      await service.deductDays('maria.garcia', 'buenos-aires', 5);
      await service.restoreDays('maria.garcia', 'buenos-aires', 3);

      const balance = await balanceRepo.findOne({
        where: { employeeId: 'maria.garcia', locationId: 'buenos-aires' },
      });
      expect(balance!.availableDays).toBe(18);
      expect(balance!.usedDays).toBe(2);
    });

    it('should throw when restoring to non-existent employee', async () => {
      await expect(service.restoreDays('unknown.user', 'buenos-aires', 1)).rejects.toThrow(/No balance found/);
    });
  });

  describe('getBalanceSync', () => {
    it('should return balance without triggering HCM revalidation', async () => {
      mockedAxios.get.mockClear();

      const balance = await service.getBalanceSync('maria.garcia', 'buenos-aires');
      expect(balance).toBeTruthy();
      expect(balance!.totalDays).toBe(20);

      // getBalanceSync should NOT call axios (unlike getBalance which triggers revalidation)
      // Wait a tick to ensure no async call was fired
      await new Promise((r) => setTimeout(r, 50));
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('should return null for unknown employee', async () => {
      const balance = await service.getBalanceSync('unknown.user', 'buenos-aires');
      expect(balance).toBeNull();
    });
  });
});
