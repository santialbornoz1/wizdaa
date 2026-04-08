import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { BalancesController } from '../../src/modules/balances/balances.controller';
import { BalancesService } from '../../src/modules/balances/balances.service';

const mockBalancesService = {
  getBalance: jest.fn(),
};

describe('BalancesController', () => {
  let controller: BalancesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BalancesController],
      providers: [
        { provide: BalancesService, useValue: mockBalancesService },
      ],
    }).compile();

    controller = module.get(BalancesController);
    jest.clearAllMocks();
  });

  describe('GET /balances', () => {
    it('should return balance for valid employee and location', async () => {
      const balance = {
        id: 'bal-1',
        employeeId: 'maria.garcia',
        locationId: 'buenos-aires',
        totalDays: 20,
        usedDays: 5,
        availableDays: 15,
      };
      mockBalancesService.getBalance.mockResolvedValueOnce(balance);

      const result = await controller.getBalance('maria.garcia', 'buenos-aires');
      expect(result).toEqual(balance);
    });

    it('should throw 400 if employeeId is missing', async () => {
      await expect(controller.getBalance('', 'buenos-aires')).rejects.toThrow(HttpException);
    });

    it('should throw 400 if locationId is missing', async () => {
      await expect(controller.getBalance('maria.garcia', '')).rejects.toThrow(HttpException);
    });

    it('should throw 404 if balance not found', async () => {
      mockBalancesService.getBalance.mockResolvedValueOnce(null);

      await expect(
        controller.getBalance('unknown.user', 'buenos-aires'),
      ).rejects.toThrow(HttpException);
    });
  });
});
