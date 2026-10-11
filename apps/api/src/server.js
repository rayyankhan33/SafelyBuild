import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { createApp } from './app.js';

await migrate(pool);
createApp().listen(config.port, () => console.log(`SafelyBuild API listening on :${config.port}`));
