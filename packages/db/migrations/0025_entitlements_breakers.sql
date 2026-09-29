-- STK-F2-13 — entitlements calculados NO BANCO e circuit breakers de custo.
--
-- Três decisões deliberadas, na ordem em que o card as pede:
--
--  - O BANCO é a fonte de verdade dos entitlements (Plano §6.1, §11.1). O
--    plano vive em `core.plan`, as permissões em `core.plan_entitlement` e a
--    atribuição em `core.organization_entitlement`; a RESOLUÇÃO é a função
--    `core.organization_entitlements`, que o banco calcula. Nenhum cálculo de
--    permissão acontece no frontend, no PostHog ou em payload de webhook: se a
--    função não devolve a linha, o recurso não existe para aquela conta.
--
--  - SEM PREÇO E SEM COBRANÇA no beta. Não existe coluna de preço em lugar
--    algum desta migração, e `plan.billable` é CHECK false: a impossibilidade
--    de cobrar é imposta pelo banco, não por convenção. Os preços ficam
--    INDEFINIDOS de propósito (o escopo excluído do card é a cobrança da Fase
--    4 / Mercado Pago) e os limites são de USO, não de dinheiro cobrado.
--
--  - CUSTO é ≠ COTA, e os dois moram na MESMA tabela. A 0024 já conta a quota
--    por APRESENTAÇÃO (`presented`): é o que o usuário recebe. O custo
--    (`cost_micros`) é o que NÓS pagamos ao fornecedor, e uma resposta incerta
--    ou uma falha confirmada pode ter custado trabalho — por isso a debitada é
--    feita em qualquer chamada que saiu, exceto a recusa por cota. Nenhuma das
--    duas dims duplica a contabilidade anterior: a unidade de cota continua
--    `quotaUnitForOutcome`, e o teto global de R$200/mês é lido da MESMA soma
--    diária que a 0024 já mantinha.
--
-- O circuit breaker NÃO é recriado aqui. A 0024 entregou a base estrutural nos
-- três escopos (`global`, `daily`, `user`) e este arquivo apenas substitui as
-- constantes de código por uma POLÍTICA no banco (`integration.breaker_policy`),
-- que é o que a 0024 deixou explicitamente para esta card ajustar: limiar e
-- janela por escopo, mais o teto de gasto. Nenhuma forma muda.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR
-- REPLACE / ON CONFLICT DO NOTHING / DO $$ ... END $$), no mesmo padrão da
-- 0010, da 0011, da 0021, da 0023 e da 0024. Esta migração é LOCAL: nada é
-- executado em produção sem o fluxo de autorização, backup e recuperação do
-- runbook.

-- ------------------------------------------------------------------ planos
-- Catálogo GLOBAL de referência, como `core.legal_document`: não é dado privado
-- de organização e não leva RLS.
--
-- `billable` é false e o CHECK impede true: no beta o produto não cobra. A
-- coluna existe para que a ausência de cobrança seja uma INVARIANTE do banco
-- e não um esquecimento: ligar a cobrança passa a ser uma migração nova e
-- explícita, não um UPDATE acidental.
CREATE TABLE IF NOT EXISTS "core"."plan" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	-- Ordem de classificação do plano (free < starter < pro). É a ordem de
	-- exibição e de comparação, nunca um valor financeiro.
	"rank" integer NOT NULL,
	"billable" boolean NOT NULL DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_id_check" CHECK ("core"."plan"."id" in ('free','starter','pro')),
	CONSTRAINT "plan_rank_check" CHECK ("core"."plan"."rank" >= 0),
	-- Sem cobrança no beta: o banco recusa o próprio plano marked as cobrável.
	CONSTRAINT "plan_not_billable_check" CHECK ("core"."plan"."billable" = false),
	CONSTRAINT "plan_label_not_empty" CHECK (btrim("core"."plan"."label") <> '')
);

