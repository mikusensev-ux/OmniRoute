/**
 * GeminiWebExecutor — Gemini Web Session Provider
 *
 * Routes requests through Google Gemini's web interface using browser
 * cookies + Playwright automation. Translates between OpenAI chat
 * completions format and Gemini's web UI.
 *
 * Auth: Cookie-based (__Secure-1PSID + __Secure-1PSIDTS from gemini.google.com)
 * Method: Playwright browser automation
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// ─── Types ──────────────────────────────────────────────────────────────────

interface GeminiMessage {
  role: string;
  content: string;
}

interface GeminiRequestBody {
  messages: GeminiMessage[];
  model?: string;
  stream?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatChatCompletion(content: string, model: string, finishReason = "stop") {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function formatStreamChunk(content: string, model: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

/**
 * Parse Gemini StreamGenerate response text.
 * Format: )]}' \n <length> \n [["wrb.fr",null,"<JSON string>"]] \n ...
 * Text is at inner[4][0][1] as array of string chunks.
 */
function parseStreamResponse(raw: string): string {
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim() || line.trim() === ")]}'" || /^\d+$/.test(line.trim())) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !arr[0] || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0][2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      // Text is at inner[4][0][1] — return from first match only
      const candidates = inner?.[4]?.[0]?.[1];
      if (Array.isArray(candidates)) {
        return candidates.filter((c: unknown) => typeof c === "string").join("");
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return "";
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials } = input;
    const requestBody = body as GeminiRequestBody;

    const cookie = credentials.apiKey || "";
    if (!cookie) {
      return {
        response: new Response(JSON.stringify({ error: "Missing Gemini cookies" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = requestBody.messages || [];
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    const prompt = lastUserMsg?.content || "";

    if (!prompt) {
      return {
        response: new Response(JSON.stringify({ error: "No user message found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent: GEMINI_USER_AGENT });

      // Parse cookies
      const cookiePairs = cookie.split(";").map((c: string) => c.trim());
      await context.addCookies(
        cookiePairs.map((c: string) => {
          const [name, ...rest] = c.split("=");
          return {
            name: name.trim(),
            value: rest.join("=").trim(),
            domain: ".google.com",
            path: "/",
            secure: true,
          };
        })
      );

      const page = await context.newPage();

      // Capture first StreamGenerate response
      let responseText = "";
      let captured = false;
      const responsePromise = new Promise<void>((resolve) => {
        page.on("response", async (resp) => {
          if (captured || !resp.url().includes("StreamGenerate")) return;
          captured = true;
          try {
            const raw = await resp.text();
            responseText = parseStreamResponse(raw);
          } catch {
            /* ignore */
          }
          resolve();
        });
      });

      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(3000);

      // Type and send message
      const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
        timeout: 10000,
      });
      await inputEl.click();
      await page.keyboard.type(prompt, { delay: 10 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");

      // Wait for response or timeout
      await Promise.race([responsePromise, page.waitForTimeout(30000)]);
      await browser.close();

      if (!responseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      const modelId = model || "gemini-2.5-pro";

      if (stream) {
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(formatStreamChunk(responseText, modelId))}\n\n`
              )
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}\n\n`)
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      return {
        response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } catch (error) {
      return {
        response: new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }
  }
}
