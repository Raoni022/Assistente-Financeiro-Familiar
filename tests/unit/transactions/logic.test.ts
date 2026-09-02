import { describe, expect, it } from 'vitest';
import {
  aggregateBy,
  inferCategory,
  reconcileCategory,
  resolveDateExpression,
} from '@/server/agents/transactions/logic';

/** Quarta-feira, 2 de setembro de 2026. Toda expectativa abaixo parte daqui. */
const HOJE = '2026-09-02';

describe('resolveDateExpression — âncoras simples', () => {
  it.each([
    [null, HOJE],
    ['', HOJE],
    ['hoje', HOJE],
    ['ontem', '2026-09-01'],
    ['anteontem', '2026-08-31'],
    ['semana passada', '2026-08-26'],
    ['semana retrasada', '2026-08-19'],
    ['mês passado', '2026-08-02'],
  ])('%j → %s', (expression, expected) => {
    expect(resolveDateExpression(expression, HOJE)).toBe(expected);
  });

  it('atravessa a virada de mês', () => {
    expect(resolveDateExpression('ontem', '2026-09-01')).toBe('2026-08-31');
    expect(resolveDateExpression('anteontem', '2026-01-01')).toBe('2025-12-30');
  });
});

describe('resolveDateExpression — dias da semana', () => {
  it('“sexta” a partir de uma quarta é a sexta anterior', () => {
    expect(resolveDateExpression('sexta', HOJE)).toBe('2026-08-28');
    expect(resolveDateExpression('na sexta-feira', HOJE)).toBe('2026-08-28');
  });

  it('“segunda” a partir de uma quarta é a segunda desta semana', () => {
    expect(resolveDateExpression('segunda', HOJE)).toBe('2026-08-31');
  });

  it('no próprio dia, “na quarta” é hoje mas “quarta passada” é a anterior', () => {
    // A diferença entre as duas leituras é exatamente a palavra "passada".
    expect(resolveDateExpression('na quarta', HOJE)).toBe(HOJE);
    expect(resolveDateExpression('quarta passada', HOJE)).toBe('2026-08-26');
  });

  it('entende “última sexta” como sinônimo de “sexta passada”', () => {
    expect(resolveDateExpression('última sexta', HOJE)).toBe('2026-08-28');
  });

  it('entende acentuação de sábado e terça', () => {
    expect(resolveDateExpression('sábado', HOJE)).toBe('2026-08-29');
    expect(resolveDateExpression('terça', HOJE)).toBe('2026-09-01');
  });
});

describe('resolveDateExpression — dia do mês e datas numéricas', () => {
  it('“dia 28” dito no dia 2 é do mês passado, não daqui a 26 dias', () => {
    expect(resolveDateExpression('dia 28', HOJE)).toBe('2026-08-28');
  });

  it('“dia 1” dito no dia 2 é deste mês', () => {
    expect(resolveDateExpression('dia 1', HOJE)).toBe('2026-09-01');
  });

  it('“no dia 2” é hoje', () => {
    expect(resolveDateExpression('no dia 2', HOJE)).toBe(HOJE);
  });

  it('aceita data numérica com e sem ano', () => {
    expect(resolveDateExpression('28/08', HOJE)).toBe('2026-08-28');
    expect(resolveDateExpression('28/08/2025', HOJE)).toBe('2025-08-28');
    expect(resolveDateExpression('5/1/26', HOJE)).toBe('2026-01-05');
  });

  it('sem ano, uma data futura é do ano anterior', () => {
    // Gasto é sempre passado: "28/12" dito em setembro é de dezembro passado.
    expect(resolveDateExpression('28/12', HOJE)).toBe('2025-12-28');
  });

  it('aceita ISO direto', () => {
    expect(resolveDateExpression('2026-07-15', HOJE)).toBe('2026-07-15');
  });

  it('rejeita data que não existe em vez de deixar escorregar', () => {
    // 31 de fevereiro viraria 3 de março numa conversão ingênua.
    expect(resolveDateExpression('31/02', HOJE)).toBeNull();
    expect(resolveDateExpression('dia 45', HOJE)).toBeNull();
  });

  it('devolve null para expressão que não entende, em vez de assumir hoje', () => {
    // Assumir hoje num gasto de outro mês corrompe a consolidação em silêncio.
    expect(resolveDateExpression('quando deu vontade', HOJE)).toBeNull();
    expect(resolveDateExpression('outro dia', HOJE)).toBeNull();
  });
});

