import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function manualReview(response) {
  return json(response, 200, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleTriage(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.text !== "string" ||
    payload.text.trim().length === 0
  ) {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timeoutId;
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("AI request timed out"));
      }, 300);
    });

    const rawResult = await Promise.race([
      classify(payload.text.trim(), { signal: controller.signal }),
      timeout,
    ]);

    let result;
    try {
      result = JSON.parse(rawResult);
    } catch {
      return manualReview(response);
    }

    const topic = result?.topic;
    const draft = typeof result?.draft === "string" ? result.draft.trim() : "";

    if (!ALLOWED_TOPICS.has(topic) || draft.length === 0) {
      return manualReview(response);
    }

    return json(response, 200, { status: "ready", topic, draft });
  } catch {
    return manualReview(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    await handleTriage(request, response);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
