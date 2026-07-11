// radar-api entry point: load configuration, build the app, listen, and shut down
// gracefully. Stateless — all durable state belongs in PostgreSQL (added later).
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'radar-api shutting down');
    await app.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(sig));
  }

  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
  } catch (err) {
    app.log.error(err, 'radar-api failed to start');
    process.exit(1);
  }
}

void main();
