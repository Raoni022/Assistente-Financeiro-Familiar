import 'server-only';
import { todayInTz } from '@/lib/dates';
import { callText } from '@/server/llm/client';
import { MODELS } from '@/server/llm/models';
import type { AgentContext, StepResult } from '@/server/agents/shared/contracts';
import { logAgentRun } from '@/server/agents/shared/run-agent';
import { synthesisSystemPrompt, synthesisUserPrompt } from './prompts';

const SYNTHESIS_TIMEOUT_MS = 20_000;

/**
 * Redige a resposta final a partir dos resultados dos agentes.
 *
 * Este nó SEMPRE roda, inclusive quando tudo falhou — é ele que transforma
 * "passo x deu erro" em uma frase que a pessoa entende. Ver docs/architecture.md §3.4.
 */
export async function synthesize(
  userMessage: string,
  results: StepResult[],
  ctx: Omit<AgentContext, 'signal'>,
): Promise<string> {
  const today = todayInTz(ctx.timezone);
  const startedAt = Date.now();

  try {
    const result = await callText(
      'orchestrator',
      {
        system: synthesisSystemPrompt(),
        user: synthesisUserPrompt({ userName: 'você', today, userMessage, results }),
      },
      AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    );

    await logAgentRun({
      householdId: ctx.householdId,
      traceId: ctx.traceId,
      conversationId: ctx.conversationId,
      agent: 'orchestrator',
      intent: 'synthesize',
      status: 'success',
      durationMs: Date.now() - startedAt,
      errorCode: null,
      retried: false,
      model: MODELS.orchestrator,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    const text = result.value.trim();
    return text.length > 0 ? text : deterministicFallback(results);
  } catch (error) {
    console.error('[synthesize] falhou:', (error as Error).message);

    await logAgentRun({
      householdId: ctx.householdId,
      traceId: ctx.traceId,
      conversationId: ctx.conversationId,
      agent: 'orchestrator',
      intent: 'synthesize',
      status: 'error',
      durationMs: Date.now() - startedAt,
      errorCode: 'LLM',
      retried: false,
      model: MODELS.orchestrator,
    });

    return deterministicFallback(results);
  }
}

/**
 * Resposta sem LLM, montada a partir do que os agentes já disseram.
 *
 * É feia e telegráfica, mas é verdadeira: cada linha veio de um agente que
 * realmente rodou. A alternativa — não responder, ou responder algo genérico —
 * esconderia do usuário que a ação dele foi executada.
 */
function deterministicFallback(results: StepResult[]): string {
  if (results.length === 0) {
    return 'Não consegui processar esse pedido agora. Pode tentar de novo?';
  }

  const succeeded = results.filter((r) => r.status === 'success');
  const failed = results.filter((r) => r.status !== 'success');

  const parts: string[] = [];
  if (succeeded.length > 0) {
    parts.push(succeeded.map((r) => r.response?.summaryForOrchestrator ?? '').join('\n'));
  }
  if (failed.length > 0) {
    parts.push(
      `Não deu certo: ${failed.map((r) => r.response?.summaryForOrchestrator ?? r.step.intent).join(' ')}`,
    );
  }

  return parts.join('\n\n');
}
