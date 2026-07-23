import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'lumo_db',
  user: process.env.DB_USER || 'lumo_user',
  password: process.env.DB_PASSWORD || 'lumo_password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const initDatabaseTables = async (): Promise<void> => {
  try {
    const client = await pool.connect();
    try {
      const sqlPath = path.join(__dirname, 'init.sql');
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await client.query(sql);
        console.log('🐘 PostgreSQL database tables initialized successfully');
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.warn('⚠️ Database connection or table initialization warning:', err.message);
  }
};
