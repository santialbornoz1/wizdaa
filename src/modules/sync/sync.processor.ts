import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import axios from 'axios';
import { TimeOffRequest } from '../timeoff/entities/timeoff-request.entity';
import { SyncHistory } from './entities/sync-history.entity';
import { Balance } from '../balances/entities/balance.entity';
import { RequestStatus } from '../../common/enums';
import { EventsGateway } from '../../common/events/events.gateway';

const HCM_BASE_URL = process.env.HCM_BASE_URL || 'http://localhost:4000';

@Processor('hcm-sync')
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(SyncHistory)
    private readonly syncHistoryRepo: Repository<SyncHistory>,
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    private readonly events: EventsGateway,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'sync-request':
        await this.handleSyncRequest(job);
        break;
      case 'rollback-request':
        await this.handleRollback(job);
        break;
      case 'cancel-request':
        await this.handleCancel(job);
        break;
      case 'batch-upsert':
        await this.handleBatchUpsert(job);
        break;
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async handleSyncRequest(job: Job): Promise<void> {
    const { requestId, employeeId, locationId, days } = job.data;

    try {
      const { data } = await axios.post(`${HCM_BASE_URL}/hcm/api/v1/time-off`, {
        employeeId,
        locationId,
        days,
        requestId,
      }, { timeout: 5000 });

      // HCM confirmed - update request status
      await this.requestRepo.update(requestId, {
        status: RequestStatus.WAITING_MANAGER_APPROVAL,
        hcmTransactionId: data.transactionId,
      });

      await this.logSync('INDIVIDUAL', requestId, employeeId, locationId, 'SUCCESS', job.attemptsMade);

      const updated = await this.requestRepo.findOne({ where: { id: requestId } });
      if (updated) this.events.emitRequestUpdate({ ...updated, event: 'synced' });
      this.logger.log(`Request ${requestId} synced with HCM. Transaction: ${data.transactionId}`);
    } catch (err: any) {
      const status = err.response?.status;

      // If HCM rejects with 400/409 (invalid dimensions or insufficient balance), it's a permanent failure
      if (status === 400 || status === 409) {
        await this.requestRepo.update(requestId, {
          status: RequestStatus.REJECTED,
          rejectionReason: err.response?.data?.message || 'Rejected by HCM',
        });

        // Restore local balance
        const balance = await this.balanceRepo.findOne({ where: { employeeId, locationId } });
        if (balance) {
          balance.usedDays -= days;
          balance.availableDays += days;
          await this.balanceRepo.save(balance);
        }

        await this.logSync('INDIVIDUAL', requestId, employeeId, locationId, 'FAILED', job.attemptsMade, err.response?.data?.message);

        this.logger.warn(`Request ${requestId} rejected by HCM: ${err.response?.data?.message}`);
        return; // Don't retry
      }

      // Transient error (5xx, timeout) - throw to trigger retry
      await this.logSync('INDIVIDUAL', requestId, employeeId, locationId, 'RETRYING', job.attemptsMade, err.message);
      this.logger.warn(`HCM sync failed for ${requestId} (attempt ${job.attemptsMade + 1}): ${err.message}`);
      throw err;
    }
  }

  private async handleRollback(job: Job): Promise<void> {
    const { requestId, employeeId, locationId, days } = job.data;

    try {
      await axios.post(`${HCM_BASE_URL}/hcm/api/v1/time-off/rollback`, {
        employeeId,
        locationId,
        days,
        requestId,
      }, { timeout: 5000 });

      await this.logSync('ROLLBACK', requestId, employeeId, locationId, 'SUCCESS', job.attemptsMade);
      this.logger.log(`Rollback completed for request ${requestId}`);
    } catch (err: any) {
      await this.logSync('ROLLBACK', requestId, employeeId, locationId, 'RETRYING', job.attemptsMade, err.message);
      this.logger.warn(`Rollback failed for ${requestId}: ${err.message}`);
      throw err;
    }
  }

  private async handleCancel(job: Job): Promise<void> {
    const { requestId, employeeId, locationId, days } = job.data;

    try {
      await axios.post(`${HCM_BASE_URL}/hcm/api/v1/time-off/rollback`, {
        employeeId,
        locationId,
        days,
        requestId,
      }, { timeout: 5000 });

      // HCM confirmed cancellation - now restore local balance and update status
      const request = await this.requestRepo.findOne({ where: { id: requestId } });
      if (request) {
        request.status = RequestStatus.CANCELLED;
        await this.requestRepo.save(request);
      }

      const balance = await this.balanceRepo.findOne({ where: { employeeId, locationId } });
      if (balance) {
        balance.usedDays -= days;
        balance.availableDays += days;
        await this.balanceRepo.save(balance);
      }

      await this.logSync('ROLLBACK', requestId, employeeId, locationId, 'SUCCESS', job.attemptsMade);
      if (request) this.events.emitRequestUpdate({ ...request, event: 'cancelled' });
      this.events.emitBalanceUpdate(employeeId, locationId, { availableDays: balance?.availableDays });
      this.logger.log(`Cancellation confirmed for request ${requestId}. Balance restored.`);
    } catch (err: any) {
      await this.logSync('ROLLBACK', requestId, employeeId, locationId, 'RETRYING', job.attemptsMade, err.message);
      throw err;
    }
  }

  private async handleBatchUpsert(job: Job): Promise<void> {
    const { employeeId, locationId, totalDays, usedDays } = job.data;

    try {
      const existing = await this.balanceRepo.findOne({ where: { employeeId, locationId } });

      if (existing) {
        // Smart upsert: preserve pending request deductions
        const pendingRequests = await this.requestRepo.find({
          where: { employeeId, locationId, status: RequestStatus.PENDING_SYNC },
        });
        const pendingDays = pendingRequests.reduce((sum, r) => sum + r.daysRequested, 0);

        existing.totalDays = totalDays;
        existing.usedDays = usedDays;
        existing.availableDays = totalDays - usedDays - pendingDays;
        existing.lastSyncedAt = new Date().toISOString();
        await this.balanceRepo.save(existing);
        this.events.emitBalanceUpdate(employeeId, locationId, { totalDays, usedDays, availableDays: existing.availableDays });
      } else {
        const balance = this.balanceRepo.create({
          employeeId,
          locationId,
          totalDays,
          usedDays,
          availableDays: totalDays - usedDays,
          lastSyncedAt: new Date().toISOString(),
        });
        await this.balanceRepo.save(balance);
        this.events.emitBalanceUpdate(employeeId, locationId, { totalDays, usedDays, availableDays: totalDays - usedDays });
      }

      await this.logSync('BATCH', null, employeeId, locationId, 'SUCCESS', 0);
    } catch (err: any) {
      await this.logSync('BATCH', null, employeeId, locationId, 'FAILED', job.attemptsMade, err.message);
      throw err;
    }
  }

  private async logSync(
    type: string,
    requestId: string | null,
    employeeId: string,
    locationId: string,
    status: string,
    attemptNumber: number,
    errorMessage?: string,
  ): Promise<void> {
    const entry = this.syncHistoryRepo.create({
      type,
      requestId: requestId ?? undefined,
      employeeId,
      locationId,
      status,
      attemptNumber,
      errorMessage,
    });
    await this.syncHistoryRepo.save(entry);
  }
}