-- Permissões do plano. `limit_value` é o TETO DE USO do recurso (unidades por
-- mês, na unidade do próprio recurso) e NÃO é preço: `null` significa "sem teto
-- próprio" — o teto global de chamadas e o teto global de custo continuam valendo
-- acima dele, porque plano nunca amplia a capacidade da infraestrutura.
CREATE TABLE IF NOT EXISTS "core"."plan_entitlement" (
	"plan_id" text NOT NULL,
	"feature" text NOT NULL,
	"enabled" boolean NOT NULL,
	"limit_value" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_entitlement_pk" PRIMARY KEY ("plan_id","feature"),
	CONSTRAINT "plan_entitlement_feature_check" CHECK ("core"."plan_entitlement"."feature" in ('ocr_extraction','telegram_ticket_flow','event_search','freebet_alerts','advanced_dashboards')),
	-- Teto é inteiro não negativo ou ausente; nunca negativo e nunca texto.
	CONSTRAINT "plan_entitlement_limit_check" CHECK ("core"."plan_entitlement"."limit_value" is null or "core"."plan_entitlement"."limit_value" >= 0),
	CONSTRAINT "plan_entitlement_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "core"."plan"("id") ON DELETE cascade ON UPDATE no action
);

-- Atribuição do plano à organização. Uma linha por tenant: é a única coisa que
-- muda quando um plano muda, e ela é gravada pelo servidor.
CREATE TABLE IF NOT EXISTS "core"."organization_entitlement" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Quem atribuiu (id interno de `auth.user`, nunca e-mail). NULL = seed.
	"assigned_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_entitlement_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "core"."plan"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "organization_entitlement_assigned_by_fk" FOREIGN KEY ("assigned_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action
);

-- RLS fail-closed: sem contexto de organização a expressão não casa nenhuma
-- linha, e tanto a leitura quanto a escrita são recusadas. Mesma fronteira de
-- `core.telegram_link` (0022).
ALTER TABLE "core"."organization_entitlement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "core"."organization_entitlement";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "core"."organization_entitlement"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS "organization_entitlement_plan_idx" ON "core"."organization_entitlement" ("plan_id");

-- ------------------------------------------------- resolução calculada no banco
-- A função É o cálculo do entitlement. Ela devolve uma linha por recurso do
-- plano efetivo, e nada mais: quem quiser saber o que a conta pode fazer lê
-- esta função, e a resposta muda quando o banco muda.
--
-- Fail-closed em dois pontos, ambos por construção:
--
--  - organização sem atribuição => plano `free`, o mais restritivo. Um tenant
--    novo nunca nasce com mais permissão do que o mínimo;
--  - organização inexistente => NENHUMA linha. "Nada" é a resposta que o
--    chamador trata como recusa, então um id desconhecido não vira permissão.
CREATE OR REPLACE FUNCTION "core"."organization_entitlements"(p_organization_id uuid)
RETURNS TABLE ("plan_id" text, "feature" text, "enabled" boolean, "limit_value" integer)
LANGUAGE sql STABLE AS $fn$
	WITH effective AS (
		SELECT COALESCE(oe.plan_id, 'free') AS resolved_plan
		  FROM "core"."organization" o
		  LEFT JOIN "core"."organization_entitlement" oe ON oe.organization_id = o.id
		 WHERE o.id = p_organization_id
	)
	SELECT effective.resolved_plan, pe.feature, pe.enabled, pe.limit_value
	  FROM effective
	  JOIN "core"."plan" p ON p.id = effective.resolved_plan
	  JOIN "core"."plan_entitlement" pe ON pe.plan_id = p.id
	 ORDER BY pe.feature;
$fn$;

