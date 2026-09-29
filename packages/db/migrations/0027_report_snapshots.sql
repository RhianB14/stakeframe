-- STK-F2-08 — snapshots de relatório IMUTÁVEIS, com versão revisada e
-- deduplicação de envio.
--
-- Quatro decisões, na ordem em que o card as pede:
--
--  - O RELATÓRIO É UM SNAPSHOT, NÃO UMA CONSULTA. `/relatorio` e a página
--    `/relatorios` continuam lendo os dados atuais (reusando o serviço da
--  F2-02/F2-03); o que esta migração guarda é a VERSÃO CONGELADA que foi
--    enviada. Sem isso, "a mensagem de terça-feira apontou R$ X" seria
--    impossível de auditar depois de qualquer correção. A página privada
--    renderiza o snapshot; a tabela guarda o número exato, a versão
--    financeira que o produziu e a narrativa determinística.
--
--  - O SNAPSHOT É IMUTÁVEL, E O BANCO IMPÕE ISSO. A correção de dados pode
--    mudar o relatório de hoje, mas nunca reescreve o que já foi publicado:
--    `report_snapshot` tem trigger `BEFORE UPDATE OR DELETE` que recusa, e a
--    correção cria uma NOVA LINHA (versão 2) sob demanda, como o card diz.
--    Nenhum serviço deste repositório faz UPDATE em snapshot — a garantia é o
--    trigger, não a disciplina do chamador, porque disciplina não sobrevive a
--    um segundo chamador.
--
--  - A DEDUPE É DO BANCO, E É POR JANELA + VERSÃO FINANCEIRA. A chave única
--    `(organization_id, period, from, to, financial_version)` é o que impede
--    dois envios do mesmo relatório: rodar o job cinco vezes no mesmo dia não
--    produz cinco mensagens, porque a segunda inserção colide com a chave.
--    Quando o financeiro MUDA, a chave muda junto e uma nova versão é
--    permitida — que é a forma de "correção gera versão revisada" sem
--    reenvio automático. O envio fica em `report_delivery`, que registra o
--    que foi entregue e quando; o relatório continua existindo mesmo se o
--    canal falhar.
--
--  - SEM URL PÚBLICA, SEM TOKEN, SEM ARQUIVO. Não existe coluna de link
--    temporário, chave de acesso ou caminho de PDF/PNG: o endereço do
--    relatório é a rota autenticada do produto (§4.3, D020), montada pela
--    aplicação a partir do `miniAppUrl` validado. O snapshot guarda o que foi
--    GERADO, nunca um arquivo para baixar.
--
-- O plano NÃO aparece aqui. A cadência por plano é do produto (a F2-13
-- calcula o entitlement no banco; o catálogo de cadência é do produto), e
-- esta migração não cria uma segunda fonte de permissão.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR
-- REPLACE / ON CONFLICT DO NOTHING / DO $$ ... END $$), no mesmo padrão da
-- 0010, da 0011, da 0021, da 0023, da 0024 e da 0025. Esta migração é LOCAL:
-- nada é executado em produção sem o fluxo de autorização, backup e
-- recuperação do runbook.

