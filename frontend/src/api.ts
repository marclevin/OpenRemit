import { getToken } from './auth';

const BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:3001';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentType = 'FIXED_SEND' | 'FIXED_RECEIVE';

export interface QuoteRequest {
  senderWalletAddress:   string;
  receiverWalletAddress: string;
  /** Amount in the wallet's smallest unit (e.g. 100 = $1.00 for USD assetScale=2) */
  amount:      string;
  paymentType: PaymentType;
}

export interface WalletInfo {
  assetCode:  string;
  assetScale: number;
}

export interface QuoteResponse {
  transactionId: string;
  paymentType:   PaymentType;
  quote: {
    debitAmount:   { value: string; assetCode: string; assetScale: number };
    receiveAmount: { value: string; assetCode: string; assetScale: number };
    expiresAt?:    string;
  };
}

export interface Transaction {
  id:                    string;
  status:                'PENDING' | 'AWAITING_GRANT' | 'COMPLETED' | 'FAILED';
  paymentType:           PaymentType;
  senderWalletAddress:   string;
  receiverWalletAddress: string;
  debitAmount:           string | null;
  receiveAmount:         string | null;
  // Sender-side (debit) currency
  assetCode:             string;
  assetScale:            number;
  // Receiver-side currency — may differ when the payment crosses currencies
  receiveAssetCode:      string | null;
  receiveAssetScale:     number | null;
  outgoingPaymentUrl:    string | null;
  errorMessage:          string | null;
  createdAt:             string;
  recipientName:         string | null;
  recipientId?:          string | null;
}

/** One row of /api/remit/history — a payment the user sent or received. */
export interface HistoryEntry {
  id:                    string;
  status:                'PENDING' | 'AWAITING_GRANT' | 'COMPLETED' | 'FAILED';
  paymentType:           PaymentType;
  direction:             'sent' | 'received';
  senderWalletAddress:   string;
  receiverWalletAddress: string;
  debitAmount:           string | null;
  receiveAmount:         string | null;
  assetCode:             string;
  assetScale:            number;
  receiveAssetCode:      string | null;
  receiveAssetScale:     number | null;
  outgoingPaymentUrl:    string | null;
  errorMessage:          string | null;
  createdAt:             string;
  // The other side of the payment (an OpenRemit user, when their wallet is known)
  counterpartyName:      string | null;
  counterpartyId:        string | null;
  counterpartyWallet:    string;
}

export interface User {
  id:            string;
  displayName:   string;
  email:         string;
  avatar:        string | null;
  walletAddress: string | null;
}

export interface UserSearchResult {
  id:            string;
  displayName:   string;
  avatar:        string | null;
  walletAddress: string | null;
}

export interface SharedTransaction {
  id:                    string;
  status:                'PENDING' | 'AWAITING_GRANT' | 'COMPLETED' | 'FAILED';
  paymentType:           PaymentType;
  senderWalletAddress:   string;
  receiverWalletAddress: string;
  debitAmount:           string | null;
  receiveAmount:         string | null;
  assetCode:             string;
  assetScale:            number;
  outgoingPaymentUrl:    string | null;
  errorMessage:          string | null;
  createdAt:             string;
}

export interface PublicProfile {
  user: {
    id:            string;
    displayName:   string;
    avatar:        string | null;
    walletAddress: string | null;
  };
  sharedTransactions: SharedTransaction[];
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown, auth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string, auth = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── API client ───────────────────────────────────────────────────────────────

export const api = {
  auth: {
    signup: (body: { displayName: string; email: string; password: string }) =>
      post<{ token: string; user: User }>('/api/auth/signup', body),
    login: (body: { email: string; password: string }) =>
      post<{ token: string; user: User }>('/api/auth/login', body),
    me: () =>
      get<User>('/api/auth/me', true),
    update: (body: Partial<User & { password: string }>) =>
      patch<User>('/api/auth/me', body),
  },

  users: {
    search: (q: string) =>
      get<UserSearchResult[]>(`/api/users/search?q=${encodeURIComponent(q)}`, true),
    getProfile: (id: string) =>
      get<PublicProfile>(`/api/users/${encodeURIComponent(id)}`, true),
  },

  walletInfo: (url: string) =>
    get<WalletInfo>(`/api/remit/wallet-info?url=${encodeURIComponent(url)}`, true),
  quote:   (body: QuoteRequest) => post<QuoteResponse>('/api/remit/quote', body, true),
  consent: (transactionId: string) =>
    post<{ interactUrl: string }>('/api/remit/consent', { transactionId }, true),
  status:  (id: string) => get<Transaction>(`/api/remit/status/${id}`),
  history: () => get<HistoryEntry[]>('/api/remit/history', true),
};
