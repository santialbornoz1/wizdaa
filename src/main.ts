import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Queue } from 'bullmq';
import { join } from 'path';
import { AppModule } from './app.module';
import { HcmAppModule } from './hcm-app.module';
import { BalancesService } from './modules/balances/balances.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // --- Main App (ExampleHR) on port 3000 ---
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // Disable for streaming support on batch endpoint
  });

  // Re-enable JSON body parser for non-streaming routes (skip batch endpoint)
  const express = await import('express');
  app.use((req: any, res: any, next: any) => {
    if (req.originalUrl === '/api/v1/sync/batch') {
      return next();
    }
    express.json({ limit: '1mb' })(req, res, next);
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableCors();
  app.useStaticAssets(join(__dirname, '..', '..', 'public'), { prefix: '/' });

  // Bull Board setup
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  const hcmSyncQueue = new Queue('hcm-sync', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
  });

  createBullBoard({
    queues: [new BullMQAdapter(hcmSyncQueue) as any],
    serverAdapter,
  });

  app.use('/admin/queues', serverAdapter.getRouter());

  await app.listen(3000);
  logger.log('ExampleHR app running on http://localhost:3000');
  logger.log('Bull Board available at http://localhost:3000/admin/queues');

  // Seed initial balances from HCM Mock
  await seedBalances(app);

  // --- HCM Mock App on port 4000 ---
  const hcmApp = await NestFactory.create<NestExpressApplication>(HcmAppModule);
  hcmApp.enableCors();
  hcmApp.useStaticAssets(join(__dirname, '..', '..', 'public', 'hcm'), { prefix: '/' });

  await hcmApp.listen(4000);
  logger.log('HCM Mock running on http://localhost:4000');
}

async function seedBalances(app: NestExpressApplication) {
  const logger = new Logger('Seed');

  try {
    const balancesService = app.get(BalancesService);

    // Seed from HCM Mock initial data
    await balancesService.upsertFromHcm('maria.garcia', 'buenos-aires', 20, 0);
    await balancesService.upsertFromHcm('james.smith', 'buenos-aires', 15, 0);
    await balancesService.upsertFromHcm('laura.chen', 'new-york', 10, 0);
    await balancesService.upsertFromHcm('carlos.lopez', 'london', 25, 0);

    logger.log('Initial balances seeded successfully');
  } catch (err: any) {
    logger.error(`Seed failed: ${err.message}`);
  }
}

bootstrap();
