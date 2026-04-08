import { Controller, Post, Get, Body } from '@nestjs/common';
import { HcmMockService } from './hcm-mock.service';

@Controller('hcm/admin')
export class HcmAdminController {
  constructor(private readonly hcmService: HcmMockService) {}

  @Post('downtime')
  toggleDowntime(@Body() body: { enabled: boolean }) {
    this.hcmService.setDowntime(body.enabled);
    return { downtime: body.enabled };
  }

  @Post('latency')
  setLatency(@Body() body: { ms: number }) {
    this.hcmService.setLatency(body.ms);
    return { latency: body.ms };
  }

  @Get('status')
  getStatus() {
    return {
      isDown: this.hcmService.isDowntime(),
      balances: this.hcmService.getAllBalancesAdmin(),
      transactions: this.hcmService.getTransactions(),
    };
  }
}
