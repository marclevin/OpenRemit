import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env from the backend/ directory explicitly so this works regardless
// of whether the process is started from the workspace root or from backend/.
dotenv.config({ path: resolve(__dirname, '..', '.env') });

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}\nCopy backend/.env.example → backend/.env and fill in your credentials.`);
  return val;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',

  op: {
    walletAddress: required('OP_WALLET_ADDRESS'),
    keyId:         required('OP_KEY_ID'),
    privateKeyPath: required('OP_PRIVATE_KEY_PATH'),
  },

  // Second wallet for the backstop tranche (outside-funded NGO/CSR pool).
  // Required for the claims/payout demo; optional for basic P2P remittance use.
  backstop: {
    walletAddress: optional('BACKSTOP_WALLET_ADDRESS'),
    keyId:         optional('BACKSTOP_KEY_ID'),
    privateKeyPath: optional('BACKSTOP_PRIVATE_KEY_PATH'),
  },

  db: {
    path: process.env.DB_PATH ?? './openremit.db',
  },

  jwtSecret: process.env.JWT_SECRET ?? 'changeme',
};

if (config.jwtSecret === 'changeme') {
  console.warn('[config] JWT_SECRET is the default placeholder — set a long random value in backend/.env before deploying.');
}
