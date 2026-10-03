import { createHash } from 'node:crypto';
import { CanonicalJsonValue, canonicalizeJson } from './canonical-json.js';

export function hashPayload(payload: CanonicalJsonValue): string {
  return createHash('sha256')
    .update(canonicalizeJson(payload), 'utf8')
    .digest('hex');
}
