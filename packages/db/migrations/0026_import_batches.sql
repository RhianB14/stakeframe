-- STK-F2-09 — lotes de importação por arquivo e marcações de origem.
--
-- Duas decisões deliberadas, na ordem em que o card as pede:
--
--  - O LOTE é uma PRIMEIRA CLASSE e não uma coluna da inbox. A foto entra por
--    `integration.inbox`; o arquivo entra por `integration.import_batch`, com as
--    LINHAS do preview e o RESULTADO gravado. Misturar os dois obrigaria a
--    fila de fotos a entender um arquivo que nunca teve imagem, e a fairia
--    carregar um payload de 500 linhas na fila de uma foto por vez.
--
--  - A MARCAÇÃO DE ORIGEM é DUPLA, e cada metade responde a uma pergunta
--    diferente. `import_batch.import_origin` diz de qual CAMINHO o lote veio
--    (template do produto ou CSV genérico mapeado); `finance.bet.import_origin`
--    diz de qual caminho a APOSTA nasceu, e sobrevive à reversão e à exclusão do
--    lote. A primeira é a origem do trabalho e pode ser apagada com ele; a
--    segunda é a origem do lançamento e é permanente.
--
-- A aposta carrega `import_batch_id` porque é ele que torna o ROLLBACK
-- possível: sem o vínculo, a reversão do lote teria de adivinhar quais
-- apostas ele criou, e adivinhação em dado financeiro não é opção. A
-- referência é ON DELETE SET NULL de propósito — apagar o lote NUNCA pode
-- apagar o lançamento, e a aposta já revertida continua no histórico com a
-- origem gravada.
--
-- O recibo (`import_batch_receipt`) é a MESMA forma de `finance.command_receipt`
-- e da 0013: hash do pedido, resultado sanitizado, e a mesma chave de
-- idempotência que a confirmação usa. Repetir a confirmação devolve o resultado
-- gravado; a mesma chave com outro conteúdo é conflito.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS / ON CONFLICT DO
-- NOTHING / DO $$ ... END $$), no mesmo padrão da 0010, da 0011, da 0021, da
-- 0024 e da 0025. Esta migração é LOCAL: nada é executado em produção sem o
-- fluxo de autorização, backup e recuperação do runbook.

