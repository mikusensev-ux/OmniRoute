import { NextRequest, NextResponse } from "next/server";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { updateScore } from "@/lib/gamification/leaderboard";
import { z } from "zod";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * POST /api/gamification/federation/score — Receive score from connected instance
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing authorization" },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const body = await request.json();
  const schema = z.object({
    apiKeyId: z.string(),
    score: z.number(),
    scope: z.enum(["global", "weekly", "monthly"]).default("global"),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: CORS_HEADERS });
  }

  await updateScore(parsed.data.apiKeyId, parsed.data.scope, parsed.data.score);

  return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
}