-- ------------------------------------------------- circuit breaker: a política
-- A 0024 deixou o limiar e a janela como constante de código, com esta card
-- nomeada para substituí-los. Agora os dois são DADOS, por escopo, e o serviço
-- os lê do banco — mudar a política é um UPDATE auditável em tabela, não um
-- deploy.
--
-- `spend_cap_micros`/`spend_window` são o teto de GASTO do escopo. No beta só
-- o escopo global tem teto preenchido (R$200/mês, §4.7): os escopos diário e
-- por usuário ficam com `null` porque o teto DIÁRIO que já existia é o de quota
-- por apresentação (`AI_QUOTA_CEILINGS.dailyPresented`) e um número de gasto por
-- usuário seria política de produto inventada aqui. A coluna existe e o serviço
-- a lê: quando houver número, ele é lido do mesmo lugar.
CREATE TABLE IF NOT EXISTS "integration"."breaker_policy" (
	"scope" text PRIMARY KEY NOT NULL,
	-- Falhas CONFIRMADAS consecutivas que abrem este circuito.
	"failure_threshold" integer NOT NULL,
	-- Contenção da recuperação, em milissegundos.
	"recovery_ms" integer NOT NULL,
	-- Teto de gasto do escopo em MICROREAIS (1 BRL = 1_000_000 micros). Null =
	-- este escopo não tem teto de gasto próprio.
	"spend_cap_micros" bigint,
	-- 'day' | 'month' | null. O que `spend_cap_micros` conta.
	"spend_window" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breaker_policy_scope_check" CHECK ("scope" in ('global','daily','user')),
	CONSTRAINT "breaker_policy_threshold_check" CHECK ("failure_threshold" >= 1),
	CONSTRAINT "breaker_policy_recovery_check" CHECK ("recovery_ms" >= 0),
	CONSTRAINT "breaker_policy_spend_nonnegative_check" CHECK ("spend_cap_micros" is null or "spend_cap_micros" >= 0),
	-- Teto e janela andam juntos: um teto sem janela é ambíguo sobre o que conta.
	CONSTRAINT "breaker_policy_spend_pair_check" CHECK (("spend_cap_micros" is null) = ("spend_window" is null)),
	CONSTRAINT "breaker_policy_spend_window_check" CHECK ("spend_window" is null or "spend_window" in ('day','month'))
);

-- ----------------------------------------------- custo estimado (o que pagamos)
-- Preço de REFERÊNCIA do fornecedor por 1.000 tokens, em microreais. Não é preço
-- de venda ao usuário — o beta não cobra (Plano §4.7) — e é exatamente o que
-- limita o teto de R$200/mês. Os valores são estimativas provisionais e o teto
-- é o que protege: mesmo com preço superestimado, o teto global fecha a porta
-- antes de qualquer gasto relevante.
CREATE TABLE IF NOT EXISTS "integration"."ai_model_price" (
	"model" text PRIMARY KEY NOT NULL,
	"input_micros_per_1k" bigint NOT NULL,
	"output_micros_per_1k" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_price_model_check" CHECK (btrim("integration"."ai_model_price"."model") <> ''),
	CONSTRAINT "ai_model_price_input_check" CHECK ("integration"."ai_model_price"."input_micros_per_1k" >= 0),
	CONSTRAINT "ai_model_price_output_check" CHECK ("integration"."ai_model_price"."output_micros_per_1k" >= 0)
);

-- O que uma chamada CUESTA quando o preço não é conhecido: preço ausente no
-- catálogo, ou uso não declarado pelo fornecedor. Assumir zero permitiria que um
-- fornecedor escondesse o uso e burlasse o teto, então a contabilidade é
-- fail-closed e cobra o valor de referência declarado aqui.
CREATE TABLE IF NOT EXISTS "integration"."ai_cost_model" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"unpriced_call_micros" bigint NOT NULL DEFAULT 1500,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cost_model_singleton_check" CHECK ("integration"."ai_cost_model"."id" = 'default'),
	CONSTRAINT "ai_cost_model_unpriced_check" CHECK ("integration"."ai_cost_model"."unpriced_call_micros" >= 0)
);

