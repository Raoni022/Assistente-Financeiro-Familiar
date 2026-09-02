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

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
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
    },
  );

  // Chamada obrigatória: é ela que dispara o refresh quando o token está perto
  // de expirar. Remover "porque o resultado não é usado" quebra a sessão.
  await supabase.auth.getUser();

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