-- --------------------------------------------------------------- o snapshot
-- Uma linha por VERSÃO PUBLICADA. `version` é 1 para a primeira emissão e
-- cresce só por revisão sob demanda; nada reescreve a versão anterior.
--
-- `financial_version` é a versão de `finance.settings` no instante da
-- geração: é o que amarra o número mostrado ao estado do financeiro. Uma
-- correção de aposta incrementa essa versão, e por isso o relatório corrigido
-- é uma linha nova — o que torna a dedupe e a auditoria a mesma coisa.
CREATE TABLE IF NOT EXISTS "integration"."report_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	-- Versão desta LINHA dentro do mesmo par (período, janela). 1 = original.
	"version" integer NOT NULL DEFAULT 1,
	-- Cadência que originou o snapshot; a página mostra as três.
	"period" text NOT NULL,
	-- Janela de DATA DE EVENTO (§3.8), em datas civis do fuso do usuário.
	"from" date NOT NULL,
	"to" date NOT NULL,
	-- Versão de finance.settings quando o snapshot foi gerado.
	"financial_version" integer NOT NULL,
	-- Métricas congeladas, já no formato do contrato de relatório (numeric
	-- como texto, nunca float). `payload` guarda o relatório completo — o
	-- dashboard, os splits e a narrativa — para que a página renderize
	-- exatamente o que foi enviado, e não uma recomputação.
	"metrics" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	-- Hash do payload: permite provar que a página mostra o mesmo conteúdo
	-- do registro sem recalcular nada.
	"content_sha256" text NOT NULL,
	-- Quem pediu a emissão. NULL = job de cadência (o dono do tenant é
	-- resolvido pela organização, como em todo o resto do produto).
	"requested_by" text,
	-- Motivo da revisão, quando `version` > 1. Auditoria de POR QUE a nova
	-- versão existe, sem texto livre do usuário.
	"revision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_snapshot_period_check" CHECK ("integration"."report_snapshot"."period" in ('daily','weekly','monthly')),
	CONSTRAINT "report_snapshot_version_positive" CHECK ("integration"."report_snapshot"."version" >= 1),
	CONSTRAINT "report_snapshot_window_ordered" CHECK ("integration"."report_snapshot"."from" <= "integration"."report_snapshot"."to"),
	CONSTRAINT "report_snapshot_financial_version_positive" CHECK ("integration"."report_snapshot"."financial_version" >= 1),
	-- Hash de conteúdo em hex de SHA-256 (64 caracteres, minúsculos): o
	-- valor é calculado pela aplicação, e o banco recusa qualquer coisa que
	-- não seja um digest — um payload sem hash verificável não entra.
	CONSTRAINT "report_snapshot_sha256_check" CHECK ("integration"."report_snapshot"."content_sha256" ~ '^[0-9a-f]{64}$'),
	-- Motivo de revisão preenchido só quando há revisão: version=1 sem motivo
	-- é emissão original, version>1 sem motivo não é auditável.
	CONSTRAINT "report_snapshot_revision_reason_check" CHECK (("integration"."report_snapshot"."version" = 1 and "integration"."report_snapshot"."revision_reason" is null) or ("integration"."report_snapshot"."version" > 1 and btrim(coalesce("integration"."report_snapshot"."revision_reason",'')) <> ''))
);

