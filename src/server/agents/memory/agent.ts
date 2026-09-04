import 'server-only';
import type { createClient } from '@/server/db/server';
import type { EmbeddingProvider } from '@/server/embeddings/provider';
import type { MemoryCandidate, RecalledMemory } from '@/server/agents/shared/contracts';
import { clampMemoryContent, mergeConfidence, pickDuplicate, shouldPersist } from './logic';

/**
 * Agente de Memória. Transversal — não é acionado via plano do roteador como
 * bills/transactions/tasks; é chamado diretamente pelo grafo em dois pontos
 * (docs/architecture.md §3.3):
 *
 *   1. `recallMemories`, antes do roteamento — pode mudar o PLANO, não só a
 *      redação da resposta.
 *   2. `persistMemoryCandidates`, depois da resposta já entregue — nunca no
 *      caminho crítico. Falha aqui não pode derrubar o chat.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

interface MatchRow {
  id: string;
  content: string;
  kind: RecalledMemory['kind'];
  scope: RecalledMemory['scope'];
  similarity: number;
}

/**
 * Recupera memórias relevantes para a mensagem do usuário.
 *
 * Falha vira lista vazia, nunca exceção: sem `VOYAGE_API_KEY`, ou com a Voyage
 * fora do ar, o assistente deve continuar funcionando — só que sem memória
 * desta vez. Memória é um reforço de contexto, não uma dependência dura.
 */
export async function recallMemories(
  supabase: Supabase,
  provider: EmbeddingProvider,
  userMessage: string,
): Promise<RecalledMemory[]> {
  try {
    const [embedding] = await provider.embed([userMessage], 'query');
    if (!embedding) return [];

    const { data, error } = await supabase.rpc('match_memories', { query_embedding: embedding });
    if (error) {
      console.error('[memory] recall falhou:', error.message);
      return [];
    }

    return ((data ?? []) as MatchRow[]).map((row) => ({
      id: row.id,
      content: row.content,
      kind: row.kind,
      scope: row.scope,
      similarity: row.similarity,
    }));
  } catch (error) {
    console.error('[memory] recall falhou:', (error as Error).message);
    return [];
  }
}

/**
 * Promove candidatos a memória duradoura, com deduplicação.
 *
 * Chamada fora do caminho crítico (via `after()` na rota de chat, depois da
 * resposta já ter sido entregue). Cada candidato é tratado de forma
 * independente — um erro num não deve impedir os outros de serem gravados.
 */
export async function persistMemoryCandidates(
  supabase: Supabase,
  provider: EmbeddingProvider,
  householdId: string,
  userId: string,
  candidates: readonly MemoryCandidate[],
): Promise<void> {
  for (const candidate of candidates) {
    if (!shouldPersist(candidate.confidence)) continue;

    try {
      await persistOne(supabase, provider, householdId, userId, candidate);
    } catch (error) {
      console.error('[memory] falha ao gravar candidato:', (error as Error).message);
    }
  }
}

async function persistOne(
  supabase: Supabase,
  provider: EmbeddingProvider,
  householdId: string,
  userId: string,
  candidate: MemoryCandidate,
): Promise<void> {
  const content = clampMemoryContent(candidate.content);

  const [embedding] = await provider.embed([content], 'document');
  if (!embedding) return;

  const { data: matches, error: matchError } = await supabase.rpc('match_memories', {
    query_embedding: embedding,
    match_count: 3,
    min_similarity: 0.92, // DEDUP_SIMILARITY_THRESHOLD — literal aqui porque é argumento de RPC, não comparação em JS
  });

  if (matchError) {
    console.error('[memory] busca de duplicata falhou:', matchError.message);
    return;
  }

  const duplicate = pickDuplicate(candidate.scope, (matches ?? []) as MatchRow[]);

  if (duplicate) {
    // Precisa da confiança já gravada para decidir o merge — match_memories
    // não a devolve (só id/content/kind/scope/similarity), então uma segunda
    // leitura pontual é o preço de manter a RPC de busca enxuta.
    const { data: existing } = await supabase
      .from('memories')
      .select('confidence')
      .eq('id', duplicate.id)
      .maybeSingle();

    const confidence = mergeConfidence(
      (existing?.confidence as number | undefined) ?? candidate.confidence,
      candidate.confidence,
    );

    await supabase
      .from('memories')
      .update({ content, confidence, last_used_at: new Date().toISOString() })
      .eq('id', duplicate.id);
    return;
  }

  await supabase.from('memories').insert({
    household_id: householdId,
    scope: candidate.scope,
    owner_id: candidate.scope === 'user' ? userId : null,
    kind: candidate.kind,
    content,
    embedding,
    source: candidate.source,
    source_ref: candidate.sourceRef ?? null,
    confidence: candidate.confidence,
  });
}
