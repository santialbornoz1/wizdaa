import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { TimeOffRequest } from '../timeoff/entities/timeoff-request.entity';
import { RequestStatus } from '../../common/enums';

@Injectable()
export class AutoCompleteService {
  private readonly logger = new Logger(AutoCompleteService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleAutoComplete() {
    const today = new Date().toISOString().split('T')[0];

    const expiredRequests = await this.requestRepo.find({
      where: {
        status: RequestStatus.APPROVED,
        endDate: LessThanOrEqual(today),
      },
    });

    if (expiredRequests.length === 0) return;

    for (const request of expiredRequests) {
      request.status = RequestStatus.COMPLETED;
      await this.requestRepo.save(request);
    }

    this.logger.log(`Auto-complete: ${expiredRequests.length} requests marked as COMPLETED`);
  }
}
