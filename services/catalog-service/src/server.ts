import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5004;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Catalog Service' }));

app.get('/api/v1/catalog/categories', async (req, res, next) => {
  try {
    const categories = await pool.query('SELECT * FROM service_categories WHERE is_active = true ORDER BY name ASC');
    res.json({ success: true, data: categories.rows });
  } catch (err) { next(err); }
});

app.get('/api/v1/catalog/services', async (req, res, next) => {
  try {
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

app.delete('/api/v1/catalog/service-requests/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pending_service_requests WHERE id = $1', [id]);
    res.json({ success: true, message: 'Service request deleted' });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`📦 Catalog Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
