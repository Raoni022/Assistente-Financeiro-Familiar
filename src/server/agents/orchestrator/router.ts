import 'server-only';
import { todayInTz } from '@/lib/dates';
import { createClient } from '@/server/db/server';
import { callStructured, LlmError } from '@/server/llm/client';
import { MODELS } from '@/server/llm/models';
import type { AgentContext, ExecutionPlan } from '@/server/agents/shared/contracts';
import { ExecutionPlanSchema, validatePlan, PlanError } from '@/server/agents/shared/plan';
import { logAgentRun } from '@/server/agents/shared/run-agent';
import { routerSystemPrompt, type RouterContext } from './prompts';

/** Timeout do roteamento. Curto: é uma classificação, não uma análise. */
const ROUTER_TIMEOUT_MS = 12_000;

/**
 * Traduz a mensagem do usuário num ExecutionPlan validado.
 *
 * Falhar aqui não pode virar silêncio: sem plano não há resposta. O fallback é
 * um plano direto que admite a falha — nunca um chute de intenção, que faria o
 * assistente executar uma escrita que ninguém pediu.
 */
/**
 * Constrói o plano a partir do prompt já montado.
 *
 * Separado de `routePlan` para que o golden set de roteamento rode **sem
 * banco** — ele precisa de uma chave da Anthropic, não de um Supabase. Sem essa
 * separação, validar uma mudança de prompt exigiria infraestrutura inteira de pé.
 */
export async function buildPlan(
  userMessage: string,
  routerContext: RouterContext,
  signal: AbortSignal = AbortSignal.timeout(ROUTER_TIMEOUT_MS),
): Promise<{ plan: ExecutionPlan; inputTokens: number | null; outputTokens: number | null }> {
  const result = await callStructured(
    'orchestrator',
    ExecutionPlanSchema,
    'plano_de_execucao',
    { system: routerSystemPrompt(routerContext), user: userMessage },
    signal,
  );

  const plan = result.value as ExecutionPlan;
  validatePlan(plan);
  return { plan, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

export async function routePlan(
  userMessage: string,
  ctx: Omit<AgentContext, 'signal'>,
): Promise<ExecutionPlan> {
  const supabase = await createClient();

  const [{ data: profiles }, { data: categories }] = await Promise.all([
    supabase.from('profiles').select('display_name'),
    supabase.from('categories').select('key'),
  ]);

  const routerContext: RouterContext = {
    today: todayInTz(ctx.timezone),
    timezone: ctx.timezone,
    userName: (profiles ?? []).length > 0 ? 'membro da casa' : 'você',
    members: (profiles ?? []).map((row) => row.display_name as string),
    categoryKeys: (categories ?? []).map((row) => row.key as string),
    memories: ctx.memories,
    conversation: ctx.conversationContext,
  };

  const startedAt = Date.now();
  let status: 'success' | 'error' | 'timeout' = 'success';
  let errorCode: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  try {
    const result = await buildPlan(userMessage, routerContext);
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    return result.plan;
  } catch (error) {
    status = error instanceof LlmError && !error.retryable ? 'error' : 'timeout';
    errorCode = error instanceof PlanError ? error.code : 'ROUTER';

    console.error('[router] falhou:', (error as Error).message);
    return fallbackPlan(error);
  } finally {
    await logAgentRun({
      householdId: ctx.householdId,
      traceId: ctx.traceId,
      conversationId: ctx.conversationId,
      agent: 'orchestrator',
      intent: 'route',
      status,
      durationMs: Date.now() - startedAt,
      errorCode,
      retried: false,
      model: MODELS.orchestrator,
      inputTokens,
      outputTokens,
    });
  }
}

/**
 * Sem plano, o certo é pedir para repetir — não adivinhar.
 *
 * Um fallback por palavra-chave pareceria mais esperto e seria pior: rotear
 * "cancela a conta de luz" para bills.delete por causa da palavra "conta", num
 * momento em que o roteador comprovadamente não está funcionando, é executar uma
 * escrita destrutiva no escuro.
 */
function fallbackPlan(error: unknown): ExecutionPlan {
  const isTimeout = (error as Error | null)?.name === 'TimeoutError'
    || (error instanceof LlmError && error.retryable);

  return {
    mode: 'direct',
    directAnswer: isTimeout
      ? 'Demorei demais para processar isso e acabei perdendo o fio. Pode repetir?'
      : 'Não consegui entender esse pedido. Pode reformular?',
    steps: [],
    rationale: `fallback do roteador: ${(error as Error | null)?.message ?? 'erro desconhecido'}`,
  };
}
