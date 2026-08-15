// Neon Postgres client helper. All functions share this.
// Neon scale-to-zero cold start (~500ms) is acceptable per spec §2.
import { neon } from '@neondatabase/serverless';

export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return neon(url);
}
