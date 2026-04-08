import { HcmMockService } from '../src/modules/hcm-mock/hcm-mock.service';

describe('HcmMockService', () => {
  let service: HcmMockService;

  beforeEach(() => {
    service = new HcmMockService();
  });

  describe('Seed data', () => {
    it('should have maria.garcia@buenos-aires with 20 days', () => {
      const balance = service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance).toBeTruthy();
      expect(balance!.totalDays).toBe(20);
      expect(balance!.availableDays).toBe(20);
    });

    it('should return undefined for unknown employee', () => {
      const balance = service.getBalance('unknown.user', 'buenos-aires');
      expect(balance).toBeUndefined();
    });
  });

  describe('reserveTimeOff', () => {
    it('should deduct days and return transaction ID', () => {
      const result = service.reserveTimeOff('maria.garcia', 'buenos-aires', 5, 'req-001');
      expect(result.success).toBe(true);
      expect(result.transactionId).toBeTruthy();
      expect(result.remainingBalance).toBe(15);

      const balance = service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance!.availableDays).toBe(15);
      expect(balance!.usedDays).toBe(5);
    });

    it('should throw on insufficient balance', () => {
      expect(() => {
        service.reserveTimeOff('maria.garcia', 'buenos-aires', 25, 'req-002');
      }).toThrow();
    });

    it('should throw on invalid dimensions', () => {
      expect(() => {
        service.reserveTimeOff('unknown.user', 'buenos-aires', 1, 'req-003');
      }).toThrow();
    });
  });

  describe('rollbackTimeOff', () => {
    it('should restore days after rollback', () => {
      service.reserveTimeOff('maria.garcia', 'buenos-aires', 5, 'req-001');
      const result = service.rollbackTimeOff('maria.garcia', 'buenos-aires', 5, 'req-001');

      expect(result.success).toBe(true);
      expect(result.remainingBalance).toBe(20);
    });
  });

  describe('addBonus (independent HCM balance change)', () => {
    it('should increase balance independently', () => {
      const result = service.addBonus('maria.garcia', 'buenos-aires', 5, 'Work Anniversary');
      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(25);

      const balance = service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance!.totalDays).toBe(25);
      expect(balance!.availableDays).toBe(25);
    });

    it('should work after a reservation', () => {
      service.reserveTimeOff('maria.garcia', 'buenos-aires', 5, 'req-001');
      service.addBonus('maria.garcia', 'buenos-aires', 3, 'Year-end bonus');

      const balance = service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance!.totalDays).toBe(23); // 20 + 3
      expect(balance!.usedDays).toBe(5);
      expect(balance!.availableDays).toBe(18); // 23 - 5
    });
  });

  describe('Downtime simulation', () => {
    it('should throw 504 when downtime is enabled', () => {
      service.setDowntime(true);
      expect(() => service.getBalance('maria.garcia', 'buenos-aires')).toThrow();
    });

    it('should resume after downtime is disabled', () => {
      service.setDowntime(true);
      service.setDowntime(false);
      const balance = service.getBalance('maria.garcia', 'buenos-aires');
      expect(balance).toBeTruthy();
    });
  });

  describe('getAllBalances', () => {
    it('should return all seeded balances', () => {
      const all = service.getAllBalances();
      expect(all.length).toBe(4);
    });
  });

  describe('Transaction log', () => {
    it('should log all transactions', () => {
      service.reserveTimeOff('maria.garcia', 'buenos-aires', 3, 'req-001');
      service.addBonus('maria.garcia', 'buenos-aires', 2, 'bonus');
      service.rollbackTimeOff('maria.garcia', 'buenos-aires', 3, 'req-001');

      const txs = service.getTransactions();
      expect(txs.length).toBe(3);
      expect(txs[0].type).toBe('RESERVE');
      expect(txs[1].type).toBe('BONUS');
      expect(txs[2].type).toBe('ROLLBACK');
    });
  });

  describe('getAllBalancesAdmin', () => {
    it('should return all balances even during downtime', () => {
      service.setDowntime(true);
      const balances = service.getAllBalancesAdmin();
      expect(balances.length).toBe(4);
    });
  });

  describe('setLatency', () => {
    it('should set latency simulation value without throwing', () => {
      service.setLatency(3000);
      // Latency is stored internally, no public getter needed
      expect(true).toBe(true);
    });
  });

  describe('rollbackTimeOff edge cases', () => {
    it('should throw on rollback for invalid dimensions', () => {
      expect(() => {
        service.rollbackTimeOff('unknown.user', 'buenos-aires', 5, 'req-001');
      }).toThrow();
    });

    it('should throw on rollback during downtime', () => {
      service.setDowntime(true);
      expect(() => {
        service.rollbackTimeOff('maria.garcia', 'buenos-aires', 5, 'req-001');
      }).toThrow();
    });
  });

  describe('reserveTimeOff during downtime', () => {
    it('should throw 504 during downtime', () => {
      service.setDowntime(true);
      expect(() => {
        service.reserveTimeOff('maria.garcia', 'buenos-aires', 1, 'req-001');
      }).toThrow();
    });
  });

  describe('addBonus edge cases', () => {
    it('should throw on bonus for invalid dimensions', () => {
      expect(() => {
        service.addBonus('unknown.user', 'buenos-aires', 5, 'bonus');
      }).toThrow();
    });
  });

  describe('isDowntime', () => {
    it('should return false by default', () => {
      expect(service.isDowntime()).toBe(false);
    });

    it('should return true after enabling downtime', () => {
      service.setDowntime(true);
      expect(service.isDowntime()).toBe(true);
    });
  });
});
