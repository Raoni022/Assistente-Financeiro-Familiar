import 'server-only';
import type { ConversationContext, UiBlock } from '@/server/agents/shared/contracts';
import { createClient } from '@/server/db/server';

/**
 * Estado da conversa entregue ao orquestrador.
 *
 * Nunca o histórico cru completo: os últimos N turnos, mais um resumo do que
 * veio antes. Enviar a conversa inteira estoura o contexto e encarece cada
 * mensagem proporcionalmente ao tempo de uso.
 */

/** Turnos crus mantidos na janela. Além disso, entra no resumo. */
const RECENT_TURNS = 8;
const MAX_SUMMARY_CHARS = 1500;
const MAX_TURN_CHARS = 400;

/**
 * Como o resumo é produzido. Duas implementações previstas:
 * Fase 2 (agora) por regra; Fase 5 por LLM, junto com o Agente de Memória.
 * A interface existe desde já para que a troca não mexa em quem chama.
 */
export interface ConversationSummarizer {
  summarize(
    previousSummary: string | null,
    olderTurns: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string;
}

/**
 * Resumo por regra: mantém só o que o usuário PEDIU, descartando o que o
 * assistente respondeu.
 *
 * O motivo é concreto — os pedidos são o que dá continuidade a uma conversa
 * ("aquela conta que falei"), enquanto as respostas repetem dados que já estão
 * no banco e podem estar desatualizadas. Um resumo que guarda "seu saldo é
 * R$ 3.482" vira uma mentira assim que um gasto é registrado.
 */
export const ruleBasedSummarizer: ConversationSummarizer = {
  summarize(previousSummary, olderTurns) {
    const requests = olderTurns
      .filter((turn) => turn.role === 'user')
      .map((turn) => `- ${truncate(turn.content, 120)}`);

    const merged = [previousSummary?.trim(), ...requests].filter(Boolean).join('\n');

    // Corta pelo começo: o passado mais distante é o mais dispensável.
    if (merged.length <= MAX_SUMMARY_CHARS) return merged;
    return merged.slice(merged.length - MAX_SUMMARY_CHARS);
  },
};

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

export interface LoadedConversation {
  conversationId: string;
  context: ConversationContext;
}

export async function loadOrCreateConversation(
  supabase: Supabase,
  householdId: string,
  userId: string,
  conversationId: string | null,
): Promise<LoadedConversation> {
  if (conversationId) {
    const { data } = await supabase
      .from('conversations')
      .select('id, summary')
      .eq('id', conversationId)
      .maybeSingle();

    if (data) {
      const context = await loadContext(supabase, data.id as string, data.summary as string | null);
      return { conversationId: data.id as string, context };
    }
  }

  const { data, error } = await supabase
    .from('conversations')
    .insert({ household_id: householdId, user_id: userId })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Não consegui abrir a conversa: ${error?.message ?? 'desconhecido'}`);
  }

  return {
    conversationId: data.id as string,
    context: { summary: null, recentTurns: [] },
  };
}

async function loadContext(
  supabase: Supabase,
  conversationId: string,
  summary: string | null,
): Promise<ConversationContext> {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(RECENT_TURNS);

  const recentTurns = (data ?? [])
    .reverse()
    .map((row) => ({
      role: row.role as 'user' | 'assistant',
      content: truncate(row.content as string, MAX_TURN_CHARS),
    }));

  return { summary, recentTurns };
}

export async function persistTurn(
  supabase: Supabase,
  params: {
    conversationId: string;
    householdId: string;
    userMessage: string;
    assistantMessage: string;
    blocks: UiBlock[];
  },
): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await supabase.from('messages').insert([
    {
      conversation_id: params.conversationId,
      household_id: params.householdId,
      role: 'user',
      content: params.userMessage,
    },
    {
      conversation_id: params.conversationId,
      household_id: params.householdId,
      role: 'assistant',
      content: params.assistantMessage,
      blocks: params.blocks.length > 0 ? params.blocks : null,
    },
  ]);

  if (error) {
    console.error('[conversation] não consegui gravar as mensagens:', error.message);
    return;
  }

  await supabase
    .from('conversations')
    .update({ last_message_at: now })
    .eq('id', params.conversationId);

  await rollSummary(supabase, params.conversationId);
}

/**
 * Move para o resumo tudo o que saiu da janela de turnos recentes.
 *
 * `summarized_through` marca quantas mensagens já entraram, para não re-resumir
 * a conversa inteira a cada turno.
 */
async function rollSummary(supabase: Supabase, conversationId: string): Promise<void> {
  const { data: conversation } = await supabase
    .from('conversations')
    .select('summary, summarized_through')
    .eq('id', conversationId)
    .maybeSingle();

  if (!conversation) return;

  const alreadySummarized = (conversation.summarized_through as number | null) ?? 0;

  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);

  const total = count ?? 0;
  const shouldSummarizeThrough = Math.max(0, total - RECENT_TURNS);

  if (shouldSummarizeThrough <= alreadySummarized) return;

  const { data: older } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .range(alreadySummarized, shouldSummarizeThrough - 1);

  const summary = ruleBasedSummarizer.summarize(
    conversation.summary as string | null,
    (older ?? []).map((row) => ({
      role: row.role as 'user' | 'assistant',
      content: row.content as string,
    })),
  );

  await supabase
    .from('conversations')
    .update({
      summary,
      summary_updated_at: new Date().toISOString(),
      summarized_through: shouldSummarizeThrough,
    })
    .eq('id', conversationId);
}
