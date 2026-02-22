import Fastify from "fastify";
import cors from "@fastify/cors";
import { startCollector, getSnapshot, getStats, registerSSEClient, removeSSEClient } from "./collector.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

const fastify = Fastify({ logger: false });

await fastify.register(cors, {
  origin: true,
  methods: ["GET"],
});

// Health check
fastify.get("/api/health", async () => {
  return { status: "ok", timestamp: Date.now() };
});

// Stats endpoint
fastify.get("/api/stats", async () => {
  return getStats();
});

// Snapshot endpoint
fastify.get("/api/snapshot", async () => {
  return getSnapshot();
});

// SSE stream
fastify.get("/api/stream", (request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial snapshot
  const snapshot = getSnapshot();
  reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // Register for updates
  registerSSEClient(reply.raw);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    removeSSEClient(reply.raw);
  });
});

// Start
try {
  await startCollector();
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[${new Date().toISOString()}] Server listening on port ${PORT}`);
} catch (err) {
  console.error("Fatal:", err);
  process.exit(1);
}
