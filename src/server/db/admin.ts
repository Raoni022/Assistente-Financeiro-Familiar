import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { env } from '@/server/env';

/**
 * ⚠️ Cliente com service role. IGNORA RLS COMPLETAMENTE.
 *
 * Este é o único arquivo do projeto autorizado a instanciá-lo. Se você precisou
 * importá-lo em algum lugar novo, pare e confirme que contornar a RLS é mesmo a
 * intenção — na quase totalidade dos casos o certo é `@/server/db/server`.
 *
 * Usos legítimos:
 *   - onboarding: criar household + profile antes de o usuário ter household
 *   - escrita em agent_runs e rate_limits (tabelas sem policy de escrita)
 *   - jobs que geram ocorrências de contas recorrentes
 *
 * Toda query feita aqui DEVE filtrar household_id explicitamente. Sem a RLS de
 * rede de segurança, esquecer o filtro vaza dado entre famílias.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();

  return createSupabaseClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
