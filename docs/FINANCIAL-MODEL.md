# Núcleo financeiro local — STK-M1-01

Implementação direta do Codex, autorizada pelo proprietário na continuidade
integral do projeto (D019). A entrega cobre a fundação privada e o núcleo de
M1/M2. Não comprova piloto, conciliação de saldos reais ou operação na VPS.

## Banca e lançamentos

A banca real é reserva + saldo disponível nas casas + principal real em aberto.
Freebets e ganhos potenciais não entram nessa soma. Os saldos iniciais exigem
conferência explícita; cadastrar uma casa cria uma conta zerada. Tipsters e
casas aceitam aliases normalizados e desativação sem apagar histórico.

Valores são strings decimais no contrato e `numeric` no PostgreSQL. Os cálculos
usam inteiros de centavos (`BigInt`), odds com até quatro casas e arredondamento
de meio centavo para cima. Nenhum cálculo financeiro usa ponto flutuante.

Cada lançamento tem partidas cuja soma deve ser zero. Contas de reserva, casa
e exposição representam ativos; a contrapartida registra aportes, retiradas,
ajustes e resultados. Transferências e registro de stakes preservam a banca.
Conciliação compara o saldo informado com o saldo contábil na data informada.
Saldo negativo gera aviso, sem criar aporte para ocultar a diferença.

O PostgreSQL impõe balanceamento ao fim da transação e proíbe alteração/exclusão
dos lançamentos, partidas, liquidações, estornos, unidades, auditorias e recibos.
Partidas somente podem ser adicionadas na transação que cria seu lançamento.
Estornos são novos lançamentos, únicos por original e com data não anterior a ele.

## Apostas e liquidações

A criação transfere a stake real da casa para exposição. Uma múltipla tem uma
única stake e várias seleções. Cadastro sem data de evento é permitido; não se
inventa horário para completar uma data. Data da aposta, do cadastro, do evento
e da liquidação são campos separados.

Vitória, derrota, anulação, meia vitória, meia derrota e cashout total encerram
o principal restante. Cashout parcial exige principal encerrado separado do
retorno recebido: encerrar R$ 40 e receber R$ 25 realiza perda de R$ 15 e deixa
R$ 60 abertos em uma aposta de R$ 100. A sugestão de retorno pode ser corrigida
conforme a casa, com justificativa. Toda liquidação requer conferência.

Créditos promocionais têm valor, validade e regra sobre devolução da stake.
São usados integralmente em uma aposta, sem diminuir caixa real. Apenas retorno
em dinheiro aumenta a banca. Anulação integral sem retorno libera o crédito;
se ele já foi reutilizado, o estorno dessa anulação é recusado para evitar uso
simultâneo. Créditos expirados não podem ser usados em aposta posterior à validade.

Correções de metadados preservam auditoria. Para corrigir stake, casa ou odds
financeiras, estorne as liquidações, cancele o registro e cadastre a correção.
Cancelamento de registro aberto reverte sua stake; o registro original permanece.

## Unidade congelada

O percentual padrão é 1%. A primeira unidade usa os saldos iniciais confirmados.
Nas viradas seguintes, o mês é determinado por `America/Sao_Paulo`; a base inclui
somente partidas efetivas **e cadastradas** antes de 00:00 do primeiro dia.
Isso inclui exposição real e exclui créditos promocionais e retornos potenciais.
Cadastros retroativos posteriores não reescrevem a unidade já congelada.

O worker verifica a virada a cada minuto; leituras do espaço e comandos também
asseguram o mês atual sob lock. Execuções concorrentes geram uma única unidade.
Alterar o percentual afeta as próximas viradas. Não se reconstrói automaticamente
um mês histórico ausente: o proprietário informa o valor e sua justificativa.
Na origem manual, `base` é equivalente matemático derivado do percentual atual,
não evidência de saldo histórico; a interface identifica o valor como informado.

Aposta retroativa sem unidade é recusada, salvo consentimento explícito para
mantê-la pendente. Uma unidade criada depois não altera silenciosamente apostas
já pendentes; a resolução explícita desses registros segue no fluxo de revisão.
Banca não positiva congela unidade zero e mantém aviso; não há divisão por zero.

## Transação, versão e recuperação

Cada comando exige sessão do proprietário, origem válida, UUID idempotente e
versão observada. A linha de configurações serializa comandos para este único
proprietário. Recibo, auditoria, partidas e estado são confirmados na mesma
transação. A repetição com mesmo ator, chave e conteúdo devolve o recibo original;
reuso com conteúdo diferente retorna conflito. A soma de exposição é conferida
contra o principal das apostas reais abertas antes de cada commit.

Formulários preservam a versão que foi exibida ao abrir. Conflito exige recarregar
e conferir os dados. A interface guarda a operação pendente na sessão da aba
antes do envio, incluindo o UUID; depois de falha de rede, fechamento da janela
ou recarga, “Verificar operação” reenvia exatamente a mesma operação. Enquanto
o resultado estiver incerto, novos comandos ficam bloqueados. A sessão expirada
remove os dados privados da tela. Sair da conta limpa o cache e dados da aba.

## Verificação e limites

`tests/unit/finance.test.ts` cobre centavos, odds, resultados, freebets, unidades
e datas. `tests/integration/finance.test.ts` usa bancos PostgreSQL descartáveis
para testar movimentos, concorrência, exposição, liquidação, cashout parcial,
estornos, créditos, unidade mensal e barreiras SQL/API. O teste da virada inclui
partidas imediatamente antes/depois da meia-noite e criação posterior retroativa.

`tests/e2e/product.test.ts` usa respostas fictícias isoladas para validar desktop
e celular, confirmação inicial, recuperação após perda de resposta, cashout
parcial e remoção dos dados na expiração da sessão. Os testes da API usam banco
real; os cenários visuais não representam movimentações financeiras reais.

Migração aditiva `0002_financial_core.sql`, precedida de `0000` e `0001`, cria
o schema financeiro. Aplicação automática é restrita ao Compose local. Produção
exige backup e autorização específica. Importação assistida, busca/calendário,
análises e exportações locais estão descritos em [IMPORTS.md](IMPORTS.md),
[EVENTS.md](EVENTS.md) e [REPORTS.md](REPORTS.md). A associação explícita de
unidade histórica ausente usa `bet.unit.resolve`; mantém o valor congelado
e a trilha de auditoria. Release `v1.0.0` continua sujeita ao piloto e a §5.5 do plano.
