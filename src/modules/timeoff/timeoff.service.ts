import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TimeOffRequest } from './entities/timeoff-request.entity';
import { Balance } from '../balances/entities/balance.entity';
import { RequestStatus } from '../../common/enums';
import { CreateTimeOffRequestDto } from './dto/create-request.dto';
import { EventsGateway } from '../../common/events/events.gateway';

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    private readonly dataSource: DataSource,
    @InjectQueue('hcm-sync')
    private readonly hcmSyncQueue: Queue,
    private readonly events: EventsGateway,
  ) {}

  async createRequest(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    // Idempotency check: if key provided and request already exists, return it
    if (dto.idempotencyKey) {
      const existing = await this.requestRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.log(`Idempotent request detected (key: ${dto.idempotencyKey}). Returning existing request ${existing.id}.`);
        return existing;
      }
    }

    // Transactional Outbox: atomic insert + balance deduction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Pre-check: sanity validation
      const balance = await queryRunner.manager.findOne(Balance, {
        where: { employeeId: dto.employeeId, locationId: dto.locationId },
      });

      if (!balance) {
        throw new HttpException(
          `No balance found for ${dto.employeeId}@${dto.locationId}`,
          HttpStatus.NOT_FOUND,
        );
      }

      if (balance.availableDays < dto.daysRequested) {
        throw new HttpException(
          {
            error: 'INSUFFICIENT_BALANCE',
            available: balance.availableDays,
            requested: dto.daysRequested,
          },
          HttpStatus.CONFLICT,
        );
      }

      // 1. Insert request as PENDING_SYNC
      const request = queryRunner.manager.create(TimeOffRequest, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        type: dto.type || 'VACATION',
        status: RequestStatus.PENDING_SYNC,
        idempotencyKey: dto.idempotencyKey,
      });
      const saved = await queryRunner.manager.save(request);

      // 2. Deduct from local balance
      balance.usedDays += dto.daysRequested;
      balance.availableDays -= dto.daysRequested;
      await queryRunner.manager.save(balance);

      await queryRunner.commitTransaction();

      // Post-commit: enqueue HCM sync (fire-and-forget)
      await this.hcmSyncQueue.add('sync-request', {
        requestId: saved.id,
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        days: dto.daysRequested,
      }, {
        attempts: 10,
        backoff: { type: 'exponential', delay: 2000 },
      });

      this.logger.log(`Request ${saved.id} created as PENDING_SYNC. HCM sync enqueued.`);
      this.events.emitRequestUpdate({ ...saved, event: 'created' });
      return saved;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getMyRequests(employeeId: string, status?: string): Promise<TimeOffRequest[]> {
    const where: Record<string, string> = { employeeId };
    if (status) {
      where.status = status;
    }
    return this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async getPendingManagerRequests(): Promise<Array<TimeOffRequest & { isConsistentWithHcm?: boolean }>> {
    const requests = await this.requestRepo.find({
      where: { status: RequestStatus.WAITING_MANAGER_APPROVAL },
      order: { createdAt: 'ASC' },
    });

    // For manager view, flag HCM consistency
    return requests.map((r) => ({
      ...r,
      isConsistentWithHcm: r.hcmTransactionId !== null,
    }));
  }

  async approveRequest(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });

    if (!request) {
      throw new HttpException('Request not found', HttpStatus.NOT_FOUND);
    }

    if (request.status !== RequestStatus.WAITING_MANAGER_APPROVAL) {
      throw new HttpException(
        `Cannot approve request in status ${request.status}. Must be WAITING_MANAGER_APPROVAL.`,
        HttpStatus.CONFLICT,
      );
    }

    request.status = RequestStatus.APPROVED;
    const saved = await this.requestRepo.save(request);

    this.logger.log(`Request ${id} approved by manager`);
    this.events.emitRequestUpdate({ ...saved, event: 'approved' });
    return saved;
  }

  async rejectRequest(id: string, reason?: string): Promise<TimeOffRequest> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const request = await queryRunner.manager.findOne(TimeOffRequest, { where: { id } });

      if (!request) {
        throw new HttpException('Request not found', HttpStatus.NOT_FOUND);
      }

      if (
        request.status !== RequestStatus.WAITING_MANAGER_APPROVAL &&
        request.status !== RequestStatus.PENDING_SYNC
      ) {
        throw new HttpException(
          `Cannot reject request in status ${request.status}`,
          HttpStatus.CONFLICT,
        );
      }

      const hadHcmConfirmation = request.status === RequestStatus.WAITING_MANAGER_APPROVAL;

      request.status = RequestStatus.REJECTED;
      request.rejectionReason = reason || 'Rejected by manager';
      await queryRunner.manager.save(request);

      // Restore local balance
      const balance = await queryRunner.manager.findOne(Balance, {
        where: { employeeId: request.employeeId, locationId: request.locationId },
      });
      if (balance) {
        balance.usedDays -= request.daysRequested;
        balance.availableDays += request.daysRequested;
        await queryRunner.manager.save(balance);
      }

      await queryRunner.commitTransaction();

      // Post-commit: enqueue HCM rollback if needed (fire-and-forget)
      if (hadHcmConfirmation) {
        await this.hcmSyncQueue.add('rollback-request', {
          requestId: request.id,
          employeeId: request.employeeId,
          locationId: request.locationId,
          days: request.daysRequested,
        }, {
          attempts: 10,
          backoff: { type: 'exponential', delay: 2000 },
        });
      }

      this.logger.log(`Request ${id} rejected. Balance restored. ${hadHcmConfirmation ? 'HCM rollback enqueued.' : ''}`);
      this.events.emitRequestUpdate({ ...request, event: 'rejected' });
      return request;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async cancelRequest(id: string): Promise<TimeOffRequest> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const request = await queryRunner.manager.findOne(TimeOffRequest, { where: { id } });

      if (!request) {
        throw new HttpException('Request not found', HttpStatus.NOT_FOUND);
      }

      const cancellableStatuses = [
        RequestStatus.PENDING_SYNC,
        RequestStatus.WAITING_MANAGER_APPROVAL,
        RequestStatus.APPROVED,
      ];

      if (!cancellableStatuses.includes(request.status)) {
        throw new HttpException(
          `Cannot cancel request in status ${request.status}`,
          HttpStatus.CONFLICT,
        );
      }

      request.status = RequestStatus.CANCELLATION_PENDING;
      await queryRunner.manager.save(request);

      await queryRunner.commitTransaction();

      // Post-commit: enqueue HCM cancellation (fire-and-forget)
      // Days NOT restored until HCM confirms
      await this.hcmSyncQueue.add('cancel-request', {
        requestId: request.id,
        employeeId: request.employeeId,
        locationId: request.locationId,
        days: request.daysRequested,
      }, {
        attempts: 10,
        backoff: { type: 'exponential', delay: 2000 },
      });

      this.logger.log(`Request ${id} cancellation initiated`);
      this.events.emitRequestUpdate({ ...request, event: 'cancellation_pending' });
      return request;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getRequestById(id: string): Promise<TimeOffRequest | null> {
    return this.requestRepo.findOne({ where: { id } });
  }
}
