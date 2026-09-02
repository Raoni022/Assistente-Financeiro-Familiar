/**
 * Carrega variáveis de ambiente para scripts e testes fora do Next.
 *
 * `import 'dotenv/config'` lê apenas `.env` — e este projeto guarda os segredos
 * em `.env.local`, que é o arquivo do `.gitignore` e o que o Next carrega.
 * Sem isto, script e teste rodam cegos e reportam "faltam variáveis" com o
 * arquivo preenchido na frente.
 */
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'], quiet: true });
