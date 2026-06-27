import { config } from './config';
import express from 'express';
import cors from 'cors';
import { remitRouter } from './routes/remit';
import { callbackRouter } from './routes/callback';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { requestsRouter } from './routes/requests';
import { newsRouter } from './routes/news';
import { claimsRouter } from './routes/claims';
import { membershipsRouter } from './routes/memberships';
import { errorHandler } from './middleware/errorHandler';
import { seedNews } from './lib/seedNews';
import { seedGroup } from './lib/seedGroup';

const app = express();

app.use(cors({ origin: config.frontendUrl, credentials: true }));
// Default limit is 100 KB — too small for base64 avatar uploads (up to ~280 KB)
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'openremit-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/news', newsRouter);
app.use('/api/remit', remitRouter);
app.use('/api/callback', callbackRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/memberships', membershipsRouter);

app.use(errorHandler);

// Seed demo data on first boot (idempotent — no-op if rows exist).
seedNews().catch((err) => console.error('[seed] News seed failed:', err));
seedGroup().catch((err) => console.error('[seed] Group seed failed:', err));

app.listen(config.port, () => {
  console.log(`\n  OpenRemit backend → http://localhost:${config.port}\n`);
});
