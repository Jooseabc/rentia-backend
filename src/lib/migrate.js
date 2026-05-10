import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../migrations');

async function ensureRegistry(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate() {
  console.log('[migrate] Iniciando migración…');

  const client = await pool.connect();
  try {
    await ensureRegistry(client);

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
    );

    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] · ${file} (ya aplicada)`);
        continue;
      }
      console.log(`[migrate] ▶ ${file}`);
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migración ${file} falló: ${err.message}`);
      }
    }

    console.log(`[migrate] ✔ Migración completa (${ran} aplicada${ran === 1 ? '' : 's'}).`);
  } finally {
    client.release();
    // NO cerramos el pool aquí — el servidor lo sigue usando
  }
}

// Permite ejecutar directamente: node src/lib/migrate.js
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .catch((err) => { console.error('[migrate] ✖ Error:', err); process.exit(1); })
    .finally(() => pool.end());
}
