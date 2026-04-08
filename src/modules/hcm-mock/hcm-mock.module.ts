import { Module, Global } from '@nestjs/common';
import { HcmMockController } from './hcm-mock.controller';
import { HcmAdminController } from './hcm-admin.controller';
import { HcmMockService } from './hcm-mock.service';

@Global()
@Module({
  controllers: [HcmMockController, HcmAdminController],
  providers: [HcmMockService],
  exports: [HcmMockService],
})
export class HcmMockModule {}
