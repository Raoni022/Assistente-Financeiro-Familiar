import next from 'eslint-config-next';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...next,
];

export default config;

// Nota: a barreira "código de servidor nunca no cliente" NÃO é feita por lint.
// É feita pelo pacote `server-only`, importado no topo de todo módulo em
// src/server/**. Importá-lo a partir de um client component quebra o build —
// garantia mecânica, não convenção. Ver docs/architecture.md §5.
