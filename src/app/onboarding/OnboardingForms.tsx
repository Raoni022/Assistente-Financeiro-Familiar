'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { createHousehold, joinHousehold, type OnboardingState } from './actions';

const INITIAL: OnboardingState = { status: 'idle' };

const inputClass =
  'w-full rounded-item border border-line-strong bg-surface px-3 py-3 text-[15px] outline-none placeholder:text-dim focus-visible:border-accent';

export function OnboardingForms() {
  const [mode, setMode] = useState<'create' | 'join'>('create');

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Como entrar" className="flex gap-1 rounded-item bg-surface p-1">
        <Tab active={mode === 'create'} onClick={() => setMode('create')}>
          Criar uma casa
        </Tab>
        <Tab active={mode === 'join'} onClick={() => setMode('join')}>
          Tenho um convite
        </Tab>
      </div>

      {mode === 'create' ? <CreateForm /> : <JoinForm />}
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

function CreateForm() {
  const [state, action] = useActionState(createHousehold, INITIAL);

  return (
    <form action={action} className="space-y-3">
      <Field id="householdName" label="Nome da casa" placeholder="Casa dos Medeiros" />
      <Field id="displayName" label="Como te chamamos" placeholder="Raoni" autoComplete="given-name" />
      <ErrorText state={state} />
      <Submit idle="Criar casa" busy="Criando…" />
    </form>
  );
}

function JoinForm() {
  const [state, action] = useActionState(joinHousehold, INITIAL);

  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="code" className="mb-1.5 block text-[13px] text-dim">
          Código do convite
        </label>
        <input
          id="code"
          name="code"
          required
          maxLength={8}
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="A1B2C3D4"
          className={`${inputClass} font-medium uppercase tracking-[0.18em]`}
        />
      </div>
      <Field id="displayName" label="Como te chamamos" placeholder="Camila" autoComplete="given-name" />
      <ErrorText state={state} />
      <Submit idle="Entrar na casa" busy="Entrando…" />
    </form>
  );
}

function Field({
  id,
  label,
  placeholder,
  autoComplete,
}: {
  id: string;
  label: string;
  placeholder: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] text-dim">
        {label}
      </label>
      <input
        id={id}
        name={id}
        required
        maxLength={80}
        placeholder={placeholder}
        {...(autoComplete ? { autoComplete } : {})}
        className={inputClass}
      />
    </div>
  );
}

function ErrorText({ state }: { state: OnboardingState }) {
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
