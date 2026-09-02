import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Keep-alive do Supabase.
 *
 * O plano free pausa projetos após ~7 dias de baixa atividade. Esta rota existe
 * só para gerar uma requisição real e diária à API REST, o que reinicia o
 * contador de inatividade.
 *
 * Agendada em vercel.json. Ver README para o CRON_SECRET.
 */

// Nunca cachear: uma resposta servida de cache não gera requisição ao Supabase,
// que é a única coisa que esta rota precisa fazer.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Teto da function. O keep-alive é a tarefa mais dispensável do sistema: se
// demorar, o certo é desistir, não consumir o orçamento de execução.
export const maxDuration = 15;

const QUERY_TIMEOUT_MS = 10_000;

/**
 * Comparação em tempo constante. Compara digests SHA-256 em vez das strings
 * cruas porque `timingSafeEqual` exige buffers do mesmo tamanho — e o
 * comprimento do header é controlado por quem chama.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const secret = process.env['CRON_SECRET'];

  // Falha fechada: sem segredo configurado, a rota não responde — nunca fica
  // aberta "porque a variável não estava setada".
  if (!secret) {
    console.error('[keep-alive] CRON_SECRET não configurado.');
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (!secretMatches(request.headers.get('authorization'), `Bearer ${secret}`)) {
    console.warn('[keep-alive] requisição não autorizada.');
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !anonKey) {
    console.error('[keep-alive] variáveis do Supabase ausentes.');
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  /*
   * Chave anon, não service role, e de propósito.
   *
   * A rota não precisa ler dado nenhum — precisa que a requisição chegue ao
   * Postgres. Com anon, a RLS devolve zero linhas e está ótimo: o que reinicia
   * o contador de inatividade é o round-trip, não o conteúdo. Colocar service
   * role num endpoint alcançável pela internet só ampliaria o estrago caso o
   * CRON_SECRET vazasse algum dia.
   *
   * Erro de rede ou banco fora ainda aparece em `error` — a checagem de saúde
   * continua valendo.
   */
  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const startedAt = Date.now();
  // Sem timeout explícito, um Supabase inalcançável segura a requisição até o
  // limite da plataforma — medido em 7s só para falhar num host inexistente.
  const { error } = await supabase
    .from('households')
    .select('id')
    .limit(1)
    .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
  const durationMs = Date.now() - startedAt;

  if (error) {
    console.error(`[keep-alive] falhou em ${durationMs}ms: ${error.message}`);
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  console.log(`[keep-alive] ok em ${durationMs}ms`);
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