-- A CHAVE ÚNICA É POR VERSÃO, e não por versão financeira.
--
-- Uma versão por (organização, período, janela, versão): a revisão cria a
-- linha 2 ao lado da 1 e nunca colide com ela. Um índice único por versão
-- FINANCEIRA seria errado aqui — a revisão 2 nasce, por definição, do mesmo
-- estado do financeiro que a versão 1 (é o dado do usuário que mudou, não o
-- saldo), e o índice recusaria a revisão. A DEDUPE DE ENVIO vive em
-- `report_delivery.dedupe_key`, que já carrega a versão financeira; as duas
-- chaves respondem a perguntas diferentes e ficam em tabelas diferentes.
CREATE UNIQUE INDEX IF NOT EXISTS "report_snapshot_revision_idx" ON "integration"."report_snapshot" USING btree ("organization_id","period","from","to","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_snapshot_org_idx" ON "integration"."report_snapshot" ("organization_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_snapshot_financial_version_idx" ON "integration"."report_snapshot" ("organization_id","financial_version");

-- RLS fail-closed, a mesma fronteira de `core.organization_entitlement` (0025):
-- sem contexto de organização a expressão não casa linha nenhuma, e a
-- comparação com NULL é o que transforma "sem contexto" em "sem linhas"
-- em vez de erro.
ALTER TABLE "integration"."report_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."report_snapshot";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."report_snapshot"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ---------------------------------------------------- a imutabilidade (a lei)
-- O trigger é a garantia de "imutável e auditável" (§4.3). Uma correção de
-- dado cria versão nova; ela não reescreve o que já foi publicado. Sem este
-- trigger, qualquer caminho de escrita futuro poderia UPDATEar um snapshot já
-- enviado e o histórico deixaria de provar nada.
CREATE OR REPLACE FUNCTION "integration"."immutable_report_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	RAISE EXCEPTION 'REPORT_SNAPSHOT_IMMUTABLE' USING ERRCODE='23514';
END
$fn$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "report_snapshot_immutable" ON "integration"."report_snapshot";--> statement-breakpoint
CREATE TRIGGER "report_snapshot_immutable"
  BEFORE UPDATE OR DELETE ON "integration"."report_snapshot"
  FOR EACH ROW EXECUTE FUNCTION "integration"."immutable_report_snapshot"();

-- ------------------------------------------------------- o envio (dedupe)
-- O REGISTRO do que foi entregue, separado do snapshot porque a entrega é o
-- que pode falhar e repetir: um relatório gerado que o Telegram não aceitou
-- continua existindo e pode ser reexibido na página, sem gerar versão nova.
--
-- `channel` é 'telegram' e não pode ser outro: o card exclui e-mail, PDF, PNG
-- e imagem compartilhável, e o CHECK é o que impede um segundo canal de
-- aparecer por conveniência.
CREATE TABLE IF NOT EXISTS "integration"."report_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"period" text NOT NULL,
	"from" date NOT NULL,
	"to" date NOT NULL,
	"financial_version" integer NOT NULL,
	-- A chave de dedupe calculada pela aplicação
	-- (`reportDeliveryKey` do shared). Indexada porque É a chave de
	-- idempotência, e a unicidade é o que impede o segundo envio.
	"dedupe_key" text NOT NULL,
	-- Destinatário e canal, para auditoria de quem recebeu o quê.
	"user_id" text NOT NULL,
	"channel" text NOT NULL DEFAULT 'telegram',
	"state" text NOT NULL DEFAULT 'pending',
	"attempts" integer NOT NULL DEFAULT 0,
	"last_error" text,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_delivery_period_check" CHECK ("integration"."report_delivery"."period" in ('daily','weekly','monthly')),
	CONSTRAINT "report_delivery_channel_check" CHECK ("integration"."report_delivery"."channel" = 'telegram'),
	-- `pending` = reservado para entrega; `delivered` = o Telegram aceitou;
	-- `skipped_no_data` = a janela não tinha apostas e nada foi enviado
	-- (a regra do card: sem dados não envia); `failed` = terminal.
	CONSTRAINT "report_delivery_state_check" CHECK ("integration"."report_delivery"."state" in ('pending','delivered','skipped_no_data','failed')),
	CONSTRAINT "report_delivery_attempts_check" CHECK ("integration"."report_delivery"."attempts" >= 0),
	CONSTRAINT "report_delivery_window_ordered" CHECK ("integration"."report_delivery"."from" <= "integration"."report_delivery"."to"),
	CONSTRAINT "report_delivery_financial_version_positive" CHECK ("integration"."report_delivery"."financial_version" >= 1),
	CONSTRAINT "report_delivery_dedupe_key_not_empty" CHECK (btrim("integration"."report_delivery"."dedupe_key") <> ''),
	CONSTRAINT "report_delivery_snapshot_fk" FOREIGN KEY ("snapshot_id") REFERENCES "integration"."report_snapshot"("id") ON DELETE restrict ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "report_delivery_dedupe_idx" ON "integration"."report_delivery" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_delivery_due_idx" ON "integration"."report_delivery" ("state","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_delivery_snapshot_idx" ON "integration"."report_delivery" ("organization_id","snapshot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_delivery_user_idx" ON "integration"."report_delivery" ("organization_id","user_id","created_at" DESC);

ALTER TABLE "integration"."report_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."report_delivery";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."report_delivery"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
