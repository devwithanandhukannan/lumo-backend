import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { errorHandler, AppError } from '@lumo/common';
import { randomUUID } from 'crypto';

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

      CREATE TABLE IF NOT EXISTS pending_service_requests (
          id VARCHAR(50) PRIMARY KEY,
          pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service_name VARCHAR(100) NOT NULL,
          description TEXT,
          suggested_price NUMERIC(10,2),
          category_id VARCHAR(50),
          status VARCHAR(30) DEFAULT 'PENDING_ADMIN_APPROVAL',
          admin_notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
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

app.post('/api/v1/catalog/categories', async (req, res, next) => {
  try {
    const { name, description, iconUrl } = req.body;
    if (!name) throw new AppError('Category name is required', 400);

    const id = `cat-${randomUUID().slice(0, 8)}`;
    const result = await pool.query(
      `INSERT INTO service_categories (id, name, description, icon_url) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, name, description || '', iconUrl || null]
    );

    res.status(201).json({ success: true, data: result.rows[0], message: 'Service category created successfully' });
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

app.post('/api/v1/catalog/services', async (req, res, next) => {
  try {
    const { categoryId, name, description, basePrice, durationMinutes } = req.body;
    if (!name || !categoryId || basePrice === undefined) {
      throw new AppError('Name, categoryId, and basePrice are required', 400);
    }

    const id = `srv-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO services (id, category_id, name, description, base_price, duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, categoryId, name, description || '', parseFloat(basePrice), parseInt(durationMinutes || '60', 10)]
    );

    const fullService = await pool.query(
      `SELECT s.*, c.name as category_name FROM services s JOIN service_categories c ON s.category_id = c.id WHERE s.id = $1`,
      [id]
    );

    console.log(`✨ [ADMIN-SERVICE-ADDED] Created service "${name}" (Price: ₹${basePrice})`);

    res.status(201).json({
      success: true,
      data: fullService.rows[0],
      message: 'New service created and listed for professionals'
    });
  } catch (err) { next(err); }
});

app.delete('/api/v1/catalog/services/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE services SET is_active = false WHERE id = $1', [id]);
    res.json({ success: true, message: 'Service removed from catalog' });
  } catch (err) { next(err); }
});

// ─── PENDING PROFESSIONAL SERVICE REQUESTS (ADMIN REVIEW) ──────────────────────

app.get('/api/v1/catalog/service-requests', async (req, res, next) => {
  try {
    await ensureCatalogSchema();
    const requests = await pool.query(`
      SELECT r.*, u.full_name as pro_name, u.phone_number as pro_phone
      FROM pending_service_requests r
      JOIN users u ON r.pro_id = u.id
      ORDER BY CASE WHEN r.status = 'PENDING_ADMIN_APPROVAL' THEN 1 ELSE 2 END, r.created_at DESC
    `);
    res.json({ success: true, data: requests.rows });
  } catch (err) { next(err); }
});

app.post('/api/v1/catalog/service-requests/:id/approve', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { categoryId, basePrice } = req.body;

    const reqRes = await pool.query('SELECT * FROM pending_service_requests WHERE id = $1', [id]);
    const reqItem = reqRes.rows[0];

    if (!reqItem) throw new AppError('Service request not found', 404);

    const price = basePrice ? parseFloat(basePrice) : (reqItem.suggested_price ? parseFloat(reqItem.suggested_price) : 299.00);
    const catId = categoryId || reqItem.category_id || 'cat-clean';
    const srvId = `srv-${randomUUID().slice(0, 8)}`;

    // Add to active services catalog
    await pool.query(
      `INSERT INTO services (id, category_id, name, description, base_price, duration_minutes)
       VALUES ($1, $2, $3, $4, $5, 60)`,
      [srvId, catId, reqItem.service_name, reqItem.description || '', price]
    );

    // Update request status to APPROVED
    await pool.query(
      `UPDATE pending_service_requests SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    console.log(`✅ [SERVICE-REQUEST-APPROVED] Approved "${reqItem.service_name}" into service catalog`);

    res.json({
      success: true,
      message: `Approved service "${reqItem.service_name}" into live catalog`,
    });
  } catch (err) { next(err); }
});

app.post('/api/v1/catalog/service-requests/:id/reject', async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE pending_service_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ success: true, message: 'Service request rejected' });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`📦 Catalog Service running on port ${PORT}`));
