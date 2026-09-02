import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/server/env';

/**
 * Cliente do servidor com o JWT do usuário. Toda query passa pela RLS.
 *
 * Este é o cliente padrão. `admin.ts` (service role) é a exceção, e só deve ser
 * usado onde contornar RLS é a intenção declarada.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component não pode escrever cookie. O middleware já cuidou da
          // renovação de sessão, então engolir aqui é correto — não é falha.
        }
      },
    },
  });
}
