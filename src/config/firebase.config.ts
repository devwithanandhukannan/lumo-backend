import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';

let firebaseApp: App | null = null;

export const initializeFirebase = (): App => {
  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    return firebaseApp;
  }

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
      console.log('🔥 Firebase Admin SDK initialized via Service Account File');
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      firebaseApp = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
      console.log('🔥 Firebase Admin SDK initialized via Environment Variables');
    } else {
      firebaseApp = initializeApp();
      console.log('🔥 Firebase Admin SDK initialized via Application Default Credentials');
    }
  } catch (err: any) {
    console.warn('⚠️ Firebase Admin SDK initialization warning:', err.message);
  }

  return firebaseApp as App;
};

export const getFirebaseAuth = (): Auth => {
  if (getApps().length === 0) {
    initializeFirebase();
  }
  return getAuth();
};
