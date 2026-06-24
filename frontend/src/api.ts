import { getToken } from './auth';

const BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:3001';

// ─── Types (mirror backend CONTRACT) ──────────────────────────────────────────

export type Role           = 'PLAYER' | 'SPONSOR';
export type Game           = 'ROCKET' | 'PLANE' | 'PACHINKO';
export type SessionStatus  = 'AWAITING_GRANT' | 'ACTIVE' | 'ENDED';
export type Outcome        = 'PENDING' | 'WIN' | 'LOSS';
export type DonationStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface User {
  id:            string;
  displayName:   string;
  email:         string;
  role:          Role;
  avatar:        string | null;
  walletAddress: string | null;
}

export interface Charity {
  id:            string;
  name:          string;
  blurb:         string;
  category:      string;
  walletAddress: string;
  accentColor:   string;
}

export interface SessionView {
  id:               string;
  charityId:        string;
  walletAddress:    string;
  status:           SessionStatus;
  bankrollLimit:    number;
  bankrollSpent:    number;
  bankrollReserved: number;
  remaining:        number;
  assetCode:        string;
  assetScale:       number;
  createdAt:        string;
  charity:          Charity;
}

export interface RoundView {
  id:             string;
  sessionId:      string;
  game:           Game;
  wager:          number;
  multiplier:     number;
  matchAmount:    number;
  outcome:        Outcome;
  settled:        boolean;
  createdAt:      string;
  serverSeedHash: string;
  clientSeed:     string;
  nonce:          number;
  serverSeed?:    string;
}

export interface DonationView {
  id:                 string;
  kind:               'USER_WAGER' | 'SPONSOR_MATCH';
  amount:             number;
  assetCode:          string;
  assetScale:         number;
  status:             DonationStatus;
  charityId?:         string | null;
  roundId?:           string | null;
  pledgeId?:          string | null;
  outgoingPaymentUrl?: string | null;
  errorMessage?:      string | null;
  createdAt:          string;
}

export interface SessionDetail {
  session:   SessionView;
  rounds:    RoundView[];
  donations: DonationView[];
}

// ── Game play responses ──
export interface PlaneStep { type: 'COIN' | 'ROCKET' | 'PAD'; mult: number }
export interface PlanePlayResponse {
  round:     RoundView;
  animation: { result: 'LAND' | 'CRASH'; finalMultiplier: number; steps: PlaneStep[] };
  remaining: number;
}
export interface RocketPlayResponse {
  roundId:        string;
  startedAt:      number;   // epoch ms
  growthK:        number;
  crashPoint:     number;   // drives the live crash; never shown to the player
  serverSeedHash: string;
  clientSeed:     string;
  nonce:          number;
  remaining:      number;
}
export interface RocketCashoutResponse {
  outcome:     'WIN' | 'LOSS';
  multiplier:  number;
  crashPoint:  number;
  matchAmount: number;
  serverSeed:  string;
}
export interface PachinkoDropResponse {
  round:     RoundView;
  animation: { bucket: number; path: number[]; multipliers: number[] };
  remaining: number;
  parked:    number;
}
export interface PachinkoCashoutResponse {
  settlement: { totalWager: number; drops: number; totalMatched: number };
  remaining:  number;
}
export interface RoundDetail {
  round:     RoundView;
  donations: DonationView[];
}

// ── Sponsor ──
export interface PledgeView {
  id:            string;
  charityId:     string | null;
  charityName:   string;
  poolLimit:     number;
  poolSpent:     number;
  remaining:     number;
  status:        'AWAITING_GRANT' | 'ACTIVE' | 'DEPLETED' | 'ENDED';
  createdAt:     string;
  recentMatches: DonationView[];
}
export interface PledgesResponse {
  pledges: PledgeView[];
  stats:   { totalMatched: number; matchesCount: number; charitiesHelped: number };
}

// ── Impact ──
export interface ImpactResponse {
  global:       { totalDonated: number; totalMatched: number; charitiesHelped: number; plays: number };
  personal:     { totalDonated: number; totalMatched: number; plays: number; wins: number };
  topCharities: { name: string; accentColor: string; total: number }[];
  byGame:       { game: Game; plays: number; wins: number }[];
  timeline:     { day: string; total: number }[];
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extra };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown, auth = false): Promise<T> {
  const headers = auth
    ? authHeaders({ 'Content-Type': 'application/json' })
    : { 'Content-Type': 'application/json' };
  return unwrap<T>(await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

async function get<T>(path: string, auth = false): Promise<T> {
  return unwrap<T>(await fetch(`${BASE}${path}`, { headers: auth ? authHeaders() : {} }));
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }));
}

// ─── API client ───────────────────────────────────────────────────────────────

export const api = {
  auth: {
    signup: (body: { displayName: string; email: string; password: string; role?: Role }) =>
      post<{ token: string; user: User }>('/api/auth/signup', body),
    login: (body: { email: string; password: string }) =>
      post<{ token: string; user: User }>('/api/auth/login', body),
    me: () => get<User>('/api/auth/me', true),
    update: (body: Partial<{ displayName: string; email: string; password: string; walletAddress: string; avatar: string | null; role: Role }>) =>
      patch<User>('/api/auth/me', body),
  },

  charities: {
    list: () => get<Charity[]>('/api/charities', true),
  },

  sessions: {
    create: (body: { charityId: string; bankroll: number }) =>
      post<{ sessionId: string; interactUrl: string }>('/api/sessions', body, true),
    active: () => get<SessionView | null>('/api/sessions/active', true),
    get:    (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, true),
    end:    (id: string) => post<{ status: 'ENDED' }>(`/api/sessions/${encodeURIComponent(id)}/end`, {}, true),
  },

  games: {
    plane:  (body: { sessionId: string; wager: number; clientSeed?: string }) =>
      post<PlanePlayResponse>('/api/games/plane/play', body, true),
    rocketPlay: (body: { sessionId: string; wager: number; clientSeed?: string }) =>
      post<RocketPlayResponse>('/api/games/rocket/play', body, true),
    rocketCashout: (roundId: string, multiplier: number) =>
      post<RocketCashoutResponse>(`/api/games/rocket/${encodeURIComponent(roundId)}/cashout`, { multiplier }, true),
    pachinkoDrop: (body: { sessionId: string; wager: number; clientSeed?: string }) =>
      post<PachinkoDropResponse>('/api/games/pachinko/drop', body, true),
    pachinkoCashout: (sessionId: string) =>
      post<PachinkoCashoutResponse>('/api/games/pachinko/cashout', { sessionId }, true),
    round: (id: string) => get<RoundDetail>(`/api/games/rounds/${encodeURIComponent(id)}`, true),
  },

  pledges: {
    create: (body: { charityId: string | null; pool: number }) =>
      post<{ pledgeId: string; interactUrl: string }>('/api/pledges', body, true),
    list: () => get<PledgesResponse>('/api/pledges', true),
    end:  (id: string) => post<{ status: 'ENDED' }>(`/api/pledges/${encodeURIComponent(id)}/end`, {}, true),
  },

  impact: {
    get: () => get<ImpactResponse>('/api/impact', true),
  },
};
