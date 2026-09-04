import { describe, expect, it } from 'vitest';
import {
  clampMemoryContent,
  mergeConfidence,
  pickDuplicate,
  shouldPersist,
  DEDUP_SIMILARITY_THRESHOLD,
  MIN_CONFIDENCE_TO_PERSIST,
} from '@/server/agents/memory/logic';

describe('shouldPersist', () => {
  it('aceita confiança no piso ou acima', () => {
    expect(shouldPersist(MIN_CONFIDENCE_TO_PERSIST)).toBe(true);
    expect(shouldPersist(0.9)).toBe(true);
  });

  it('rejeita confiança abaixo do piso', () => {
    expect(shouldPersist(MIN_CONFIDENCE_TO_PERSIST - 0.01)).toBe(false);
    expect(shouldPersist(0)).toBe(false);
  });
});

describe('clampMemoryContent', () => {
  it('colapsa espaço e apara as pontas', () => {
    expect(clampMemoryContent('  a   família   decidiu  \n\n manter a Netflix  ')).toBe(
      'a família decidiu manter a Netflix',
    );
  });

  it('corta no limite do CHECK constraint de 1000 caracteres', () => {
    const long = 'x'.repeat(1200);
    const result = clampMemoryContent(long);
    expect(result.length).toBe(1000);
    expect(result.endsWith('…')).toBe(true);
  });

  it('não mexe em texto já dentro do limite', () => {
    expect(clampMemoryContent('conta de luz')).toBe('conta de luz');
  });
});

describe('pickDuplicate', () => {
  it('escolhe o primeiro match do MESMO escopo do candidato', () => {
    const matches = [
      { id: 'm1', scope: 'user' as const },
      { id: 'm2', scope: 'household' as const },
    ];
    expect(pickDuplicate('household', matches)).toEqual({ id: 'm2', scope: 'household' });
    expect(pickDuplicate('user', matches)).toEqual({ id: 'm1', scope: 'user' });
  });

  it('não deixa um fato de família atualizar por engano uma preferência pessoal', () => {
    // O único match retornado é de escopo diferente do candidato — não é
    // duplicata válida, mesmo que a similaridade textual seja alta.
    const matches = [{ id: 'm1', scope: 'user' as const }];
    expect(pickDuplicate('household', matches)).toBeNull();
  });

  it('devolve null para lista vazia', () => {
    expect(pickDuplicate('household', [])).toBeNull();
  });
});

describe('mergeConfidence', () => {
  it('nunca deixa uma observação mais fraca derrubar a confiança já registrada', () => {
    expect(mergeConfidence(0.9, 0.6)).toBe(0.9);
  });

  it('reforça quando a nova observação é mais forte', () => {
    expect(mergeConfidence(0.6, 0.9)).toBe(0.9);
  });

  it('constantes de módulo fazem sentido entre si', () => {
    expect(DEDUP_SIMILARITY_THRESHOLD).toBeGreaterThan(MIN_CONFIDENCE_TO_PERSIST);
    expect(DEDUP_SIMILARITY_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
