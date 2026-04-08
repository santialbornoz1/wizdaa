import { Controller, Get, Post, Patch, Param, Body, Query, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffService } from './timeoff.service';
import { CreateTimeOffRequestDto } from './dto/create-request.dto';
import { SyncHistory } from '../sync/entities/sync-history.entity';

@Controller('api/v1')
export class TimeOffController {
  constructor(
    private readonly timeoffService: TimeOffService,
    @InjectRepository(SyncHistory)
    private readonly syncHistoryRepo: Repository<SyncHistory>,
  ) {}

  // --- Employee Endpoints ---

  @Post('requests')
  async createRequest(
    @Body() dto: CreateTimeOffRequestDto,
    @Headers('idempotency-key') headerKey?: string,
  ) {
    // Header takes precedence, body is fallback
    if (headerKey && !dto.idempotencyKey) {
      dto.idempotencyKey = headerKey;
    }
    return this.timeoffService.createRequest(dto);
  }

  @Get('requests/me')
  async getMyRequests(
    @Query('employeeId') employeeId: string,
    @Query('status') status?: string,
  ) {
    if (!employeeId) {
      throw new HttpException('employeeId is required', HttpStatus.BAD_REQUEST);
    }
    return this.timeoffService.getMyRequests(employeeId, status);
  }

  @Get('activity')
  async getActivity(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
  ) {
    if (!employeeId) {
      throw new HttpException('employeeId is required', HttpStatus.BAD_REQUEST);
    }

    const requests = await this.timeoffService.getMyRequests(employeeId);
    const syncEvents = await this.syncHistoryRepo.find({
      where: { employeeId, ...(locationId ? { locationId } : {}) },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    // Merge into unified timeline
    const activity = [
      ...requests.map((r) => ({
        type: 'request' as const,
        date: r.createdAt,
        data: r,
      })),
      ...syncEvents
        .filter((s) => s.type === 'BATCH' && s.status === 'SUCCESS')
        .map((s) => ({
          type: 'sync' as const,
          date: s.createdAt,
          data: s,
        })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return activity;
  }

  @Patch('requests/:id/cancel')
  async cancelRequest(@Param('id') id: string) {
    return this.timeoffService.cancelRequest(id);
  }

  // --- Manager Endpoints ---

  @Get('admin/requests/pending')
  async getPendingRequests() {
    return this.timeoffService.getPendingManagerRequests();
  }

  @Patch('admin/requests/:id/approve')
  async approveRequest(@Param('id') id: string) {
    return this.timeoffService.approveRequest(id);
  }

  @Patch('admin/requests/:id/reject')
  async rejectRequest(
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.timeoffService.rejectRequest(id, body?.reason);
  }
}
