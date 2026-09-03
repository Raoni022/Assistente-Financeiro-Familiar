import { describe, expect, it } from 'vitest';
import '../../../scripts/load-env.mjs';
import dataset from './dataset.json';
import { buildPlan } from '@/server/agents/orchestrator/router';
import type { RouterContext } from '@/server/agents/orchestrator/prompts';
import { TransactionsCreateSchema } from '@/server/agents/transactions/schemas';
import { reconcileCategory, resolveDateExpression } from '@/server/agents/transactions/logic';
import { parseBRLToCents } from '@/lib/money';

/**
 * Avaliação de extração do Agente de Gastos — o gate da Fase 3.
 *
 * Mede o que **de fato chegaria ao banco**, não a saída crua do modelo: a frase
 * passa pelo roteador e o payload resultante passa pelos MESMOS conversores que
 * o agente usa em produção. Medir só o JSON do LLM daria uma taxa de acerto
 * bonita e irrelevante — o que corrompe dado é o valor final gravado.
 *
 * `npm run eval`. Precisa de ANTHROPIC_API_KEY; não precisa de Supabase.
 */

const configured = Boolean(process.env['ANTHROPIC_API_KEY']);

/**
 * Limiares por campo, calibrados pelo custo do erro:
 *  - valor errado é o pior defeito possível num app financeiro;
 *  - data errada joga o gasto para outro mês e distorce a consolidação;
 *  - categoria errada é chato, corrigível pelo usuário, e vira aprendizado.
 */
const THRESHOLDS = { amount: 0.98, date: 0.95, category: 0.85, exact: 0.85 };

const CATEGORY_KEYS = [
  'mercado', 'delivery', 'restaurante', 'transporte', 'combustivel', 'saude', 'farmacia',
  'educacao', 'lazer', 'vestuario', 'casa', 'pet', 'assinatura', 'energia', 'agua',
  'internet', 'telefone', 'aluguel', 'condominio', 'cartao', 'emprestimo', 'imposto',
  'seguro', 'salario', 'outros',
];

const context: RouterContext = {
  today: dataset.today,
  timezone: 'America/Sao_Paulo',
  userName: 'Raoni',
  members: ['Raoni', 'Camila'],
  categoryKeys: CATEGORY_KEYS,
  activeBills: dataset.activeBills,
  memories: [],
  conversation: { summary: null, recentTurns: [] },
};

interface Extracted {
  amountCents: number | null;
  occurredOn: string | null;
  categoryKey: string | null;
  kind: string;
  routed: boolean;
  /** Para onde o roteador mandou, quando não foi para transactions.create. */
  actualIntents: string[];
}

/** Roda a frase pelo caminho real: roteador → schema → conversores. */
async function extract(message: string): Promise<Extracted> {
  const { plan } = await buildPlan(message, context);

  const actualIntents = plan.steps.map((candidate) => candidate.intent);
  const step = plan.steps.find((candidate) => candidate.intent === 'transactions.create');
  if (!step) {
    // Saber que não roteou não basta: sem saber para ONDE foi, o relatório não
    // diz o que corrigir. Custou uma rodada inteira descobrir isso.
    return {
      amountCents: null, occurredOn: null, categoryKey: null,
      kind: 'expense', routed: false,
      actualIntents: actualIntents.length > 0 ? actualIntents : [`direct: ${plan.rationale.slice(0, 80)}`],
    };
  }

  const parsed = TransactionsCreateSchema.safeParse(step.payload);
  if (!parsed.success) {
    return {
      amountCents: null, occurredOn: null, categoryKey: null,
      kind: 'expense', routed: true, actualIntents,
    };
  }

  const payload = parsed.data;

  let amountCents: number | null = null;
  try {
    amountCents = parseBRLToCents(payload.amount);
  } catch {
    amountCents = null;
  }

  const category = reconcileCategory(payload.categoryKey, payload.rawText || message, CATEGORY_KEYS);

  return {
    amountCents,
    occurredOn: resolveDateExpression(payload.dateExpression, dataset.today),
    categoryKey: category.key,
    kind: payload.kind,
    routed: true,
    actualIntents,
  };
}

