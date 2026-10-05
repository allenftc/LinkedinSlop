import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(rootDir, "config", "system-prompt.json");
const maxBodySize = 1_000_000;

const staticFiles = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["public/index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
]);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodySize) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function createConfigError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  return error;
}

function validateApiUrl(apiUrl) {
  if (typeof apiUrl !== "string" || !apiUrl.trim()) {
    throw createConfigError("config.system-prompt.json must define an apiUrl.");
  }

  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw createConfigError("config.system-prompt.json apiUrl is not a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw createConfigError("config.system-prompt.json apiUrl must use HTTP or HTTPS.");
  }
}

async function loadConfig() {
  let config;

  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`Could not read ${configPath}.`);
  }

  const apiUrl = process.env.TRANSLATION_API_URL || config.apiUrl;
  const model = process.env.TRANSLATION_MODEL || config.model;

  validateApiUrl(apiUrl);

  if (typeof model !== "string" || !model.trim()) {
    throw new Error("config.system-prompt.json must define a model.");
  }

  if (typeof config.systemPrompt !== "string" || !config.systemPrompt.trim()) {
    throw new Error("config.system-prompt.json must define a systemPrompt.");
  }

  if (config.temperature !== undefined &&
      (typeof config.temperature !== "number" || config.temperature < 0 || config.temperature > 2)) {
    throw createConfigError("config.system-prompt.json temperature must be between 0 and 2.");
  }

  if (config.disableThinking !== undefined && typeof config.disableThinking !== "boolean") {
    throw createConfigError("config.system-prompt.json disableThinking must be true or false.");
  }

  return { ...config, apiUrl, model };
}

function writeStreamEvent(response, payload) {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractSseEvent(buffer) {
  const boundary = /\r?\n\r?\n/.exec(buffer);
  if (!boundary) {
    return null;
  }
  return {
    content: buffer.slice(0, boundary.index),
    rest: buffer.slice(boundary.index + boundary[0].length),
  };
}

function getStreamText(eventData) {
  const delta = eventData.choices?.[0]?.delta;
  if (typeof delta?.content === "string") {
    return delta.content;
  }
  if (typeof delta?.text === "string") {
    return delta.text;
  }
  return "";
}

function stripAsterisks(text) {
  return text.replace(/\*/g, "");
}

async function streamFromApi(apiResponse, response) {
  if (!apiResponse.body) {
    throw new Error("The LLM API did not return a stream.");
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.flushHeaders?.();

  const decoder = new TextDecoder();
  let buffer = "";
  let receivedText = false;

  const consumeEvent = (event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data || data === "[DONE]") {
      return;
    }

    let eventData;
    try {
      eventData = JSON.parse(data);
    } catch {
      throw new Error("The LLM API returned an invalid stream.");
    }

    const text = stripAsterisks(getStreamText(eventData));
    if (text) {
      receivedText = true;
      writeStreamEvent(response, { type: "delta", text });
    }
  };

  for await (const chunk of apiResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const event = extractSseEvent(buffer);
      if (!event) {
        break;
      }
      consumeEvent(event.content);
      buffer = event.rest;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeEvent(buffer);
  }

  if (!receivedText) {
    throw new Error("The LLM API returned no text.");
  }

  writeStreamEvent(response, { type: "done" });
  response.end();
}

async function translate(request, response) {
  const body = await readJsonBody(request);
  const text = typeof body.text === "string" ? body.text : "";

  if (!text.trim()) {
    return sendJson(response, 400, { error: "Enter English text to transform." });
  }

  if (text.length > 100_000) {
    return sendJson(response, 400, { error: "Text must be 100,000 characters or fewer." });
  }

  const config = await loadConfig();
  const apiKey = process.env.TRANSLATION_API_KEY;
  const isSecureApi = new URL(config.apiUrl).protocol === "https:";
  if (!apiKey && isSecureApi) {
    return sendJson(response, 500, {
      error: "Set TRANSLATION_API_KEY before starting the server.",
    });
  }

  const userPrompt = `Transform the following English text into a LinkedIn post using the system instructions. Return plain text only, with no Markdown or asterisks.\n\nText:\n${text}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey && isSecureApi) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const messages = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const requestBody = {
    model: config.model,
    temperature: config.temperature ?? 0.2,
    messages,
    stream: true,
  };

  if (config.disableThinking) {
    messages.push({ role: "assistant", content: " \n" });
    requestBody.chat_template_kwargs = { enable_thinking: false };
    requestBody.continue_assistant_turn = true;
  }

  const apiResponse = await fetch(config.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!apiResponse.ok) {
    let detail = "";
    try {
      const errorBody = await apiResponse.json();
      detail = errorBody.error?.message || errorBody.message || "";
    } catch {
      detail = "";
    }
    const error = new Error(detail || `The LLM API returned HTTP ${apiResponse.status}.`);
    error.statusCode = 502;
    throw error;
  }

  try {
    await streamFromApi(apiResponse, response);
  } catch (error) {
    if (!response.headersSent) {
      throw error;
    }
    writeStreamEvent(response, { type: "error", error: error.message });
    if (!response.writableEnded) {
      response.end();
    }
  }
}

async function serveStatic(pathname, response) {
  const staticFile = staticFiles.get(pathname);
  if (!staticFile) {
    return sendJson(response, 404, { error: "Not found." });
  }

  try {
    const [relativePath, contentType] = staticFile;
    const content = await readFile(resolve(rootDir, relativePath));
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(content);
  } catch {
    sendJson(response, 500, { error: "Could not load the web UI." });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");

    if (url.pathname === "/api/translate") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "Method not allowed." });
      }
      return await translate(request, response);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "Method not allowed." });
    }

    return await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : "The server could not complete the request.",
    });
  }
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";

server.listen(port, host, () => {
  console.log(`Translation UI running at http://${host}:${port}`);
});
