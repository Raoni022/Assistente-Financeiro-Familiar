import 'server-only';

/**
 * Interface do provedor de embeddings. Nenhum código fora deste diretório
 * conhece a Voyage API diretamente — trocar de provedor (ou usar um mock nos
 * testes) é trocar a implementação, não os chamadores.
 *
 * `type` distingue embedding de consulta vs. de documento. A Voyage (e a
 * maioria dos provedores modernos) usa embeddings assimétricos: o texto que a
 * pessoa digita ("quanto gastei em mercado?") e o texto armazenado
 * ("preferência: evitar delivery às sextas") são vetorizados com prompts
 * internos diferentes para melhorar o retrieval. Usar o tipo errado não quebra
 * nada visivelmente — só piora a qualidade da busca, silenciosamente.
 */
export type EmbeddingKind = 'query' | 'document';

export interface EmbeddingProvider {
  /** Dimensão do vetor que este provedor produz. Deve bater com `vector(N)` no schema. */
  readonly dimension: number;
  embed(texts: readonly string[], kind: EmbeddingKind): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}
