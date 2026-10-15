// Camera ingest. Authenticated by the camera's own key, not by a user session: people cannot
// call this endpoint, and cameras cannot call anything else.
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, audit, bad, wrap } from '../http.js';
import { authenticateCamera, ingestFrame } from '../services/ingest.js';
import { recompute } from '../services/forecast.js';
import { rebuild } from '../services/rollup.js';

export const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

router.post('/ingest/frame', upload.single('image'), wrap(async (req, res) => {
  const camera = await authenticateCamera(pool, req.headers['x-camera-key']);
  if (!camera) throw new HttpError(401, 'invalid_camera_key', 'unknown camera or wrong key');
  if (!req.file) throw bad("attach the frame in the 'image' field");
  const capturedAt = new Date(req.body.captured_at);
  const result = await ingestFrame(pool, camera, { buffer: req.file.buffer, capturedAt });
  const project = (await pool.query('SELECT * FROM projects WHERE id = $1', [camera.project_id])).rows[0];
  await rebuild(pool, project);
  await recompute(pool, project);
  await audit(pool, { project, user: null, actor: `camera: ${camera.name}` }, 'ingest', 'frame', result.media_id, { camera: camera.name });
  res.status(201).json(result);
}));
