import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/server/db/server';

/**
 * Troca o `code` do magic link por uma sessão (fluxo PKCE). O verificador foi
 * gravado em cookie pelo cliente de servidor no momento do envio do link.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(`${origin}/login?erro=link_invalido`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth] exchangeCodeForSession falhou:', error.message);
    return NextResponse.redirect(`${origin}/login?erro=link_expirado`);
  }

  // Sem household ainda, a raiz redireciona sozinha para /onboarding.
  return NextResponse.redirect(`${origin}/`);
}
