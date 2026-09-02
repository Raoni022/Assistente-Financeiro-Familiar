import { describe, expect, it } from 'vitest';
import { deadlineLabel } from '@/lib/dates';
import {
  canTransition,
  resolveDeadline,
  sortTasksByUrgency,
} from '@/server/agents/tasks/logic';
import { resolveDateExpression } from '@/server/agents/transactions/logic';

/** Quarta-feira, 2 de setembro de 2026. */
const HOJE = '2026-09-02';

describe('resolveDeadline — os três retornos são diferentes', () => {
  it('undefined quando não há prazo mencionado — tarefa sem prazo é válida', () => {
    expect(resolveDeadline(null, HOJE)).toBeUndefined();
    expect(resolveDeadline('', HOJE)).toBeUndefined();
  });

  it('null quando mencionou algo que não dá para resolver — aí o agente pergunta', () => {
    expect(resolveDeadline('quando der', HOJE)).toBeNull();
    expect(resolveDeadline('assim que possível', HOJE)).toBeNull();
  });

  it('data quando entendeu', () => {
    expect(resolveDeadline('amanhã', HOJE)).toBe('2026-09-03');
  });
});

describe('resolveDeadline — âncoras', () => {
  it.each([
    ['hoje', '2026-09-02'],
    ['amanhã', '2026-09-03'],
    ['depois de amanhã', '2026-09-04'],
    ['semana que vem', '2026-09-09'],
    ['mês que vem', '2026-10-02'],
    ['fim do mês', '2026-09-30'],
    ['em 3 dias', '2026-09-05'],
    ['em 2 semanas', '2026-09-16'],
  ])('%j → %s', (expression, expected) => {
    expect(resolveDeadline(expression, HOJE)).toBe(expected);
  });

  it('rejeita prazo absurdamente distante', () => {
    expect(resolveDeadline('em 400 dias', HOJE)).toBeNull();
  });
});

describe('resolveDeadline — aponta para o futuro, ao contrário do gasto', () => {
  it('“sexta” é a PRÓXIMA sexta, não a anterior', () => {
    expect(resolveDeadline('sexta', HOJE)).toBe('2026-09-04');
    // O mesmo texto num gasto resolve para trás — são funções distintas.
    expect(resolveDateExpression('sexta', HOJE)).toBe('2026-08-28');
  });

  it('“dia 15” é deste mês quando ainda não passou', () => {
    expect(resolveDeadline('dia 15', HOJE)).toBe('2026-09-15');
    expect(resolveDateExpression('dia 15', HOJE)).toBe('2026-08-15');
  });

  it('“dia 1” já passou, então é do mês que vem', () => {
    expect(resolveDeadline('dia 1', HOJE)).toBe('2026-10-01');
  });

  it('“na quarta” numa quarta é hoje; “quarta que vem” é a próxima', () => {
    expect(resolveDeadline('na quarta', HOJE)).toBe(HOJE);
    expect(resolveDeadline('quarta que vem', HOJE)).toBe('2026-09-09');
  });

  it('data numérica que já passou vai para o ano seguinte', () => {
    expect(resolveDeadline('15/01', HOJE)).toBe('2027-01-15');
    expect(resolveDeadline('15/10', HOJE)).toBe('2026-10-15');
  });

  it('rejeita data inexistente', () => {
    expect(resolveDeadline('31/02', HOJE)).toBeNull();
  });
});

describe('canTransition', () => {
  it('permite os caminhos normais', () => {
    expect(canTransition('todo', 'doing')).toBe(true);
    expect(canTransition('todo', 'done')).toBe(true);
    expect(canTransition('doing', 'done')).toBe(true);
  });

  it('permite reabrir o que foi concluído ou cancelado', () => {
    expect(canTransition('done', 'todo')).toBe(true);
    expect(canTransition('cancelled', 'todo')).toBe(true);
  });

  it('não conclui direto o que foi cancelado', () => {
    // O histórico mentiria: nada foi feito, a tarefa tinha sido descartada.
    expect(canTransition('cancelled', 'done')).toBe(false);
  });

  it('não transiciona para o mesmo estado', () => {
    expect(canTransition('todo', 'todo')).toBe(false);
  });
});

describe('sortTasksByUrgency', () => {
  it('atrasadas, depois com prazo, depois sem prazo, depois resolvidas', () => {
    const tasks = [
      { id: 'concluida', dueDate: '2026-08-01', status: 'done' as const },
      { id: 'sem-prazo', dueDate: null, status: 'todo' as const },
      { id: 'futura', dueDate: '2026-09-20', status: 'todo' as const },
      { id: 'atrasada', dueDate: '2026-08-30', status: 'todo' as const },
      { id: 'hoje', dueDate: '2026-09-02', status: 'doing' as const },
    ];

    expect(sortTasksByUrgency(tasks, HOJE).map((t) => t.id)).toEqual([
      'atrasada',
      'hoje',
      'futura',
      'sem-prazo',
      'concluida',
    ]);
  });

  it('não muta o array recebido', () => {
    const tasks = [
      { id: 'a', dueDate: '2026-09-20', status: 'todo' as const },
      { id: 'b', dueDate: '2026-08-30', status: 'todo' as const },
    ];
    sortTasksByUrgency(tasks, HOJE);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('deadlineLabel', () => {
  it.each([
    [null, 'sem prazo'],
    ['2026-09-02', 'para hoje'],
    ['2026-09-03', 'para amanhã'],
    ['2026-09-06', 'em 4 dias'],
    ['2026-09-01', 'atrasada desde ontem'],
    ['2026-08-28', 'atrasada há 5 dias'],
  ])('%j → %j', (dueDate, expected) => {
    expect(deadlineLabel(dueDate, HOJE)).toBe(expected);
  });
});
