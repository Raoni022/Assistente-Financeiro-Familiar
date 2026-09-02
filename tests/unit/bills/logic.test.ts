import { describe, expect, it } from 'vitest';
import {
  findPotentialDuplicates,
  generateOccurrenceDates,
  normalizeTitle,
  sortByAttention,
  titleSimilarity,
  type BillFingerprint,
  type RecurrenceSpec,
} from '@/server/agents/bills/logic';

const monthly = (day: number, startsOn: string, endsOn: string | null = null): RecurrenceSpec => ({
  recurrence: 'monthly',
  startsOn,
  endsOn,
  recurrenceDay: day,
});

describe('generateOccurrenceDates — mensal', () => {
  it('gera um vencimento por mês no dia configurado', () => {
    expect(generateOccurrenceDates(monthly(15, '2026-09-15'), '2026-09-01', '2026-12-31')).toEqual([
      '2026-09-15',
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
    ]);
  });

  it('encurta o dia 31 para o último dia do mês curto, sem pular nem escorregar', () => {
    // Fevereiro de 2026 tem 28 dias. A conta vence em 28/02, não some da lista
    // nem vira 01/03 — é o que banco e cartão fazem.
    expect(generateOccurrenceDates(monthly(31, '2026-01-31'), '2026-01-01', '2026-05-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('respeita ano bissexto', () => {
    expect(generateOccurrenceDates(monthly(31, '2028-01-31'), '2028-02-01', '2028-02-29')).toEqual([
      '2028-02-29',
    ]);
  });

  it('não gera vencimento antes de starts_on', () => {
    // Começa em 20/01 com vencimento dia 15: o primeiro é 15/02, não 15/01.
    expect(generateOccurrenceDates(monthly(15, '2026-01-20'), '2026-01-01', '2026-03-31')).toEqual([
      '2026-02-15',
      '2026-03-15',
    ]);
  });

  it('para em ends_on', () => {
    expect(
      generateOccurrenceDates(monthly(10, '2026-01-10', '2026-03-01'), '2026-01-01', '2026-12-31'),
    ).toEqual(['2026-01-10', '2026-02-10']);
  });

  it('atravessa a virada de ano', () => {
    expect(generateOccurrenceDates(monthly(5, '2026-11-05'), '2026-11-01', '2027-02-28')).toEqual([
      '2026-11-05',
      '2026-12-05',
      '2027-01-05',
      '2027-02-05',
    ]);
  });
});

describe('generateOccurrenceDates — demais recorrências', () => {
  it('avulsa gera exatamente um vencimento', () => {
    const spec: RecurrenceSpec = {
      recurrence: 'none',
      startsOn: '2026-09-15',
      endsOn: null,
      recurrenceDay: null,
    };
    expect(generateOccurrenceDates(spec, '2026-09-01', '2026-12-31')).toEqual(['2026-09-15']);
    expect(generateOccurrenceDates(spec, '2026-10-01', '2026-12-31')).toEqual([]);
  });

  it('semanal a cada 7 dias', () => {
    const spec: RecurrenceSpec = {
      recurrence: 'weekly',
      startsOn: '2026-09-02',
      endsOn: null,
      recurrenceDay: null,
    };
    expect(generateOccurrenceDates(spec, '2026-09-01', '2026-09-30')).toEqual([
      '2026-09-02',
      '2026-09-09',
      '2026-09-16',
      '2026-09-23',
      '2026-09-30',
    ]);
  });

  it('trimestral a cada 3 meses', () => {
    const spec: RecurrenceSpec = {
      recurrence: 'quarterly',
      startsOn: '2026-01-10',
      endsOn: null,
      recurrenceDay: 10,
    };
    expect(generateOccurrenceDates(spec, '2026-01-01', '2026-12-31')).toEqual([
      '2026-01-10',
      '2026-04-10',
      '2026-07-10',
      '2026-10-10',
    ]);
  });

  it('anual a cada 12 meses', () => {
    const spec: RecurrenceSpec = {
      recurrence: 'yearly',
      startsOn: '2026-03-20',
      endsOn: null,
      recurrenceDay: 20,
    };
    expect(generateOccurrenceDates(spec, '2026-01-01', '2029-01-01')).toEqual([
      '2026-03-20',
      '2027-03-20',
      '2028-03-20',
    ]);
  });

  it('devolve vazio quando a janela é inválida ou anterior ao início', () => {
    expect(generateOccurrenceDates(monthly(15, '2026-09-15'), '2026-12-31', '2026-01-01')).toEqual([]);
    expect(generateOccurrenceDates(monthly(15, '2026-09-15'), '2026-01-01', '2026-05-31')).toEqual([]);
  });

  it('exige recurrenceDay para recorrência mensal', () => {
    const spec: RecurrenceSpec = {
      recurrence: 'monthly',
      startsOn: '2026-09-15',
      endsOn: null,
      recurrenceDay: null,
    };
    expect(() => generateOccurrenceDates(spec, '2026-09-01', '2026-12-31')).toThrow(RangeError);
  });
});

describe('normalizeTitle e titleSimilarity', () => {
  it('ignora acento, caixa e pontuação', () => {
    expect(normalizeTitle('Conta de Água — COPASA')).toBe('conta de agua copasa');
    expect(titleSimilarity('Conta de Água', 'conta de agua')).toBe(1);
  });

  it('ignora palavras que não distinguem uma conta de outra', () => {
    expect(titleSimilarity('Conta de Luz', 'Luz')).toBe(1);
  });

  it('dá zero para contas sem nada em comum', () => {
    expect(titleSimilarity('Internet Vivo', 'Energia CEMIG')).toBe(0);
  });
});

describe('findPotentialDuplicates', () => {
  const existing: BillFingerprint[] = [
    { id: 'b1', title: 'Conta de Luz', amountCents: 34000, dueDate: '2026-09-15' },
    { id: 'b2', title: 'Internet Vivo', amountCents: 12990, dueDate: '2026-09-08' },
  ];

  it('sinaliza título e valor iguais na mesma janela', () => {
    const found = findPotentialDuplicates(
      { title: 'conta de luz', amountCents: 34000, dueDate: '2026-09-16' },
      existing,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ billId: 'b1', reason: 'titulo_e_valor_iguais' });
  });

  it('sinaliza título parecido na mesma data mesmo com valor diferente', () => {
    // A conta de luz varia todo mês — valor diferente não descarta duplicata.
    const found = findPotentialDuplicates(
      { title: 'Luz', amountCents: 41500, dueDate: '2026-09-15' },
      existing,
    );
    expect(found[0]).toMatchObject({ billId: 'b1', reason: 'titulo_parecido_mesma_data' });
  });

  it('não sinaliza contas genuinamente diferentes', () => {
    expect(
      findPotentialDuplicates(
        { title: 'Academia', amountCents: 9900, dueDate: '2026-09-10' },
        existing,
      ),
    ).toEqual([]);
  });

  it('não confunde dois cartões diferentes no mesmo dia e valor', () => {
    // "cartao" é o único token em comum: 1/3 de similaridade, abaixo do corte.
    // Dois cartões distintos com a mesma fatura no mesmo dia é coincidência
    // plausível, e perguntar a cada vez seria ruído.
    const cards: BillFingerprint[] = [
      { id: 'c1', title: 'Cartão Nubank', amountCents: 50000, dueDate: '2026-09-10' },
    ];
    expect(
      findPotentialDuplicates(
        { title: 'Cartão Itaú', amountCents: 50000, dueDate: '2026-09-10' },
        cards,
      ),
    ).toEqual([]);
  });

  it('ordena por confiança', () => {
    const many: BillFingerprint[] = [
      { id: 'x', title: 'Luz', amountCents: 99999, dueDate: '2026-09-15' },
      { id: 'y', title: 'Conta de Luz', amountCents: 34000, dueDate: '2026-09-15' },
    ];
    const found = findPotentialDuplicates(
      { title: 'Conta de Luz', amountCents: 34000, dueDate: '2026-09-15' },
      many,
    );
    expect(found.map((f) => f.billId)).toEqual(['y', 'x']);
  });
});

describe('sortByAttention', () => {
  it('põe vencidas primeiro, mais antiga na frente', () => {
    const items = [
      { id: 'futura', dueDate: '2026-09-20', status: 'pending', amountCents: 100 },
      { id: 'vencida-recente', dueDate: '2026-09-01', status: 'pending', amountCents: 100 },
      { id: 'vencida-antiga', dueDate: '2026-08-10', status: 'pending', amountCents: 100 },
      { id: 'paga-antiga', dueDate: '2026-08-05', status: 'paid', amountCents: 100 },
    ];
    expect(sortByAttention(items, '2026-09-02').map((i) => i.id)).toEqual([
      'vencida-antiga',
      'vencida-recente',
      'paga-antiga',
      'futura',
    ]);
  });

  it('desempata pelo valor maior', () => {
    const items = [
      { id: 'pequena', dueDate: '2026-09-15', status: 'pending', amountCents: 1000 },
      { id: 'grande', dueDate: '2026-09-15', status: 'pending', amountCents: 90000 },
    ];
    expect(sortByAttention(items, '2026-09-02').map((i) => i.id)).toEqual(['grande', 'pequena']);
  });

  it('não muta o array recebido', () => {
    const items = [
      { id: 'a', dueDate: '2026-09-20', status: 'pending', amountCents: 100 },
      { id: 'b', dueDate: '2026-09-01', status: 'pending', amountCents: 100 },
    ];
    sortByAttention(items, '2026-09-02');
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
