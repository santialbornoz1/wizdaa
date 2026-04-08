import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AutoCompleteService } from '../src/modules/sync/auto-complete.service';
import { TimeOffRequest } from '../src/modules/timeoff/entities/timeoff-request.entity';
import { RequestStatus } from '../src/common/enums';
import { testDbModule } from './helpers/test-db.helper';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from '../src/modules/balances/entities/balance.entity';
import { SyncHistory } from '../src/modules/sync/entities/sync-history.entity';

describe('AutoCompleteService', () => {
  let module: TestingModule;
  let service: AutoCompleteService;
  let requestRepo: Repository<TimeOffRequest>;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        testDbModule(),
        TypeOrmModule.forFeature([TimeOffRequest, Balance, SyncHistory]),
      ],
      providers: [AutoCompleteService],
    }).compile();

    service = module.get(AutoCompleteService);
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
  });

  afterEach(async () => {
    await module.close();
  });

  it('should mark expired APPROVED requests as COMPLETED', async () => {
    await requestRepo.save({
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      startDate: '2026-01-01',
      endDate: '2026-01-05',
      daysRequested: 4,
      type: 'VACATION',
      status: RequestStatus.APPROVED,
    });

    await service.handleAutoComplete();

    const requests = await requestRepo.find();
    expect(requests[0].status).toBe(RequestStatus.COMPLETED);
  });

  it('should NOT mark future APPROVED requests as COMPLETED', async () => {
    await requestRepo.save({
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      startDate: '2027-12-01',
      endDate: '2027-12-10',
      daysRequested: 7,
      type: 'VACATION',
      status: RequestStatus.APPROVED,
    });

    await service.handleAutoComplete();

    const requests = await requestRepo.find();
    expect(requests[0].status).toBe(RequestStatus.APPROVED);
  });

  it('should NOT touch requests in other statuses', async () => {
    await requestRepo.save({
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      startDate: '2026-01-01',
      endDate: '2026-01-05',
      daysRequested: 4,
      type: 'VACATION',
      status: RequestStatus.PENDING_SYNC,
    });

    await service.handleAutoComplete();

    const requests = await requestRepo.find();
    expect(requests[0].status).toBe(RequestStatus.PENDING_SYNC);
  });
});
