import { describe, expect, it } from 'vitest';
import type { ExecutionPlan, PlanStep, StepResult } from '@/server/agents/shared/contracts';
import {
  ExecutionPlanSchema,
  PlanError,
  resolveLevels,
  resolveReferences,
  stepsBlockedBy,
  validatePlan,
} from '@/server/agents/shared/plan';

const step = (
  id: string,
  overrides: Partial<PlanStep> = {},
): PlanStep => ({
  id,
  agent: 'bills',
  intent: 'bills.list',
  payload: {},
  dependsOn: [],
  ...overrides,
});

const delegate = (steps: PlanStep[]): ExecutionPlan => ({
  mode: 'delegate',
  steps,
  rationale: 'teste',
});

const successResult = (id: string, data: Record<string, unknown>): StepResult => ({
  step: step(id),
  status: 'success',
  response: { success: true, data, summaryForOrchestrator: 'ok' },
  durationMs: 1,
  retried: false,
});

describe('ExecutionPlanSchema', () => {
  it('aceita um plano mínimo e aplica os defaults', () => {
    const parsed = ExecutionPlanSchema.parse({
      mode: 'delegate',
      rationale: 'cadastro simples',
      steps: [{ id: 's1', agent: 'bills', intent: 'bills.create' }],
    });
    expect(parsed.steps[0]).toMatchObject({ payload: {}, dependsOn: [] });
  });

  it('rejeita intenção fora da união fechada', () => {
    const result = ExecutionPlanSchema.safeParse({
      mode: 'delegate',
      rationale: 'x',
      steps: [{ id: 's1', agent: 'bills', intent: 'bills.inventada' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejeita intenção de agente ainda não implementado', () => {
    /*
     * O golden set flagrou o roteador propondo `insights.compare_periods` para
     * "quem gastou mais esse mês?" — intenção válida na taxonomia e sem agente
     * por trás. O usuário receberia "isso entra numa fase seguinte" para uma
     * pergunta que o agente de Gastos responde hoje.
     *
     * Restringir o schema torna o erro impossível em vez de instruído. Este
     * teste guarda essa fronteira sem gastar chamada de modelo — quando o
     * Insights entrar, ele falha e lembra de atualizar ACTIVE_AGENTS.
     */
    const result = ExecutionPlanSchema.safeParse({
      mode: 'delegate',
      rationale: 'x',
      steps: [{ id: 's1', agent: 'insights', intent: 'insights.compare_periods' }],
    });
    expect(result.success).toBe(false);
  });

  it('aceita as intenções dos agentes que existem', () => {
    for (const intent of ['bills.list', 'transactions.create', 'tasks.complete'] as const) {
      const result = ExecutionPlanSchema.safeParse({
        mode: 'delegate',
        rationale: 'x',
        steps: [{ id: 's1', agent: intent.split('.')[0], intent }],
      });
      expect(result.success, intent).toBe(true);
    }
  });

  it('rejeita plano com passos demais', () => {
    const steps = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      agent: 'bills',
      intent: 'bills.list',
    }));
    expect(ExecutionPlanSchema.safeParse({ mode: 'delegate', rationale: 'x', steps }).success).toBe(
      false,
    );
  });
});

describe('validatePlan', () => {
  it('aceita um plano coerente', () => {
    expect(() => validatePlan(delegate([step('s1')]))).not.toThrow();
  });

  it('rejeita agente que não corresponde à intenção', () => {
    // O modelo às vezes acerta a intenção e erra o agente. Adivinhar qual metade
    // estava certa seria pior do que recusar.
    const plan = delegate([step('s1', { agent: 'tasks', intent: 'bills.create' })]);
    expect(() => validatePlan(plan)).toThrow(
      expect.objectContaining({ code: 'AGENT_INTENT_MISMATCH' }),
    );
  });

  it('rejeita ids repetidos', () => {
    expect(() => validatePlan(delegate([step('s1'), step('s1')]))).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_STEP_ID' }),
    );
  });

  it('rejeita dependência inexistente', () => {
    const plan = delegate([step('s1', { dependsOn: ['s9'] })]);
    expect(() => validatePlan(plan)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_DEPENDENCY' }),
    );
  });

  it('rejeita autodependência', () => {
    const plan = delegate([step('s1', { dependsOn: ['s1'] })]);
    expect(() => validatePlan(plan)).toThrow(expect.objectContaining({ code: 'SELF_DEPENDENCY' }));
  });

  it('rejeita ciclo', () => {
    const plan = delegate([
      step('s1', { dependsOn: ['s2'] }),
      step('s2', { dependsOn: ['s1'] }),
    ]);
    expect(() => validatePlan(plan)).toThrow(expect.objectContaining({ code: 'CYCLE' }));
  });

  it('rejeita delegação sem passos', () => {
    expect(() => validatePlan(delegate([]))).toThrow(
      expect.objectContaining({ code: 'EMPTY_DELEGATE' }),
    );
  });

  it('exige directAnswer no modo direto e proíbe passos', () => {
    expect(() => validatePlan({ mode: 'direct', steps: [], rationale: 'x' })).toThrow(
      expect.objectContaining({ code: 'MISSING_DIRECT_ANSWER' }),
    );
    expect(() =>
      validatePlan({ mode: 'direct', directAnswer: 'oi', steps: [step('s1')], rationale: 'x' }),
    ).toThrow(expect.objectContaining({ code: 'DIRECT_WITH_STEPS' }));
  });
});

