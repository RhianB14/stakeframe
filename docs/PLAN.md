# Stakeframe — Plano Mestre

> Documento de referência de produto e arquitetura, recebido do Codex na tarefa
> STK-M0-01. As decisões abaixo são vinculantes; mudanças passam pelo Codex.

## 1. Objetivo e decisões consolidadas

Criar do zero um sistema pessoal para registrar apostas esportivas, controlar a
banca e acompanhar resultados com clareza e confiança. O projeto anterior
(SharkTrack) é consultado apenas como referência, sem copiar histórico Git ou
importar dados financeiros.

**Codex é responsável pelo planejamento, pelas decisões técnicas, pela revisão e
pelas aprovações. Hermes Desktop executa as implementações e todas as operações
autorizadas no GitHub.** O proprietário participa das decisões de produto e
encaminha prompts e relatórios entre os dois.

**Diretriz vigente de 06/09/2026:** o proprietário atribuiu ao Codex também as
implementações e a continuidade autônoma do trabalho. A divisão com Hermes
abaixo permanece como protocolo de referência, subordinada à diretriz em
[AGENTS.md](../AGENTS.md). Autorizações por SHA/base, produção e operações
destrutivas continuam exigidas; a verificação do próprio código é identificada.

| Aspecto               | Decisão                                                  |
| --------------------- | -------------------------------------------------------- |
| Nome                  | Stakeframe                                               |
| Repositório           | Público `RhianB14/stakeframe`                            |
| Licença               | MIT                                                      |
| Público               | Somente o proprietário, com acesso autenticado           |
| Visual                | Escuro, em português, adaptado para computador e celular |
| Hospedagem            | VPS Oracle Always Free                                   |
| Banco de dados        | PostgreSQL na VPS                                        |
| IA                    | API Gemini direta a partir do worker na VPS              |
| Entradas              | Telegram, upload pelo site e cadastro manual             |
| Casas                 | Bet365, Superbet, Novibet e outras cadastráveis          |
| Gestão                | Banca geral, reserva e saldos por casa                   |
| Unidade               | Definida mensalmente, normalmente 1% da banca            |
| Resultados            | Liquidação manual                                        |
| Início                | Base vazia, com saldos iniciais conferidos               |
| Orçamento operacional | Até R$100/mês, conforme limites definidos abaixo         |

Domínio preferencial: `stakeframe.com.br`, sujeito a consulta de disponibilidade
e preço antes da compra.

**Filtro das funcionalidades:** manter e melhorar cadastro, importação de
bilhetes, finanças, tipsters, calendário, relatórios e exportação. Fora da
primeira versão: comunidade, progressões, otimizadores, recomendações de
apostas, sistemas como Trixie/Yankee, exchanges e liquidação automática.

## 2. Fase zero obrigatória: setup completo antes das funcionalidades

### 2.1. Preparação do ambiente

Hermes deve, mediante prompt de autorização do Codex:

- Inspecionar os ambientes local e da VPS (arquitetura, armazenamento,
  serviços existentes).
- Preparar o novo projeto em `C:\Users\Rhian Batista\dev\NEW-TRACK`,
  preservando o projeto antigo.
- Configurar Git, GitHub CLI, Node.js, gerenciador de pacotes e Docker nas
  versões documentadas.
- Validar autenticação no GitHub e acesso à VPS.
- Separar credenciais e configurações de desenvolvimento e produção.
- Documentar instalação, comandos, dependências e recuperação do ambiente.

Senhas, tokens, sessões OAuth e dados pessoais não aparecem em prompts,
histórico do Git ou relatórios públicos.

### 2.2. Criação e configuração do GitHub

Sequência:

1. Confirmar a conta `RhianB14` e verificar se `stakeframe` está disponível.
   Se já existir, interromper a criação para inspeção, sem sobrescrever nada.
2. Criar o repositório público com descrição do projeto e licença MIT.
3. Inicializar o projeto local e conectar o remoto correto.
4. Criar o commit inicial com documentação, configuração básica e o primeiro
   fluxo de validação.
5. Publicar a branch `main`.
6. Executar a primeira validação para disponibilizar os nomes dos checks.
7. Configurar as proteções da `main`.
8. Validar o fluxo completo por uma PR de setup, revisada e autorizada pelo
   Codex.

