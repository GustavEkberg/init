'use server';

import { Effect, Match, Schema as S } from 'effect';
import { NextEffect } from '@/lib/next-effect';
import { getSession } from '@/lib/services/auth/get-session';
import { S3 } from '@/lib/services/s3/live-layer';
import { UnauthorizedError, ValidationError } from '@/lib/core/errors';

const FileUrl = S.String.pipe(S.minLength(1), S.maxLength(2048));

/**
 * Server action to delete a file from S3.
 *
 * @param fileUrl - The public URL of the file to delete (or the S3 key)
 *
 * @example
 * ```tsx
 * const result = await deleteFileAction('https://bucket.s3.region.amazonaws.com/avatars/user123/photo.jpg')
 * if (result._tag === 'Success') {
 *   // File deleted, update your database to remove the reference
 * }
 * ```
 */
export const deleteFileAction = async (fileUrl: string) => {
  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const parsed = yield* S.decodeUnknown(FileUrl)(fileUrl).pipe(
        Effect.mapError(() => new ValidationError({ message: 'Invalid file URL', field: 'fileUrl' }))
      );

      const session = yield* getSession();
      const s3 = yield* S3;

      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'file.url': parsed
      });

      // Extract key from URL if it's a full URL
      const key = parsed.startsWith('https://') ? s3.getObjectKeyFromUrl(parsed) : parsed;

      // Ownership check: getUploadUrlAction shapes keys as
      // `folder/userId/timestamp-fileName` — the second segment must be the
      // caller. Files stored under other key shapes are not deletable here;
      // add a domain-specific rule if you need that.
      const ownerId = key.split('/')[1];
      if (ownerId !== session.user.id) {
        return yield* new UnauthorizedError({ message: 'You can only delete your own files' });
      }

      yield* s3.deleteFile(key);
    }).pipe(
      Effect.withSpan('action.file.delete', {
        attributes: { operation: 'file.delete' }
      }),
      NextEffect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.when('UnauthorizedError', () =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: error.message
              })
            ),
            Match.when('ValidationError', () =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: error.message
              })
            ),
            Match.orElse(() =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: 'Failed to delete file'
              })
            )
          ),
        onSuccess: () => Effect.succeed({ _tag: 'Success' as const })
      })
    )
  );
};
