import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  totalDays: number;
  usedDays: number;
  availableDays: number;
  lastUpdated: string;
}

export interface HcmTransaction {
  transactionId: string;
  requestId: string;
  employeeId: string;
  locationId: string;
  days: number;
  type: 'RESERVE' | 'ROLLBACK' | 'BONUS';
  timestamp: string;
}

@Injectable()
export class HcmMockService {
  private readonly logger = new Logger(HcmMockService.name);
  private balances: Map<string, HcmBalance> = new Map();
  private transactions: HcmTransaction[] = [];
  private simulateDowntime = false;
  private simulateLatencyMs = 0;

  constructor() {
    this.seed();
  }

  private seed() {
    this.setBalance('maria.garcia', 'buenos-aires', 20);
    this.setBalance('james.smith', 'buenos-aires', 15);
    this.setBalance('laura.chen', 'new-york', 10);
    this.setBalance('carlos.lopez', 'london', 25);
    this.logger.log('HCM Mock seeded with initial balances');
  }

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  private setBalance(employeeId: string, locationId: string, totalDays: number) {
    this.balances.set(this.key(employeeId, locationId), {
      employeeId,
      locationId,
      totalDays,
      usedDays: 0,
      availableDays: totalDays,
      lastUpdated: new Date().toISOString(),
    });
  }

  getBalance(employeeId: string, locationId: string): HcmBalance | undefined {
    this.checkDowntime();
    return this.balances.get(this.key(employeeId, locationId));
  }

  getAllBalances(): HcmBalance[] {
    this.checkDowntime();
    return Array.from(this.balances.values());
  }

  getAllBalancesAdmin(): HcmBalance[] {
    return Array.from(this.balances.values());
  }

  reserveTimeOff(employeeId: string, locationId: string, days: number, requestId: string) {
    this.checkDowntime();

    const balance = this.balances.get(this.key(employeeId, locationId));
    if (!balance) {
      throw new HttpException(
        { error: 'INVALID_DIMENSIONS', message: `No balance for ${employeeId} at ${locationId}` },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (balance.availableDays < days) {
      throw new HttpException(
        {
          error: 'INSUFFICIENT_BALANCE',
          message: `Requested ${days} days but only ${balance.availableDays} available`,
          available: balance.availableDays,
        },
        HttpStatus.CONFLICT,
      );
    }

    balance.usedDays += days;
    balance.availableDays -= days;
    balance.lastUpdated = new Date().toISOString();

    const txId = `hcm-tx-${Date.now()}`;
    this.transactions.push({
      transactionId: txId,
      requestId,
      employeeId,
      locationId,
      days,
      type: 'RESERVE',
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Reserved ${days} days for ${employeeId}@${locationId}. Available: ${balance.availableDays}`);

    return {
      success: true,
      transactionId: txId,
      remainingBalance: balance.availableDays,
    };
  }

  rollbackTimeOff(employeeId: string, locationId: string, days: number, requestId: string) {
    this.checkDowntime();

    const balance = this.balances.get(this.key(employeeId, locationId));
    if (!balance) {
      throw new HttpException(
        { error: 'INVALID_DIMENSIONS', message: `No balance for ${employeeId} at ${locationId}` },
        HttpStatus.BAD_REQUEST,
      );
    }

    balance.usedDays -= days;
    balance.availableDays += days;
    balance.lastUpdated = new Date().toISOString();

    const txId = `hcm-tx-${Date.now()}`;
    this.transactions.push({
      transactionId: txId,
      requestId,
      employeeId,
      locationId,
      days,
      type: 'ROLLBACK',
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Rolled back ${days} days for ${employeeId}@${locationId}. Available: ${balance.availableDays}`);

    return {
      success: true,
      transactionId: txId,
      remainingBalance: balance.availableDays,
    };
  }

  addBonus(employeeId: string, locationId: string, days: number, reason: string) {
    const balance = this.balances.get(this.key(employeeId, locationId));
    if (!balance) {
      throw new HttpException(
        { error: 'INVALID_DIMENSIONS', message: `No balance for ${employeeId} at ${locationId}` },
        HttpStatus.BAD_REQUEST,
      );
    }

    balance.totalDays += days;
    balance.availableDays += days;
    balance.lastUpdated = new Date().toISOString();

    const txId = `hcm-tx-${Date.now()}`;
    this.transactions.push({
      transactionId: txId,
      requestId: `bonus-${Date.now()}`,
      employeeId,
      locationId,
      days,
      type: 'BONUS',
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Bonus: +${days} days for ${employeeId}@${locationId} (${reason}). Available: ${balance.availableDays}`);

    return {
      success: true,
      transactionId: txId,
      newBalance: balance.availableDays,
      reason,
    };
  }

  setDowntime(enabled: boolean) {
    this.simulateDowntime = enabled;
    this.logger.warn(`HCM downtime simulation: ${enabled ? 'ON' : 'OFF'}`);
  }

  setLatency(ms: number) {
    this.simulateLatencyMs = ms;
    this.logger.warn(`HCM latency simulation: ${ms}ms`);
  }

  isDowntime(): boolean {
    return this.simulateDowntime;
  }

  getTransactions(): HcmTransaction[] {
    return this.transactions;
  }

  private checkDowntime() {
    if (this.simulateDowntime) {
      throw new HttpException(
        { error: 'HCM_UNAVAILABLE', message: 'HCM system is currently unavailable' },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
  }
}
