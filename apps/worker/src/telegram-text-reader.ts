import { sha256Hex } from '@stakeframe/db';
import {
  OPENROUTER_MODELS,
  completionSchema,
  textBetDraftJsonSchema,
  textBetDraftSchema,
} from '@stakeframe/shared';
import { IntegrationError, readJson } from './http.js';
import { providerStructuredSchema } from './openrouter.js';

/**
 * STK-F2-07 — a leitura do registro textual em PT-BR, na fronteira da chamada
 * paga.
 *
 * É a mesma disciplina da STK-F2-06 (extração de imagem), com a diferença que
 * a imagem impõe: aqui não existe OCR nem segunda leitura, porque não existe
 * pixels. O texto do usuário é a única evidência, e o modelo o TRANSFORMA em
 * campos — nunca o corrige contra outra fonte, nunca o completa.
 *
 * Por isso o prompt é deliberadamente curto e negativo. Ele diz o que fazer e,
 * com mais força, o que NÃO fazer: sem casa, sem tipster resolvido, sem origem
 * financeira, sem data inventada, sem cálculo, sem comentário, sem opinião.
 * A lista de proibições é o que impede a resposta de virar recomendação — o
 * card proíbe IA narrativa, e a forma mais barata de garantir isso é não ter
 * campo onde ela caiba, mais um prompt que não a convida.
 */
export const TEXT_REGISTRATION_SYSTEM_PROMPT = [
  '[Papel] Transforme a descrição de uma aposta, escrita em português do Brasil, em campos estruturados.',
  '[Fonte única] A mensagem do usuário é a ÚNICA fonte. Não pesquise, não consulte o mundo, não complete o que não estiver escrito e não use o seu conhecimento sobre partidas, casas ou apostas.',
  '[Procedimento] (1) Localize valor, odd, referência e cada seleção. (2) Releia o texto comparando campo a campo. (3) Só então responda o JSON.',
  '[Valor e odd] Transcreva como aparecem, em ponto decimal e sem moeda: "50 reais" vira "50.00", "2,5" vira "2.50". Nunca calcule um a partir do outro, nunca some seleções para chegar a um valor e nunca invente valor ou odd que o texto não traz. Sem valor ou sem odd no texto, o campo é null.',
  '[Seleções] Uma entrada por linha de seleção do texto. Preserve o evento, o mercado e a escolha como escritos. A odd da seleção só entra se estiver escrita NA LINHA DA SELEÇÃO; a odd total do cupom não substitui a odd de uma seleção. Campo ausente é null.',
  '[Casa e tipster] O usuário pode citar o nome de uma casa ou de um tipster no texto. Copie o NOME EXATAMENTE como escrito, em bookmakerName e tipsterName, e nada além disso. Não escolha layout, não sugira casa, não normalize o nome, não invente cadastro. Se o texto não citar, o campo é null.',
  '[Origem financeira] Não há campo de origem e você não deve inferir nada sobre dinheiro real, freebet, bônus ou promoção. Isso é escolha do usuário, em outra etapa.',
  '[Datas] Não há campo de data e você NÃO deve escrever nenhuma. A data da aposta é o instante da mensagem, que o servidor já conhece; a data do jogo é outra etapa.',
  '[Cálculo] Não calcule retorno, lucro, ganho, resultado provável, chance ou qualquer projeção. Não estime, não arredonde, não complete.',
  '[Opinião] Não emita recomendação, palpite, análise, comentário, conselho nem explicação. Sua resposta é um formulário preenchido, não uma resposta a uma pergunta.',
  '[Warnings] Preencha warnings apenas quando o texto estiver ambíguo, cortado ou contraditório num campo. Escreva o que não deu para ler ("odd da segunda seleção não aparece no texto"), nunca o que acha que o usuário deveria fazer.',
  '[Formato] Responda SOMENTE com o objeto JSON exigido pelo schema, sem markdown, sem comentário, sem texto antes ou depois.',
  '[Exemplo sintético] Texto: "Apostei 50 reais na Bet365, odd 2.50, seleção Time Alfa no Mercado da Vitória, referência ABC123". Resposta: {"reference":"ABC123","stake":"50.00","odds":"2.50","bookmakerName":"Bet365","tipsterName":null,"selections":[{"event":null,"sport":null,"market":"Mercado da Vitória","selection":"Time Alfa","odds":null}],"warnings":[]}.',
].join('\n\n');

type ReadTextOptions = {
  apiKey: string;
  text: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

/**
 * Ler o texto é chamar o fornecedor com a cadeia de modelos já aprovada, uma
 * vez. O failover entre modelos acontece DENTRO da requisição (mesmo contrato da
 * STK-G0-19): a aplicação não repete, não insiste e não tenta outro caminho.
 */
export function readTextBet(options: ReadTextOptions) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const started = performance.now();
  return (async () => {
    try {
      const response = await (options.fetchImpl ?? fetch)(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            models: [...OPENROUTER_MODELS],
            max_tokens: 1024,
            seed: 0,
            stream: false,
            provider: { allow_fallbacks: true, require_parameters: true, sort: 'throughput' },
            messages: [
              { role: 'system', content: TEXT_REGISTRATION_SYSTEM_PROMPT },
              { role: 'user', content: options.text },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'text_bet_draft',
                strict: true,
                schema: providerStructuredSchema(textBetDraftJsonSchema),
              },
            },
          }),
        },
      );
      if (!response.ok) {
        const safeMetadata = response.status === 429 ? {} : {};
        await response.body?.cancel();
        throw new IntegrationError(
          response.status === 402
            ? 'AI_BUDGET_EXHAUSTED'
            : response.status === 429
              ? 'AI_RATE_LIMITED'
              : [401, 403].includes(response.status)
                ? 'AI_AUTH_REFUSED'
                : [400, 422].includes(response.status)
                  ? 'AI_REQUEST_INVALID'
                  : 'AI_PROVIDER_UNAVAILABLE',
          safeMetadata,
        );
      }
      const parsed = completionSchema.safeParse(await readJson(response));
      if (!parsed.success) throw new IntegrationError('AI_RESPONSE_INVALID');
      const content = parsed.data.choices[0]!.message.content;
      let candidate: unknown;
      try {
        candidate = JSON.parse(content) as unknown;
      } catch {
        throw new IntegrationError('AI_EXTRACTION_INVALID');
      }
      // A borda que sanitiza: strictObject rejeita qualquer campo além dos
      // declarados, então casa resolvida, origem, data ou comentário do modelo
      // não chegam nem ao preview.
      const draft = textBetDraftSchema.safeParse(candidate);
      if (!draft.success) throw new IntegrationError('AI_EXTRACTION_INVALID');
      return {
        draft: draft.data,
        requestId: parsed.data.id,
        usage: parsed.data.usage ?? null,
        model: parsed.data.model,
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      // A exceção pode carregar URL, credencial ou o texto do usuário: o nome
      // do código é tudo que sai daqui.
      throw new IntegrationError(
        signal.aborted ? 'AI_REQUEST_INTERRUPTED' : 'AI_CONNECTION_FAILED',
      );
    }
  })();
}

/**
 * O texto do usuário é a única evidência e ele NUNCA é registrado: nem no
 * banco, nem em log, nem na auditoria. O que prova que a leitura aconteceu são
 * o hash do texto enviado e o hash da estrutura recebida — a mesma técnica da
 * STK-F2-06, onde o conteúdo entra como SHA-256.
 */
export const textRegistrationHashes = (text: string, response: unknown) => ({
  textSha256: sha256Hex(text),
  responseSha256: sha256Hex(JSON.stringify(response)),
});
