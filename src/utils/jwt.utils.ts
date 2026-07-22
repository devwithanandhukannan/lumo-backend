import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { UserRole } from '../db/memoryDb';

export interface TokenPayload {
  userId: string;
  role: UserRole;
  phoneNumber: string;
}

export const generateAccessToken = (payload: TokenPayload): string => {
  const options: SignOptions = {
    expiresIn: config.jwtExpiresIn as any,
  };
  return jwt.sign(payload, config.jwtSecret, options);
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  const options: SignOptions = {
    expiresIn: config.jwtRefreshExpiresIn as any,
  };
  return jwt.sign(payload, config.jwtRefreshSecret, options);
};

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, config.jwtSecret) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, config.jwtRefreshSecret) as TokenPayload;
};
