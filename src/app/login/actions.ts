'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { createClient } from '@/server/db/server';

const LoginInput = z.object({
  email: z.email({ message: 'Digite um e-mail válido.' }),
});

export interface LoginState {
  status: 'idle' | 'sent' | 'error';
  message?: string;
}

/**
 * Login por magic link. Sem senha, de propósito: senha em app familiar vira
 * senha reciclada, e não há nada aqui que justifique guardar hash e fluxo de
 * recuperação quando o e-mail já é o fator.
 */
export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = LoginInput.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'E-mail inválido.' };
  }

  const headerList = await headers();
  const host = headerList.get('host');
  const protocol = host?.startsWith('localhost') ? 'http' : 'https';

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${protocol}://${host}/auth/callback` },
  });

  if (error) {
    // A mensagem do Supabase pode revelar se o e-mail existe. Resposta genérica
    // e idêntica nos dois casos — não vale entregar enumeração de conta em troca
    // de uma mensagem de erro mais específica.
    console.error('[login] signInWithOtp falhou:', error.message);
    return {
      status: 'error',
      message: 'Não consegui enviar o link agora. Tente de novo em alguns minutos.',
    };
  }

  return { status: 'sent' };
}
