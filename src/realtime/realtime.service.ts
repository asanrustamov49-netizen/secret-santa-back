import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { DatabaseService } from '../database/database.service';
import {
  ChatRealtimeEvent,
  type ChatRealtimePayload,
  eventRoom,
  type RealtimeEventName,
  type RealtimePayload,
  userRoom,
} from './realtime.events';

/**
 * Sends "this changed" notifications. Called by controllers *after* the REST action
 * succeeded — the action itself never depends on it: a failure here is logged and
 * swallowed, and clients catch up on their next refetch anyway.
 *
 * Everything goes through rooms (server.to(room)), so a Redis adapter can later spread
 * it across several API instances without changing any caller.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server?: Server;

  constructor(private readonly db: DatabaseService) {}

  /** Set by the gateway once Socket.IO is up */
  attach(server: Server) {
    this.server = server;
  }

  /** Everyone listening to this event */
  toEvent(eventId: string, event: RealtimeEventName) {
    this.emit(eventRoom(eventId), event, eventId);
  }

  /**
   * A new chat message, to everyone listening to this event. Only members are in the
   * room (joins are membership-checked, removals take people out), and the message is
   * exactly what GET /events/:id/messages returns to each of them.
   */
  chatMessage(eventId: string, message: unknown) {
    if (!this.server) return;
    try {
      const payload: ChatRealtimePayload = { eventId, message };
      this.server
        .to(eventRoom(eventId))
        .emit(ChatRealtimeEvent.message, payload);
    } catch (error) {
      this.logger.warn(
        `Realtime emit failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
    }
  }

  /** All tabs of one user */
  toUser(userId: string, event: RealtimeEventName, eventId: string) {
    this.emit(userRoom(userId), event, eventId);
  }

  /** Every event this user takes part in — e.g. their profile or wishlist changed */
  async toUserEvents(userId: string, event: RealtimeEventName) {
    try {
      const rows = await this.db.query<{ eventId: string }>(
        `select event_id as "eventId" from participants where user_id = $1`,
        [userId],
      );
      for (const { eventId } of rows) this.toEvent(eventId, event);
    } catch (error) {
      this.logger.warn(
        `Realtime fan-out failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
    }
  }

  /** The user left or was removed: their open tabs stop hearing about this event */
  removeFromEvent(userId: string, eventId: string) {
    this.server?.in(userRoom(userId)).socketsLeave(eventRoom(eventId));
  }

  /** The event is gone: nobody listens to it any more */
  closeEvent(eventId: string) {
    this.server?.in(eventRoom(eventId)).socketsLeave(eventRoom(eventId));
  }

  /** Whether this user may listen to this event: the same rule as EventsService.get */
  async canJoin(userId: string, eventId: string): Promise<boolean> {
    const [row] = await this.db.query<{ ok: boolean }>(
      `select true as ok from participants where event_id = $1 and user_id = $2`,
      [eventId, userId],
    );
    return Boolean(row?.ok);
  }

  private emit(room: string, event: RealtimeEventName, eventId: string) {
    if (!this.server) return;
    try {
      const payload: RealtimePayload = { eventId };
      this.server.to(room).emit(event, payload);
    } catch (error) {
      this.logger.warn(
        `Realtime emit failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
    }
  }
}
