import { EventsGateway } from '../src/common/events/events.gateway';

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let mockServer: { emit: jest.Mock };

  beforeEach(() => {
    gateway = new EventsGateway();
    mockServer = { emit: jest.fn() };
    (gateway as any).server = mockServer;
  });

  it('should emit balance:updated event with correct payload', () => {
    gateway.emitBalanceUpdate('maria.garcia', 'buenos-aires', {
      totalDays: 20,
      usedDays: 5,
      availableDays: 15,
    });

    expect(mockServer.emit).toHaveBeenCalledWith('balance:updated', {
      employeeId: 'maria.garcia',
      locationId: 'buenos-aires',
      totalDays: 20,
      usedDays: 5,
      availableDays: 15,
    });
  });

  it('should emit request:updated event with correct payload', () => {
    const request = { id: 'req-1', status: 'APPROVED', event: 'approved' };
    gateway.emitRequestUpdate(request);

    expect(mockServer.emit).toHaveBeenCalledWith('request:updated', request);
  });
});