-- ------------------------------------------------------------------- o lote
-- Uma linha por upload. A identidade é `content_sha256`: o MESMO arquivo com o
-- MESMO mapeamento efetivo reenviado devolve o MESMO lote, que é o que torna a
-- repetição do upload idempotente sem depender de horário ou id de requisição.
CREATE TABLE IF NOT EXISTS "integration"."import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	-- Versão otimista do lote: preview revalidado, commit e rollback somam.
	"version" integer NOT NULL DEFAULT 1,
	-- preview: validado, nada gravado. committed: todas as linhas entraram.
	-- partially_committed: houve linha recusada, e o resultado PARCIAL é
	-- explícito. rolled_back: as apostas do lote foram revertidas.
	"state" text NOT NULL,
	-- De qual CAMINHO o lote veio: template do produto ou CSV genérico mapeado.
	"origin" text NOT NULL,
	-- Nome informado pelo usuário. É rótulo, não conteúdo: o arquivo em si
	-- nunca é gravado (o risco de PII do card é o de guardar histórico de
	-- outra pessoa, e um nome de arquivo não guarda histórico de ninguém).
	"filename" text NOT NULL,
	-- SHA-256 do conteúdo com o mapeamento efetivo dentro. É a identidade e
	-- nunca o conteúdo: o banco não tem onde caber o arquivo.
	"content_sha256" text NOT NULL,
	-- O mapeamento DECLARADO pelo usuário (null = template). Guardá-lo é o que
	-- permite revalidar o mesmo arquivo com o mesmo critério.
	"mapping" jsonb,
	"total" integer NOT NULL DEFAULT 0,
	"valid" integer NOT NULL DEFAULT 0,
	"invalid" integer NOT NULL DEFAULT 0,
	"duplicates" integer NOT NULL DEFAULT 0,
	-- Linhas GRAVADAS e linhas PULADAS do commit. Somados, fecham com `total`.
	"committed" integer NOT NULL DEFAULT 0,
	"skipped" integer NOT NULL DEFAULT 0,
	-- As LINHAS do preview, já normalizadas: o commit grava exatamente isto, e
	-- nunca reinterpreta o arquivo depois que o usuário leu.
	"rows" jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- Uma entrada por linha recusada, com o código fechado que a recusou.
	"skipped_rows" jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- O RESULTADO do commit, sanitizado: contagens, linhas, ids das apostas.
	"result" jsonb,
	"committed_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batch_state_check" CHECK ("integration"."import_batch"."state" in ('preview','committed','partially_committed','rolled_back')),
	CONSTRAINT "import_batch_origin_check" CHECK ("integration"."import_batch"."origin" in ('stakeframe_template','csv_generic')),
	CONSTRAINT "import_batch_sha256_check" CHECK ("integration"."import_batch"."content_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "import_batch_filename_check" CHECK (char_length("integration"."import_batch"."filename") between 1 and 200),
	CONSTRAINT "import_batch_counts_check" CHECK ("integration"."import_batch"."valid" >= 0 and "integration"."import_batch"."invalid" >= 0 and "integration"."import_batch"."duplicates" >= 0 and "integration"."import_batch"."total" >= 0),
	-- committed e skipped fecham com o total: nunca há linha que desapareça
	-- entre o que o usuário leu e o que foi gravado.
	CONSTRAINT "import_batch_partition_check" CHECK (
		"integration"."import_batch"."state" in ('preview','rolled_back')
		or "integration"."import_batch"."committed" + "integration"."import_batch"."skipped" = "integration"."import_batch"."total"
	)
);
--> statement-breakpoint
-- A identidade do lote é POR ORGANIZAÇÃO: o mesmo arquivo de outro tenant é
-- outro lote, e duas organizações com o mesmo conteúdo não colidem.
CREATE UNIQUE INDEX IF NOT EXISTS "import_batch_organization_id_content_sha256_idx" ON "integration"."import_batch" ("organization_id","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_batch_organization_id_id_idx" ON "integration"."import_batch" ("organization_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_batch_created_idx" ON "integration"."import_batch" ("organization_id","created_at" DESC);

-- RLS fail-closed, a mesma fronteira de `integration.import_action_receipt` (0013).
ALTER TABLE "integration"."import_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."import_batch";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."import_batch"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ------------------------------------------------------------ recibo do lote
-- Idempotência da CONFIRMAÇÃO. O resultado é sanitizado (contagens, linhas e
-- ids) e nunca o conteúdo do arquivo.
CREATE TABLE IF NOT EXISTS "integration"."import_batch_receipt" (
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"key" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batch_receipt_pk" PRIMARY KEY("organization_id","key"),
	CONSTRAINT "import_batch_receipt_hash_check" CHECK ("integration"."import_batch_receipt"."hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "integration"."import_batch_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."import_batch_receipt";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."import_batch_receipt"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS "import_batch_receipt_batch_idx" ON "integration"."import_batch_receipt" ("organization_id","batch_id");

-- ------------------------------------------- marcação de origem da APOSTA
-- Duas colunas em `finance.bet`, e nenhuma delas reescreve dado existente:
-- aposta feita à mão não ganha nada; a aposta já registrada continua sem lote
-- e sem origem.
--
-- `import_batch_id` é ON DELETE SET NULL de propósito: apagar o lote não pode
-- apagar (nem desvincular) um lançamento financeiro. A aposta já revertida
-- continua no histórico, com `import_origin` gravado.
--
-- `import_origin` é a origem PERMANENTE do lançamento. É ela que responde "de
-- onde veio este registro" depois que o arquivo foi descartado, e é o que
-- impede que um lançamento importado pareça um lançamento digitado à mão.
ALTER TABLE "finance"."bet" ADD COLUMN IF NOT EXISTS "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD COLUMN IF NOT EXISTS "import_origin" text;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_import_origin_check' AND conrelid='finance.bet'::regclass) THEN
	ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_import_origin_check" CHECK ("finance"."bet"."import_origin" is null or "finance"."bet"."import_origin" in ('stakeframe_template','csv_generic'));
END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_import_batch_id_fk' AND conrelid='finance.bet'::regclass) THEN
	ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "integration"."import_batch"("id") ON DELETE set null ON UPDATE no action;
END IF; END $$;--> statement-breakpoint
-- Um lançamento tem uma origem; os dois juntos ou nenhum dos dois. A coerência
-- é do BANCO, não da aplicação: uma aposta marcada como vinda de um arquivo sem
-- lote (ou vice-versa) é um estado que não existe.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_import_origin_pair_check' AND conrelid='finance.bet'::regclass) THEN
	-- A origem e o lote NASCEM juntos, mas o lote pode ser apagado depois: o
	-- `ON DELETE SET NULL` de `import_batch_id` desvincula o lançamento, e o
	-- CHECK não pode recusar essa desvinculação — seria impedir a própria
	-- migração de rodar. O que continua recusado é o INVERSO (origem sem lote
	-- nascida) e a origem que não pertence ao vocabulário. Por isso a regra
	-- exige que, sem lote, a aposta seja JÁ revertida (`cancelled`): aposta
	-- aberta apontando para origem sem lote é um lançamento que ninguém
	-- consegue reverter.
	ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_import_origin_pair_check" CHECK (
		("finance"."bet"."import_origin" is null and "finance"."bet"."import_batch_id" is null)
		or ("finance"."bet"."import_batch_id" is not null)
		or ("finance"."bet"."state" = 'cancelled')
	);
END IF; END $$;--> statement-breakpoint
-- Índice do rollback: a reversão do lote busca as apostas por este vínculo, e
-- um índice parcial sobre as ABERTAS mantém a busca pequena mesmo com o
-- histórico cheio de apostas já revertidas.
CREATE INDEX IF NOT EXISTS "bet_import_batch_idx" ON "finance"."bet" ("organization_id","import_batch_id") WHERE "import_batch_id" is not null;