A publicação inicial na `main` foi uma **exceção expressamente autorizada no
prompt de bootstrap** (STK-M0-01). Depois disso, alterações entram
exclusivamente por PR.

O repositório terá:

- README com objetivo, instalação, desenvolvimento e operação.
- Licença MIT, `.gitignore`, `.editorconfig` e exemplo de variáveis sem
  valores reais.
- `AGENTS.md` com responsabilidades, limites de atuação e protocolo de
  aprovação.
- Documentação de arquitetura, decisões, modelo financeiro, implantação e
  recuperação.
- Templates de issue e PR.
- Labels de tipo de trabalho, prioridade e etapa.
- Milestones correspondentes às entregas do projeto.
- Alertas de dependências e detecção de segredos.
- Wiki e Discussions desativados inicialmente.

### 2.3. Branches, proteções e integração contínua

`main` é a branch estável; branches curtas por tarefa (`feat/...`, `fix/...`,
`chore/...`). Sem branch `develop` permanente.

Proteções na `main`: PR obrigatória, checks obrigatórios com nomes únicos,
atualização em relação à base, resolução de conversas, histórico linear e
bloqueio de force push e exclusão. Proteções aplicadas também a
administradores. Somente squash merge, com exclusão da branch após integração;
auto-merge desativado.

A CI verifica, conforme os componentes forem introduzidos:

- Formatação, lint e tipos.
- Testes unitários e de integração com PostgreSQL real.
- Build.
- Testes de interface dos fluxos críticos.
- Migrações e compatibilidade dos contratos.
- Segredos e dependências vulneráveis, com análise das ocorrências relevantes.

Checks não podem aparecer como aprovados quando uma etapa obrigatória foi
omitida. CI em runners hospedados pelo GitHub, sem código de PR pública
executando com acesso privilegiado à VPS ou aos dados reais.

### 2.4. Permissões do Hermes e aprovação do Codex

Hermes está autorizado a implementar, criar branches, fazer commits, push,
abrir PRs e executar merges, respeitando a autorização de cada tarefa.

| Ação                                             | Regra de autorização                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| Criar e configurar o repositório                 | Prompt específico de setup aprovado pelo Codex           |
| Implementar, testar e corrigir                   | Dentro do escopo do prompt da tarefa                     |
| Criar branch, fazer commits e push               | Autorizados antecipadamente no prompt da tarefa          |
| Abrir e atualizar PR                             | Autorizados no mesmo prompt                              |
| Corrigir problemas apontados na revisão          | Dentro do escopo da revisão do Codex                     |
| Executar merge                                   | Aprovação posterior e específica do Codex                |
| Criar release ou implantar em produção           | Autorização explícita, que pode agrupar as duas ações    |
| Executar migração em produção                    | Autorização com validação de backup e recuperação        |
| Alterar proteções, credenciais ou permissões     | Nova autorização específica                              |
| Apagar dados, reescrever histórico, excluir repo | Decisão explícita e separada, fora da autorização normal |

A autorização antecipada evita interrupções para cada commit. **Ela não
autoriza o Hermes a aprovar o próprio trabalho nem a fazer merge apenas porque
os testes passaram.**

Com uma única identidade GitHub, não existe identidade independente de revisor
(o GitHub não permite que o autor aprove a própria PR). A revisão do Codex é
registrada no fluxo de trabalho, sem configurar uma exigência impossível de
aprovação formal pela mesma conta. As proteções técnicas continuam exigindo PR
e CI.

Inicialmente:

- A aprovação do Codex ocorre na conversa e é encaminhada ao Hermes.
- Hermes registra na PR o texto recebido, identificando que foi retransmitido.
- O registro inclui número da PR, SHA revisado, resultado dos checks e
  autorização concedida.
- O registro é trilha operacional, não aprovação independente imposta pelo
  GitHub.
- Um novo commit invalida a autorização de merge. Alteração da base exige nova
  validação antes da integração.

Credenciais administrativas do setup ficam separadas das permissões rotineiras.

### 2.5. Infraestrutura e serviços

