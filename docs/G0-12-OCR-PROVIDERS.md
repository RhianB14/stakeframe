# STK-G0-12 — OCR Azure + Google Vision

O runtime possui um contrato OCR neutro e dois adaptadores privados:

- Azure Vision Read API (`apps/worker/src/azure-vision.ts`);
- Google Cloud Vision `DOCUMENT_TEXT_DETECTION`
  (`apps/worker/src/google-vision.ts`).

Ambos normalizam texto, páginas, linhas, blocos, coordenadas e confiança para
o contrato de `apps/worker/src/ocr.ts`. A imagem original continua sendo a
fonte de verdade e o OCR nunca libera uma importação automaticamente.

## Política de provedores

O padrão é Azure primário + Google fallback. O fallback só é usado para falha
recuperável do primário (indisponibilidade, conexão, timeout ou rate limit).
Falhas de autenticação, configuração, resposta inválida, imagem vazia ou
divergência semântica não são mascaradas.

`OCR_MODE=consensus` é uma operação explícita de validação: os dois provedores
são chamados e o item falha fechado se o texto normalizado divergir. O padrão
`OCR_MODE=failover` evita chamadas duplicadas e custo desnecessário.

## Segurança e operação

Os dois segredos são lidos exclusivamente de arquivos absolutos por
`*_API_KEY_FILE`. Chaves, imagens, texto OCR e respostas dos provedores não
entram em logs, Git, PR ou Kanban. Configuração incompleta falha antes da
rede; se OCR estiver habilitado sem a IA multimodal, o worker recusa iniciar.

O overlay `compose.ocr.yml` é opcional e permanece fora do compose padrão.
Nenhuma conta, API, faturamento, recurso ou chave é criada pelo código. A
ativação real exige provisionamento separado e autorização do proprietário.

## Estados de falha

Os adaptadores retornam somente códigos sanitizados. A fila não repete
chamadas pagas. Se o primário falhar de forma recuperável, o fallback pode ser
tentado uma vez; se os dois falharem, o item permanece falho para revisão.
No modo consenso, divergência retorna `OCR_PROVIDER_DIVERGENCE` e não chama a
extração multimodal.
