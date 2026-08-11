const { pool } = require('../packages/database');

async function main() {
  try {
    const profOne = await pool.query("SELECT id, full_name, phone_number FROM users WHERE phone_number = '+916363636363' OR full_name ILIKE '%Proffone%'");
    const profOneId = profOne.rows[0]?.id;
    console.log('Proffone User:', profOne.rows[0]);

    if (profOneId) {
      const updateRes = await pool.query(
        "UPDATE pending_service_requests SET pro_id = $1 WHERE service_name ILIKE 'fun' RETURNING *",
        [profOneId]
      );
      console.log('Reassigned service requests to Proffone:', updateRes.rows);

      const funService = await pool.query("SELECT id FROM services WHERE LOWER(name) = 'fun'");
      const funServiceId = funService.rows[0]?.id;
      if (funServiceId) {
        await pool.query(
          `INSERT INTO pro_offered_services (id, pro_id, service_id, custom_price, is_active, updated_at)
           VALUES ($1, $2, $3, 366.00, true, NOW())
           ON CONFLICT (pro_id, service_id) DO UPDATE SET is_active = true, custom_price = 366.00, updated_at = NOW()`,
          [`pos-${Date.now().toString(36)}`, profOneId, funServiceId]
        );
        console.log('Linked fun service to Proffone in pro_offered_services ✓');
      }
    }

    const finalRes = await pool.query(
      'SELECT r.id, r.service_name, r.status, r.pro_id, u.full_name, u.phone_number FROM pending_service_requests r JOIN users u ON r.pro_id = u.id'
    );
    console.log('Current service requests in database:', finalRes.rows);
    process.exit(0);
  } catch (err) {
    console.error('Error fixing custom requests:', err);
    process.exit(1);
  }
}

main();