- Docker Compose para aplicação, API, worker, PostgreSQL e Caddy.
- Volumes persistentes e redes internas.
- Domínio, DNS, HTTPS e renovação de certificados.
- Login Google autorizado somente para a identidade do proprietário.
- Bot Telegram restrito ao usuário/chat do proprietário.
- Cloudflare R2 privado, com buckets separados para anexos e backups.
- Monitoramento externo de disponibilidade e alertas operacionais.
- Procedimentos de backup, restauração e atualização.

PostgreSQL permanece sem exposição pública direta. Acesso administrativo
por conexão restrita.

A IA usa diretamente a API Gemini, por decisão aprovada pelo proprietário em
06/09/2026. O principal inicial é `gemini-3.1-flash-lite`, validado no ensaio
fictício; `gemini-3.5-flash-lite` permanece candidato e `gemini-3.8-flash` é
candidato à segunda leitura. Ambos retornaram indisponibilidade no ensaio e
exigem revalidação. Modelos e cotas estão em [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md).
O worker deve funcionar independentemente do computador pessoal, com credencial
privada, limites por modelo e fila persistente. O nível gratuito foi escolhido;
não há troca automática para cobrança ou outro provedor. Em falta de cota ou
incerteza, preservar o trabalho para revisão/reprocessamento.

O setup valida autenticação, imagens e saída estruturada; a precisão em bilhetes
reais depende da amostra privada e não é comprovada por uma imagem fictícia.
OmniRoute permanece opcional: sua instalação local foi preservada em backup,
sem exigir implantação ou transferência de sessões para a VPS. Não presumir
que uma assinatura permita qualquer modelo ou modalidade de API.

**Critério de conclusão da fase zero:** repositório configurado, permissões
verificadas, PR de setup aprovada e integrada, infraestrutura acessível,
autenticação restrita, integrações básicas verificadas e restauração de backup
demonstrada. Só então começar as funcionalidades.

## 3. Produto e regras de negócio

### 3.1. Experiência e navegação

Visual com fundo grafite, superfícies discretas e azul para ações. Resultados
positivos e negativos usam cores acompanhadas de texto ou símbolos.

| Área          | Conteúdo                                             |
| ------------- | ---------------------------------------------------- |
| Visão geral   | Banca, exposição, resultados e pendências            |
| Apostas       | Lista, filtros, detalhes, cadastro e liquidação      |
| Calendário    | Eventos e apostas relacionadas                       |
| Financeiro    | Reserva, casas, aportes, retiradas e conciliação     |
| Análises      | Resultados por período, tipster, casa e esporte      |
| Configurações | Casas, tipsters, unidade, integrações e preferências |

Unidades com destaque, valores em reais sempre acessíveis. Estados de
carregamento, erro, vazio e indisponibilidade com tratamento explícito.

### 3.2. Entrada de bilhetes

Convenção da legenda:

```text
Nome do tipster
Nome da casa de aposta
```

A legenda é interpretada por regras determinísticas. A IA extrai os dados do
bilhete, preservando o conteúdo original para conferência.

Fluxo:

1. Receber imagem e legenda.
2. Identificar tipster e casa, considerando aliases cadastrados.
3. Extrair aposta, seleções, valores, odds e informações de eventos.
4. Validar campos essenciais e procurar duplicidades.
5. Registrar automaticamente quando os dados estiverem consistentes.
6. Encaminhar casos duvidosos para revisão, com os campos problemáticos
   destacados.

Regras:

- Divergência entre a casa da legenda e a casa visível no bilhete exige
  revisão antes do lançamento financeiro.
- Ausência ou incerteza de data e hora do evento não bloqueia uma aposta
  financeiramente válida.
- Reenvios e novas tentativas não podem duplicar apostas ou movimentações.
- Bilhetes parecidos não serão descartados automaticamente como duplicados.
- Layouts ainda não validados permanecem sujeitos à revisão.
- Cadastro manual continua disponível quando IA ou serviços externos falharem.

Tipster é uma classificação própria. Estratégias e tags ficam fora da primeira
versão.

### 3.3. Tipos de aposta e liquidação

Primeira versão contempla:

- Simples e múltiplas, incluindo combinações do mesmo evento.
- Odds turbinadas.
- Vitória, derrota, anulação, meia vitória e meia derrota.
- Cashout total e parcial.
- Freebets avulsas.

