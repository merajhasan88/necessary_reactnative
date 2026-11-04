/** Reading what your backend answered. */

import { ApiException } from '../errors';

/**
 * The text [field] of an [answer] your backend gave. A field it left out is an [ApiException], as
 * every failure of a call is: a cast would let it through unseen.
 */
export function answerText(answer: Record<string, unknown>, field: string): string {
  const value = answer[field];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new ApiException(`The backend answered no ${field}.`, { code: 'invalid_backend_answer' });
}
