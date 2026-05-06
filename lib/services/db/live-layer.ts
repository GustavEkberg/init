import 'server-only';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, Layer, Redacted } from 'effect';
import { NodeContext } from '@effect/platform-node';
import { drizzle, type EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import * as schema from './schema';
import { isLocalDbUrl, stripSslMode } from './url';

const DatabaseUrl = Config.redacted('DATABASE_URL').pipe(
  Config.map(url => Redacted.make(stripSslMode(Redacted.value(url))))
);

// PostgreSQL connection layer (internal)
const PgLive = PgClient.layerConfig({
  url: DatabaseUrl,
  ssl: DatabaseUrl.pipe(Config.map(url => !isLocalDbUrl(Redacted.value(url))))
});

// Service definition
// v4 migration: Change Effect.Service to ServiceMap.Service
export class Db extends Effect.Service<Db>()('@app/Db', {
  effect: Effect.gen(function* () {
    const client = yield* PgClient.PgClient;
    return drizzle(client, { schema });
  })
}) {
  // Base layer (has unsatisfied PgClient dependency)
  static layer = this.Default;

  // Composed layer with all dependencies satisfied
  static Live = this.layer.pipe(Layer.provideMerge(PgLive), Layer.provide(NodeContext.layer));
}

// Type export for convenience
export type Database = EffectPgDatabase<typeof schema>;
