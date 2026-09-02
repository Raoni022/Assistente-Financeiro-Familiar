import { describe, expect, it } from 'vitest';
import {
  assertIsoDate,
  daysUntil,
  dueLabel,
  isOverdue,
  monthLabel,
  monthRange,
  previousMonthsRange,
  relativeDayLabel,
  startOfDayUtc,
  todayInTz,
} from '@/lib/dates';

/**
 * A suíte roda com TZ=Asia/Tokyo (UTC+9) — ver o script `test` no package.json.
 * Não é capricho: a família está em UTC-3 e a Vercel em UTC, então qualquer
 * cálculo que dependa do fuso da MÁQUINA passa despercebido rodando no Brasil.
 * Tóquio expõe essa classe de erro na primeira execução.
 */

describe('todayInTz', () => {
  it('usa o dia civil da família, não o do servidor', () => {
    // 02:00Z de 15/09 ainda é 14/09 em São Paulo (UTC-3).
    const now = new Date('2026-09-15T02:00:00Z');
    expect(todayInTz('America/Sao_Paulo', now)).toBe('2026-09-14');
    // E já é 15/09 em Tóquio — provando que o fuso do processo não manda.
    expect(todayInTz('Asia/Tokyo', now)).toBe('2026-09-15');
  });
});

describe('daysUntil / isOverdue / dueLabel', () => {
  it('conta dias civis', () => {
    expect(daysUntil('2026-09-15', '2026-09-12')).toBe(3);
    expect(daysUntil('2026-09-12', '2026-09-12')).toBe(0);
    expect(daysUntil('2026-09-10', '2026-09-12')).toBe(-2);
  });

  it('atravessa virada de mês e de ano', () => {
    expect(daysUntil('2027-01-02', '2026-12-31')).toBe(2);
  });

  it('deriva atraso em vez de ler estado armazenado', () => {
    expect(isOverdue('2026-09-10', '2026-09-12', 'pending')).toBe(true);
    expect(isOverdue('2026-09-10', '2026-09-12', 'paid')).toBe(false);
    expect(isOverdue('2026-09-15', '2026-09-12', 'pending')).toBe(false);
  });

  it('rotula o vencimento em português', () => {
    expect(dueLabel('2026-09-12', '2026-09-12')).toBe('vence hoje');
    expect(dueLabel('2026-09-13', '2026-09-12')).toBe('vence amanhã');
    expect(dueLabel('2026-09-15', '2026-09-12')).toBe('vence em 3 dias');
    expect(dueLabel('2026-09-11', '2026-09-12')).toBe('vencida ontem');
    expect(dueLabel('2026-09-10', '2026-09-12')).toBe('vencida há 2 dias');
  });
});

describe('monthRange', () => {
  it.each([
    ['2026-09-15', '2026-09-01', '2026-09-30'],
    ['2026-01-31', '2026-01-01', '2026-01-31'],
    ['2026-02-10', '2026-02-01', '2026-02-28'],
    ['2028-02-10', '2028-02-01', '2028-02-29'], // bissexto
  ])('%s → %s..%s', (ref, start, end) => {
    expect(monthRange(ref)).toEqual({ start, end });
  });
});

describe('previousMonthsRange', () => {
  it('exclui o mês de referência da linha de base', () => {
    // "média dos últimos 3 meses" vista de setembro = jun, jul, ago.
    expect(previousMonthsRange('2026-09-15', 3)).toEqual({
      start: '2026-06-01',
      end: '2026-08-31',
    });
  });

  it('atravessa a virada de ano', () => {
    expect(previousMonthsRange('2026-01-20', 3)).toEqual({
      start: '2025-10-01',
      end: '2025-12-31',
    });
  });

  it('rejeita janela inválida', () => {
    expect(() => previousMonthsRange('2026-09-15', 0)).toThrow(RangeError);
  });
});

describe('rótulos', () => {
  it('nomeia o mês em português', () => {
    expect(monthLabel('2026-09-15')).toBe('Setembro');
    expect(monthLabel('2026-01-01')).toBe('Janeiro');
    expect(monthLabel('2026-12-31')).toBe('Dezembro');
  });

  it('usa dia relativo só nos casos que a pessoa reconhece de cabeça', () => {
    expect(relativeDayLabel('2026-09-12', '2026-09-12')).toBe('hoje');
    expect(relativeDayLabel('2026-09-11', '2026-09-12')).toBe('ontem');
    expect(relativeDayLabel('2026-09-10', '2026-09-12')).toBe('anteontem');
    expect(relativeDayLabel('2026-09-08', '2026-09-12')).toBe('08/09');
  });
});

describe('startOfDayUtc', () => {
  it('converte dia civil da família para instante UTC', () => {
    // Meia-noite de 15/09 em São Paulo (UTC-3) é 03:00Z do mesmo dia.
    expect(startOfDayUtc('2026-09-15', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-09-15T03:00:00.000Z',
    );
  });
});

describe('assertIsoDate', () => {
  it.each(['2026-9-15', '15/09/2026', '2026-13-01', '2026-02-30', 'ontem'])(
    'rejeita %j',
    (bad) => {
      expect(() => assertIsoDate(bad)).toThrow(RangeError);
    },
  );
});
