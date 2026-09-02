import { describe, expect, it } from 'vitest';
import {
  formatCents,
  MoneyParseError,
  parseBRLToCents,
  percentChange,
  sumCents,
} from '@/lib/money';

describe('parseBRLToCents', () => {
  it.each([
    ['80', 8000],
    ['80 reais', 8000],
    ['R$ 80', 8000],
    ['r$80,00', 8000],
    ['80,50', 8050],
    ['1.234,56', 123456],
    ['R$ 1.234,56', 123456],
    ['1234,5', 123450],
    ['12.345.678,90', 1234567890],
    ['0,99', 99],
  ])('interpreta %j como %i centavos', (input, expected) => {
    expect(parseBRLToCents(input)).toBe(expected);
  });

  it('trata ponto com 3 dígitos como separador de milhar', () => {
    expect(parseBRLToCents('1.234')).toBe(123400);
  });

  it('trata ponto com 2 dígitos como decimal (hábito en-US)', () => {
    expect(parseBRLToCents('80.50')).toBe(8050);
  });

  it('aceita gírias comuns de valor', () => {
    expect(parseBRLToCents('50 conto')).toBe(5000);
    expect(parseBRLToCents('30 pila')).toBe(3000);
  });

  it('não perde centavo por arredondamento de float', () => {
    // 0.1 + 0.2 em float é o clássico. Aqui tudo é inteiro.
    expect(sumCents([parseBRLToCents('0,10'), parseBRLToCents('0,20')])).toBe(30);
  });

  it('rejeita entrada sem número', () => {
    expect(() => parseBRLToCents('caro pra caramba')).toThrow(MoneyParseError);
  });
});

describe('formatCents', () => {
  it('formata em BRL com dois dígitos', () => {
    //   = espaço não separável, que o Intl pt-BR usa após "R$".
    expect(formatCents(123456).replace(/ /g, ' ')).toBe('R$ 1.234,56');
    expect(formatCents(0).replace(/ /g, ' ')).toBe('R$ 0,00');
  });
});

describe('sumCents', () => {
  it('rejeita valor não inteiro', () => {
    expect(() => sumCents([100, 50.5])).toThrow(MoneyParseError);
  });
});

describe('percentChange', () => {
  it('calcula variação normal', () => {
    expect(percentChange(48600, 36200)).toBeCloseTo(34.25, 2);
  });

  it('retorna null quando a base é zero em vez de Infinity', () => {
    expect(percentChange(1000, 0)).toBeNull();
  });
});
