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

app.use(errorHandler);

app.listen(PORT, () => console.log(`📦 Catalog Service running on port ${PORT}`));