describe('inferCategory', () => {
  it.each([
    ['pedi ifood ontem', 'delivery'],
    ['fui de uber pro centro', 'transporte'],
    ['abasteci o carro', 'combustivel'],
    ['compras do supermercado', 'mercado'],
    ['passei na drogaria', 'farmacia'],
    ['almoçamos fora', 'restaurante'],
    ['consulta com o dentista', 'saude'],
    ['ração do cachorro no petshop', 'pet'],
    ['ingresso do cinema', 'lazer'],
    ['assinatura da netflix', 'assinatura'],
  ])('%j → %s', (text, expected) => {
    expect(inferCategory(text)).toBe(expected);
  });

  it('devolve null quando nada é evidente, em vez de chutar "outros"', () => {
    // Chutar esconde do usuário que a classificação não aconteceu, e categoria
    // errada envenena o Insights depois.
    expect(inferCategory('gastei 200 numa parada aí')).toBeNull();
  });
});

describe('reconcileCategory', () => {
  const allowed = ['mercado', 'delivery', 'transporte', 'saude', 'outros'];

  it('confia no modelo quando a categoria existe', () => {
    expect(reconcileCategory('saude', 'comprei fralda pro bebê', allowed)).toEqual({
      key: 'saude',
      source: 'model',
    });
  });

  it('cai na heurística quando o modelo inventa uma categoria', () => {
    expect(reconcileCategory('comida_fora', 'pedi ifood', allowed)).toEqual({
      key: 'delivery',
      source: 'heuristic',
    });
  });

  it('cai na heurística quando o modelo não respondeu', () => {
    expect(reconcileCategory(null, 'fui de uber', allowed)).toEqual({
      key: 'transporte',
      source: 'heuristic',
    });
  });

  it('ignora heurística que aponta para categoria fora da lista permitida', () => {
    expect(reconcileCategory(null, 'ingresso do cinema', allowed)).toEqual({
      key: null,
      source: 'none',
    });
  });

  it('devolve none quando nem o modelo nem a heurística sabem', () => {
    expect(reconcileCategory(null, 'gastei 50 ali', allowed)).toEqual({
      key: null,
      source: 'none',
    });
  });
});

describe('aggregateBy', () => {
  const transactions = [
    { amountCents: 21840, categoryKey: 'mercado', spentById: 'camila' },
    { amountCents: 6490, categoryKey: 'delivery', spentById: 'raoni' },
    { amountCents: 9210, categoryKey: 'mercado', spentById: 'raoni' },
    { amountCents: 4500, categoryKey: null, spentById: 'raoni' },
  ];

  it('soma por categoria, do maior para o menor', () => {
    expect(aggregateBy(transactions, 'category')).toEqual([
      { key: 'mercado', totalCents: 31050, count: 2 },
      { key: 'delivery', totalCents: 6490, count: 1 },
      { key: 'sem_categoria', totalCents: 4500, count: 1 },
    ]);
  });

  it('soma por pessoa', () => {
    expect(aggregateBy(transactions, 'person')).toEqual([
      { key: 'raoni', totalCents: 20200, count: 3 },
      { key: 'camila', totalCents: 21840, count: 1 },
    ].sort((a, b) => b.totalCents - a.totalCents));
  });

  it('devolve vazio para lista vazia', () => {
    expect(aggregateBy([], 'category')).toEqual([]);
  });
});