Resultados informados manualmente. O sistema sugere o retorno para situações
comuns, permitindo correção com registro de auditoria.

No cashout parcial, registrar separadamente o valor recebido e a parcela do
principal original encerrada. O restante continua em aberto. Não deduzir a
parcela encerrada somente pelo pagamento recebido.

### 3.4. Banca e financeiro

A banca é formada por:

- Reserva fora das casas.
- Saldo disponível em cada casa.
- Principal real comprometido em apostas abertas.

Aportes e retiradas são separados do lucro ou prejuízo das apostas.
Transferências entre reserva e casas não alteram a banca total.

Todas as movimentações financeiras têm histórico auditável. Correções produzem
estornos e lançamentos corretivos, sem apagar silenciosamente o histórico.

A conciliação compara o saldo calculado com o saldo real de cada casa e
registra ajustes identificados. Uma aposta real importada com saldo
desatualizado pode ser registrada com alerta de conciliação; o sistema não
inventa um aporte para compensá-la.

### 3.5. Unidade mensal

No primeiro dia de cada mês, à meia-noite em `America/Sao_Paulo`, calcular a
unidade com base no percentual configurado (inicialmente 1%).

Base: **reserva + saldo disponível nas casas + principal real das apostas
abertas.** Excluir ganhos potenciais e créditos promocionais.

- A unidade fica congelada durante o mês.
- Aportes durante o mês entram no cálculo do mês seguinte.
- O primeiro mês usa a banca inicial conferida.
- Apostas preservam a referência de unidade do mês em que foram feitas.
- Cadastros retroativos usam a unidade histórica correspondente; ausência
  desse valor exige revisão.

### 3.6. Freebets

Registrar casa, valor, validade, uso e retorno. O crédito promocional fica
separado do dinheiro real.

A liquidação considera a regra de devolução ou não do valor promocional, sem
tratar o crédito como aporte. Carteiras de bônus e controle de rollover ficam
fora da primeira versão.

### 3.7. Datas, horários e calendário

Separar data de realização da aposta, início do evento, liquidação e criação
do registro.

- Armazenar instantes com fuso explícito.
- Exibir no fuso de São Paulo.
- Preservar datas parciais sem inventar horário à meia-noite.
- Diferenciar horário confirmado, estimado e pendente.
- Não substituir automaticamente uma correção manual confirmada.
- Tratar adiamentos, partidas semelhantes e conflitos de fontes como casos de
  revisão.

Usar inicialmente TheSportsDB para busca estruturada e Tavily como
complemento, com cache e limites. Ausência em uma consulta limitada não é
interpretada como inexistência do evento. API-Sports pode ser avaliada
posteriormente mediante evidência de falha de cobertura.

Essas consultas servem para identificação e programação dos eventos; a
liquidação continua manual.

### 3.8. Relatórios

O desempenho é atribuído à **data do evento**. Nas múltiplas, o resultado
integral fica na data do último evento. O calendário mostra cada evento sem
multiplicar o valor financeiro do bilhete.

O financeiro segue as datas efetivas das movimentações. Um resultado
registrado posteriormente pode atualizar um relatório histórico de desempenho.

Apresentar:

- Lucro/prejuízo em reais e unidades.
- Valores apostados, retornos e exposição aberta.
- Resultados por tipster, casa e esporte.
- ROI real: resultado líquido real dividido pelo principal real encerrado
  elegível.
- Freebets separadas para não distorcer o ROI.
- Taxa de acerto com definição explícita, excluindo anulações e cashouts.
- Pendências de data e registros excluídos dos filtros por falta de
  informação.

### 3.9. Retenção e exportação

Manter anexos enquanto houver apostas abertas ou revisão pendente. Excluir
imagens 30 dias após a liquidação final; imagens compartilhadas aguardam o
encerramento de todas as apostas vinculadas.

Importações descartadas têm anexos removidos 30 dias após o descarte. O
histórico estruturado e a auditoria são preservados.

Exportação CSV para análise e JSON para portabilidade, sem incluir
credenciais.

## 4. Arquitetura, operação e segurança

### 4.1. Tecnologias

