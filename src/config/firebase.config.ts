import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';

let firebaseApp: App | null = null;

export const initializeFirebase = (): App => {
  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    return firebaseApp;
  }

  try {
    // Method 1 (RECOMMENDED & MOST SECURE):
    // Store the entire service account JSON as a base64-encoded string in FIREBASE_SERVICE_ACCOUNT_JSON.
    // Generate with: base64 -i firebase-service-account.json | tr -d '\n'
    // This eliminates the need to have the .json file in the repo or filesystem at all.
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccountJson = Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
        'base64'
      ).toString('utf-8');
      const serviceAccount = JSON.parse(serviceAccountJson);
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
      console.log('🔥 Firebase Admin SDK initialized via FIREBASE_SERVICE_ACCOUNT_JSON env var');

    // Method 2 (Fallback): Individual env vars (project_id, client_email, private_key)
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      firebaseApp = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
      console.log('🔥 Firebase Admin SDK initialized via FIREBASE_PROJECT_ID/PRIVATE_KEY env vars');

    // Method 3 (Legacy / local dev only): File path — NEVER use in production.
    // The firebase-service-account.json file MUST be in .gitignore.
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      console.warn(
        '⚠️ [SECURITY] Using FIREBASE_SERVICE_ACCOUNT_PATH (file). ' +
        'For production, set FIREBASE_SERVICE_ACCOUNT_JSON instead. ' +
        'Ensure firebase-service-account.json is in .gitignore.'
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
      console.log('🔥 Firebase Admin SDK initialized via Service Account File (dev only)');

    // Method 4: GCP Application Default Credentials (Cloud Run, GKE, etc.)
    } else {
      firebaseApp = initializeApp();
      console.log('🔥 Firebase Admin SDK initialized via Application Default Credentials (GCP)');
    }
  } catch (err: any) {
    console.warn('⚠️ Firebase Admin SDK initialization warning:', err.message);
    console.warn('   Set FIREBASE_SERVICE_ACCOUNT_JSON env var with base64-encoded service account JSON.');
  }

  return firebaseApp as App;
};

export const getFirebaseAuth = (): Auth => {
  if (getApps().length === 0) {
    initializeFirebase();
  }
  return getAuth();
};
