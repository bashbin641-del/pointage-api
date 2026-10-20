import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';

type DependencyState = 'up' | 'down' | 'not_configured';

export interface InfrastructureHealth {
  status: 'ok' | 'degraded';
  dependencies: {
    redis: DependencyState;
    supabase: DependencyState;
  };
}

@Injectable()
export class InfrastructureService implements OnApplicationShutdown {
  private readonly redisUrl = process.env.REDIS_URL;
  private readonly supabaseUrl = process.env.SUPABASE_URL;
  private readonly supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  private redisClient?: RedisClientType;
  private supabaseClient?: SupabaseClient;

  async health(): Promise<InfrastructureHealth> {
    const [redis, supabase] = await Promise.all([
      this.checkRedis(),
      this.checkSupabase(),
    ]);

    return {
      status: redis === 'up' && supabase === 'up' ? 'ok' : 'degraded',
      dependencies: { redis, supabase },
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
  }

  private async checkRedis(): Promise<DependencyState> {
    if (!this.redisUrl) {
      return 'not_configured';
    }

    try {
      const client = await this.getRedisClient();
      return (await client.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  private async checkSupabase(): Promise<DependencyState> {
    if (!this.supabaseUrl || !this.supabaseSecretKey) {
      return 'not_configured';
    }

    try {
      const { error } = await this.getSupabaseClient().auth.admin.listUsers({
        page: 1,
        perPage: 1,
      });
      return error ? 'down' : 'up';
    } catch {
      return 'down';
    }
  }

  async getRedisClient(): Promise<RedisClientType> {
    if (!this.redisUrl) {
      throw new Error('REDIS_URL_MISSING');
    }

    if (!this.redisClient) {
      this.redisClient = createClient({
        url: this.redisUrl,
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000),
        },
      });

      this.redisClient.on('error', () => undefined);
    }

    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }

    return this.redisClient;
  }

  getSupabaseClient(): SupabaseClient {
    if (!this.supabaseClient) {
      this.supabaseClient = createSupabaseClient(
        this.supabaseUrl as string,
        this.supabaseSecretKey as string,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
        },
      );
    }

    return this.supabaseClient;
  }
}
