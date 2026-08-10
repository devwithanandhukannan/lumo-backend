#!/usr/bin/env tsx
/**
 * LUMO Database Migration Runner
 * 
 * Usage:
 *   npx tsx scripts/run-migration.ts                    # Run all pending migrations
 *   npx tsx scripts/run-migration.ts 001               # Run specific migration by number
 * 
 * Migrations are stored in /migrations/*.sql
 * Applied migrations are tracked in the migration_log table.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'lumo_db',
  user: process.env.DB_USER || 'lumo_user',
  password: process.env.DB_PASSWORD || 'lumo_password',
});

async function ensureMigrationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_log (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      checksum TEXT
    )
  `);
  console.log('✅ Migration log table ready');
}

async function getAppliedMigrations(): Promise<string[]> {
  const res = await pool.query('SELECT filename FROM migration_log ORDER BY filename ASC');
  return res.rows.map((r) => r.filename);
}

async function runMigration(filePath: string, filename: string) {
  const sql = fs.readFileSync(filePath, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO migration_log (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [filename]
    );
    await client.query('COMMIT');
    console.log(`✅ Applied: ${filename}`);
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error(`❌ Failed: ${filename}\n   Error: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const targetMigration = process.argv[2]; // Optional: specific migration number prefix
  const migrationsDir = path.resolve(__dirname, '../migrations');

  console.log('🗄️  LUMO Database Migration Runner');
  console.log(`📁 Migrations directory: ${migrationsDir}`);
  console.log(`🔗 Database: ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT}`);
  console.log('');

  if (!fs.existsSync(migrationsDir)) {
    console.error('❌ Migrations directory not found:', migrationsDir);
    process.exit(1);
  }

  await ensureMigrationTable();

  const appliedMigrations = await getAppliedMigrations();
  console.log(`📋 Already applied: ${appliedMigrations.length} migration(s)`);

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Alphabetical = chronological order for NNN_ prefix naming

  const pendingFiles = migrationFiles.filter((f) => {
    if (appliedMigrations.includes(f)) return false;
    if (targetMigration && !f.startsWith(targetMigration)) return false;
    return true;
  });

  if (pendingFiles.length === 0) {
    console.log('✨ No pending migrations. Database is up to date.');
    await pool.end();
    return;
  }

  console.log(`\n🚀 Running ${pendingFiles.length} pending migration(s):\n`);

  for (const filename of pendingFiles) {
    const filePath = path.join(migrationsDir, filename);
    await runMigration(filePath, filename);
  }

  console.log('\n✅ All migrations completed successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
