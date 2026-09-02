import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { runOrchestrator } from '@/server/agents/orchestrator/graph';
import { getSession } from '@/server/auth/session';
import { loadOrCreateConversation, persistTurn } from '@/server/conversation';
import { createClient } from '@/server/db/server';
import { CHAT_LIMITS, checkRateLimit, pruneRateLimits } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Insights pode levar 25s; a síntese, mais 20s. 60s dá folga sem prender. */
export const maxDuration = 60;

const ChatRequest = z.object({
  message: z.string().trim().min(1, 'Mensagem vazia.').max(2000, 'Mensagem longa demais.'),
  conversationId: z.uuid().nullable().default(null),
});

export interface ChatResponseBody {
  conversationId: string;
  text: string;
  blocks: unknown[];
  /** Tabelas alteradas — o cliente revalida só o que mudou. */
  touched: string[];
}

export async function POST(request: NextRequest) {
  /*
   * `getSession`, não `requireHousehold`: aquele chama `redirect()`, que numa
   * rota de API vira um 307 com HTML. O fetch do cliente seguiria o redirect,
   * receberia a página de login e quebraria no `response.json()` — o usuário
   * veria "perdi a conexão" quando o problema real é sessão expirada.
   */
  const session = await getSession();
  if (!session?.householdId) {
    return NextResponse.json(
      { error: 'Sua sessão expirou. Entre de novo para continuar.' },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = ChatRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Requisição inválida.' },
      { status: 400 },
    );
  }

  const userLimit = await checkRateLimit(session.userId, CHAT_LIMITS.perUser);
  if (!userLimit.allowed) {
    return NextResponse.json(
      { error: 'Você mandou muitas mensagens seguidas. Espere alguns minutos.' },
      { status: 429, headers: { 'Retry-After': String(userLimit.retryAfterSeconds) } },
    );
  }

  const householdLimit = await checkRateLimit(session.householdId, CHAT_LIMITS.perHousehold);
  if (!householdLimit.allowed) {
    return NextResponse.json(
      { error: 'A casa atingiu o limite de mensagens de hoje.' },
      { status: 429, headers: { 'Retry-After': String(householdLimit.retryAfterSeconds) } },
    );
  }

  const supabase = await createClient();

  try {
    const { conversationId, context } = await loadOrCreateConversation(
      supabase,
      session.householdId,
      session.userId,
      parsed.data.conversationId,
    );

    const result = await runOrchestrator(parsed.data.message, {
      householdId: session.householdId,
      userId: session.userId,
      conversationId,
      timezone: session.timezone,
      conversationContext: context,
      traceId: randomUUID(),
    });

    await persistTurn(supabase, {
      conversationId,
      householdId: session.householdId,
      userMessage: parsed.data.message,
      assistantMessage: result.text,
      blocks: result.blocks,
    });

    // Oportunista: limpa janelas velhas de vez em quando, sem cron dedicado.
    if (Math.random() < 0.02) void pruneRateLimits();

    const payload: ChatResponseBody = {
      conversationId,
      text: result.text,
      blocks: result.blocks,
      touched: result.touched,
    };

    return NextResponse.json(payload);
  } catch (error) {
    // O usuário nunca vê o erro cru, e também nunca recebe uma resposta
    // inventada no lugar dele (requisito 7.2 do brief).
    console.error('[chat] falha não tratada:', (error as Error).message);
    return NextResponse.json(
      { error: 'Algo deu errado por aqui e não consegui concluir. Tente de novo.' },
      { status: 500 },
    );
  }
}
