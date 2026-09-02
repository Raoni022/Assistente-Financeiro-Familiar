import 'server-only';
import { createAdminClient } from '@/server/db/admin';

/**
 * Rate limit em Postgres. Sem Redis: o volume é de uma família, e um serviço a
 * mais seria superfície sem ganho (docs/architecture.md §5).
 *
 * O objetivo aqui é conter **custo descontrolado** — um bug em loop chamando o
 * modelo, ou uso indevido — não deter um atacante determinado. O incremento é
 * feito em duas etapas (ler, escrever) e portanto tem corrida: sob concorrência
 * o contador pode subcontar em algumas unidades. Isso é aceitável para o que a
 * proteção precisa fazer; um loop continua batendo no teto em segundos.
 */

export interface RateLimitRule {
  bucket: string;
  limit: number;
  windowMs: number;
}

export const CHAT_LIMITS = {
  perUser: { bucket: 'chat_user', limit: 30, windowMs: 10 * 60 * 1000 },
  perHousehold: { bucket: 'chat_household', limit: 300, windowMs: 24 * 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  /** Segundos até a janela virar. Vira o header Retry-After. */
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  subjectId: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / rule.windowMs) * rule.windowMs);
  const retryAfterSeconds = Math.ceil(
    (windowStart.getTime() + rule.windowMs - now) / 1000,
  );

  try {
    const admin = createAdminClient();

    const { data } = await admin
      .from('rate_limits')
      .select('count')
      .eq('subject_id', subjectId)
      .eq('bucket', rule.bucket)
      .eq('window_start', windowStart.toISOString())
      .maybeSingle();

    const current = (data?.count as number | undefined) ?? 0;

    if (current >= rule.limit) {
      return { allowed: false, retryAfterSeconds };
    }

    await admin.from('rate_limits').upsert(
      {
        subject_id: subjectId,
        bucket: rule.bucket,
        window_start: windowStart.toISOString(),
        count: current + 1,
      },
      { onConflict: 'subject_id,bucket,window_start' },
    );

    return { allowed: true, retryAfterSeconds };
  } catch (error) {
    // Falha do limitador não pode derrubar o chat. Registra e libera: o risco de
    // um pedido a mais é menor que o de um assistente inutilizável por causa de
    // uma tabela de contagem.
    console.error('[rate-limit] falhou, liberando:', (error as Error).message);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Limpa janelas antigas. Chamado esporadicamente pela própria rota de chat. */
export async function pruneRateLimits(): Promise<void> {
  try {
    const admin = createAdminClient();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await admin.from('rate_limits').delete().lt('window_start', cutoff);
  } catch {
    // Melhor deixar lixo na tabela do que falhar uma requisição por causa dele.
  }
}
