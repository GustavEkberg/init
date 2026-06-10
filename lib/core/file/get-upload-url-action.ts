'use server';

import { Clock, Effect, Match, Schema as S } from 'effect';
import { NextEffect } from '@/lib/next-effect';
import { getSession } from '@/lib/services/auth/get-session';
import { S3 } from '@/lib/services/s3/live-layer';
import { ValidationError } from '@/lib/core/errors';

// Strict allowlists: both values are interpolated into the S3 object key.
// No `/`, no leading dots — callers cannot shape keys outside
// `folder/userId/...` (key spoofing / prefix escape).
const GetUploadUrlInput = S.Struct({
  fileName: S.String.pipe(S.minLength(1), S.maxLength(255), S.pattern(/^[\w][\w.\- ]*$/)),
  folder: S.String.pipe(S.minLength(1), S.maxLength(64), S.pattern(/^[a-z0-9][a-z0-9-]*$/))
});

type GetUploadUrlInput = S.Schema.Type<typeof GetUploadUrlInput>;

/**
 * Server action to get a signed URL for uploading a file to S3.
 *
 * Usage:
 * 1. Client calls this action with fileName and folder
 * 2. Server returns signedUrl (for upload) and publicUrl (for storage)
 * 3. Client uploads directly to S3 using the signedUrl
 * 4. Client saves publicUrl to database via another action
 *
 * @example
 * ```tsx
 * const result = await getUploadUrlAction({ fileName: 'photo.jpg', folder: 'avatars' })
 * if (result._tag === 'Success') {
 *   await fetch(result.signedUrl, { method: 'PUT', body: file })
 *   // Now save result.publicUrl to your database
 * }
 * ```
 */
export const getUploadUrlAction = async (input: GetUploadUrlInput) => {
  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const parsed = yield* S.decodeUnknown(GetUploadUrlInput)(input).pipe(
        Effect.mapError(
          () =>
            new ValidationError({
              message:
                'Invalid file name or folder (letters, digits, dots, dashes; no slashes)',
              field: 'fileName'
            })
        )
      );

      const session = yield* getSession();
      const s3 = yield* S3;

      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'file.name': parsed.fileName,
        'file.folder': parsed.folder
      });

      // Generate unique key: folder/userId/timestamp-filename
      // This prevents collisions and organizes files by user.
      // The userId segment is what deleteFileAction checks for ownership.
      const now = yield* Clock.currentTimeMillis;
      const key = `${parsed.folder}/${session.user.id}/${now}-${parsed.fileName}`;

      // Signed URL expires in 5 minutes - enough time for upload
      const signedUrl = yield* s3.createSignedUrl(key, 300);

      // Public URL is what gets stored in the database
      const publicUrl = s3.getUrlFromObjectKey(key);

      return {
        signedUrl,
        publicUrl,
        key
      };
    }).pipe(
      Effect.withSpan('action.file.getUploadUrl', {
        attributes: { operation: 'file.getUploadUrl' }
      }),
      NextEffect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.when('ValidationError', () =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: error.message
              })
            ),
            Match.orElse(() =>
              Effect.succeed({
                _tag: 'Error' as const,
                message: 'Failed to generate upload URL'
              })
            )
          ),
        onSuccess: data => Effect.succeed({ _tag: 'Success' as const, ...data })
      })
    )
  );
};
