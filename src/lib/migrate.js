import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../migrations');

async function migrate() {
  console.log('[migrate] Iniciando migración…');
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`[migrate] Ejecutando ${file}`);
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }
  console.log('[migrate] ✔ Migración completa.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] ✖ Error:', err);
  process.exit(1);
});
