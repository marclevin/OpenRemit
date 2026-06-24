import type { WalletAddress } from '@interledger/open-payments';
import { isPendingGrant } from '@interledger/open-payments';
import { getClient, isFinalizedGrant } from './openPayments';

// ─────────────────────────────────────────────────────────────────────────────
// grantFlow — the ONE interactive consent that powers a whole pool.
//
// A "pool" is either a player's session bankroll or a sponsor's pledge. In both
// cases we ask the wallet's auth server for an interactive outgoing-payment grant
// whose debitAmount limit is the pool size. The player/sponsor approves it once in
// their browser; we then hold the finalised access token and create many small
// outgoing payments under it (one per donation) with no further redirects, until
// the cumulative debit reaches the limit.
//
// This is the template's remit.ts (request) + callback.ts (continue) flow, lifted
// out so play_sessions and pledges share exactly one implementation.
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolGrant {
  interactUrl:   string;  // send the browser here to approve
  continueUri:   string;  // persist — needed to continue the grant at /api/callback
  continueToken: string;  // persist — bearer for the continuation
}

export interface PoolToken {
  accessToken: string;    // the bearer used for every outgoing payment under the pool
  manageUrl:   string;    // token management URL — used to ROTATE it when it expires
}

/**
 * Request an interactive outgoing-payment grant limited to `limitValue` of the
 * wallet's currency. `callbackUrl` is where the auth server redirects after
 * consent (our /api/callback, already carrying grantType + id). `nonce` is the
 * GNAP interact.finish nonce.
 */
export async function requestPoolGrant(
  senderWallet: WalletAddress,
  limitValue:   number,
  callbackUrl:  string,
  nonce:        string,
): Promise<PoolGrant> {
  const client = await getClient();

  // Log the exact grant shape we're authorising, so a later donation failure can
  // be lined up against the limit it was granted (currency, scale, value).
  console.log(
    `[grant] outgoing-payment grant for ${senderWallet.id}: ` +
    `limits.debitAmount = { value: ${limitValue}, assetCode: ${senderWallet.assetCode}, assetScale: ${senderWallet.assetScale} }`,
  );

  const grant = await client.grant.request(
    { url: senderWallet.authServer },
    {
      access_token: {
        access: [
          {
            type:       'outgoing-payment',
            actions:    ['create', 'read'],
            identifier: senderWallet.id,
            limits: {
              debitAmount: {
                value:      String(limitValue),
                assetCode:  senderWallet.assetCode,
                assetScale: senderWallet.assetScale,
              },
            },
          },
        ],
      },
      interact: {
        start:  ['redirect'],
        finish: { method: 'redirect', uri: callbackUrl, nonce },
      },
    },
  );

  if (!isPendingGrant(grant) || !grant.interact?.redirect) {
    throw new Error('Expected an interactive outgoing-payment grant with a redirect link');
  }

  return {
    interactUrl:   grant.interact.redirect,
    continueUri:   grant.continue.uri,
    continueToken: grant.continue.access_token.value,
  };
}

/**
 * Exchange the interact_ref from /api/callback for the finalised access token (and
 * its management URL) that the pool reuses for its lifetime. Throws if consent was
 * denied/expired.
 */
export async function continuePoolGrant(
  continueUri:   string,
  continueToken: string,
  interactRef:   string,
): Promise<PoolToken> {
  const client = await getClient();

  const finalized = await client.grant.continue(
    { url: continueUri, accessToken: continueToken },
    { interact_ref: interactRef },
  );

  if (!isFinalizedGrant(finalized)) {
    throw new Error('Grant continuation did not return an access token. Consent may have been denied or expired.');
  }

  return {
    accessToken: finalized.access_token.value,
    manageUrl:   finalized.access_token.manage,
  };
}

/**
 * Rotate a pool's access token via its management URL — used when the current
 * token has gone inactive (the grant outlives any single token). Returns the fresh
 * token + its new management URL, which the caller must persist.
 */
export async function rotatePoolToken(manageUrl: string, currentToken: string): Promise<PoolToken> {
  const client = await getClient();
  const rotated = await client.token.rotate({ url: manageUrl, accessToken: currentToken });
  return {
    accessToken: rotated.access_token.value,
    manageUrl:   rotated.access_token.manage,
  };
}
