import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
      /*
       * `server-only` lança por desenho fora do runtime React Server, o que
       * quebraria qualquer teste que importe um módulo de src/server/**.
       * Apontar para o empty.js do próprio pacote — o mesmo que o Next usa sob
       * a condição `react-server` — mantém a garantia onde ela vale (o bundler
       * continua barrando import a partir de client component) sem tornar a
       * lógica de servidor intestável.
       */
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // tests/unit é determinístico e sem rede — é o que roda no CI.
    // tests/eval chama modelo e custa dinheiro: só sob demanda (`npm run eval`).
    // tests/rls precisa de um Supabase alcançável (`npm run test:rls`).
    include: ['**/*.test.ts'],
  },
});
