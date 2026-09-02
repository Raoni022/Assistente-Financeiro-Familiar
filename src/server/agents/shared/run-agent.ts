import 'server-only';
import { createAdminClient } from '@/server/db/admin';
import { LlmError } from '@/server/llm/client';
import {
  AGENT_TIMEOUT_MS,
  type AgentContext,
  type AgentError,
  type AgentResponse,
  type PlanStep,
  type SpecialistAgent,
  type StepResult,
} from './contracts';

/**
 * Executa um passo do plano com timeout, retry e registro em `agent_runs`.
 *
 * Política em docs/architecture.md §3.4. O resumo: uma única retentativa, e só
 * para erro transitório. Erro de validação ou ambiguidade nunca é retentado —
 * o mesmo prompt com temperatura 0 erra igual, e retentar só gasta.
 */

function toAgentError(error: unknown): AgentError {
  if (error instanceof LlmError) {
    return { code: 'LLM', message: error.message, retryable: error.retryable };
  }

  const name = (error as Error | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { code: 'TIMEOUT', message: 'Tempo esgotado.', retryable: true };
  }

  return {
    code: 'UNKNOWN',
    message: (error as Error | null)?.message ?? 'Erro desconhecido.',
    retryable: false,
  };
}

async function invokeOnce(
  agent: SpecialistAgent,
  step: PlanStep,
  ctx: Omit<AgentContext, 'signal'>,
  timeoutMs: number,
): Promise<AgentResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);

  try {
    return await agent({
      ctx: { ...ctx, signal: timeout },
      intent: step.intent,
      payload: step.payload,
    });
  } catch (error) {
    const agentError = toAgentError(error);
    return {
      success: false,
      error: agentError,
      summaryForOrchestrator:
        agentError.code === 'TIMEOUT'
          ? `A operação "${step.intent}" demorou demais e foi interrompida.`
          : `A operação "${step.intent}" falhou.`,
    };
  }
}

export async function runStep(
  agent: SpecialistAgent,
  step: PlanStep,
  ctx: Omit<AgentContext, 'signal'>,
): Promise<StepResult> {
  const timeoutMs = AGENT_TIMEOUT_MS[step.agent];
  const startedAt = Date.now();

  let response = await invokeOnce(agent, step, ctx, timeoutMs);
  let retried = false;

  if (!response.success && response.error.retryable) {
    retried = true;
    response = await invokeOnce(agent, step, ctx, timeoutMs);
  }

  const durationMs = Date.now() - startedAt;

  const status: StepResult['status'] = response.success
    ? 'success'
    : response.error.code === 'TIMEOUT'
      ? 'timeout'
      : 'error';

  await logAgentRun({
    householdId: ctx.householdId,
    traceId: ctx.traceId,
    conversationId: ctx.conversationId,
    agent: step.agent,
    intent: step.intent,
    status,
    durationMs,
    errorCode: response.success ? null : response.error.code,
    retried,
  });

  return { step, status, response, durationMs, retried };
}

export interface AgentRunLog {
  householdId: string;
  traceId: string;
  conversationId: string | null;
  agent: string;
  intent: string;
  status: 'success' | 'error' | 'timeout' | 'skipped';
  durationMs: number;
  errorCode: string | null;
  retried: boolean;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * ATENÇÃO: só metadado. Nada de valor, título de conta, descrição de gasto ou
 * conteúdo de mensagem entra aqui — requisito 7.1 do brief.
 *
 * Usa service role porque `agent_runs` não tem policy de escrita: o servidor
 * registra, o usuário só lê.
 *
 * Falha de log NUNCA derruba a resposta. Observabilidade quebrada é um
 * problema; usuário sem resposta por causa dela é um problema maior.
 */
export async function logAgentRun(entry: AgentRunLog): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('agent_runs').insert({
      household_id: entry.householdId,
      trace_id: entry.traceId,
      conversation_id: entry.conversationId,
      agent: entry.agent,
      intent: entry.intent,
      status: entry.status,
      duration_ms: entry.durationMs,
      error_code: entry.errorCode,
      model: entry.model ?? null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      retried: entry.retried,
    });
    if (error) console.error('[agent_runs] falha ao registrar:', error.message);
  } catch (error) {
    console.error('[agent_runs] falha ao registrar:', (error as Error).message);
  }
}
