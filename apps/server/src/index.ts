import "dotenv/config";
import { getConfig } from "./config.js";
import { createServer } from "./server.js";

const config = getConfig();
const app = await createServer(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`LLM Telepresence Browser Lab listening on ${config.baseUrl}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