| Camada                      | Escolha                               |
| --------------------------- | ------------------------------------- |
| Organização                 | Monorepo TypeScript com modo estrito  |
| Runtime                     | Node.js 24 LTS                        |
| Interface                   | React, Vite, Tailwind CSS e shadcn/ui |
| Estado remoto               | TanStack Query                        |
| API                         | Fastify                               |
| Contratos                   | Zod e OpenAPI                         |
| Banco e acesso              | PostgreSQL 18 e Drizzle               |
| Processamento assíncrono    | pg-boss e worker separado             |
| Autenticação                | Better Auth com Google                |
| Arquivos e backups externos | Cloudflare R2                         |
| Publicação                  | Docker Compose e Caddy                |
| Testes                      | Vitest, PostgreSQL real e Playwright  |

Versões exatas e lockfile fixados durante o setup, após verificar
compatibilidade e suporte à arquitetura da VPS.

### 4.2. Dados e interfaces

Domínios: usuário/sessão, casas, tipsters, contas financeiras, lançamentos,
unidades mensais, apostas, seleções, eventos, liquidações, freebets,
importações, anexos e auditoria.

Regras técnicas:

- Valores monetários e odds com tipos decimais e aritmética decimal
  explícita.
- Valores decimais transmitidos como strings nos contratos JSON.
- API de negócio versionada em `/api/v1`.
- Listagens paginadas e filtros consistentes.
- Idempotência para operações que possam ser repetidas.
- Controle de versão para evitar sobrescritas concorrentes.
- Erros com código estável e identificador de requisição.
- Transações curtas; chamadas de IA e buscas externas fora das transações
  financeiras.
- Publicação de jobs relacionada a alterações persistidas com garantia
  transacional.
- Proteção contra efeitos financeiros duplicados independentemente da fila.

Estados de processamento de uma importação são distintos do resultado de uma
aposta.

### 4.3. Segurança e privacidade

- Login somente para a identidade Google previamente autorizada.
- Verificação de acesso no servidor em todas as operações.
- Bot Telegram restrito.
- Anexos privados, acessados por URLs temporárias.
- Validação de formato e tamanho de arquivos.
- Segredos fora do repositório e logs sem conteúdo sensível.
- Ambientes, bancos e credenciais separados.
- Dados fictícios em testes públicos.
- Sessões revogáveis e acesso administrativo restrito.

O repositório público contém código e documentação; bilhetes, saldos e
credenciais permanecem privados.

### 4.4. Disponibilidade, backup e recuperação

O aplicativo deve funcionar com o computador pessoal desligado. A operação
contínua é uma meta; a infraestrutura gratuita da Oracle não é garantia de
disponibilidade, inclusive porque instâncias ociosas podem ser recuperadas
pelo provedor.

- Jobs com tentativas limitadas, espera progressiva e opção de
  reprocessamento.
- Monitoramento de aplicação, banco, fila, disco, HTTPS, backups e consumo de
  APIs.
- Alertas deduplicados e acionáveis.
- Backups externos criptografados a cada 30 minutos.
- Alerta quando o último backup externo válido ultrapassar uma hora.
- Retenção de cópias frequentes por 48 horas e diárias por 30 dias.
- Chave de recuperação guardada fora da VPS.
- Recuperação das configurações de IA e custódia da credencial fora da VPS.
- Teste mensal de restauração e antes de migrações relevantes.

Objetivos: **RPO de até uma hora** e **RTO de até quatro horas**, considerando
servidor disponível e atuação do operador. A restauração reaplica as regras de
retenção para não reintroduzir anexos expirados.

### 4.5. Custos e publicação

R$80 de orçamento operacional e R$20 de margem, dentro do teto de R$100/mês.
Domínio anual e assinaturas existentes de Codex, Hermes e provedores ficam
separados.

- Documentar preços e limites reais no setup.
- Manter rotas pagas sem preço conhecido desativadas.
- Limitar chamadas de IA e buscas.
- Preservar cadastro manual se o limite de automação for atingido.
- Monitorar armazenamento sem apagar histórico financeiro para reduzir
  custos.

A publicação usa imagens identificadas por versão/digest, produzidas pela CI.
Deploy, migrações e rollback têm procedimentos documentados e autorização
específica do Codex.

## 5. Execução, revisão e critérios de conclusão

### 5.1. Etapas

