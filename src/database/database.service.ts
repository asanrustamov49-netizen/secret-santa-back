import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';

/** Anything that can run a query: the pool, or a client inside a transaction */
export interface Queryable {
  query<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

/**
 * Thin wrapper around a node-postgres pool. Plain SQL with $1, $2… parameters —
 * never build queries by concatenating user input.
 */
@Injectable()
export class DatabaseService
  implements Queryable, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseService.name);

  private readonly pool = new Pool({
    connectionString: env.databaseUrl,
    max: 10,
    ssl: env.databaseSsl
      ? env.databaseSslCa
        ? { ca: env.databaseSslCa } // verified against Supabase's CA
        : { rejectUnauthorized: false } // encrypted, certificate not pinned
      : undefined,
  });

  constructor() {
    // An idle client dropping (network blip, pooler restart) must not crash the process
    this.pool.on('error', (error) =>
      this.logger.error(`Idle database client error: ${error.message}`),
    );
  }

  async onModuleInit() {
    try {
      await this.pool.query('select 1');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Cannot connect to PostgreSQL — check DATABASE_URL / DATABASE_SSL in .env. ${reason}`,
      );
      throw new Error('Database connection failed', { cause: error });
    }
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, params);
    return result.rows;
  }

  /** First row or null */
  async one<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** Runs `work` in BEGIN … COMMIT; any thrown error rolls everything back. */
  async transaction<R>(work: (tx: Queryable) => Promise<R>): Promise<R> {
    const client: PoolClient = await this.pool.connect();
    const tx: Queryable = {
      query: async <T extends QueryResultRow>(
        text: string,
        params?: unknown[],
      ) => (await client.query<T>(text, params)).rows,
    };

    try {
      await client.query('begin');
      const result = await work(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
