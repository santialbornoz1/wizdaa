import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { BalancesService } from './balances.service';

@Controller('api/v1/balances')
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get()
  async getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
  ) {
    if (!employeeId || !locationId) {
      throw new HttpException(
        'employeeId and locationId are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const balance = await this.balancesService.getBalance(employeeId, locationId);

    if (!balance) {
      throw new HttpException(
        `No balance found for employee ${employeeId} at location ${locationId}`,
        HttpStatus.NOT_FOUND,
      );
    }

    return balance;
  }
}
