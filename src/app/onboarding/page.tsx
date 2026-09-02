import { redirect } from 'next/navigation';
import { requireSession } from '@/server/auth/session';
import { OnboardingForms } from './OnboardingForms';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await requireSession();
  if (session.householdId) redirect('/');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <h1 className="text-[22px] font-semibold">Quase lá</h1>
      <p className="mt-1 mb-8 text-[15px] text-dim">
        Crie a casa da sua família ou entre com o código que te mandaram.
      </p>
      <OnboardingForms />
    </main>
  );
}
