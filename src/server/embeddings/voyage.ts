import 'server-only';
import { env } from '@/server/env';
import type { EmbeddingKind, EmbeddingProvider } from './provider';
import { EmbeddingError } from './provider';

/**
 * Provedor de embeddings via Voyage AI.
 *
 * `voyage-3.5-lite` produz 1024 dimensões por padrão — o mesmo número que
 * `memories.embedding vector(1024)` na migração. Trocar de modelo aqui exige
 * trocar a coluna e reindexar; os dois precisam concordar sempre.
 *
 * 200 milhões de tokens grátis por conta (crédito único, não mensal); depois
 * disso, US$ 0,02 por milhão. Para o volume de uma família isso não deve sair
 * do free tier.
 */
const MODEL = 'voyage-3.5-lite';
const DIMENSION = 1024;
const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

/** Limite da própria Voyage por requisição. Acima disso, dividir em lotes. */
const MAX_INPUTS_PER_CALL = 128;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens: number };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function embedBatch(
  apiKey: string,
  texts: readonly string[],
  kind: EmbeddingKind,
  signal: AbortSignal,
): Promise<number[][]> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: kind,
      output_dimension: DIMENSION,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EmbeddingError(
      `Voyage respondeu ${response.status}: ${body.slice(0, 200)}`,
      isRetryableStatus(response.status),
    );
  }

  const parsed = (await response.json()) as VoyageResponse;

  // A API preserva ordem, mas devolve `index` explícito — reordenar por ele em
  // vez de confiar na ordem de chegada é o que a própria doc recomenda.
  return [...parsed.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

export function createVoyageProvider(): EmbeddingProvider {
  return {
    dimension: DIMENSION,
    async embed(texts, kind) {
      if (texts.length === 0) return [];

      const { VOYAGE_API_KEY } = env();
      if (!VOYAGE_API_KEY) {
        throw new EmbeddingError('VOYAGE_API_KEY não configurada.', false);
      }

      const signal = AbortSignal.timeout(15_000);
      const results: number[][] = [];

      for (let offset = 0; offset < texts.length; offset += MAX_INPUTS_PER_CALL) {
        const batch = texts.slice(offset, offset + MAX_INPUTS_PER_CALL);
        results.push(...(await embedBatch(VOYAGE_API_KEY, batch, kind, signal)));
      }

      return results;
    },
  };
}
