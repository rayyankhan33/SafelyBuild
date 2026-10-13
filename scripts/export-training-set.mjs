// Export stored camera frames and what the current models predicted, as a starting point for
// labelling and training a better model (see docs/model-integration.md).
//
//   node --env-file-if-exists=.env scripts/export-training-set.mjs <outputDir> [--project <id>] [--include-demo]
//
// Writes <outputDir>/images/<mediaId>.<ext> and <outputDir>/labels.json in the evaluate.py formats, with the
// current prediction pre-filled and "verified": false. A human labeller corrects each entry and sets
// "verified": true; evaluate.py should be run only on verified entries (strip the others).
// Synthetic demo frames are excluded unless --include-demo is given, because they are not real data.
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../apps/api/src/db/pool.js';
import * as storage from '../apps/api/src/storage.js';

const out = process.argv[2];
if (!out || out.startsWith('--')) { console.error('usage: export-training-set.mjs <outputDir> [--project <id>] [--include-demo]'); process.exit(2); }
const argv = process.argv.slice(3);
const projectId = argv.includes('--project') ? argv[argv.indexOf('--project') + 1] : null;
const includeDemo = argv.includes('--include-demo');

fs.mkdirSync(path.join(out, 'images'), { recursive: true });
const { rows } = await pool.query(
  `SELECT m.id, m.storage_key, m.content_type, m.sha256, m.captured_at, c.kind, c.name AS camera, c.scale_m_per_px, e.element_type, p.is_demo,
          (SELECT row_to_json(x) FROM (SELECT so.stage, so.fraction, r.model_version FROM stage_observations so JOIN inference_runs r ON r.id = so.inference_run_id WHERE r.media_id = m.id LIMIT 1) x) AS stage,
          (SELECT jsonb_agg(jsonb_build_object('material_code', mt.code, 'quantity', io.quantity)) FROM inventory_observations io JOIN inference_runs r ON r.id = io.inference_run_id
             JOIN material_catalog mt ON mt.id = io.material_id WHERE r.media_id = m.id) AS inventory,
          (SELECT jsonb_agg(jsonb_build_object('defect_type', d.defect_type, 'bbox', d.bbox, 'severity', d.severity, 'score', d.score)) FROM defects d WHERE d.media_id = m.id AND d.is_violation) AS defects
   FROM media m JOIN cameras c ON c.id = m.camera_id JOIN projects p ON p.id = m.project_id LEFT JOIN design_elements e ON e.id = c.element_id
   WHERE ($1::uuid IS NULL OR m.project_id = $1) AND ($2 OR NOT p.is_demo) ORDER BY m.captured_at`, [projectId, includeDemo]);

const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp' };
const labels = { stage: [], inventory: [], defects: [] };
for (const r of rows) {
  const file = `images/${r.id}.${ext[r.content_type]}`;
  fs.writeFileSync(path.join(out, file), await storage.read(r.storage_key));
  if (r.kind === 'zone' && r.stage) labels.stage.push({ file, element_type: r.element_type, stage: r.stage.stage, fraction: r.stage.fraction, predicted_by: r.stage.model_version, verified: false });
  if (r.kind === 'yard' && r.inventory) labels.inventory.push({ file, scale_m_per_px: Number(r.scale_m_per_px), stock: Object.fromEntries(r.inventory.map((i) => [i.material_code, i.quantity])), verified: false });
  labels.defects.push({ file, boxes: (r.defects ?? []).map((d) => ({ defect_type: d.defect_type, bbox: d.bbox })), verified: false });
}
for (const [task, list] of Object.entries(labels)) fs.writeFileSync(path.join(out, `labels.${task}.json`), JSON.stringify(list, null, 2));
console.log(`Exported ${rows.length} frames to ${out} (${labels.stage.length} stage, ${labels.inventory.length} inventory, ${labels.defects.length} defect candidates).`);
if (!rows.length) console.log('No real frames yet (demo frames are excluded; use --include-demo to export them for testing).');
await pool.end();
