import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const env = process.env;
const production = env.NODE_ENV === 'production';

if (production && !env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production');

export const config = {
  production,
  port: Number(env.PORT || 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/safelybuild',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtTtl: env.JWT_TTL || '12h',
  inferenceUrl: env.INFERENCE_URL || 'http://localhost:8000',
  inferenceTimeoutMs: Number(env.INFERENCE_TIMEOUT_MS || 60_000),
  storageDir: env.STORAGE_DIR || path.join(repoRoot, 'storage'),
  maxUploadBytes: 15 * 1024 * 1024,
  // Indicative market rates in PKR - DEMO VALUES, edit per project before relying on an estimate.
  defaultRatesPkr: { CEMENT: 1400, SAND: 85, AGGREGATE: 120, REBAR: 270, BRICK: 28 },
};

// SAND and AGGREGATE rates above are per cubic foot-equivalents converted to m3 below so that
// the unit shown in the UI (m3) is consistent with the quantities estimated.
const CFT_PER_M3 = 35.3147;
config.defaultRatesPkr.SAND = Math.round(config.defaultRatesPkr.SAND * CFT_PER_M3);
config.defaultRatesPkr.AGGREGATE = Math.round(config.defaultRatesPkr.AGGREGATE * CFT_PER_M3);
