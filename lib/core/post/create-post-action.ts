'use server';

import { Effect, Match, Schema as S } from 'effect';
import { revalidatePath } from 'next/cache';
import { NextEffect } from '@/lib/next-effect';
import { getSession } from '@/lib/services/auth/get-session';
import { Db } from '@/lib/services/db/live-layer';
import * as schema from '@/lib/services/db/schema';
import { ValidationError } from '@/lib/core/errors';

const CreatePostInput = S.Struct({
  title: S.String.pipe(S.minLength(1), S.maxLength(200)),
  content: S.optional(S.String.pipe(S.maxLength(10_000)))
});

type CreatePostInput = S.Schema.Type<typeof CreatePostInput>;

export const createPostAction = async (input: CreatePostInput) => {
  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const parsed = yield* S.decodeUnknown(CreatePostInput)(input).pipe(
        Effect.mapError(
          () =>
            new ValidationError({
              message: 'Title is required (1-200 characters); content up to 10,000 characters',
              field: 'title'
            })
        )
      );

      const session = yield* getSession();
      const db = yield* Db;

      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'user.email': session.user.email,
        'post.title': parsed.title
      });

      const [post] = yield* db
        .insert(schema.post)
        .values({
          title: parsed.title,
          content: parsed.content,
          userId: session.user.id
        })
        .returning();

      return post;
    }).pipe(
      Effect.withSpan('action.post.create', {
        attributes: { operation: 'post.create' }
      }),
      NextEffect.matchEffect({
        onFailure: error =>
          Match.value(error._tag).pipe(
            Match.when('UnauthenticatedError', () => NextEffect.redirect('/login')),
            Match.when('ValidationError', () =>
              Effect.succeed({ _tag: 'Error' as const, message: error.message })
            ),
            // Generic message: never leak internal error details to the client
            Match.orElse(() =>
              Effect.succeed({ _tag: 'Error' as const, message: 'Failed to create post' })
            )
          ),
        onSuccess: post =>
          Effect.sync(() => {
            revalidatePath('/');
            return { _tag: 'Success' as const, post };
          })
      })
    )
  );
};
