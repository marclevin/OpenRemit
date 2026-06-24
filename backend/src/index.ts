import { config } from './config';
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { charitiesRouter } from './routes/charities';
import { sessionsRouter } from './routes/sessions';
import { gamesRouter } from './routes/games';
import { pledgesRouter } from './routes/pledges';
import { impactRouter } from './routes/impact';
import { callbackRouter } from './routes/callback';
import { errorHandler } from './middleware/errorHandler';
import { seedCharities } from './lib/seedCharities';

const app = express();

app.use(cors({ origin: config.frontendUrl, credentials: true }));
// Default limit is 100 KB — too small for base64 avatar uploads (up to ~280 KB)
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'goodwager-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/charities', charitiesRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/games', gamesRouter);
app.use('/api/pledges', pledgesRouter);
app.use('/api/impact', impactRouter);
app.use('/api/callback', callbackRouter);

app.use(errorHandler);

// Seed the demo charities on first boot (idempotent — no-op if any exist).
seedCharities().catch((err) => console.error('[seed] Charity seed failed:', err));

app.listen(config.port, () => {
  console.log(`\n  GoodWager backend → http://localhost:${config.port}\n`);
});
