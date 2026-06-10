'use server';

import { Effect, Match, Schema as S } from 'effect';
import { NextEffect } from '@/lib/next-effect';
import { getSession } from '@/lib/services/auth/get-session';
import { S3 } from '@/lib/services/s3/live-layer';
import { ValidationError } from '@/lib/core/errors';

const FileUrl = S.String.pipe(S.minLength(1), S.maxLength(2048));

/**
 * Server action to get a signed URL for downloading a file from S3.
 *
 * Usage:
 * 1. Client calls this action with the file URL (stored in database)
 * 2. Server validates user is authenticated
 * 3. Client uses signed URL to access the file
 *
 * Security: Add domain-specific authorization checks as needed.
 * For multi-tenant apps, verify the file's object key belongs to the user's org.
 *
 * @example
 * ```tsx
 * const result = await getDownloadUrlAction(receipt.fileUrl)
 * if (result._tag === 'Success') {
 *   window.open(result.signedUrl, '_blank')
 * }
 * ```
 */
export const getDownloadUrlAction = async (fileUrl: string) => {
  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const parsed = yield* S.decodeUnknown(FileUrl)(fileUrl).pipe(
        Effect.mapError(() => new ValidationError({ message: 'Invalid file URL', field: 'fileUrl' }))
      );

      yield* getSession();
      const s3 = yield* S3;

      yield* Effect.annotateCurrentSpan({
        'file.url': parsed
      });

      // Signed URL expires in 5 minutes - enough time to download/view
      const signedUrl = yield* s3.createSignedDownloadUrl(parsed, 300);

      return { signedUrl };
    }).pipe(
      Effect.withSpan('action.file.getDownloadUrl', {
        attributes: { operation: 'file.getDownloadUrl' }
      }),
      NextEffect.matchEffect({
        onFailure: error =>
          Match.value(error).pipe(
            Match.tag('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.tag('ValidationError', e =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: e.message
              })
            ),
            Match.orElse(() =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: 'Failed to generate download URL'
              })
            )
          ),
        onSuccess: data => Effect.succeed({ _tag: 'Success' as const, ...data })
      })
    )
  );
};
