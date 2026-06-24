import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}\nCopy backend/.env.example → backend/.env and fill in your credentials.`);
  return val;
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

  // Receiver wallet seeded charities donate to. Defaults to the app wallet so
  // donations move on the testnet out of the box; override per-charity in
  // lib/seedCharities.ts (or globally via CHARITY_WALLET_ADDRESS) with distinct
  // test wallets to make charities separate receivers.
  charityWalletAddress: process.env.CHARITY_WALLET_ADDRESS ?? required('OP_WALLET_ADDRESS'),

  db: {
    path: process.env.DB_PATH ?? './openremit.db',
  },

  jwtSecret: process.env.JWT_SECRET ?? 'changeme',
};

if (config.jwtSecret === 'changeme') {
  console.warn('[config] JWT_SECRET is the default placeholder — set a long random value in backend/.env before deploying.');
}
