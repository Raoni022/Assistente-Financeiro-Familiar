'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/server/db/server';

/**
 * Login por e-mail + senha, uma conta por pessoa da família.
 *
 * Trocado do magic link original porque o link por e-mail depende de três
 * coisas fora do nosso controle acontecerem certas ao mesmo tempo — SMTP
 * configurado, domínio de redirect cadastrado no Supabase, e o e-mail chegando
 * a tempo — e qualquer uma delas errada quebra o login inteiro. Senha resolve
 * a sessão na hora, sem round-trip de e-mail.
 *
 * Isso só funciona sem loop se "Confirm email" estiver DESLIGADO em
 * Authentication → Providers → Email no painel do Supabase — senão
 * `signUp` não devolve sessão ativa até confirmar por e-mail, e caímos de
 * volta no mesmo problema que estamos evitando.
 */

const EmailInput = z.email({ message: 'Digite um e-mail válido.' });
const PasswordInput = z
  .string()
  .min(8, 'A senha precisa ter pelo menos 8 caracteres.')
  .max(72); // limite prático do bcrypt, que o Supabase usa por baixo

export interface AuthState {
  status: 'idle' | 'error';
  message?: string;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = EmailInput.safeParse(formData.get('email'));
  const password = PasswordInput.safeParse(formData.get('password'));

  if (!email.success) return { status: 'error', message: email.error.issues[0]!.message };
  if (!password.success) return { status: 'error', message: password.error.issues[0]!.message };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.data,
    password: password.data,
  });

  if (error) {
    // Mensagem idêntica para "não existe" e "senha errada" — não vale entregar
    // enumeração de conta em troca de um erro mais específico.
    console.error('[login] signInWithPassword falhou:', error.message);
    return { status: 'error', message: 'E-mail ou senha incorretos.' };
  }

  redirect('/');
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = EmailInput.safeParse(formData.get('email'));
  const password = PasswordInput.safeParse(formData.get('password'));

  if (!email.success) return { status: 'error', message: email.error.issues[0]!.message };
  if (!password.success) return { status: 'error', message: password.error.issues[0]!.message };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: email.data,
    password: password.data,
  });

  if (error) {
    console.error('[login] signUp falhou:', error.message);
    // "User already registered" é o único caso em que vale ser específico: a
    // ação certa (entrar em vez de criar conta) é diferente da genérica.
    const message = error.message.toLowerCase().includes('already registered')
      ? 'Esse e-mail já tem conta. Use a aba "Entrar".'
      : 'Não consegui criar a conta agora. Tente de novo.';
    return { status: 'error', message };
  }

  if (!data.session) {
    // "Confirm email" ainda ligado no Supabase — sessão só viria depois de um
    // clique em e-mail, o que é exatamente o que este fluxo existe para evitar.
    console.error('[login] signUp sem sessão — "Confirm email" ainda ligado no Supabase?');
    return {
      status: 'error',
      message: 'Conta criada, mas não entrou automaticamente. Peça para desligar "Confirm email" no Supabase.',
    };
  }

  redirect('/onboarding');
}
