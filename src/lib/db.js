import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const ssl =
  process.env.NODE_ENV === 'production' && process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10,
});

export const query = (text, params) => pool.query(text, params);

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});
