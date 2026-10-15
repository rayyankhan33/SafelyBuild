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
  // TEMPORARY test-footage feature (docs/temporary-features.md)
  testUploadMaxBytes: Number(env.MAX_TEST_UPLOAD_MB || 300) * 1024 * 1024,
  testUploadTimeoutMs: Number(env.TEST_UPLOAD_TIMEOUT_MS || 10 * 60_000),
  // Site local time is UTC+5 (Pakistan): a frame's "day" is its local calendar date.
  siteUtcOffsetHours: Number(env.SITE_UTC_OFFSET_HOURS || 5),
  // Frames whose camera clock differs from the server by more than this are rejected (replay / clock tampering).
  maxClockSkewMs: Number(env.MAX_CLOCK_SKEW_MS || 10 * 60_000),
  maxFramesPerCameraPerDay: Number(env.MAX_FRAMES_PER_CAMERA_PER_DAY || 200),
};
