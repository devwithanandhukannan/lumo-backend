import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { Gender } from '../db/memoryDb';
import { AppError } from '../middleware/error.middleware';

export class UserService {
  // Get Current User Profile
  async getUserProfile(userId: string) {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    let professionalDetails = undefined;
    if (user.role === 'PROFESSIONAL') {
      const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [userId]);
      professionalDetails = proRes.rows[0];
    }

    const locRes = await pool.query('SELECT * FROM saved_locations WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [userId]);

    return {
      user: {
        id: user.id,
        phoneNumber: user.phone_number,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        gender: user.gender,
        avatarUrl: user.avatar_url,
        isActive: user.is_active,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
      professionalProfile: professionalDetails,
      savedLocations: locRes.rows.map((loc) => ({
        id: loc.id,
        userId: loc.user_id,
        label: loc.label,
        addressText: loc.address_text,
        latitude: loc.latitude,
        longitude: loc.longitude,
        isDefault: loc.is_default,
        createdAt: loc.created_at,
      })),
    };
  }

  // Update Profile Details
  async updateProfile(userId: string, data: { fullName?: string; email?: string; gender?: Gender; avatarUrl?: string }) {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    if (data.email && data.email !== user.email) {
      const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [data.email, userId]);
      if (emailCheck.rows.length > 0) {
        throw new AppError('Email address is already in use by another account', 400, 'EMAIL_IN_USE');
      }
    }

    const newFullName = data.fullName || user.full_name;
    const newEmail = data.email !== undefined ? data.email : user.email;
    const newGender = data.gender || user.gender;
    const newAvatarUrl = data.avatarUrl !== undefined ? data.avatarUrl : user.avatar_url;

    const updateRes = await pool.query(
      `UPDATE users 
       SET full_name = $1, email = $2, gender = $3, avatar_url = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [newFullName, newEmail, newGender, newAvatarUrl, userId]
    );

    const updated = updateRes.rows[0];
    return {
      id: updated.id,
      phoneNumber: updated.phone_number,
      email: updated.email,
      fullName: updated.full_name,
      role: updated.role,
      gender: updated.gender,
      avatarUrl: updated.avatar_url,
      isActive: updated.is_active,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  }

  // Get Saved Locations
  async getSavedLocations(userId: string) {
    const locRes = await pool.query('SELECT * FROM saved_locations WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [userId]);
    return locRes.rows.map((loc) => ({
      id: loc.id,
      userId: loc.user_id,
      label: loc.label,
      addressText: loc.address_text,
      latitude: loc.latitude,
      longitude: loc.longitude,
      isDefault: loc.is_default,
      createdAt: loc.created_at,
    }));
  }

  // Add Saved Location
  async addSavedLocation(
    userId: string,
    data: { label: string; addressText: string; latitude: number; longitude: number; isDefault?: boolean }
  ) {
    const userRes = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const locCountRes = await pool.query('SELECT COUNT(*) FROM saved_locations WHERE user_id = $1', [userId]);
    const isFirstLocation = parseInt(locCountRes.rows[0].count, 10) === 0;
    const shouldBeDefault = data.isDefault ?? isFirstLocation;

    if (shouldBeDefault) {
      await pool.query('UPDATE saved_locations SET is_default = false WHERE user_id = $1', [userId]);
    }

    const locId = `loc-${randomUUID().slice(0, 8)}`;
    const insertRes = await pool.query(
      `INSERT INTO saved_locations (id, user_id, label, address_text, latitude, longitude, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [locId, userId, data.label, data.addressText, data.latitude, data.longitude, shouldBeDefault]
    );

    const loc = insertRes.rows[0];
    return {
      id: loc.id,
      userId: loc.user_id,
      label: loc.label,
      addressText: loc.address_text,
      latitude: loc.latitude,
      longitude: loc.longitude,
      isDefault: loc.is_default,
      createdAt: loc.created_at,
    };
  }

  // Delete Saved Location
  async deleteSavedLocation(userId: string, locationId: string) {
    const deleteRes = await pool.query('DELETE FROM saved_locations WHERE id = $1 AND user_id = $2 RETURNING id', [locationId, userId]);
    if (deleteRes.rows.length === 0) {
      throw new AppError('Location not found', 404, 'LOCATION_NOT_FOUND');
    }

    return { message: 'Location deleted successfully' };
  }
}

export const userService = new UserService();
