import 'server-only';
import { ChatAnthropic } from '@langchain/anthropic';
import type { z } from 'zod';
import { env } from '@/server/env';
import { MAX_OUTPUT_TOKENS, MODELS, type ModelSlot } from './models';

/**
 * Única porta de entrada para o modelo. Nenhum agente instancia ChatAnthropic
 * por conta própria — assim o slot de modelo, o teto de tokens e o tratamento
 * de erro ficam num lugar só.
 */

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function model(slot: ModelSlot): ChatAnthropic {
  const { ANTHROPIC_API_KEY } = env();
  if (!ANTHROPIC_API_KEY) {
    throw new LlmError('ANTHROPIC_API_KEY não configurada.', false);
  }

  return new ChatAnthropic({
    model: MODELS[slot],
    apiKey: ANTHROPIC_API_KEY,
    maxTokens: MAX_OUTPUT_TOKENS[slot],
    /*
     * Sem `temperature`, e não por descuido.
     *
     * A família Claude 5 (opus-5, sonnet-5, fable-5, mythos-5) não expõe
     * parâmetros de amostragem: passar `temperature`, `topK` ou `topP` com
     * valor não-padrão lança antes de qualquer requisição sair. Só o Haiku 4.5
     * aceitaria — e configurar por slot deixaria metade dos agentes com um
     * comportamento e metade com outro, sem ganho.
     *
     * O que garante consistência aqui não é temperatura: é a união fechada de
     * intenções, o schema Zod validando a saída estruturada e o golden set
     * medindo regressão. Isso continua valendo.
     */
    maxRetries: 0, // o retry é nosso, em run-agent.ts, para ficar no agent_runs
  });
}

/**
 * Transporte, 429 e 5xx são transitórios e valem uma segunda tentativa.
 *
 * Saída fora do schema também passou a valer: enquanto havia `temperature: 0`,
 * repetir o mesmo prompt daria o mesmo erro. A família Claude 5 não aceita esse
 * parâmetro, então a saída varia entre chamadas e a retentativa tem chance real.
 */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number; response?: { status?: number } } | null)?.status
    ?? (error as { response?: { status?: number } } | null)?.response?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;

  const name = (error as Error | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;

  const message = (error as Error | null)?.message?.toLowerCase() ?? '';
  return message.includes('fetch failed') || message.includes('econnreset') || message.includes('etimedout');
}

export interface StructuredCallResult<T> {
  value: T;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Chamada com saída estruturada validada por Zod.
 *
 * O retorno já veio validado pelo schema — se o modelo devolveu algo fora do
 * formato, isto lança em vez de propagar um objeto meio preenchido adiante.
 */
export async function callStructured<S extends z.ZodType>(
  slot: ModelSlot,
  schema: S,
  schemaName: string,
  messages: { system: string; user: string },
  signal: AbortSignal,
): Promise<StructuredCallResult<z.infer<S>>> {
  try {
    const structured = model(slot).withStructuredOutput(schema, {
      name: schemaName,
      includeRaw: true,
    });

    const response = (await (structured.invoke(
      [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      { signal },
    ) as unknown)) as {
      parsed: z.infer<S>;
      raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } };
    };

    /*
     * `includeRaw` faz o LangChain devolver `parsed: null` quando a saída não
     * bate com o schema, em vez de lançar. Sem esta checagem, o null viaja para
     * dentro do chamador e estoura como TypeError em algum ponto distante — foi
     * exatamente o que a avaliação de extração pegou em "netflix 55,90".
     */
    if (response.parsed === null || response.parsed === undefined) {
      throw new LlmError(
        `${MODELS[slot]} devolveu saída fora do schema ${schemaName}.`,
        // Retentável agora, ao contrário do que este arquivo dizia antes: sem
        // poder fixar temperature na família 5, a saída é não-determinística e
        // uma segunda tentativa do mesmo prompt tem chance real de acertar.
        true,
      );
    }

    const usage = response.raw?.usage_metadata;

    return {
      value: response.parsed,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
    };
  } catch (error) {
    throw new LlmError(
      `Chamada estruturada a ${MODELS[slot]} falhou: ${(error as Error).message}`,
      isRetryable(error),
      error,
    );
  }
}

/** Chamada de texto livre. Usada só na síntese da resposta final. */
export async function callText(
  slot: ModelSlot,
  messages: { system: string; user: string },
  signal: AbortSignal,
): Promise<StructuredCallResult<string>> {
  try {
    // O tipo de mensagem do LangChain varia entre versões; o que precisamos
    // dele é estável (content + usage_metadata), então normalizamos aqui em vez
    // de acoplar o resto do código ao formato interno da biblioteca.
    const response = (await model(slot).invoke(
      [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      { signal },
    )) as unknown as {
      content: string | Array<{ type?: string; text?: string }>;
      usage_metadata?: { input_tokens?: number; output_tokens?: number };
    };

    const text =
      typeof response.content === 'string'
        ? response.content
        : response.content.map((part) => part.text ?? '').join('');

    return {
      value: text,
      inputTokens: response.usage_metadata?.input_tokens ?? null,
      outputTokens: response.usage_metadata?.output_tokens ?? null,
    };
  } catch (error) {
    throw new LlmError(
      `Chamada de texto a ${MODELS[slot]} falhou: ${(error as Error).message}`,
      isRetryable(error),
      error,
    );
  }
}
