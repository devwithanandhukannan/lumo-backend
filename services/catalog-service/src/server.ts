import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5004;

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Catalog Service' }));

function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.get('/api/v1/catalog/categories', async (req, res, next) => {
  try {
    const categories = await pool.query('SELECT * FROM service_categories WHERE is_active = true ORDER BY name ASC');
    res.json({ success: true, data: categories.rows });
  } catch (err) { next(err); }
});

app.get('/api/v1/catalog/services', async (req, res, next) => {
  try {
    const categoryId = req.query.categoryId as string | undefined;
    const latStr = req.query.latitude as string | undefined;
    const lngStr = req.query.longitude as string | undefined;

    let query = 'SELECT s.*, c.name as category_name FROM services s JOIN service_categories c ON s.category_id = c.id WHERE s.is_active = true';
    const params: any[] = [];

    if (categoryId) {
      query += ' AND s.category_id = $1';
      params.push(categoryId);
    }
    query += ' ORDER BY s.name ASC';

    const servicesRes = await pool.query(query, params);
    let services = servicesRes.rows;

    if (latStr && lngStr) {
      const custLat = parseFloat(latStr);
      const custLng = parseFloat(lngStr);

      const prosRes = await pool.query(`
        SELECT u.id as pro_id, u.gender, p.coverage_radius_km, p.current_location, p.latitude, p.longitude
        FROM users u
        JOIN professional_profiles p ON u.id = p.user_id
        WHERE u.role = 'PROFESSIONAL'
          AND p.verification_status IN ('APPROVED', 'PENDING')
          AND p.is_busy = false
      `);
      const pros = prosRes.rows;

      services = services.map(service => {
        const matchingPros = pros.filter(pro => {
          let curLoc = pro.current_location;
          if (typeof curLoc === 'string') {
            try { curLoc = JSON.parse(curLoc); } catch (_) {}
          }
          const proLat = parseFloat(pro.latitude || curLoc?.latitude || curLoc?.lat || custLat.toString());
          const proLng = parseFloat(pro.longitude || curLoc?.longitude || curLoc?.lng || custLng.toString());
          const radiusKm = parseFloat(pro.coverage_radius_km || '50.00');
          const dist = calculateDistanceKm(custLat, custLng, proLat, proLng);
          return dist <= radiusKm;
        });

        return {
          ...service,
          available_pros_count: matchingPros.length,
          is_available: matchingPros.length > 0,
        };
      });
    } else {
      services = services.map(service => ({
        ...service,
        available_pros_count: 1,
        is_available: true,
      }));
    }

    res.json({ success: true, data: services });
  } catch (err) { next(err); }
});

// Update 3: List professionals available for a specific service in customer range
app.get('/api/v1/catalog/services/:serviceId/professionals', async (req, res, next) => {
  try {
    const { serviceId } = req.params;
    const customerLat = parseFloat(req.query.lat as string);
    const customerLng = parseFloat(req.query.lng as string);
    const femaleOnly = req.query.femaleOnly === 'true';
    const sortBy = (req.query.sortBy as 'distance' | 'rating' | 'price') || 'distance';

    if (isNaN(customerLat) || isNaN(customerLng)) {
      res.status(400).json({ success: false, message: 'lat and lng query params are required' });
      return;
    }

    const query = `
      SELECT u.id, u.full_name, u.gender,
             pp.latitude, pp.longitude, pp.rating_avg,
             pp.total_jobs_completed, pp.coverage_radius_km,
             pos.km_charge_per_km, pos.custom_price as service_price
      FROM pro_offered_services pos
      JOIN professional_profiles pp ON pp.user_id = pos.pro_id
      JOIN users u ON u.id = pos.pro_id
      WHERE pos.service_id = $1
        AND pos.is_active = true
        AND pp.is_blacklisted = false
        ${femaleOnly ? "AND u.gender = 'FEMALE'" : ''}
    `;

    const prosRes = await pool.query(query, [serviceId]);
    const pros = prosRes.rows;

    const nearbyPros = pros
      .map((p) => {
        const pLat = parseFloat(p.latitude) || customerLat;
        const pLng = parseFloat(p.longitude) || customerLng;
        const distKm = calculateDistanceKm(customerLat, customerLng, pLat, pLng);
        const kmCharge = parseFloat(p.km_charge_per_km) || 15;
        const basePrice = parseFloat(p.service_price) || 0;
        const travelCharge = parseFloat((distKm * kmCharge).toFixed(2));
        const estimatedTotal = parseFloat((basePrice + travelCharge).toFixed(2));
        return {
          proId: p.id,
          name: p.full_name,
          gender: p.gender,
          ratingAvg: parseFloat(p.rating_avg) || 5.0,
          totalJobsCompleted: p.total_jobs_completed || 0,
          distanceKm: parseFloat(distKm.toFixed(2)),
          kmCharge,
          serviceBasePrice: basePrice,
          travelCharge,
          estimatedTotal,
          coverageRadiusKm: parseFloat(p.coverage_radius_km) || 50,
        };
      })
      .filter((p) => p.distanceKm <= p.coverageRadiusKm);

    if (sortBy === 'rating') {
      nearbyPros.sort((a, b) => b.ratingAvg - a.ratingAvg);
    } else if (sortBy === 'price') {
      nearbyPros.sort((a, b) => a.estimatedTotal - b.estimatedTotal);
    } else {
      nearbyPros.sort((a, b) => a.distanceKm - b.distanceKm);
    }

    res.json({ success: true, data: nearbyPros });
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
