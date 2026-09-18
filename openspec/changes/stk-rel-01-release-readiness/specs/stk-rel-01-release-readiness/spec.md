# Spec — prontidão da primeira release beta

## ADDED Requirements

### Requirement: Versão auditada e sem conflito

A versão da release DEVE (MUST) ter como fonte única o campo `version` do
`package.json` da raiz; nenhum workspace, manifest, documento ou código pode
manter uma segunda versão de release; o `releaseInfo` exposto pelo runtime
(`/api/v1/system/status`) DEVE corresponder à versão fonte quando estampada e
degradar para marcadores explícitos (`unversioned`/`unknown`) quando ausente.

#### Scenario: workspace com placeholder

- **WHEN** um `package.json` interno é privado e não publicado
- **THEN** seu valor `0.0.0` é aceito como placeholder e não como versão de release

#### Scenario: artefato sem estampilha

- **WHEN** a imagem não recebe `STAKEFRAME_VERSION`
- **THEN** o runtime reporta `unversioned` e a verificação de artefato recusa a publicação

### Requirement: Notas da release verificáveis

`docs/releases/v0.1.0-beta.1.md` DEVE (MUST) existir descrevendo a release com
fatos verificáveis do histórico da main e da documentação — resumo, entregas
(Fase 1, STK-M0, STK-G0-01, STK-G0-19), limitações conhecidas, importação
automática desligada, OCR sem ativação produtiva, migrações não aplicadas em
produção e os passos necessários para publicação e deploy futuro — sem dados
privados, segredos ou conteúdo de bilhetes, e sem declarar a release como
publicada.

#### Scenario: release ainda não publicada

- **WHEN** a tag, o GitHub Release ou a publicação de imagens ainda não ocorreram
- **THEN** as notas registram explicitamente esse estado como pendente de autorização

### Requirement: Pipeline de release auditado

O pipeline DEVE (MUST) garantir: SHA de origem imutável e verificado contra a
main atual com CI 5/5; versão lida do commit revisado; uma única data UTC para
os cinco artefatos; labels OCI com versão, commit e data; consumo por digest e
proibição de `latest`; `publish-candidate` sem parâmetros publicando somente o
registro aprovado; autorização explícita para publicação e deploy; permissões
mínimas; nenhuma exposição de segredos; recusa de build a partir de branch
arbitrária.

#### Scenario: branch arbitrária

- **WHEN** um dispatch tenta usar um SHA que não é a main atual, ou um ref que
  não é `refs/heads/main`
- **THEN** a validação de origem encerra com falha antes de qualquer acesso ao registry

#### Scenario: publicação sem aprovação

- **WHEN** os digests a publicar não correspondem ao registro aprovado
- **THEN** a verificação recusa a publicação antes do acesso ao registry

### Requirement: Cinco artefatos consistentes

Os artefatos `api`, `worker`, `migrate`, `web-production` e `operations` DEVEM
(MUST) ter target correto no `Dockerfile`, labels OCI estampados, runtime sem
dependências de desenvolvimento, healthcheck definido, compatibilidade com
`deployment.env` por digest, suporte a rollback por digest e ausência de
`latest` ou segredo embutido.

#### Scenario: matriz incompleta

- **WHEN** qualquer um dos cinco artefatos não tem target, healthcheck ou pin por digest
- **THEN** a auditoria registra a lacuna como bloqueio de release

### Requirement: Migrações e rollback auditados (somente leitura)

As migrações DEVEM (MUST) ser auditadas sem acesso à produção: lista completa,
identificação das pendentes em relação ao estado documentado, verificação
forward-only, compatibilidade código↔schema e ordem; o rollback DEVE (MUST)
operar por digest com conjunto exato dos cinco serviços, recusa de arquivo
incompleto e de pins duplicados, modo parcial somente explícito e recusa
quando a imagem/digest anterior não existe.

#### Scenario: produção intocada

- **WHEN** a auditoria consulta migrações e rollback
- **THEN** nenhuma conexão com produção é feita e nenhum estado é alterado

### Requirement: Limites da preparação

A preparação DEVE (MUST) registrar explicitamente: zero tag, zero GitHub
Release, zero publicação, zero deploy, zero migração produtiva, importação
automática desligada e zero segredos expostos; merge e qualquer operação de
release ficam pendentes de autorização vinculada ao SHA final.

#### Scenario: card final

- **WHEN** a auditoria termina
- **THEN** o card permanece em REVIEW e a PR aberta, sem merge
