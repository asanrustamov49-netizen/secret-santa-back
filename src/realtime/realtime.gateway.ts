import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { Server, Socket } from 'socket.io';
import { Public } from '../common/auth/public.decorator';
import { env } from '../config/env';
import { RealtimeTicketService } from './realtime-ticket.service';
import {
  eventRoom,
  type RealtimeAck,
  RealtimeCommand,
  userRoom,
} from './realtime.events';
import { RealtimeService } from './realtime.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Browsers always send Origin on a WebSocket; it must be one of our frontends.
 * (CORS itself only covers the HTTP long-polling fallback.) Non-browser clients send
 * none — they still need a valid ticket, like everyone else.
 */
function allowRequest(
  req: IncomingMessage,
  callback: (error: string | null | undefined, success: boolean) => void,
) {
  const origin = req.headers.origin;
  callback(null, !origin || env.corsOrigins.includes(origin));
}

interface SocketData {
  userId: string;
}

type AppSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

/**
 * The realtime channel: a notification bus on top of the REST API.
 * - Handshake: a ticket from GET /api/realtime/ticket (see RealtimeTicketService), else refused
 * - Rooms: user:<id> (joined automatically) and event:<id> (only after a membership check)
 * - Messages: see realtime.events.ts — "event X changed", never the change itself
 *
 * @Public: this is not an HTTP route, so the global JwtAuthGuard doesn't apply —
 * sockets are authenticated at the handshake instead.
 */
@Public()
@WebSocketGateway({
  cors: { origin: env.corsOrigins, credentials: false },
  allowRequest,
  serveClient: false,
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Realtime');

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly tickets: RealtimeTicketService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
    server.use((socket: AppSocket, next) => {
      const ticket: unknown = (socket.handshake.auth as { ticket?: unknown })
        ?.ticket;
      this.tickets
        .verify(ticket)
        .then((userId) => {
          if (!userId) {
            this.logger.warn('Connection rejected: no valid ticket');
            return next(new Error('unauthorized'));
          }
          socket.data.userId = userId;
          next();
        })
        .catch(() => next(new Error('unavailable')));
    });
  }

  async handleConnection(socket: AppSocket) {
    await socket.join(userRoom(socket.data.userId));
    this.logger.log(`Socket connected (${this.count()} open)`);
    // Socket.IO's own reason ("transport close", "client namespace disconnect"…) — nothing about the user
    socket.on('disconnect', (reason) =>
      this.logger.log(`Socket disconnected: ${reason} (${this.count()} open)`),
    );
  }

  /** Start listening to an event — only one I take part in */
  @SubscribeMessage(RealtimeCommand.joinEvent)
  async joinEvent(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck> {
    const eventId = (body as { eventId?: unknown } | null)?.eventId;
    if (typeof eventId !== 'string' || !UUID.test(eventId))
      return { ok: false };

    if (!(await this.realtime.canJoin(socket.data.userId, eventId))) {
      this.logger.warn('Room join rejected: not a participant');
      return { ok: false };
    }
    await socket.join(eventRoom(eventId));
    return { ok: true };
  }

  @SubscribeMessage(RealtimeCommand.leaveEvent)
  async leaveEvent(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck> {
    const eventId = (body as { eventId?: unknown } | null)?.eventId;
    if (typeof eventId !== 'string' || !UUID.test(eventId))
      return { ok: false };
    await socket.leave(eventRoom(eventId));
    return { ok: true };
  }

  /** Open sockets on this instance — a number, never who */
  private count() {
    return this.server?.engine?.clientsCount ?? 0;
  }
}
