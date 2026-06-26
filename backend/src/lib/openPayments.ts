import {
  createAuthenticatedClient,
  isPendingGrant,
  isFinalizedGrantWithAccessToken,
} from '@interledger/open-payments';
import type { Grant, GrantContinuation, GrantWithAccessToken, PendingGrant } from '@interledger/open-payments';
import { config } from '../config';

type OPClient = Awaited<ReturnType<typeof createAuthenticatedClient>>;

// Pool wallet singleton (the primary app wallet — OP_WALLET_ADDRESS).
let _client: OPClient | null = null;

export async function getClient(): Promise<OPClient> {
  if (_client) return _client;
  _client = await createAuthenticatedClient({
    walletAddressUrl: config.op.walletAddress,
    keyId:            config.op.keyId,
    privateKey:       config.op.privateKeyPath, // file path — SDK reads the .pem itself
  });
  return _client;
}

// Backstop wallet singleton (outside-funded tranche — BACKSTOP_WALLET_ADDRESS).
// Throws if backstop credentials are not configured.
let _backstopClient: OPClient | null = null;

export async function getBackstopClient(): Promise<OPClient> {
  if (_backstopClient) return _backstopClient;
  const { walletAddress, keyId, privateKeyPath } = config.backstop;
  if (!walletAddress || !keyId || !privateKeyPath) {
    throw new Error(
      'Backstop wallet credentials not configured. Set BACKSTOP_WALLET_ADDRESS, BACKSTOP_KEY_ID, and BACKSTOP_PRIVATE_KEY_PATH in backend/.env.'
    );
  }
  _backstopClient = await createAuthenticatedClient({
    walletAddressUrl: walletAddress,
    keyId,
    privateKey: privateKeyPath,
  });
  return _backstopClient;
}

export async function getClientForSource(source: 'POOL' | 'BACKSTOP'): Promise<OPClient> {
  return source === 'POOL' ? getClient() : getBackstopClient();
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
