// Wrapper sobre web-push. No revienta si las VAPID keys no están seteadas:
// las rutas devuelven 503 y los reminders simplemente saltan los pushes.
import webpush from 'web-push';
import { query } from './db.js';

const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:soporte@rentia.app';

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.warn('[push] ⚠ VAPID keys inválidas:', err.message);
  }
} else {
  console.warn('[push] ⚠ VAPID keys no configuradas — Web Push deshabilitado');
}

export const pushEnabled    = () => configured;
export const getPublicKey   = () => PUBLIC_KEY;

// Envía a una sola suscripción. Si el endpoint está muerto (404/410),
// la elimina automáticamente de la BD para no reintentar.
export async function sendToSubscription(sub, payload) {
  if (!configured) return { ok: false, reason: 'push disabled' };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    const code = err.statusCode || err.status;
    if (code === 404 || code === 410) {
      await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
      return { ok: false, reason: 'gone', removed: true };
    }
    console.error('[push] Error enviando:', code, err.body || err.message);
    return { ok: false, reason: err.message };
  }
}

// Envía a todas las subs de un usuario. Devuelve cuántas tuvieron éxito.
export async function sendToUser(userId, payload) {
  if (!configured) return 0;
  const subs = (await query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  )).rows;
  let sent = 0;
  for (const sub of subs) {
    const r = await sendToSubscription(sub, payload);
    if (r.ok) sent++;
  }
  return sent;
}
