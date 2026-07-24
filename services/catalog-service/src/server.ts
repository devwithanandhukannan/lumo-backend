import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { errorHandler } from '@lumo/common';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5004;

app.use(cors());
app.use(express.json());

async function ensureCatalogSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_categories (
          id VARCHAR(50) PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          icon_url TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS services (
          id VARCHAR(50) PRIMARY KEY,
          category_id VARCHAR(50) NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          base_price NUMERIC(10,2) NOT NULL,
          duration_minutes INT NOT NULL DEFAULT 60,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO service_categories (id, name, description) VALUES
      ('cat-clean', 'Cleaning Services', 'Home deep cleaning, kitchen & bathroom sanitization'),
      ('cat-elec', 'Electrical Repair', 'Wiring, switchboard, fan & appliance repairs'),
      ('cat-plumb', 'Plumbing Care', 'Tap leak fix, pipe repair & unblocking'),
      ('cat-salon', 'Salon & Spa', 'Home haircut, facial & grooming'),
      ('cat-safe', 'Safety Services', 'Verified safety escort & security')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO services (id, category_id, name, description, base_price, duration_minutes) VALUES
      ('srv-clean-01', 'cat-clean', 'Home Deep Cleaning', 'Full house deep cleaning & sanitization', 499.00, 120),
      ('srv-clean-02', 'cat-clean', 'Kitchen Cleaning', 'Degreasing, counter & appliance cleaning', 349.00, 60),
      ('srv-elec-01', 'cat-elec', 'Switch & Socket Repair', 'Fix loose wiring, burnt sockets & switches', 199.00, 30),
      ('srv-elec-02', 'cat-elec', 'Fan Installation & Repair', 'Ceiling/exhaust fan mounting & regulator fix', 249.00, 45),
      ('srv-plumb-01', 'cat-plumb', 'Tap Leak Fix', 'Repair leaking taps, replace washers & valves', 249.00, 30),
      ('srv-plumb-02', 'cat-plumb', 'Pipe Leak Repair', 'Fix PVC/metal pipe joints & drainage leaks', 349.00, 60)
      ON CONFLICT (id) DO NOTHING;
    `);
  } catch (err: any) {
    console.warn('⚠️ Catalog schema warning:', err.message);
  }
}

ensureCatalogSchema();

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Catalog Service' }));

app.get('/api/v1/catalog/categories', async (req, res, next) => {
  try {
    await ensureCatalogSchema();
    const categories = await pool.query('SELECT * FROM service_categories WHERE is_active = true ORDER BY name ASC');
    res.json({ success: true, data: categories.rows });
  } catch (err) { next(err); }
});

app.get('/api/v1/catalog/services', async (req, res, next) => {
  try {
    await ensureCatalogSchema();
    const categoryId = req.query.categoryId as string | undefined;
    let query = 'SELECT s.*, c.name as category_name FROM services s JOIN service_categories c ON s.category_id = c.id WHERE s.is_active = true';
    const params: any[] = [];

    if (categoryId) {
      query += ' AND s.category_id = $1';
      params.push(categoryId);
    }
    query += ' ORDER BY s.name ASC';

    const services = await pool.query(query, params);
    res.json({ success: true, data: services.rows });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`📦 Catalog Service running on port ${PORT}`));
