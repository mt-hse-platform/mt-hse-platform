// Usage:
//   node scripts/bootstrap-org.ts --org "اسم المؤسسة" --email admin@example.com --name "الاسم الكامل" --uid <Firebase User UID> [--locale ar|en]
// Prints SQL to stdout. Pipe it to psql as the DB owner:
//   node scripts/bootstrap-org.ts ... | docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d mthse -v ON_ERROR_STOP=1
import { parseArgs } from 'node:util';
import { buildBootstrapSql } from './bootstrapSql.ts';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    uid: { type: 'string' },
    locale: { type: 'string', default: 'ar' },
  },
});

try {
  if (!values.org || !values.email || !values.name || !values.uid) {
    throw new Error('Required: --org, --email, --name, --uid');
  }
  process.stdout.write(buildBootstrapSql({
    orgName: values.org,
    adminEmail: values.email,
    adminFullName: values.name,
    firebaseUid: values.uid,
    locale: values.locale as 'ar' | 'en',
  }));
} catch (err) {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
}
