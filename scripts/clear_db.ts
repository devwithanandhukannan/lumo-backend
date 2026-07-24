import { pool } from '@lumo/database';

async function clearTestData() {
  try {
    console.log('🧹 Clearing all test data from LUMO database safely...');

    const tables = [
      'otps',
      'email_verifications',
      'refresh_tokens',
      'saved_locations',
      'pro_offered_services',
      'pending_service_requests',
      'bookings',
      'booking_state_logs',
      'sos_alerts',
      'misconduct_incidents',
      'professional_profiles'
    ];

    for (const tbl of tables) {
      try {
        await pool.query(`TRUNCATE TABLE ${tbl} CASCADE;`);
        console.log(`  ✓ Truncated table: ${tbl}`);
      } catch (e: any) {
        // Skip if table doesn't exist
      }
    }

    await pool.query(`DELETE FROM users WHERE role != 'SUPER_ADMIN';`);
    console.log('  ✓ Removed test users from users table.');

    console.log('✅ Database cleared cleanly! Only Super Admin remains.');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Error clearing database:', err.message);
    process.exit(1);
  }
}

clearTestData();
