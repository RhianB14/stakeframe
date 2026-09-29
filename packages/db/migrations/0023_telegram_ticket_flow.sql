-- STK-F2-05 — fluxo da mensagem Telegram até o bilhete: fila de UMA foto por
-- vez, preview obrigatório antes de qualquer escrita financeira, arquivamento
-- recuperável por 30 dias e duplicata decidida por identidade DETERMINÍSTICA da
-- imagem + contexto (nunca por timestamp).
--
-- O transporte continua sendo o polling do worker existente: nenhum webhook,
-- nenhum serviço novo (Plano Master §8.2).
--
-- Três fronteiras deliberadas:
--  - `placedAt` é o instante da MENSAGEM ORIGINAL (`telegram_received_at`,
--    gravado no recebimento e imutável). A data do EVENTO é outro campo
--    (`event_at`, que nasce pendente) e NUNCA é inferida da data de envio.
--  - A fila serializa por organização: enquanto um bilhete está `admitted`
--    (em voo), a próxima foto fica `queued`. Nenhuma foto é processada em
--    paralelo, e nenhuma é pulada: a ordem é `telegram_queued_at`.
--  - A identidade determinística é `SHA-256(sha256_da_imagem ‖ contexto
--    normalizado)`. O contexto é a legenda normalizada; o id da mensagem e o
--    instante NÃO participam, então a mesma foto reenviada em outra mensagem é
--    reconhecida como duplicata em vez de virar um segundo bilhete.
--
-- O preview é a fronteira financeira: a extração fica gravada, mas a aposta e
-- o lançamento só nascem por `import.confirm` (Mini App ou callback do preview),
-- com versão otimista e chave idempotente determinística.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS), no mesmo
-- padrão da 0010, da 0011 e da 0021. Esta migração é LOCAL: nada é executado
-- em produção sem o fluxo de autorização, backup e recuperação do runbook.

-- --------------------------------------------------------------- fila e identidade
-- `telegram_identity` é preenchida no recebimento e nunca muda: a linha que a
-- carrega é a identidade do bilhete, e o índice serve a busca de duplicata.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_identity" text;--> statement-breakpoint
-- Duplicata apontada por identidade (a original). NULL = bilhete original.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_duplicate_of" uuid;--> statement-breakpoint
-- Estado da fila do worker: none (web/sem fila) → queued → admitted → preview,
-- com duplicate e archived como saídas terminais do arquivamento.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_queue_state" text NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_admitted_at" timestamp with time zone;--> statement-breakpoint
-- Instante em que o preview estruturado foi publicado: a prova de que nenhuma
-- escrita financeira aconteceu antes da decisão do usuário.
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_preview_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_telegram_queue_state_check' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_telegram_queue_state_check" CHECK ("integration"."inbox"."telegram_queue_state" in ('none','queued','admitted','preview','duplicate','archived'));
END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_telegram_identity_check' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_telegram_identity_check" CHECK ("integration"."inbox"."telegram_identity" is null or "integration"."inbox"."telegram_identity" ~ '^[a-f0-9]{64}$');
END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_telegram_duplicate_of_fk' AND conrelid='integration.inbox'::regclass) THEN
	ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_telegram_duplicate_of_fk" FOREIGN KEY ("organization_id","telegram_duplicate_of") REFERENCES "integration"."inbox"("organization_id","id") ON DELETE no action ON UPDATE no action;
END IF; END $$;--> statement-breakpoint
-- A busca de duplicata é sempre por organização + identidade.
CREATE INDEX IF NOT EXISTS "inbox_telegram_identity_idx" ON "integration"."inbox" USING btree ("organization_id","telegram_identity") WHERE "integration"."inbox"."telegram_identity" is not null;--> statement-breakpoint
-- A fila é drenada por ordem de chegada; o índice parcial cobre só as linhas
-- que realmente disputam a admissão.
CREATE INDEX IF NOT EXISTS "inbox_telegram_queue_idx" ON "integration"."inbox" USING btree ("telegram_queue_state","telegram_queued_at","id") WHERE "integration"."inbox"."telegram_queue_state" in ('queued','admitted');--> statement-breakpoint

-- ------------------------------------------------------------ arquivo recuperável
-- A STK-G0-19 usava descarte com limpeza imediata das mensagens. Aqui o
-- descarte (e a duplicata) viram ARQUIVO: a linha continua endereçável por 30
-- dias e pode ser restaurada nesse período. Não existe `/undo` temporizado — a
-- recuperabilidade é uma janela de 30 dias do registro, não um prazo de
-- resposta do bot.
CREATE TABLE IF NOT EXISTS "integration"."telegram_ticket_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	-- Identidade determinística do bilhete arquivado (mesma regra do inbox).
	-- Índice de recuperação: reenviar a mesma imagem dentro da janela encontra
	-- o registro em vez de criar um bilhete novo.
	"identity" text NOT NULL,
	-- Motivo do arquivamento: descarte explícito do usuário, duplicata
	-- detecteda por identidade ou bilhete substituído por um reenvio.
	"reason" text NOT NULL,
	-- archived (recuperável) | restored (devolvido ao fluxo) | expired (fim da
	-- janela). Uma linha nunca volta de restored/expired para archived.
	"state" text NOT NULL DEFAULT 'archived',
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Janela de recuperação de 30 dias, medida do arquivamento. É a verdade do
	-- prazo: a retenção do anexo nunca pode expirar antes dela.
	"recoverable_until" timestamp with time zone NOT NULL,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_ticket_archive_identity_check" CHECK ("integration"."telegram_ticket_archive"."identity" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "telegram_ticket_archive_reason_check" CHECK ("integration"."telegram_ticket_archive"."reason" in ('discarded','duplicate','superseded')),
	CONSTRAINT "telegram_ticket_archive_state_check" CHECK ("integration"."telegram_ticket_archive"."state" in ('archived','restored','expired')),
	CONSTRAINT "telegram_ticket_archive_window_check" CHECK ("integration"."telegram_ticket_archive"."recoverable_until" > "integration"."telegram_ticket_archive"."archived_at"),
	CONSTRAINT "telegram_ticket_archive_restored_check" CHECK (("integration"."telegram_ticket_archive"."state" = 'restored') = ("integration"."telegram_ticket_archive"."restored_at" is not null)),
	CONSTRAINT "telegram_ticket_archive_organization_id_id_idx" UNIQUE("organization_id","id"),
	CONSTRAINT "telegram_ticket_archive_inbox_fk" FOREIGN KEY ("organization_id","inbox_id") REFERENCES "integration"."inbox"("organization_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Um bilhete tem no máximo um arquivo VIVO: rearquivar o mesmo registro atualiza
-- a linha existente em vez de acumular histórico paralelo.
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_ticket_archive_live_idx" ON "integration"."telegram_ticket_archive" USING btree ("organization_id","inbox_id") WHERE "integration"."telegram_ticket_archive"."state" = 'archived';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_ticket_archive_identity_idx" ON "integration"."telegram_ticket_archive" USING btree ("organization_id","identity","archived_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_ticket_archive_due_idx" ON "integration"."telegram_ticket_archive" USING btree ("state","recoverable_until") WHERE "integration"."telegram_ticket_archive"."state" = 'archived';--> statement-breakpoint

-- RLS fail-closed: sem contexto de organização a expressão não casa nenhuma
-- linha, e tanto a leitura quanto a escrita são recusadas. A mesma fronteira
-- das tabelas privadas de `finance` e `integration`.
ALTER TABLE "integration"."telegram_ticket_archive" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."telegram_ticket_archive";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."telegram_ticket_archive"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
