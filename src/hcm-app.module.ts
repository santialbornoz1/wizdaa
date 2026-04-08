import { Module } from '@nestjs/common';
import { HcmMockModule } from './modules/hcm-mock/hcm-mock.module';

@Module({
  imports: [HcmMockModule],
})
export class HcmAppModule {}
