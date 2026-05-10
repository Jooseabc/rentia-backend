import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import authRouter from './routes/auth.js';
import propertiesRouter from './routes/properties.js';
import tenantsRouter from './routes/tenants.js';
import tenantPortalRouter from './routes/tenant-portal.js';
import { startReminderJob } from './lib/reminders.js';
import { migrate } from './lib/migrate.js';

const app = express();
const PORT = Number(process.env.PORT || 4000);
app.set('trust proxy', 1);

// CORS
const origins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origen no permitido (${origin})`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

// Rate limit en auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'SAA API', version: '1.0.0' });
});

// Rutas
app.use('/api/auth', authRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/tenant-portal', tenantPortalRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(err.status || 500).json({ error: err.message || 'Error del servidor' });
});

// Arranca el servidor después de aplicar migraciones pendientes
migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] ✔ SAA API escuchando en :${PORT}`);
      console.log(`[server]   CORS permitidos: ${origins.join(', ') || '(ninguno)'}`);
      startReminderJob();
    });
  })
  .catch((err) => {
    console.error('[server] ✖ Migración fallida, abortando arranque:', err.message);
    process.exit(1);
  });