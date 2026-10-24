// UNTESTED in the authoring sandbox (needs the firebase-admin package and network).
// Verifying an ID token only needs the projectId: Firebase public certificates are fetched from Google.
// A service-account key is NOT required for verification (only for server-side user admin, later).
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { TokenVerifier, VerifiedToken } from './ports.ts';

export class FirebaseTokenVerifier implements TokenVerifier {
  private auth: ReturnType<typeof getAuth>;

  constructor(projectId: string) {
    this.auth = getAuth(initializeApp({ projectId }));
  }

  async verify(idToken: string): Promise<VerifiedToken> {
    // checkRevoked=true so that disabled/signed-out-everywhere users are rejected (needs network to Firebase).
    const decoded = await this.auth.verifyIdToken(idToken, true);
    return { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true };
  }
}
