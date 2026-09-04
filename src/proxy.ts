import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Convenção `proxy.ts` do Next 16 (o antigo `middleware.ts`, agora deprecado).
 *
 * Faz uma coisa só: renovar o token de sessão do Supabase e reescrever os
 * cookies na resposta. Sem isso, o token expira e o usuário é deslogado no meio
 * do uso.
 *
 * NÃO decide autorização. Autorização mora em duas camadas mais confiáveis:
 * `requireSession`/`requireHousehold` no servidor e a RLS no banco. Proxy roda
 * no edge, sem acesso ao banco — confiar nele para autorizar seria confiar na
 * camada mais fraca da pilha.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];

  /*
   * Falha aqui não pode derrubar o site inteiro. O proxy roda em TODO request
   * — se `createServerClient` ou `getUser()` lançarem (env var ausente na
   * Vercel, chave malformada, Supabase fora do ar), o pior resultado aceitável
   * é "a sessão não foi renovada desta vez", nunca "Internal Server Error" na
   * página inicial. `requireSession`/`requireHousehold` no servidor e a RLS no
   * banco continuam sendo a autorização de verdade — o proxy é só otimização.
   */
  if (!url || !anonKey) {
    console.error('[proxy] NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY ausente.');
    return response;
  }

  try {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    // Chamada obrigatória: é ela que dispara o refresh quando o token está
    // perto de expirar. Remover "porque o resultado não é usado" quebra a
    // sessão.
    await supabase.auth.getUser();
  } catch (error) {
    console.error('[proxy] falha ao renovar sessão:', (error as Error).message);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Tudo, exceto assets estáticos e imagens — que não têm sessão para renovar
     * e só custariam latência.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};
