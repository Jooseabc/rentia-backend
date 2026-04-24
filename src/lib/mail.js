import nodemailer from 'nodemailer';

let transporter = null;
let enabled = false;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  enabled = true;
  console.log('[mail] ✔ SMTP configurado');
} else {
  console.log('[mail] ⚠ SMTP no configurado (las notificaciones quedan deshabilitadas)');
}

export const mailEnabled = () => enabled;

export async function sendMail({ to, subject, html, text }) {
  if (!enabled) return { skipped: true };
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  return transporter.sendMail({ from, to, subject, html, text });
}
