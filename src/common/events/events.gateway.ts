import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class EventsGateway {
  @WebSocketServer()
  server: Server;

  emitBalanceUpdate(employeeId: string, locationId: string, balance: Record<string, unknown>) {
    this.server.emit('balance:updated', { employeeId, locationId, ...balance });
  }

  emitRequestUpdate(request: Record<string, unknown>) {
    this.server.emit('request:updated', request);
  }

}
