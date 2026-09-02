import { cn } from '@/lib/cn';

/**
 * Peso visual por raio, não por sombra. Ver docs/design.md §3 — o raio é
 * deliberadamente diferente por nível de importância, e a elevação vem de
 * degrau de superfície + borda de 1px, nunca de sombra cinza genérica.
 */
type CardWeight = 'hero' | 'section' | 'raised';

const WEIGHT: Record<CardWeight, string> = {
  hero: 'rounded-hero bg-surface p-5 sm:p-6',
  section: 'rounded-card bg-surface p-4 sm:p-5',
  raised: 'rounded-card bg-raised p-4',
};

export function Card({
  weight = 'section',
  className,
  children,
}: {
  weight?: CardWeight;
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn('border border-line', WEIGHT[weight], className)}>{children}</div>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 px-1 text-[13px] font-medium uppercase tracking-[0.04em] text-dim">
      {children}
    </h2>
  );
}
