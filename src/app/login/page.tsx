import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getSession()) redirect('/');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <h1 className="text-[22px] font-semibold">Assistente Financeiro</h1>
      <p className="mt-1 mb-8 text-[15px] text-dim">As contas e os gastos da casa, num lugar só.</p>
      <LoginForm />
    </main>
  );
}
