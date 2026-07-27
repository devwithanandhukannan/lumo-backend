import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';

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

const server = app.listen(PORT, () => console.log(`📍 Geo & Location Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
