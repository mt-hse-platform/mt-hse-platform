// UNTESTED entry point: wires the real adapters. Required env: DATABASE_URL (as app_user), FIREBASE_PROJECT_ID.
import pg from 'pg';
import { createApi, defaultClock } from './server.ts';
import { startSweeper } from './sweeper.ts';
import { FirebaseTokenVerifier } from './firebaseVerifier.ts';
import { PgIdentityStore } from './pgIdentityStore.ts';
import { PgWorkRepo } from './pgWorkRepo.ts';
import { PlaywrightPdfRenderer } from './playwrightPdf.ts';
import { DiskBlobStore } from './blobStore.ts';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};

const pool = new pg.Pool({ connectionString: need('DATABASE_URL'), max: 10 });
const work = new PgWorkRepo(pool);
const server = createApi({
  verifier: new FirebaseTokenVerifier(need('FIREBASE_PROJECT_ID')),
  store: new PgIdentityStore(pool),
  work,
  // uploaded files live on disk (a Docker volume in production); MEDIA_DIR selects the folder
  blobs: new DiskBlobStore(process.env.MEDIA_DIR ?? './media'),
  // PDF export is enabled with PDF_ENABLED=1 (and CHROMIUM_PATH pointing to Chrome/Chromium; PDF_NO_SANDBOX=1 inside containers)
  pdf: process.env.PDF_ENABLED === '1'
    ? new PlaywrightPdfRenderer({ executablePath: process.env.CHROMIUM_PATH, noSandbox: process.env.PDF_NO_SANDBOX === '1' })
    : undefined,
  logger: { error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, meta: String(meta) })) },
});

const logger = { error: (message: string, meta?: unknown) => console.error(JSON.stringify({ level: 'error', message, meta: String(meta) })) };
startSweeper(work, defaultClock, logger);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: 'api_listening', port })));
