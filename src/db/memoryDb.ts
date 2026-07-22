export type UserRole = 'CUSTOMER' | 'PROFESSIONAL' | 'ADMIN' | 'SUPER_ADMIN';
export type Gender = 'MALE' | 'FEMALE' | 'OTHER';
export type VerificationStatus = 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface User {
  id: string;
  phoneNumber: string;
  email?: string;
  fullName: string;
  role: UserRole;
  gender?: Gender;
  avatarUrl?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OTPRecord {
  phoneNumber: string;
  otp: string;
  expiresAt: number; // timestamp ms
}

export interface RefreshTokenRecord {
  token: string;
  userId: string;
  expiresAt: number;
}

export interface SavedLocation {
  id: string;
  userId: string;
  label: string; // e.g. "Home", "Office"
  addressText: string;
  latitude: number;
  longitude: number;
  isDefault: boolean;
  createdAt: string;
}

export interface VerificationDocuments {
  govtIdType?: 'AADAAR' | 'PASSPORT' | 'DRIVING_LICENSE' | 'VOTER_ID';
  govtIdNumber?: string;
  govtIdDocUrl?: string;
  policeVerificationPdfUrl?: string;
  certifications?: string[];
  submittedAt?: string;
}

export interface ProfessionalProfile {
  id: string;
  userId: string;
  verificationStatus: VerificationStatus;
  verificationNotes?: string;
  documents: VerificationDocuments;
  faceVerificationUrl?: string;
  faceVerified: boolean;
  isOnline: boolean;
  isBusy: boolean;
  currentLocation?: {
    latitude: number;
    longitude: number;
    updatedAt: string;
  };
  ratingAvg: number;
  totalJobsCompleted: number;
  acceptanceRate: number;
  cancellationRate: number;
  accountHealthScore: number;
  isBlacklisted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrainingModule {
  id: string;
  title: string;
  description: string;
  durationMinutes: number;
  category: 'SAFETY_GUIDELINES' | 'PROFESSIONAL_BEHAVIOR' | 'EMERGENCY_PROTOCOLS' | 'SERVICE_QUALITY';
  passingScore: number;
  isRequired: boolean;
}

export interface UserTrainingProgress {
  userId: string;
  moduleId: string;
  completedAt: string;
  score: number;
  passed: boolean;
}

class MemoryDatabase {
  public users: Map<string, User> = new Map();
  public otps: Map<string, OTPRecord> = new Map(); // key: phone
  public refreshTokens: Map<string, RefreshTokenRecord> = new Map(); // key: token
  public savedLocations: Map<string, SavedLocation[]> = new Map(); // key: userId
  public professionalProfiles: Map<string, ProfessionalProfile> = new Map(); // key: userId
  public trainingModules: Map<string, TrainingModule> = new Map(); // key: moduleId
  public userTrainingProgress: Map<string, UserTrainingProgress[]> = new Map(); // key: userId

  constructor() {}
}

export const db = new MemoryDatabase();
