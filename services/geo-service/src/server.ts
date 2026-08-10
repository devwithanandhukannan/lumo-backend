import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest } from '@lumo/common';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5006;

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Geo & Location Service' }));

// Haversine formula distance calculation in KM
function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 1. Proximity Check & Coverage Validation
app.post('/api/v1/geo/proximity-check', async (req, res) => {
  try {
    const { originLat, originLng, destLat, destLng, maxRadiusKm = 50 } = req.body;
    if (originLat === undefined || originLng === undefined || destLat === undefined || destLng === undefined) {
      return res.status(400).json({ success: false, message: 'originLat, originLng, destLat, destLng are required' });
    }

    const distanceKm = haversineDistanceKm(
      parseFloat(originLat),
      parseFloat(originLng),
      parseFloat(destLat),
      parseFloat(destLng)
    );

    const isWithinCoverage = distanceKm <= parseFloat(maxRadiusKm);

    res.json({
      success: true,
      data: {
        distanceKm: Math.round(distanceKm * 100) / 100,
        maxRadiusKm: parseFloat(maxRadiusKm),
        isWithinCoverage,
        message: isWithinCoverage
          ? `Target location is within ${Math.round(distanceKm)} km service area`
          : `Target location (${Math.round(distanceKm)} km) exceeds maximum service radius (${maxRadiusKm} km)`,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

import { randomUUID } from 'crypto';

// Self-healing DB check for service_suspensions
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_suspensions (
          id VARCHAR(50) PRIMARY KEY,
          title VARCHAR(150) NOT NULL,
          reason_category VARCHAR(50) NOT NULL DEFAULT 'OTHER',
          custom_message TEXT NOT NULL,
          boundary_type VARCHAR(20) NOT NULL DEFAULT 'POLYGON',
          polygon_geojson JSONB,
          center_latitude DOUBLE PRECISION,
          center_longitude DOUBLE PRECISION,
          radius_km NUMERIC(6,2) DEFAULT 5.00,
          affected_pincodes TEXT[],
          affected_category_ids TEXT[],
          severity VARCHAR(30) NOT NULL DEFAULT 'FULL_BLACKOUT',
          is_active BOOLEAN DEFAULT TRUE,
          starts_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          created_by VARCHAR(50),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_service_suspensions_active ON service_suspensions (is_active, starts_at, expires_at);
    `);
  } catch (err: any) {
    console.warn('⚠️ Geo Service DB Migration check:', err?.message || err);
  }
})();

// Ray-casting Point-in-Polygon algorithm for GeoJSON Polygon ring
function isPointInRing(latitude: number, longitude: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]; // ring[i] is [lng, lat]
    const xj = ring[j][0], yj = ring[j][1]; // ring[j] is [lng, lat]

    const intersect = ((yi > latitude) !== (yj > latitude)) &&
      (longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Evaluates point against GeoJSON Geometry (Polygon or MultiPolygon)
function isPointInGeoJSONGeometry(latitude: number, longitude: number, geojson: any): boolean {
  if (!geojson) return false;
  
  // Extract geometry if full GeoJSON Feature is passed
  const geometry = geojson.type === 'Feature' ? geojson.geometry : geojson;
  if (!geometry || !geometry.coordinates) return false;

  if (geometry.type === 'Polygon') {
    // coordinates: [ outerRing, hole1, hole2, ... ]
    const outerRing = geometry.coordinates[0];
    if (!outerRing) return false;
    const inOuter = isPointInRing(latitude, longitude, outerRing);
    if (!inOuter) return false;
    // Check if in any holes (if in hole, then outside)
    for (let h = 1; h < geometry.coordinates.length; h++) {
      if (isPointInRing(latitude, longitude, geometry.coordinates[h])) {
        return false;
      }
    }
    return true;
  } else if (geometry.type === 'MultiPolygon') {
    // coordinates: [ [polygon1Rings], [polygon2Rings] ]
    for (const polygonCoords of geometry.coordinates) {
      const outerRing = polygonCoords[0];
      if (outerRing && isPointInRing(latitude, longitude, outerRing)) {
        let inHole = false;
        for (let h = 1; h < polygonCoords.length; h++) {
          if (isPointInRing(latitude, longitude, polygonCoords[h])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
  }
  return false;
}

const TOWN_COORDINATES: Record<string, { lat: number; lng: number }> = {
  thottikkanam: { lat: 9.8601, lng: 76.9697 },
  idukki: { lat: 9.8500, lng: 76.9700 },
  senapathy: { lat: 9.8550, lng: 77.0100 },
  munnar: { lat: 10.0889, lng: 77.0595 },
  kochi: { lat: 9.9312, lng: 76.2673 },
  ernakulam: { lat: 9.9816, lng: 76.2999 },
  trivandrum: { lat: 8.5241, lng: 76.9366 },
  thiruvananthapuram: { lat: 8.5241, lng: 76.9366 },
  bangalore: { lat: 12.9716, lng: 77.5946 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  mumbai: { lat: 19.0760, lng: 72.8777 },
};

// 2. Check Emergency Service Suspension for a location
app.post('/api/v1/geo/check-suspension', async (req, res) => {
  try {
    const { latitude, longitude, categoryId, pincode, locationName } = req.body;
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'latitude and longitude are required' });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    // Query active suspensions where current time is between starts_at and expires_at
    const result = await pool.query(`
      SELECT * FROM service_suspensions 
      WHERE is_active = TRUE 
        AND starts_at <= NOW() 
        AND (expires_at IS NULL OR expires_at >= NOW())
      ORDER BY created_at DESC
    `);

    for (const s of result.rows) {
      // 1. Check Category Match (if affected_category_ids specified)
      if (s.affected_category_ids && s.affected_category_ids.length > 0 && categoryId) {
        if (!s.affected_category_ids.includes(categoryId)) continue;
      }

      let isInside = false;

      // Geocode fallback coordinates if locationName is provided
      let evalLat = lat;
      let evalLng = lng;
      if (locationName && (Math.abs(lat - 12.9716) < 0.01 && Math.abs(lng - 77.5946) < 0.01)) {
        const locLower = locationName.toString().toLowerCase();
        for (const [town, coords] of Object.entries(TOWN_COORDINATES)) {
          if (locLower.includes(town)) {
            evalLat = coords.lat;
            evalLng = coords.lng;
            break;
          }
        }
      }

      // 2. Check Boundary Type
      if (['POLYGON', 'DISTRICT', 'STATE', 'COUNTRY'].includes(s.boundary_type) && s.polygon_geojson) {
        let geojson = s.polygon_geojson;
        if (typeof geojson === 'string') {
          try { geojson = JSON.parse(geojson); } catch (_) {}
        }
        isInside = isPointInGeoJSONGeometry(evalLat, evalLng, geojson);
      } else if (s.boundary_type === 'RADIUS' && s.center_latitude !== null && s.center_longitude !== null) {
        const dist = haversineDistanceKm(evalLat, evalLng, s.center_latitude, s.center_longitude);
        isInside = dist <= parseFloat(s.radius_km || 5);
      }
      
      // 3. Secondary check: Pincode array match
      if (!isInside && s.affected_pincodes && pincode) {
        const pList = Array.isArray(s.affected_pincodes)
          ? s.affected_pincodes
          : typeof s.affected_pincodes === 'string'
          ? (s.affected_pincodes as string).split(',').map((p: string) => p.trim())
          : [];
        isInside = pList.includes(pincode.toString().trim());
      }

      // 4. Secondary check: Location / Region name text match (e.g. "Idukki", "Senapathy", "Kerala", "Thottikkanam")
      if (!isInside && locationName) {
        const locParts = locationName.toString().toLowerCase().split(',').map((p: string) => p.trim()).filter((p: string) => p.length >= 3);
        const title = (s.title || '').toString().toLowerCase().trim();
        const msg = (s.custom_message || '').toString().toLowerCase().trim();
        const area = (s.area_name || '').toString().toLowerCase().trim();
        for (const part of locParts) {
          if (title.includes(part) || part.includes(title) || msg.includes(part) || (area && (area.includes(part) || part.includes(area)))) {
            isInside = true;
            break;
          }
        }
      }

      if (isInside) {
        return res.json({
          success: true,
          isSuspended: true,
          suspension: {
            id: s.id,
            title: s.title,
            reasonCategory: s.reason_category,
            message: s.custom_message,
            boundaryType: s.boundary_type,
            severity: s.severity,
            startsAt: s.starts_at,
            expiresAt: s.expires_at,
            areaName: s.area_name || s.title,
          },
        });
      }
    }

    return res.json({ success: true, isSuspended: false });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Admin: List All Service Suspensions
app.get('/api/v1/geo/suspensions', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM service_suspensions ORDER BY created_at DESC`);
    res.json({ success: true, data: result.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Admin: Create New Service Suspension (GeoJSON Polygon or Radius)
app.post('/api/v1/geo/suspensions', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const {
      title,
      reasonCategory = 'OTHER',
      customMessage,
      boundaryType = 'POLYGON',
      polygonGeoJson,
      centerLatitude,
      centerLongitude,
      radiusKm = 5,
      affectedPincodes = [],
      affectedCategoryIds = [],
      severity = 'FULL_BLACKOUT',
      startsAt,
      expiresAt,
      expiresInHours,
      createdBy,
    } = req.body;

    if (!title || !customMessage) {
      return res.status(400).json({ success: false, message: 'title and customMessage are required' });
    }

    const id = `susp-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const startsAtDate = startsAt ? new Date(startsAt).toISOString() : new Date().toISOString();
    let expiresAtDate = expiresAt ? new Date(expiresAt).toISOString() : null;
    if (!expiresAtDate && expiresInHours) {
      expiresAtDate = new Date(Date.now() + parseFloat(expiresInHours) * 3600 * 1000).toISOString();
    }

    const result = await pool.query(
      `INSERT INTO service_suspensions (
        id, title, reason_category, custom_message, boundary_type, polygon_geojson,
        center_latitude, center_longitude, radius_km, affected_pincodes,
        affected_category_ids, severity, is_active, starts_at, expires_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, $13, $14, $15)
      RETURNING *`,
      [
        id,
        title,
        reasonCategory,
        customMessage,
        boundaryType,
        polygonGeoJson ? (typeof polygonGeoJson === 'object' ? JSON.stringify(polygonGeoJson) : polygonGeoJson) : null,
        centerLatitude ? parseFloat(centerLatitude) : null,
        centerLongitude ? parseFloat(centerLongitude) : null,
        parseFloat(radiusKm),
        affectedPincodes,
        affectedCategoryIds,
        severity,
        startsAtDate,
        expiresAtDate,
        createdBy || req.user?.userId || null,
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0], message: 'Emergency blackout rule created successfully' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Admin: Toggle Suspension Active Status
app.patch('/api/v1/geo/suspensions/:id/toggle', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const result = await pool.query(
      `UPDATE service_suspensions SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [Boolean(isActive), id]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Suspension not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Admin: Delete Service Suspension
app.delete('/api/v1/geo/suspensions/:id', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM service_suspensions WHERE id = $1`, [id]);
    res.json({ success: true, message: 'Suspension rule deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(PORT, () => console.log(`📍 Geo & Location Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
