import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { AppError } from '../middleware/error.middleware';

export class ProfessionalService {
  private async getOrCreateProfile(userId: string) {
    const res = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [userId]);
    if (res.rows.length > 0) {
      return res.rows[0];
    }

    const proProfId = `pro-prof-${randomUUID().slice(0, 8)}`;
    const insertRes = await pool.query(
      `INSERT INTO professional_profiles (id, user_id, verification_status, documents, face_verified, is_online, is_busy, rating_avg, total_jobs_completed, acceptance_rate, cancellation_rate, account_health_score, is_blacklisted)
       VALUES ($1, $2, 'PENDING', '{}'::jsonb, false, false, false, 5.0, 0, 100.0, 0.0, 100.0, false)
       RETURNING *`,
      [proProfId, userId]
    );

    return insertRes.rows[0];
  }

  // 1. Submit Onboarding Documents
  async submitDocuments(
    userId: string,
    data: {
      govtIdType: 'AADAAR' | 'PASSPORT' | 'DRIVING_LICENSE' | 'VOTER_ID';
      govtIdNumber: string;
      govtIdDocUrl: string;
      policeVerificationPdfUrl: string;
      certifications?: string[];
    }
  ) {
    await this.getOrCreateProfile(userId);

    const documentsObj = {
      govtIdType: data.govtIdType,
      govtIdNumber: data.govtIdNumber,
      govtIdDocUrl: data.govtIdDocUrl,
      policeVerificationPdfUrl: data.policeVerificationPdfUrl,
      certifications: data.certifications || [],
      submittedAt: new Date().toISOString(),
    };

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET documents = $1, verification_status = 'IN_REVIEW', verification_notes = 'Documents submitted. Awaiting Admin verification.', updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [JSON.stringify(documentsObj), userId]
    );

    const updated = updateRes.rows[0];
    return {
      message: 'Onboarding verification documents submitted successfully',
      verificationStatus: updated.verification_status,
      documents: updated.documents,
    };
  }

  // 2. Submit Live Face Verification Selfie
  async submitFaceVerification(userId: string, faceImageUrl: string) {
    await this.getOrCreateProfile(userId);

    if (!faceImageUrl) {
      throw new AppError('Face verification selfie image URL is required', 400, 'MISSING_FACE_IMAGE');
    }

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET face_verification_url = $1, face_verified = true, updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [faceImageUrl, userId]
    );

    const updated = updateRes.rows[0];
    return {
      message: 'Face verification completed successfully',
      faceVerified: updated.face_verified,
      faceVerificationUrl: updated.face_verification_url,
    };
  }

  // 3. Get Verification Pipeline Status
  async getVerificationStatus(userId: string) {
    const profile = await this.getOrCreateProfile(userId);
    const docs = typeof profile.documents === 'string' ? JSON.parse(profile.documents) : profile.documents || {};

    return {
      verificationStatus: profile.verification_status,
      verificationNotes: profile.verification_notes || 'Awaiting document submissions.',
      faceVerified: profile.face_verified,
      documentsSubmitted: !!docs.submittedAt,
      documents: docs,
      isBlacklisted: profile.is_blacklisted,
    };
  }

  // 4. Get Algorithmic Account Health Panel
  async getAccountHealth(userId: string) {
    const profile = await this.getOrCreateProfile(userId);

    const ratingAvg = parseFloat(profile.rating_avg);
    const acceptanceRate = parseFloat(profile.acceptance_rate);
    const cancellationRate = parseFloat(profile.cancellation_rate);

    const ratingComponent = (ratingAvg / 5.0) * 50;
    const acceptanceComponent = acceptanceRate * 0.3;
    const penaltyComponent = cancellationRate * 0.5;
    const computedHealthScore = Math.max(0, Math.min(100, ratingComponent + acceptanceComponent - penaltyComponent));

    const finalScore = parseFloat(computedHealthScore.toFixed(1));

    await pool.query('UPDATE professional_profiles SET account_health_score = $1 WHERE user_id = $2', [finalScore, userId]);

    let healthStatus: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'CRITICAL_RISK' = 'EXCELLENT';
    let warningMessage = undefined;

    if (finalScore < 60) {
      healthStatus = 'CRITICAL_RISK';
      warningMessage = 'CRITICAL: Account health score is below 60. Account is at risk of suspension.';
    } else if (finalScore < 75) {
      healthStatus = 'WARNING';
      warningMessage = 'WARNING: Low response or cancellation rates detected. Please improve acceptance rate.';
    } else if (finalScore < 90) {
      healthStatus = 'GOOD';
    }

    return {
      accountHealthScore: finalScore,
      healthStatus,
      warningMessage,
      metrics: {
        totalJobsCompleted: profile.total_jobs_completed,
        ratingAvg: ratingAvg,
        acceptanceRate: `${acceptanceRate}%`,
        cancellationRate: `${cancellationRate}%`,
      },
      isBlacklisted: profile.is_blacklisted,
    };
  }

  // 5. Toggle Online Duty Status & GPS Location Update
  async updateDutyStatus(
    userId: string,
    data: { isOnline: boolean; latitude?: number; longitude?: number }
  ) {
    const profile = await this.getOrCreateProfile(userId);

    if (profile.verification_status !== 'APPROVED') {
      throw new AppError(
        `Cannot go online. Account verification status is ${profile.verification_status}. Must be APPROVED by Admin.`,
        403,
        'VERIFICATION_REQUIRED'
      );
    }

    if (profile.is_blacklisted) {
      throw new AppError('Cannot go online. Account is blacklisted due to safety violations.', 403, 'ACCOUNT_BLACKLISTED');
    }

    let locationJson = profile.current_location;
    if (data.latitude !== undefined && data.longitude !== undefined) {
      locationJson = {
        latitude: data.latitude,
        longitude: data.longitude,
        updatedAt: new Date().toISOString(),
      };
    }

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET is_online = $1, current_location = $2,
           latitude = COALESCE($3, latitude),
           longitude = COALESCE($4, longitude),
           updated_at = NOW()
       WHERE user_id = $5
       RETURNING *`,
      [
        data.isOnline,
        JSON.stringify(locationJson),
        data.latitude ?? null,
        data.longitude ?? null,
        userId,
      ]
    );

    const updated = updateRes.rows[0];
    const parsedLoc = typeof updated.current_location === 'string' ? JSON.parse(updated.current_location) : updated.current_location;

    return {
      isOnline: updated.is_online,
      isBusy: updated.is_busy,
      currentLocation: parsedLoc,
      message: updated.is_online ? 'Duty status set to ONLINE. You can now receive job requests.' : 'Duty status set to OFFLINE.',
    };
  }

  // 6. Get Training Modules
  async getTrainingModules(userId: string) {
    const modRes = await pool.query('SELECT * FROM training_modules ORDER BY is_required DESC, title ASC');
    const progRes = await pool.query('SELECT * FROM user_training_progress WHERE user_id = $1', [userId]);

    const userProgress = progRes.rows;

    const modulesWithStatus = modRes.rows.map((mod) => {
      const progress = userProgress.find((p) => p.module_id === mod.id);
      return {
        id: mod.id,
        title: mod.title,
        description: mod.description,
        durationMinutes: mod.duration_minutes,
        category: mod.category,
        passingScore: mod.passing_score,
        isRequired: mod.is_required,
        isCompleted: progress ? progress.passed : false,
        score: progress ? progress.score : null,
        completedAt: progress ? progress.completed_at : null,
      };
    });

    const totalRequired = modulesWithStatus.filter((m) => m.isRequired).length;
    const completedRequired = modulesWithStatus.filter((m) => m.isRequired && m.isCompleted).length;

    return {
      trainingComplianceStatus: completedRequired === totalRequired ? 'FULLY_COMPLIANT' : 'PENDING_TRAINING',
      requiredCompletedCount: completedRequired,
      totalRequiredCount: totalRequired,
      modules: modulesWithStatus,
    };
  }

  // 7. Complete Training Module Quiz
  async submitTrainingQuiz(userId: string, moduleId: string, score: number) {
    const modRes = await pool.query('SELECT * FROM training_modules WHERE id = $1', [moduleId]);
    const module = modRes.rows[0];

    if (!module) {
      throw new AppError('Training module not found', 404, 'MODULE_NOT_FOUND');
    }

    const passed = score >= module.passing_score;

    await pool.query(
      `INSERT INTO user_training_progress (user_id, module_id, score, passed, completed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, module_id) DO UPDATE SET score = $3, passed = $4, completed_at = NOW()`,
      [userId, moduleId, score, passed]
    );

    return {
      moduleId: module.id,
      moduleTitle: module.title,
      score,
      passingScore: module.passing_score,
      passed,
      message: passed
        ? `Congratulations! You passed module '${module.title}'.`
        : `Score ${score}% is below passing requirement of ${module.passing_score}%. Please review and retry.`,
    };
  }
  // 8. Offered Services Management
  async saveOfferedServices(userId: string, services: Array<{ serviceId: string; customPrice?: number; kmCharge?: number }>) {
    await this.getOrCreateProfile(userId);
    const results = [];
    for (const item of services) {
      const customPrice = item.customPrice ?? null;
      const kmCharge = item.kmCharge ?? 15.00;
      const res = await pool.query(
        `INSERT INTO pro_offered_services (id, pro_id, service_id, custom_price, km_charge_per_km, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         ON CONFLICT (pro_id, service_id) 
         DO UPDATE SET custom_price = COALESCE($4, pro_offered_services.custom_price),
                       km_charge_per_km = COALESCE($5, pro_offered_services.km_charge_per_km),
                       is_active = true,
                       updated_at = NOW()
         RETURNING *`,
        [`pos-${randomUUID().slice(0, 8)}`, userId, item.serviceId, customPrice, kmCharge]
      );
      results.push(res.rows[0]);
    }
    return results;
  }

  async getOfferedServices(userId: string) {
    const res = await pool.query(
      `SELECT pos.*, s.name as service_name, s.category_id, s.base_price, s.icon
       FROM pro_offered_services pos
       JOIN services s ON s.id = pos.service_id
       WHERE pos.pro_id = $1
       ORDER BY s.name ASC`,
      [userId]
    );
    return res.rows;
  }

  async updateServicePrice(userId: string, serviceId: string, customPrice: number, kmCharge?: number) {
    const res = await pool.query(
      `UPDATE pro_offered_services
       SET custom_price = $1, km_charge_per_km = COALESCE($2, km_charge_per_km), updated_at = NOW()
       WHERE pro_id = $3 AND service_id = $4
       RETURNING *`,
      [customPrice, kmCharge ?? null, userId, serviceId]
    );
    if (res.rows.length === 0) {
      throw new AppError('Offered service not found', 404, 'NOT_FOUND');
    }
    return res.rows[0];
  }

  async toggleServiceStatus(userId: string, serviceId: string, isActive: boolean) {
    const res = await pool.query(
      `UPDATE pro_offered_services
       SET is_active = $1, updated_at = NOW()
       WHERE pro_id = $2 AND service_id = $3
       RETURNING *`,
      [isActive, userId, serviceId]
    );
    if (res.rows.length === 0) {
      throw new AppError('Offered service not found', 404, 'NOT_FOUND');
    }
    return res.rows[0];
  }

  async deleteOfferedService(userId: string, serviceId: string) {
    await pool.query('DELETE FROM pro_offered_services WHERE pro_id = $1 AND service_id = $2', [userId, serviceId]);
    return { message: 'Service removed from offered list' };
  }
}

export const professionalService = new ProfessionalService();

