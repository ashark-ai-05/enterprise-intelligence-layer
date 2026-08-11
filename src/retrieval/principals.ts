/**
 * Viewer principals → authorization-domain principal refs.
 *
 * A `Viewer` carries principals as `domain:identifier` strings; the ACL layer
 * wants them split. Principals are per-authorization-domain — an Atlassian
 * account id and a directory group are not interchangeable — so the split
 * matters and belongs in one place rather than in every arm that needs it.
 *
 * → docs/14 Gap 1, src/security/acl.ts
 */

import type { PrincipalRef } from "../security/acl.js";

/** Domain used when a principal arrives without one. */
export const DEFAULT_DOMAIN = "enterprise";

export function toPrincipalRefs(principals: readonly string[]): PrincipalRef[] {
  return principals.map((principal) => {
    const separator = principal.indexOf(":");
    return separator === -1
      ? { domain: DEFAULT_DOMAIN, principalId: principal }
      : {
          domain: principal.slice(0, separator),
          principalId: principal.slice(separator + 1),
        };
  });
}
