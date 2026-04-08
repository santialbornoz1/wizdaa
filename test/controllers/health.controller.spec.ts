import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { HealthController } from '../../src/modules/health/health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  const mockHealthCheckService = {
    check: jest.fn().mockImplementation((_checks) => {
      // Execute the check functions
      return Promise.resolve({
        status: 'ok',
        info: { database: { status: 'up' } },
      });
    }),
  };

  const mockDbIndicator = {
    pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: TypeOrmHealthIndicator, useValue: mockDbIndicator },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('should return healthy status', async () => {
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(mockHealthCheckService.check).toHaveBeenCalled();
  });
});
