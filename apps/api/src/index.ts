import { buildServer } from './server.js';
import { assertProductionLaunchReadiness } from './services/launchReadiness.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

assertProductionLaunchReadiness();

const app = buildServer({ logger: true });

app
  .listen({ port, host })
  .then(() => {
    app.log.info({ port, host }, 'molt-negotiation-api_started');
  })
  .catch((error) => {
    app.log.error({ err: error }, 'startup_failed');
    process.exit(1);
  });