const tally = { amount: 0, date: 0, category: 0, exact: 0, routed: 0 };
const misses: string[] = [];

describe.skipIf(!configured)('extração de gastos — taxa de acerto', () => {
  for (const testCase of dataset.cases) {
    it(`${testCase.id}: ${testCase.message}`, { timeout: 60_000 }, async () => {
      /*
       * Exceção também é resultado de medição.
       *
       * Na primeira execução, "netflix 55,90" estourou um TypeError dentro do
       * roteador e o caso saiu do relatório inteiro — o instrumento perdeu
       * justamente o caso mais interessante. Capturar aqui mantém a falha
       * visível e contabilizada.
       */
      let got: Extracted;
      try {
        got = await extract(testCase.message);
      } catch (error) {
        misses.push(`  ${testCase.id} "${testCase.message}"
    EXCEÇÃO: ${(error as Error).message}`);
        throw error;
      }

      const expectedCategories = testCase.categories as Array<string | null>;
      const expectedKind = (testCase as { kind?: string }).kind ?? 'expense';

      const amountOk = got.amountCents === testCase.amountCents;
      const dateOk = got.occurredOn === testCase.occurredOn;
      const categoryOk = expectedCategories.includes(got.categoryKey);
      const kindOk = got.kind === expectedKind;

      if (got.routed) tally.routed += 1;
      if (amountOk) tally.amount += 1;
      if (dateOk) tally.date += 1;
      if (categoryOk) tally.category += 1;
      if (amountOk && dateOk && categoryOk && kindOk) tally.exact += 1;

      if (!(amountOk && dateOk && categoryOk && kindOk)) {
        misses.push(
          `  ${testCase.id} "${testCase.message}"\n` +
            `    valor:     ${amountOk ? 'ok' : `${got.amountCents} ≠ ${testCase.amountCents}`}\n` +
            `    data:      ${dateOk ? 'ok' : `${got.occurredOn} ≠ ${testCase.occurredOn}`}\n` +
            `    categoria: ${categoryOk ? 'ok' : `${got.categoryKey} ∉ [${expectedCategories.join(', ')}]`}\n` +
            `    tipo:      ${kindOk ? 'ok' : `${got.kind} ≠ ${expectedKind}`}` +
            (got.routed ? '' : `
    roteou p/: ${got.actualIntents.join(', ')}`),
        );
      }

      expect({ amountOk, dateOk, categoryOk, kindOk }).toEqual({
        amountOk: true,
        dateOk: true,
        categoryOk: true,
        kindOk: true,
      });
    });
  }

  it('taxas de acerto ficam acima dos limiares', () => {
    const total = dataset.cases.length;
    const rate = (n: number) => n / total;

    if (misses.length > 0) {
      console.log('\nCasos que erraram:\n' + misses.join('\n'));
    }

    console.log(
      `\nExtração (${total} frases)\n` +
        `  roteado p/ transactions.create: ${tally.routed}/${total}\n` +
        `  valor:     ${tally.amount}/${total} (${(rate(tally.amount) * 100).toFixed(1)}%)\n` +
        `  data:      ${tally.date}/${total} (${(rate(tally.date) * 100).toFixed(1)}%)\n` +
        `  categoria: ${tally.category}/${total} (${(rate(tally.category) * 100).toFixed(1)}%)\n` +
        `  os três:   ${tally.exact}/${total} (${(rate(tally.exact) * 100).toFixed(1)}%)\n`,
    );

    expect(rate(tally.amount)).toBeGreaterThanOrEqual(THRESHOLDS.amount);
    expect(rate(tally.date)).toBeGreaterThanOrEqual(THRESHOLDS.date);
    expect(rate(tally.category)).toBeGreaterThanOrEqual(THRESHOLDS.category);
    expect(rate(tally.exact)).toBeGreaterThanOrEqual(THRESHOLDS.exact);
  });
});

describe.skipIf(configured)('extração de gastos', () => {
  it('pulado: defina ANTHROPIC_API_KEY para rodar (não precisa de Supabase)', () => {
    expect(configured).toBe(false);
  });
});
