/**
 * Lógica pura do Agente de Memória — nada aqui toca rede, banco ou embedding.
 *
 * O agente em si (agent.ts) decide O QUE fazer a partir destas funções; elas
 * decidem o CRITÉRIO. Separar assim é o que permite testar "isto deveria virar
 * memória duradoura?" sem gastar uma chamada de embedding por caso de teste.
 */

/** Abaixo disso, um candidato não vira memória. Defesa em profundidade — os
 *  agentes de origem já filtram por confiança própria (0.6–0.9); este piso
 *  protege contra um agente futuro emitindo sinal fraco demais para durar. */
export const MIN_CONFIDENCE_TO_PERSIST = 0.5;

/**
 * Acima disto, duas memórias são consideradas a mesma coisa dita de novo —
 * atualiza a existente em vez de duplicar. Ver docs/architecture.md §3.3.
 */
export const DEDUP_SIMILARITY_THRESHOLD = 0.92;

/** Content da tabela `memories` tem CHECK (length between 1 and 1000). */
const MAX_MEMORY_CONTENT_LENGTH = 1000;

export function shouldPersist(confidence: number): boolean {
  return confidence >= MIN_CONFIDENCE_TO_PERSIST;
}

/**
 * Normaliza o texto antes de gerar embedding e gravar: colapsa espaço, corta
 * no limite do CHECK constraint. Cortar aqui — não deixar o Postgres rejeitar
 * o insert — porque um erro de constraint no meio de um side-effect
 * assíncrono não tem quem veja e trate.
 */
export function clampMemoryContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_MEMORY_CONTENT_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_MEMORY_CONTENT_LENGTH - 1)}…`;
}

export interface DuplicateCandidate {
  id: string;
  scope: 'user' | 'household';
}

/**
 * Entre memórias já acima do limiar de similaridade (o chamador filtra isso
 * via `min_similarity` na própria query), escolhe a que serve de alvo do
 * upsert — a primeira com o MESMO escopo do candidato nesta lista.
 *
 * Por que o escopo tem que bater: `match_memories` devolve tanto memórias de
 * household quanto (quando aplicável) memórias pessoais do usuário logado.
 * Um fato de família ("a família decidiu manter a Netflix") não pode
 * atualizar por engano uma preferência pessoal só porque o texto é parecido.
 *
 * A lista já vem ordenada por similaridade decrescente (é como o SQL da RPC
 * ordena); por isso o primeiro match de escopo igual é o melhor candidato.
 */
export function pickDuplicate<T extends DuplicateCandidate>(
  candidateScope: 'user' | 'household',
  matches: readonly T[],
): T | null {
  return matches.find((match) => match.scope === candidateScope) ?? null;
}

/**
 * Uma observação repetida deve reforçar a confiança, nunca derrubá-la. Se a
 * nova ocorrência veio mais fraca que a memória já registrada, a antiga
 * prevalece — um "acho que sim" não apaga um "com certeza" anterior.
 */
export function mergeConfidence(existing: number, incoming: number): number {
  return Math.max(existing, incoming);
}