describe('resolveLevels', () => {
  it('põe passos independentes no mesmo nível — eles rodam em paralelo', () => {
    const levels = resolveLevels([step('s1'), step('s2')]);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('serializa quando há dependência', () => {
    const levels = resolveLevels([step('s2', { dependsOn: ['s1'] }), step('s1')]);
    expect(levels.map((level) => level.map((s) => s.id))).toEqual([['s1'], ['s2']]);
  });

  it('resolve um losango: dois ramos paralelos que voltam a convergir', () => {
    const levels = resolveLevels([
      step('a'),
      step('b', { dependsOn: ['a'] }),
      step('c', { dependsOn: ['a'] }),
      step('d', { dependsOn: ['b', 'c'] }),
    ]);
    expect(levels.map((l) => l.map((s) => s.id).sort())).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('resolveReferences', () => {
  const results = new Map<string, StepResult>([
    ['s1', successResult('s1', { occurrenceId: 'occ-123', bill: { title: 'Energia' } })],
  ]);

  it('resolve uma referência simples', () => {
    expect(resolveReferences({ id: '$steps.s1.data.occurrenceId' }, results)).toEqual({
      id: 'occ-123',
    });
  });

  it('resolve caminho aninhado', () => {
    expect(resolveReferences({ t: '$steps.s1.data.bill.title' }, results)).toEqual({ t: 'Energia' });
  });

  it('resolve dentro de arrays e objetos aninhados', () => {
    expect(
      resolveReferences({ ids: ['$steps.s1.data.occurrenceId', 'fixo'], n: { v: 1 } }, results),
    ).toEqual({ ids: ['occ-123', 'fixo'], n: { v: 1 } });
  });

  it('deixa strings comuns intactas', () => {
    expect(resolveReferences({ q: 'gastei $100 no mercado' }, results)).toEqual({
      q: 'gastei $100 no mercado',
    });
  });

  it('falha quando o caminho não existe, em vez de virar undefined', () => {
    // Um passo rodando com parâmetro faltando produz resposta errada com cara
    // de certa — é o pior modo de falha possível aqui.
    expect(() => resolveReferences({ x: '$steps.s1.data.naoExiste' }, results)).toThrow(
      expect.objectContaining({ code: 'UNRESOLVED_REFERENCE' }),
    );
  });

  it('falha quando o passo referenciado não teve sucesso', () => {
    const failed = new Map<string, StepResult>([
      [
        's1',
        {
          step: step('s1'),
          status: 'error',
          response: {
            success: false,
            error: { code: 'DB', message: 'x', retryable: false },
            summaryForOrchestrator: 'falhou',
          },
          durationMs: 1,
          retried: false,
        },
      ],
    ]);
    expect(() => resolveReferences({ x: '$steps.s1.data.id' }, failed)).toThrow(PlanError);
  });
});

describe('stepsBlockedBy', () => {
  it('bloqueia dependentes em cascata, sem tocar nos independentes', () => {
    const steps = [
      step('s1'),
      step('s2', { dependsOn: ['s1'] }),
      step('s3', { dependsOn: ['s2'] }),
      step('s4'),
    ];
    expect([...stepsBlockedBy(new Set(['s1']), steps)].sort()).toEqual(['s2', 's3']);
  });

  it('não bloqueia nada quando nada falhou', () => {
    const steps = [step('s1'), step('s2', { dependsOn: ['s1'] })];
    expect(stepsBlockedBy(new Set(), steps).size).toBe(0);
  });
});
