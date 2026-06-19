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
  // ISO timestamp the quote stops being usable; null if the quote omitted one.
  quoteExpiresAt:        string | null;
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
  // ISO timestamp the quote stops being usable; null if the quote omitted one.
  quoteExpiresAt:        string | null;
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
  // Receiver-side currency — may differ when the payment crosses currencies
  receiveAssetCode:      string | null;
  receiveAssetScale:     number | null;
  outgoingPaymentUrl:    string | null;
  errorMessage:          string | null;
  createdAt:             string;
}

/** One payment request ("ask"). counterpart = the other party:
 *  for incoming asks the requester (who gets paid), for outgoing asks the payer. */
export interface PaymentRequestEntry {
  id:          string;
  paymentType: PaymentType;
  /** Smallest asset unit. FIXED_SEND: payer's currency; FIXED_RECEIVE: requester's. */
  amount:      string;
  assetCode:   string;
  assetScale:  number;
  note:        string | null;
  status:      'PENDING' | 'COMPLETED' | 'DECLINED' | 'CANCELLED';
  createdAt:   string;
  counterpartId:     string;
  counterpartName:   string;
  counterpartAvatar: string | null;
  counterpartWallet: string | null;
}

export interface PaymentRequestList {
  incoming: PaymentRequestEntry[]; // asks addressed to me — I would pay
  outgoing: PaymentRequestEntry[]; // asks I created — I get paid
}

/** A Web Monetization news post. The body is present only on the detail
 *  endpoint and only once the current reader has unlocked it. */
export interface NewsPost {
  id:           string;
  authorName:   string;
  authorAvatar: string | null;
  title:        string;
  excerpt:      string;
  category:     string | null;
  /** Price in MAJOR units (e.g. "0.10"), denominated in the receiver's currency. */
  price:           string;
  priceAssetCode:  string;
  priceAssetScale: number;
  /** The "monetization receiver" — the app/journalist wallet readers pay. */
  receiverWallet:  string;
  /** The special article: payments stream live while reading, up to streamLimit. */
  streaming:       boolean;
  /** Body is returned without an unlock (used by the streaming article). */
  freeToRead:      boolean;
  /** Cap in MAJOR units for the streaming article; null for normal posts. */
  streamLimit:     string | null;
  unlocked:        boolean;
  createdAt:       string;
  // Detail-only fields:
  body?:    string | null;
  receipt?: {
    method:          'WEB_MONETIZATION' | 'OPEN_PAYMENTS';
    amountSent:      { value: string; assetCode: string; assetScale: number };
    incomingPayment: string | null;
  } | null;
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

  requests: {
    create: (body: { payerId: string; paymentType: PaymentType; amount: string; note?: string }) =>
      post<{ id: string; status: 'PENDING' }>('/api/requests', body, true),
    list: () =>
      get<PaymentRequestList>('/api/requests', true),
    /** Returns the same shape as quote() — feed it into the consent flow. */
    fulfill: (id: string) =>
      post<QuoteResponse>(`/api/requests/${encodeURIComponent(id)}/fulfill`, {}, true),
    decline: (id: string) =>
      post<{ status: 'DECLINED' }>(`/api/requests/${encodeURIComponent(id)}/decline`, {}, true),
    cancel: (id: string) =>
      post<{ status: 'CANCELLED' }>(`/api/requests/${encodeURIComponent(id)}/cancel`, {}, true),
  },

  news: {
    list: () =>
      get<NewsPost[]>('/api/news/posts', true),
    get: (id: string) =>
      get<NewsPost>(`/api/news/posts/${encodeURIComponent(id)}`, true),
    /** Web Monetization path: record + verify an unlock the browser streamed.
     *  streamedValue (MAJOR units) is the client's running total, used for the
     *  receipt when server-side verification of the incoming payment isn't available. */
    wmUnlock: (id: string, body: { incomingPayment?: string; streamedValue?: string }) =>
      post<{ unlocked: boolean; verified: boolean }>(`/api/news/posts/${encodeURIComponent(id)}/wm-unlock`, body, true),
    /** Fallback path: one-off Open Payments. Returns the same shape as quote(). */
    unlock: (id: string) =>
      post<QuoteResponse>(`/api/news/posts/${encodeURIComponent(id)}/unlock`, {}, true),
  },

  walletInfo: (url: string) =>
    get<WalletInfo>(`/api/remit/wallet-info?url=${encodeURIComponent(url)}`, true),
  quote:   (body: QuoteRequest) => post<QuoteResponse>('/api/remit/quote', body, true),
  consent: (transactionId: string) =>
    post<{ interactUrl: string }>('/api/remit/consent', { transactionId }, true),
  status:  (id: string) => get<Transaction>(`/api/remit/status/${id}`),
  history: () => get<HistoryEntry[]>('/api/remit/history', true),
};
