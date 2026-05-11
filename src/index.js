import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

// ── Helmet: cabeceras de seguridad por defecto ───────────────────
// Desactivamos CSP porque es una API; el frontend (Render Static) tiene la
// suya. Mantenemos HSTS, X-Content-Type-Options, X-Frame-Options, etc.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // permite que el frontend descargue PDFs
}));

// ── CORS ─────────────────────────────────────────────────────────
// Lee CORS_ORIGIN de env (separados por coma). Si no está, lanza warning
// y deja la API en modo "sin origen permitido" excepto requests sin origin
// (curl, server-to-server). NUNCA usar "*" en producción.
const rawOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowAny = rawOrigins.includes('*');

if (rawOrigins.length === 0) {
  console.warn('[server] ⚠ CORS_ORIGIN no configurado → solo se aceptarán requests sin Origin');
}
if (allowAny) {
  console.warn('[server] ⚠ CORS_ORIGIN incluye "*" → cualquier dominio puede llamar al API');
}

app.use(
  cors({
    origin: (origin, cb) => {
      // Requests sin Origin (curl, health checks, server-to-server) siempre permitidos
      if (!origin) return cb(null, true);
      if (allowAny || rawOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origen no permitido (${origin})`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

// ── Rate limits anti fuerza-bruta ────────────────────────────────
// Login: 5 intentos FALLIDOS por IP cada 15 min. Los logins exitosos no
// consumen cupo, así que un usuario legítimo nunca se ve afectado.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Intenta de nuevo en 15 minutos.' },
});

// Register: 5 cuentas por IP cada hora. El sistema ya exige código de
// invitación, esto es defensa adicional contra spam masivo.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de registro desde esta IP.' },
});

app.use('/api/auth/login',    loginLimiter);
app.use('/api/auth/register', registerLimiter);

// Login del portal de inquilinos: mismo trato que el admin login.
app.use('/api/tenant-portal/login', loginLimiter);

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
  // CORS rejections vienen aquí con un error específico
  if (err && /^CORS:/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }
  console.error('[server]', err);
  res.status(err.status || 500).json({ error: err.message || 'Error del servidor' });
});

// Arranca el servidor después de aplicar migraciones pendientes
migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] ✔ SAA API escuchando en :${PORT}`);
      console.log(`[server]   CORS permitidos: ${rawOrigins.join(', ') || '(ninguno explícito)'}`);
      startReminderJob();
    });
  })
  .catch((err) => {
    console.error('[server] ✖ Migración fallida, abortando arranque:', err.message);
    process.exit(1);
  });
