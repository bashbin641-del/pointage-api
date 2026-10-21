import {
  Injectable,
  Logger,
  MessageEvent,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisClientType } from 'redis';
import { Observable, Subject, filter, interval, map, merge, of } from 'rxjs';
import { InfrastructureService } from './infrastructure.service';

const realtimeChannel = 'pointage:events:v1';

export type RealtimeEventType =
  | 'administrator.updated'
  | 'attendance.recorded'
  | 'attendance.updated'
  | 'attendance.deleted'
  | 'employee.created'
  | 'employee.updated'
  | 'employee.deleted'
  | 'site.created'
  | 'site.deleted'
  | 'terminal.activated'
  | 'terminal.created'
  | 'terminal.deleted'
  | 'terminal.session_revoked';

export type RealtimeEvent = {
  id: string;
  type: RealtimeEventType;
  occurredAt: string;
  employeeId?: string;
  terminalId?: string;
};

@Injectable()
export class RealtimeService implements OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events = new Subject<RealtimeEvent>();
  private subscriber?: RedisClientType;
  private startPromise?: Promise<void>;

  constructor(private readonly infrastructure: InfrastructureService) {}

  async publish(event: Omit<RealtimeEvent, 'id' | 'occurredAt'>): Promise<void> {
    const message: RealtimeEvent = {
      ...event,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    };

    try {
      const redis = await this.infrastructure.getRedisClient();
      await redis.publish(realtimeChannel, JSON.stringify(message));
    } catch {
      // A realtime notification must never roll back an already confirmed operation.
      this.logger.warn(`Realtime event could not be published: ${event.type}`);
    }
  }

  async stream(predicate: (event: RealtimeEvent) => boolean): Promise<Observable<MessageEvent>> {
    await this.ensureSubscriber();

    const connected = of<MessageEvent>({
      type: 'connected',
      retry: 2_000,
      data: { connectedAt: new Date().toISOString() },
    });
    const updates = this.events.pipe(
      filter(predicate),
      map((event): MessageEvent => ({
        id: event.id,
        type: event.type,
        data: event,
      })),
    );
    const heartbeats = interval(15_000).pipe(
      map((): MessageEvent => ({
        type: 'heartbeat',
        data: { serverTime: new Date().toISOString() },
      })),
    );

    return merge(connected, updates, heartbeats);
  }

  async onApplicationShutdown(): Promise<void> {
    this.events.complete();
    if (this.subscriber?.isOpen) {
      await this.subscriber.quit();
    }
  }

  private async ensureSubscriber(): Promise<void> {
    if (this.subscriber?.isReady) return;
    if (!this.startPromise) {
      this.startPromise = this.startSubscriber().catch((error: unknown) => {
        this.startPromise = undefined;
        this.subscriber = undefined;
        throw error;
      });
    }

    try {
      await this.startPromise;
    } catch {
      throw new ServiceUnavailableException('TEMPS_REEL_INDISPONIBLE');
    }
  }

  private async startSubscriber(): Promise<void> {
    const redis = await this.infrastructure.getRedisClient();
    const subscriber = redis.duplicate() as RedisClientType;
    subscriber.on('error', () => undefined);
    await subscriber.connect();
    await subscriber.subscribe(realtimeChannel, (payload) => {
      try {
        const event = JSON.parse(payload) as RealtimeEvent;
        if (event.id && event.type && event.occurredAt) this.events.next(event);
      } catch {
        this.logger.warn('An invalid realtime event was ignored.');
      }
    });
    this.subscriber = subscriber;
  }
}
