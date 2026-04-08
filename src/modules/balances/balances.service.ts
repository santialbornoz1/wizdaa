import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Balance } from './entities/balance.entity';
import axios from 'axios';
import { EventsGateway } from '../../common/events/events.gateway';

const HCM_BASE_URL = process.env.HCM_BASE_URL || 'http://localhost:4000';

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    private readonly events: EventsGateway,
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<Balance | null> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    // Trigger async revalidation (stale-while-revalidate)
    this.revalidateWithHcm(employeeId, locationId).catch((err) => {
      this.logger.warn(`Background revalidation failed for ${employeeId}@${locationId}: ${err.message}`);
    });

    return balance;
  }

  async getBalanceSync(employeeId: string, locationId: string): Promise<Balance | null> {
    return this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });
  }

  async upsertFromHcm(
    employeeId: string,
    locationId: string,
    hcmTotalDays: number,
    hcmUsedDays: number,
  ): Promise<Balance> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (existing) {
      existing.totalDays = hcmTotalDays;
      existing.usedDays = hcmUsedDays;
      existing.availableDays = hcmTotalDays - hcmUsedDays;
      existing.lastSyncedAt = new Date().toISOString();
      const saved = await this.balanceRepo.save(existing);
      this.events.emitBalanceUpdate(employeeId, locationId, { totalDays: saved.totalDays, usedDays: saved.usedDays, availableDays: saved.availableDays });
      return saved;
    }

    const balance = this.balanceRepo.create({
      employeeId,
      locationId,
      totalDays: hcmTotalDays,
      usedDays: hcmUsedDays,
      availableDays: hcmTotalDays - hcmUsedDays,
      lastSyncedAt: new Date().toISOString(),
    });

    const saved = await this.balanceRepo.save(balance);
    this.events.emitBalanceUpdate(employeeId, locationId, { totalDays: saved.totalDays, usedDays: saved.usedDays, availableDays: saved.availableDays });
    return saved;
  }

  async deductDays(employeeId: string, locationId: string, days: number): Promise<Balance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance) {
      throw new Error(`No balance found for ${employeeId}@${locationId}`);
    }

    if (balance.availableDays < days) {
      throw new Error(`Insufficient balance: ${balance.availableDays} available, ${days} requested`);
    }

    balance.usedDays += days;
    balance.availableDays -= days;
    const saved = await this.balanceRepo.save(balance);
    this.events.emitBalanceUpdate(employeeId, locationId, { totalDays: saved.totalDays, usedDays: saved.usedDays, availableDays: saved.availableDays });
    return saved;
  }

  async restoreDays(employeeId: string, locationId: string, days: number): Promise<Balance> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance) {
      throw new Error(`No balance found for ${employeeId}@${locationId}`);
    }

    balance.usedDays -= days;
    balance.availableDays += days;
    const saved = await this.balanceRepo.save(balance);
    this.events.emitBalanceUpdate(employeeId, locationId, { totalDays: saved.totalDays, usedDays: saved.usedDays, availableDays: saved.availableDays });
    return saved;
  }

  private async revalidateWithHcm(employeeId: string, locationId: string): Promise<void> {
    try {
      const { data } = await axios.get(
        `${HCM_BASE_URL}/hcm/api/v1/balances/${employeeId}/${locationId}`,
        { timeout: 3000 },
      );

      const localBalance = await this.balanceRepo.findOne({
        where: { employeeId, locationId },
      });

      if (!localBalance) return;

      // Self-healing: detect discrepancies
      if (data.totalDays !== localBalance.totalDays || data.usedDays !== localBalance.usedDays) {
        this.logger.warn(
          `Discrepancy detected for ${employeeId}@${locationId}. ` +
          `Local: ${localBalance.totalDays}/${localBalance.usedDays}, ` +
          `HCM: ${data.totalDays}/${data.usedDays}. Updating local.`,
        );

        localBalance.totalDays = data.totalDays;
        localBalance.usedDays = data.usedDays;
        localBalance.availableDays = data.availableDays;
        localBalance.lastSyncedAt = new Date().toISOString();
        await this.balanceRepo.save(localBalance);
        this.events.emitBalanceUpdate(employeeId, locationId, { totalDays: data.totalDays, usedDays: data.usedDays, availableDays: data.availableDays });
      }
    } catch {
      // HCM unreachable - use stale local data
    }
  }
}
