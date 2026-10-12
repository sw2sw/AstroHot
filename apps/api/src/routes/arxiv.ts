import type { FastifyInstance } from "fastify";
import { loadArxivFeed, parseArxivQuery } from "@aihot/backend/publication/arxiv";
import { sendProblem } from "../http/respond.ts";

export function registerArxiv(app: FastifyInstance, load = loadArxivFeed) {
  app.get("/api/arxiv/items", async (req, reply) => {
    let query;
    try {
      query = parseArxivQuery(req.query as Record<string, unknown>);
    } catch {
      return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "Invalid arxiv category or pagination." });
    }
    return reply.header("Cache-Control", "public, max-age=60").send(await load(query));
  });
}
