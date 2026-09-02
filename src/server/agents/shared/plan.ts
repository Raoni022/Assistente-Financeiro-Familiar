import 'server-only';
import { z } from 'zod';
import {
  ACTIVE_AGENTS,
  ACTIVE_INTENTS,
  AGENT_BY_INTENT,
  type AgentIntent,
  type ExecutionPlan,
  type PlanStep,
  type StepResult,
} from './contracts';

/**
 * Validação e execução do plano produzido pelo roteador.
 *
 * Tudo aqui é determinístico e testável sem modelo. O LLM propõe um plano; este
 * módulo decide se ele é executável. Um plano inválido é erro de validação —
 * nunca uma execução parcial que falha no meio.
 */

export const PlanStepSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,15}$/, 'id deve ser curto e alfanumérico, ex: "s1"'),
  // Só agentes e intenções com implementação real: o modelo não consegue
  // propor algo que ainda não existe. Ver ACTIVE_AGENTS em contracts.ts.
  agent: z.enum(ACTIVE_AGENTS),
  intent: z.enum(ACTIVE_INTENTS as [AgentIntent, ...AgentIntent[]]),
  payload: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).max(8).default([]),
});

export const ExecutionPlanSchema = z.object({
  mode: z.enum(['direct', 'delegate']),
  directAnswer: z.string().max(2000).optional(),
  steps: z.array(PlanStepSchema).max(6).default([]),
  rationale: z.string().max(500),
});

export class PlanError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AGENT_INTENT_MISMATCH'
      | 'DUPLICATE_STEP_ID'
      | 'UNKNOWN_DEPENDENCY'
      | 'SELF_DEPENDENCY'
      | 'CYCLE'
      | 'EMPTY_DELEGATE'
      | 'DIRECT_WITH_STEPS'
      | 'MISSING_DIRECT_ANSWER'
      | 'UNRESOLVED_REFERENCE',
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

/**
 * Rejeita planos que não fazem sentido antes de gastar uma chamada de agente.
 * Cada checagem aqui corresponde a um jeito real de o modelo errar.
 */
export function validatePlan(plan: ExecutionPlan): void {
  if (plan.mode === 'direct') {
    if (plan.steps.length > 0) {
      throw new PlanError('Plano direto não pode ter passos.', 'DIRECT_WITH_STEPS');
    }
    if (!plan.directAnswer?.trim()) {
      throw new PlanError('Plano direto exige directAnswer.', 'MISSING_DIRECT_ANSWER');
    }
    return;
  }

  if (plan.steps.length === 0) {
    throw new PlanError('Plano de delegação sem passos.', 'EMPTY_DELEGATE');
  }

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) {
      throw new PlanError(`id de passo repetido: ${step.id}`, 'DUPLICATE_STEP_ID');
    }
    ids.add(step.id);

    // O agente é derivável da intenção. Se o modelo discordar de si mesmo, o
    // plano está incoerente e não vale adivinhar qual metade estava certa.
    if (AGENT_BY_INTENT[step.intent] !== step.agent) {
      throw new PlanError(
        `passo ${step.id}: intent ${step.intent} pertence a ${AGENT_BY_INTENT[step.intent]}, não a ${step.agent}`,
        'AGENT_INTENT_MISMATCH',
      );
    }
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) {
        throw new PlanError(`passo ${step.id} depende de si mesmo.`, 'SELF_DEPENDENCY');
      }
      if (!ids.has(dependency)) {
        throw new PlanError(
          `passo ${step.id} depende de ${dependency}, que não existe.`,
          'UNKNOWN_DEPENDENCY',
        );
      }
    }
  }

  // resolveLevels lança em ciclo — chamar aqui garante que o plano é executável
  // antes de qualquer efeito colateral.
  resolveLevels(plan.steps);
}

/**
 * Agrupa passos em níveis de execução. Cada nível roda em paralelo; o nível
 * seguinte só começa quando o anterior termina.
 *
 * "quanto gastamos e o que vence?" → um nível com dois passos.
 * "cadastra a conta e diz se estoura" → dois níveis de um passo.
 */
export function resolveLevels(steps: readonly PlanStep[]): PlanStep[][] {
  const pending = new Map(steps.map((step) => [step.id, step]));
  const done = new Set<string>();
  const levels: PlanStep[][] = [];

  while (pending.size > 0) {
    const ready = [...pending.values()].filter((step) =>
      step.dependsOn.every((dependency) => done.has(dependency)),
    );

    if (ready.length === 0) {
      throw new PlanError(
        `dependência circular entre: ${[...pending.keys()].join(', ')}`,
        'CYCLE',
      );
    }

    for (const step of ready) {
      pending.delete(step.id);
    }
    for (const step of ready) {
      done.add(step.id);
    }
    levels.push(ready);
  }

  return levels;
}

const REFERENCE = /^\$steps\.([a-z][a-z0-9_]{0,15})\.(.+)$/;

/**
 * Substitui referências `$steps.<id>.<caminho>` pelos valores já produzidos.
 *
 * É isto que faz "cadastra a conta e me diz se estoura o orçamento" funcionar:
 * o passo de Insights recebe o id da ocorrência que o passo de Contas acabou de
 * criar, sem que o modelo precise inventar um id.
 *
 * Referência não resolvível é erro, nunca `undefined` silencioso — um passo
 * rodando com parâmetro faltando produz resposta errada com cara de certa.
 */
export function resolveReferences(
  payload: Record<string, unknown>,
  results: ReadonlyMap<string, StepResult>,
): Record<string, unknown> {
  return resolveValue(payload, results) as Record<string, unknown>;
}

function resolveValue(value: unknown, results: ReadonlyMap<string, StepResult>): unknown {
  if (typeof value === 'string') {
    const match = REFERENCE.exec(value);
    if (!match) return value;

    const [, stepId, path] = match as unknown as [string, string, string];
    const result = results.get(stepId);

    if (!result || result.status !== 'success' || !result.response?.success) {
      throw new PlanError(
        `referência ${value} aponta para um passo que não concluiu com sucesso.`,
        'UNRESOLVED_REFERENCE',
      );
    }

    const resolved = readPath({ data: result.response.data }, path);
    if (resolved === undefined) {
      throw new PlanError(`referência ${value} não existe no resultado.`, 'UNRESOLVED_REFERENCE');
    }
    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, results));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveValue(item, results),
      ]),
    );
  }

  return value;
}

function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Passos que não podem mais rodar porque uma dependência falhou.
 *
 * O plano nunca aborta inteiro por causa de um ramo: passos independentes
 * seguem, e o sintetizador é informado exatamente do que ficou de fora.
 */
export function stepsBlockedBy(
  failedIds: ReadonlySet<string>,
  steps: readonly PlanStep[],
): Set<string> {
  const blocked = new Set<string>();
  let changed = true;

  // Ponto fixo: um passo bloqueado bloqueia quem depende dele, em cascata.
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (blocked.has(step.id)) continue;
      const isBlocked = step.dependsOn.some(
        (dependency) => failedIds.has(dependency) || blocked.has(dependency),
      );
      if (isBlocked) {
        blocked.add(step.id);
        changed = true;
      }
    }
  }

  return blocked;
}
