import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5003;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Pro Service' }));

app.get('/api/v1/pro/health', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [req.user!.userId]);
    const pro = proRes.rows[0];
    if (!pro) throw new AppError('Professional profile not found', 404);

    res.json({
      success: true,
      data: {
        accountHealthScore: parseFloat(pro.account_health_score),
        ratingAvg: parseFloat(pro.rating_avg),
        totalJobsCompleted: pro.total_jobs_completed,
        acceptanceRate: parseFloat(pro.acceptance_rate),
        cancellationRate: parseFloat(pro.cancellation_rate),
        verificationStatus: pro.verification_status,
      },
    });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`👷 Pro Service running on port ${PORT}`));
