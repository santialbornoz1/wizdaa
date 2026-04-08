import { Controller, Post, Req, Res, HttpStatus, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Request, Response } from 'express';
import { parser as jsonParser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { chain } from 'stream-chain';

@Controller('api/v1/sync')
export class SyncController {
  private readonly logger = new Logger(SyncController.name);

  constructor(
    @InjectQueue('hcm-sync')
    private readonly hcmSyncQueue: Queue,
  ) {}

  @Post('batch')
  async batchSync(@Req() req: Request, @Res() res: Response) {
    // Respond immediately with 202 Accepted
    res.status(HttpStatus.ACCEPTED).json({
      message: 'Batch sync accepted. Processing in background.',
      timestamp: new Date().toISOString(),
    });

    let count = 0;

    try {
      const pipeline = chain([
        req,
        jsonParser(),
        streamArray(),
      ]);

      pipeline.on('data', async ({ value }: { value: { employeeId: string; locationId: string; totalDays: number; usedDays: number } }) => {
        await this.hcmSyncQueue.add('batch-upsert', {
          employeeId: value.employeeId,
          locationId: value.locationId,
          totalDays: value.totalDays,
          usedDays: value.usedDays,
        });
        count++;
      });

      pipeline.on('end', () => {
        this.logger.log(`Batch sync completed: ${count} records enqueued`);
      });

      pipeline.on('error', (err: Error) => {
        this.logger.error(`Batch sync stream error: ${err.message}`);
      });
    } catch (err: any) {
      this.logger.error(`Batch sync failed: ${err.message}`);
    }
  }
}
