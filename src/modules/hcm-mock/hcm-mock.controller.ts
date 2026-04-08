import { Controller, Get, Post, Body, Param, HttpException, HttpStatus } from '@nestjs/common';
import { HcmMockService } from './hcm-mock.service';

@Controller('hcm/api/v1')
export class HcmMockController {
  constructor(private readonly hcmService: HcmMockService) {}

  @Get('balances/all')
  getAllBalances() {
    return this.hcmService.getAllBalances();
  }

  @Get('balances/:employeeId/:locationId')
  getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    const balance = this.hcmService.getBalance(employeeId, locationId);
    if (!balance) {
      throw new HttpException(
        { error: 'INVALID_DIMENSIONS', message: `No balance found for employee ${employeeId} at location ${locationId}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    return balance;
  }

  @Post('time-off')
  reserveTimeOff(
    @Body() body: { employeeId: string; locationId: string; days: number; requestId: string },
  ) {
    return this.hcmService.reserveTimeOff(body.employeeId, body.locationId, body.days, body.requestId);
  }

  @Post('time-off/rollback')
  rollbackTimeOff(
    @Body() body: { employeeId: string; locationId: string; days: number; requestId: string },
  ) {
    return this.hcmService.rollbackTimeOff(body.employeeId, body.locationId, body.days, body.requestId);
  }

  @Post('balances/:employeeId/:locationId/bonus')
  addBonus(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Body() body: { days: number; reason: string },
  ) {
    return this.hcmService.addBonus(employeeId, locationId, body.days, body.reason);
  }
}
