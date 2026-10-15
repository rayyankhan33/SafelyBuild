import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { createApp } from './app.js';
import { failStaleRuns } from './services/testfootage.js';

await migrate(pool);
await failStaleRuns(pool); // test-footage runs interrupted by the last shutdown cannot be resumed
createApp().listen(config.port, () => console.log(`SafelyBuild API listening on :${config.port}`));
