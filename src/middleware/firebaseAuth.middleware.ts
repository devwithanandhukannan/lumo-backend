import { Request, Response, NextFunction } from 'express';
import { getFirebaseAuth } from '../config/firebase.config';
import { DecodedIdToken } from 'firebase-admin/auth';

export interface FirebaseAuthenticatedRequest extends Request {
  firebaseUser?: DecodedIdToken;
}

export const verifyFirebaseIdToken = async (
  req: FirebaseAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or malformed Authorization header with Bearer Firebase ID Token',
      },
    });
    return;
  }

  const idToken = authHeader.split(' ')[1];

  try {
    const auth = getFirebaseAuth();
    const decodedToken = await auth.verifyIdToken(idToken);
    req.firebaseUser = decodedToken;
    next();
  } catch (err: any) {
    console.error('Firebase ID Token verification error:', err.message);
    res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_FIREBASE_TOKEN',
        message: 'Firebase ID Token is invalid, revoked, or expired',
        details: err.message,
      },
    });
  }
};
