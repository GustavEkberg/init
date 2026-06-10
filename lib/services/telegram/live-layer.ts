import 'server-only';
import { Config, Context, Effect, Layer, Redacted } from 'effect';
import { retryPolicy } from '../retry';
import { TelegramConfigError, TelegramSendError } from './errors';

const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;

const splitIntoChunks = (str: string, chunkSize: number): string[] => {
  const length = Math.ceil(str.length / chunkSize);
  return Array.from({ length }, (_, i) => str.slice(i * chunkSize, i * chunkSize + chunkSize));
};

// Configuration service (internal)
class TelegramConfig extends Context.Tag('@app/TelegramConfig')<
  TelegramConfig,
  {
    readonly botToken: Redacted.Redacted<string>;
    readonly chatId: string;
  }
>() {}

const TelegramConfigLive = Layer.effect(
  TelegramConfig,
  Effect.gen(function* () {
    const botToken = yield* Config.redacted('TELEGRAM_BOT_TOKEN').pipe(
      Effect.mapError(() => new TelegramConfigError({ message: 'TELEGRAM_BOT_TOKEN not found' }))
    );
    const chatId = yield* Config.string('TELEGRAM_CHAT_ID').pipe(
      Effect.mapError(() => new TelegramConfigError({ message: 'TELEGRAM_CHAT_ID not found' }))
    );

    return { botToken, chatId };
  })
);

// Service definition
// v4 migration: Change Effect.Service to ServiceMap.Service
export class Telegram extends Effect.Service<Telegram>()('@app/Telegram', {
  effect: Effect.gen(function* () {
    const config = yield* TelegramConfig;

    const sendMessage = (message: string) =>
      Effect.tryPromise({
        // `signal` aborts the fetch on interruption (e.g. timeout below)
        try: async signal => {
          const endpoint = `https://api.telegram.org/bot${Redacted.value(config.botToken)}/sendMessage`;
          const response = await fetch(endpoint, {
            method: 'POST',
            signal,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              chat_id: config.chatId,
              disable_web_page_preview: true,
              text: message
            })
          });
          if (!response.ok) {
            const body = await response.text();
            throw new Error(`Telegram API error: ${response.status} - ${body}`);
          }
        },
        catch: error =>
          new TelegramSendError({
            message: error instanceof Error ? error.message : 'Unknown error',
            cause: error
          })
      }).pipe(
        // Telegram rate-limits (429); jittered exponential backoff (max 3 retries).
        // Duplicate messages on a lost response are acceptable for notifications.
        Effect.timeoutFail({
          duration: '10 seconds',
          onTimeout: () => new TelegramSendError({ message: 'Telegram request timed out' })
        }),
        Effect.retry(retryPolicy),
        Effect.withSpan('Telegram.sendMessage')
      );

    const send = (message: string) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          'telegram.messageLength': message.length,
          'telegram.chatId': config.chatId
        });

        const chunks = splitIntoChunks(message, TELEGRAM_MESSAGE_MAX_LENGTH);

        yield* Effect.annotateCurrentSpan({
          'telegram.chunks': chunks.length
        });

        for (const chunk of chunks) {
          yield* sendMessage(chunk);
        }
      }).pipe(
        Effect.withSpan('Telegram.send'),
        Effect.tapError(error => Effect.logError('Telegram send failed', { error }))
      );

    return { send } as const;
  })
}) {
  // Base layer (has unsatisfied TelegramConfig dependency)
  static layer = this.Default;

  // Composed layer with all dependencies satisfied
  static Live = this.layer.pipe(Layer.provide(TelegramConfigLive));
}
