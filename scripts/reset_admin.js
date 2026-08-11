const argon2 = require('../node_modules/argon2');
const { pool } = require('../packages/database');

async function main() {
  try {
    const hash = await argon2.hash('Admin@123');
    await pool.query("UPDATE users SET password_hash = $1 WHERE email = 'admin@lumo.in'", [hash]);
    console.log('✅ Successfully set password for admin@lumo.in to Admin@123');
    
    // Also test login
    const res = await fetch('http://localhost:8000/api/v1/auth/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@lumo.in', password: 'Admin@123' })
    });
    const data = await res.json();
    console.log('Login test status:', res.status, 'Success:', data.success);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
