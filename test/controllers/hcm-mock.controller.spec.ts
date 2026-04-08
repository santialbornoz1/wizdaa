import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { HcmMockController } from '../../src/modules/hcm-mock/hcm-mock.controller';
import { HcmAdminController } from '../../src/modules/hcm-mock/hcm-admin.controller';
import { HcmMockService } from '../../src/modules/hcm-mock/hcm-mock.service';

describe('HcmMockController', () => {
  let controller: HcmMockController;
  let service: HcmMockService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HcmMockController],
      providers: [HcmMockService],
    }).compile();

    controller = module.get(HcmMockController);
    service = module.get(HcmMockService);
  });

  describe('GET /balances/all', () => {
    it('should return all balances', () => {
      const result = controller.getAllBalances();
      expect(result).toHaveLength(4);
    });
  });

  describe('GET /balances/:employeeId/:locationId', () => {
    it('should return balance for valid employee', () => {
      const result = controller.getBalance('maria.garcia', 'buenos-aires');
      expect(result.totalDays).toBe(20);
    });

    it('should throw 400 for invalid employee', () => {
      expect(() => controller.getBalance('unknown', 'buenos-aires')).toThrow(HttpException);
    });
  });

  describe('POST /time-off', () => {
    it('should reserve time off', () => {
      const result = controller.reserveTimeOff({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        days: 3,
        requestId: 'req-1',
      });
      expect(result.success).toBe(true);
      expect(result.transactionId).toBeTruthy();
    });
  });

  describe('POST /time-off/rollback', () => {
    it('should rollback reservation', () => {
      service.reserveTimeOff('maria.garcia', 'buenos-aires', 5, 'req-1');
      const result = controller.rollbackTimeOff({
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        days: 5,
        requestId: 'req-1',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('POST /balances/:empId/:locId/bonus', () => {
    it('should add bonus', () => {
      const result = controller.addBonus('maria.garcia', 'buenos-aires', {
        days: 5,
        reason: 'Anniversary',
      });
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(25);
    });
  });
});

describe('HcmAdminController', () => {
  let controller: HcmAdminController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HcmAdminController],
      providers: [HcmMockService],
    }).compile();

    controller = module.get(HcmAdminController);
  });

  describe('POST /downtime', () => {
    it('should toggle downtime', () => {
      const result = controller.toggleDowntime({ enabled: true });
      expect(result).toEqual({ downtime: true });
    });
  });

  describe('POST /latency', () => {
    it('should set latency', () => {
      const result = controller.setLatency({ ms: 2000 });
      expect(result).toEqual({ latency: 2000 });
    });
  });

  describe('GET /status', () => {
    it('should return full status', () => {
      const result = controller.getStatus();
      expect(result).toHaveProperty('isDown');
      expect(result).toHaveProperty('balances');
      expect(result).toHaveProperty('transactions');
      expect(result.balances).toHaveLength(4);
    });
  });
});
