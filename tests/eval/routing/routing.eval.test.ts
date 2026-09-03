import { describe, expect, it } from 'vitest';
import '../../../scripts/load-env.mjs';
import goldenSet from './golden-set.json';
import { buildPlan } from '@/server/agents/orchestrator/router';
import type { RouterContext } from '@/server/agents/orchestrator/prompts';

/**
 * Golden set de roteamento.
 *
 * **Rode isto sempre que mexer no prompt do orquestrador** (`npm run eval`).
 * É a única forma de saber se uma mudança de redação melhorou ou piorou o
 * roteamento — sem ele, ajustar prompt é chute com passo firme.
 *
 * Chama modelo e custa dinheiro, então fica fora de `npm test`. Precisa de
 * ANTHROPIC_API_KEY, mas NÃO precisa de Supabase.
 */

const configured = Boolean(process.env['ANTHROPIC_API_KEY']);

/** Abaixo disso, o roteamento não é confiável o bastante para ir a produção. */
const MIN_ACCURACY = 0.9;

const CATEGORY_KEYS = [
  'mercado', 'delivery', 'restaurante', 'transporte', 'combustivel', 'saude', 'farmacia',
  'educacao', 'lazer', 'vestuario', 'casa', 'pet', 'assinatura', 'energia', 'agua',
  'internet', 'telefone', 'aluguel', 'condominio', 'cartao', 'emprestimo', 'imposto',
  'seguro', 'salario', 'outros',
];

const context: RouterContext = {
  today: goldenSet.today,
  timezone: 'America/Sao_Paulo',
  userName: 'Raoni',
  members: goldenSet.members,
  categoryKeys: CATEGORY_KEYS,
  activeBills: goldenSet.activeBills,
  memories: [],
  conversation: { summary: null, recentTurns: [] },
};

interface Failure {
  id: string;
  message: string;
  expected: string;
  got: string;
  rationale: string;
}

describe.skipIf(!configured)('roteamento — golden set', () => {
  const failures: Failure[] = [];
  let correct = 0;

  // Um `it` por caso: a saída do vitest já vira o relatório de quais frases
  // regrediram, sem precisar de um runner próprio.
  for (const testCase of goldenSet.cases) {
    it(`${testCase.id}: ${testCase.message}`, { timeout: 60_000 }, async () => {
      const { plan } = await buildPlan(testCase.message, context);

      const gotIntents = plan.steps.map((step) => step.intent).sort();
      const expectedIntents = [...testCase.intents].sort();

      const matches =
        plan.mode === testCase.mode &&
        gotIntents.length === expectedIntents.length &&
        gotIntents.every((intent, index) => intent === expectedIntents[index]);

      if (matches) {
        correct += 1;
      } else {
        failures.push({
          id: testCase.id,
          message: testCase.message,
          expected: `${testCase.mode} [${expectedIntents.join(', ')}]`,
          got: `${plan.mode} [${gotIntents.join(', ')}]`,
          rationale: plan.rationale,
        });
      }

      expect({ mode: plan.mode, intents: gotIntents }).toEqual({
        mode: testCase.mode,
        intents: expectedIntents,
      });
    });
  }

  it('acurácia geral fica acima do limiar', () => {
    const total = goldenSet.cases.length;
    const accuracy = correct / total;

    if (failures.length > 0) {
      console.log('\nCasos que erraram:');
      for (const failure of failures) {
        console.log(`  ${failure.id}: "${failure.message}"`);
        console.log(`    esperado: ${failure.expected}`);
        console.log(`    obtido:   ${failure.got}`);
        console.log(`    porquê:   ${failure.rationale}`);
      }
    }

    console.log(`\nAcurácia: ${correct}/${total} (${(accuracy * 100).toFixed(1)}%)\n`);
    expect(accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });
});

describe.skipIf(configured)('roteamento — golden set', () => {
  it('pulado: defina ANTHROPIC_API_KEY para rodar (não precisa de Supabase)', () => {
    expect(configured).toBe(false);
  });
});
