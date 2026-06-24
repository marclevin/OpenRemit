import {
  createAuthenticatedClient,
  isPendingGrant,
  isFinalizedGrantWithAccessToken,
  OpenPaymentsClientError,
} from '@interledger/open-payments';
import type { Grant, GrantContinuation, GrantWithAccessToken, PendingGrant } from '@interledger/open-payments';
import { config } from '../config';

// Singleton — one authenticated client per process lifetime.
// The client signs every request with the Ed25519 private key.
let _client: Awaited<ReturnType<typeof createAuthenticatedClient>> | null = null;

export async function getClient() {
  if (_client) return _client;
  _client = await createAuthenticatedClient({
    walletAddressUrl: config.op.walletAddress,
    keyId:            config.op.keyId,
    privateKey:       config.op.privateKeyPath, // file path — SDK reads the .pem itself
  });
  return _client;
}

// Convert shorthand "$ilp.example.com/alice" → "https://ilp.example.com/alice".
// The SDK also accepts full https:// URLs, so this is safe to call either way.
export function normaliseWalletAddress(addr: string): string {
  return addr.startsWith('$') ? `https://${addr.slice(1)}` : addr;
}

// Type guard for grants that are finalised and carry a usable access token.
// Composes the SDK's own guards so it works for both fresh grant requests
// (PendingGrant | Grant) and grant continuations (GrantContinuation | Grant).
export function isFinalizedGrant(
  grant: PendingGrant | GrantContinuation | Grant
): grant is GrantWithAccessToken {
  return !isPendingGrant(grant) && isFinalizedGrantWithAccessToken(grant);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// True when an OP error looks like the access token is no longer usable (expired
// / "Inactive Token"), i.e. it's worth rotating the token and retrying — as
// opposed to a genuine "forbidden" like an exhausted spending limit.
export function isStaleTokenError(err: unknown): boolean {
  if (!(err instanceof OpenPaymentsClientError)) return false;
  if (err.status === 401) return true;
  if (err.status === 403) {
    const d = (err.description ?? '').toLowerCase();
    return d.includes('token') || d.includes('inactive') || d.includes('expired');
  }
  return false;
}

// Open Payments SDK errors (OpenPaymentsClientError) carry the real cause in
// `description` / `status` / `code` / `validationErrors` / `details` — none of
// which show up in the bare `.message`. This flattens all of it into one
// diagnostic line. Use it everywhere we log an OP failure.
export function describeOpError(err: unknown): string {
  if (err instanceof OpenPaymentsClientError) {
    const parts: string[] = [err.message];
    if (err.description && err.description !== err.message) parts.push(`description="${err.description}"`);
    if (err.status != null) parts.push(`status=${err.status}`);
    if (err.code) parts.push(`code=${err.code}`);
    if (err.validationErrors?.length) parts.push(`validationErrors=[${err.validationErrors.join('; ')}]`);
    if (err.details && Object.keys(err.details).length) parts.push(`details=${safeJson(err.details)}`);
    return parts.join(' ');
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