| Marco                  | Entrega                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| M0 — Setup             | GitHub, permissões, CI, ambientes, infraestrutura, integrações e restauração |
| M1 — Fundação          | Login, navegação, visual, contratos e migrações iniciais                     |
| M2 — Núcleo financeiro | Banca, casas, unidade, apostas manuais, liquidações, freebets e cashouts     |
| M3 — Importação        | Telegram, upload, extração, revisão e prevenção de duplicidade               |
| M4 — Eventos           | Datas, fusos, buscas e calendário                                            |
| M5 — Análises          | Dashboard, relatórios, filtros e exportações                                 |
| M6 — Validação         | Piloto real, recuperação, desempenho, custos e release `v1.0.0`              |

Cada marco tem critérios de aceite e revisão do Codex antes da autorização do
próximo.

### 5.2. Formato obrigatório dos prompts para o Hermes

Cada prompt informa:

1. Identificador e objetivo da tarefa.
2. Repositório e ponto de partida.
3. Escopo autorizado e exclusões relevantes.
4. Decisões de implementação e contratos necessários.
5. Critérios de aceite e verificações.
6. Operações Git autorizadas.
7. Evidências exigidas na devolutiva.
8. Condições que exigem retorno ao Codex.

A autorização de desenvolvimento segue o modelo:

> Autorizado implementar esta tarefa, criar a branch indicada, executar
> verificações, fazer commits, push e abrir ou atualizar a PR. O merge e a
> implantação dependem de autorização posterior do Codex.

### 5.3. Revisão e autorização de merge

Hermes devolve link da PR, SHA atual, resumo das alterações, resultados
verificáveis dos testes, alterações de banco e limitações encontradas.

Codex revisa o diff e as evidências, pede correções quando necessário e só
então emite a autorização:

> **Merge autorizado:** PR #N, head SHA `<sha>`, base validada `<sha>`, por
> squash, com os checks obrigatórios aprovados. Esta autorização não inclui
> deploy ou migração em produção, salvo indicação explícita.

Antes de executar, Hermes confirma que a PR e seus commits continuam
correspondendo à autorização. Havendo alteração, conflito ou falha de check,
retorna para revisão.

Após o merge, informa o commit resultante, a situação da CI na `main` e o
encerramento da issue correspondente. Aprovação de merge não é inferida de
silêncio, elogio, ausência de comentários ou sucesso dos testes.

### 5.4. Testes essenciais

- Aportes, retiradas, transferências e conciliação sem distorção do resultado.
- Liquidações, estornos, cashouts parciais e freebets.
- Repetição e concorrência sem lançamentos duplicados.
- Cálculo da unidade na virada do mês e cadastros retroativos.
- Legenda com tipster na primeira linha e casa na segunda.
- Divergências entre legenda e imagem, aliases e ausência de campos.
- Reenvios, imagens recortadas e apostas legítimas semelhantes.
- Fusos, virada de dia, horários ausentes, adiamentos e correções manuais.
- Múltiplas sem duplicação financeira no calendário ou nos relatórios.
- Bloqueio de usuários não autorizados.
- Uso em celular e computador.
- Exclusão correta de anexos compartilhados.
- Reinício de serviços, indisponibilidade de provedores e restauração sem
  repetir efeitos.

Validar a extração com um conjunto privado e representativo de bilhetes das
três casas principais. Nenhum exemplo real é publicado no repositório.

### 5.5. Aceite da primeira versão

A `v1.0.0` somente será liberada quando:

- Os saldos estiverem conciliados durante o piloto.
- Não houver falhas conhecidas críticas de integridade ou acesso.
- Importações incertas forem encaminhadas corretamente à revisão.
- Datas desconhecidas permanecerem identificadas, sem valores inventados.
- Backups e restauração estiverem demonstrados.
- O funcionamento independente do computador estiver validado.
- Custos e alertas estiverem configurados.
- Os fluxos principais estiverem aprovados em computador e celular.
- GitHub, documentação e protocolo de autorização estiverem em uso.
- Codex autorizar expressamente a release e a implantação.

Padrões iniciais: português, BRL, odds decimais, fuso de São Paulo e operação
online. Mudanças nesses padrões passam pelo planejamento antes de serem
implementadas.
