'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { signIn, signUp, type AuthState } from './actions';

const INITIAL: AuthState = { status: 'idle' };

const inputClass =
  'w-full rounded-item border border-line-strong bg-surface px-3 py-3 text-[15px] outline-none placeholder:text-dim focus-visible:border-accent';

export function LoginForm() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Entrar ou criar conta" className="flex gap-1 rounded-item bg-surface p-1">
        <Tab active={mode === 'signin'} onClick={() => setMode('signin')}>
          Entrar
        </Tab>
        <Tab active={mode === 'signup'} onClick={() => setMode('signup')}>
          Criar conta
        </Tab>
      </div>

      {mode === 'signin' ? <SignInForm /> : <SignUpForm />}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 rounded-[7px] px-3 py-2 text-[13px] font-medium transition-colors ${
        active ? 'bg-raised text-text' : 'text-dim'
      }`}
    >
      {children}
    </button>
  );
}

function SignInForm() {
  const [state, action] = useActionState(signIn, INITIAL);

  return (
    <form action={action} className="space-y-3">
      <Field id="email" label="E-mail" type="email" autoComplete="email" placeholder="voce@exemplo.com" />
      <Field id="password" label="Senha" type="password" autoComplete="current-password" placeholder="••••••••" />
      <ErrorText state={state} />
      <Submit idle="Entrar" busy="Entrando…" />
    </form>
  );
}

function SignUpForm() {
  const [state, action] = useActionState(signUp, INITIAL);

  return (
    <form action={action} className="space-y-3">
      <Field id="email" label="E-mail" type="email" autoComplete="email" placeholder="voce@exemplo.com" />
      <Field
        id="password"
        label="Senha"
        type="password"
        autoComplete="new-password"
        placeholder="mínimo 8 caracteres"
      />
      <ErrorText state={state} />
      <Submit idle="Criar conta" busy="Criando…" />
    </form>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] text-dim">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        required
        placeholder={placeholder}
        className={inputClass}
      />
    </div>
  );
}

function ErrorText({ state }: { state: AuthState }) {
  if (state.status !== 'error') return null;
  return (
    <p role="alert" className="text-[13px] text-negative">
      {state.message}
    </p>
  );
}

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-item bg-accent px-4 py-3 text-[15px] font-medium text-accent-ink transition-opacity disabled:opacity-60"
    >
      {pending ? busy : idle}
    </button>
  );
}
