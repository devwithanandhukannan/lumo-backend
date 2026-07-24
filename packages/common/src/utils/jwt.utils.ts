import jwt from 'jsonwebtoken';
import { AppError } from '../errors/AppError';

export type UserRole = 'CUSTOMER' | 'PROFESSIONAL' | 'ADMIN' | 'SUPER_ADMIN';

export interface TokenPayload {
  userId: string;
  role: UserRole;
  phoneNumber?: string;
}

const JWT_SECRET = process.env.JWT_SECRET || 'lumo_super_secret_jwt_key_2026_safety_first';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'lumo_super_secret_refresh_jwt_key_2026';

export const generateAccessToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
};

export const verifyAccessToken = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (err: any) {
    throw new AppError('Invalid or expired access token', 401, 'INVALID_TOKEN');
  }
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
  } catch (err: any) {
    throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }
};