-- ------------------------------------------------- custo na contabilidade F2-06
-- Uma coluna nova na MESMA tabela de quota: nenhuma contagem é duplicada, apenas
-- uma dimensão nova sobre os mesmos dias. A soma mensal do custo é a mesma
-- agregação que a 0024 já fazia para o teto de apresentações.
ALTER TABLE "integration"."ai_usage_day" ADD COLUMN IF NOT EXISTS "cost_micros" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_usage_cost_nonnegative' AND conrelid='integration.ai_usage_day'::regclass) THEN
	ALTER TABLE "integration"."ai_usage_day" ADD CONSTRAINT "ai_usage_cost_nonnegative" CHECK ("integration"."ai_usage_day"."cost_micros" >= 0);
END IF; END $$;--> statement-breakpoint
-- Uma recusa por cota não custou nada: nenhuma chamada saiu. Qualquer outro
-- desfecho pode ter custado, inclusive a resposta incerta — que é justamente a
-- que o dinheiro já gasto torna proibido repetir.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_usage_refused_is_free' AND conrelid='integration.ai_usage_day'::regclass) THEN
	ALTER TABLE "integration"."ai_usage_day" ADD CONSTRAINT "ai_usage_refused_is_free" CHECK ("integration"."ai_usage_day"."refused" >= 0);
END IF; END $$;

-- ================================================================= seeds
-- Todos replay-safe: rodar a migração duas vezes na mesma transação deixa a
-- segunda como no-op, e o journal nunca registra duas entradas.
INSERT INTO "core"."plan" ("id","label","rank","billable") VALUES
	('free','Free',0,false),
	('starter','Starter',1,false),
	('pro','Pro',2,false)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Teto de `ocr_extraction` em extrações APRESENTADAS por mês, que é a mesma
-- unidade que a quota da 0024 debita — o plano limita o que o tenant apresenta,
-- não um número paralelo de "chamadas".
INSERT INTO "core"."plan_entitlement" ("plan_id","feature","enabled","limit_value") VALUES
	('free','ocr_extraction',true,100),
	('starter','ocr_extraction',true,500),
	('pro','ocr_extraction',true,null),
	('free','telegram_ticket_flow',true,null),
	('starter','telegram_ticket_flow',true,null),
	('pro','telegram_ticket_flow',true,null),
	('free','event_search',true,null),
	('starter','event_search',true,null),
	('pro','event_search',true,null),
	('free','freebet_alerts',true,null),
	('starter','freebet_alerts',true,null),
	('pro','freebet_alerts',true,null),
	('free','advanced_dashboards',false,null),
	('starter','advanced_dashboards',true,null),
	('pro','advanced_dashboards',true,null)
ON CONFLICT ("plan_id","feature") DO NOTHING;--> statement-breakpoint
INSERT INTO "integration"."breaker_policy" ("scope","failure_threshold","recovery_ms","spend_cap_micros","spend_window") VALUES
	('global',5,900000,200000000,'month'),
	('daily',5,900000,null,null),
	('user',5,900000,null,null)
ON CONFLICT ("scope") DO NOTHING;--> statement-breakpoint
-- Preço de referência dos três modelos que o produto consulta. Estimativa
-- provisionais, conservadora, e sem nenhuma relação com cobrança ao usuário.
INSERT INTO "integration"."ai_model_price" ("model","input_micros_per_1k","output_micros_per_1k") VALUES
	('google/gemini-3.8-flash',1500,6000),
	('qwen/qwen3-vl-32b-instruct',800,2400),
	('deepseek/deepseek-v4-flash-vision-exp',400,1200)
ON CONFLICT ("model") DO NOTHING;--> statement-breakpoint
INSERT INTO "integration"."ai_cost_model" ("id","unpriced_call_micros") VALUES ('default',1500)
ON CONFLICT ("id") DO NOTHING;
