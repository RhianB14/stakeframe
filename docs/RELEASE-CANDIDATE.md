# Artefato candidato

STK-M0-19 prepara os cinco targets para revisão antes da primeira implantação.
O workflow manual `Release candidate` só aceita o SHA completo da `main` atual,
com o workflow CI de push concluído e seus cinco jobs aprovados. Uma CI de PR,
job ignorado, arquitetura ausente ou outro workflow não satisfaz esse gate.

## Geração e conferência

Executar o workflow na `main`, informando seu SHA após a CI terminar. Cada
runner nativo, AMD64 ou ARM64, constrói `api`, `worker`, `migrate`,
`web-production` e `operations`, diretamente do commit Git remoto. Buildx
0.37.0, BuildKit 0.33.0 por digest e actions por SHA compõem o procedimento.
O builder tem 4 GiB de limite e paralelismo dois; não recebe segredos de build.
As permissões do workflow são somente leitura de conteúdo e Actions.

Cada arquivo `.oci.tar` contém imagem, layers e proveniência máxima SLSA v0.2.
A tag candidata dá nome ao subject da proveniência; não envia a imagem ao
registry. O verificador Python lê o tar sem extrair caminhos ou executar
conteúdo, confere cada blob por SHA-256, tamanho, plataforma, configuração de
usuário não root e labels de origem. Também confere o vínculo entre a
proveniência, o manifest executável, o commit, repositório e target.

O manifesto consolidado só é emitido depois de verificar novamente os cinco
arquivos. `candidate.json` registra SHA de origem, run da CI, arquitetura,
checksums e tamanhos dos arquivos, digests dos índices, manifests executáveis
e proveniência. `source-validation.json`, metadados do build e relatórios
individuais acompanham os arquivos. Uma execução só produz o conjunto completo
quando os dois jobs terminam com sucesso.

O GitHub retém os dois artifacts por **um dia**, com compressão adicional
desabilitada. Baixar e preservar o conjunto necessário à janela dentro desse
prazo. Um novo build pode produzir novos digests e exige nova conferência.
Esse material comprova consistência e procedência registrada pelo builder;
não constitui assinatura independente nem autorização de produção.

Referências técnicas: [exportador OCI](https://docs.docker.com/build/exporters/oci-docker/),
[proveniência](https://docs.docker.com/build/metadata/attestations/slsa-provenance/) e
[vínculos das attestations](https://docs.docker.com/build/metadata/attestations/attestation-storage/).

## Publicação posterior

Os destinos propostos são `ghcr.io/rhianb14/stakeframe-<target>`. Publicar esses
pacotes e conceder `packages: write` exige autorização específica. A geração
de candidato não faz login no registry, push de imagem, release GitHub ou tag
`v1.0.0`. Preparar a publicação dos mesmos bytes com preservação de digests;
não reconstruir as imagens no momento do deploy.

Para a VPS ARM64, selecionar os cinco índices do artifact ARM64. Cada índice
inclui a imagem dessa arquitetura e sua proveniência. A disponibilidade do
artifact AMD64 não transforma cada índice em uma imagem multiarch. A criação
de índices adicionais multiarch é outra operação, com outros digests.

Antes da autorização de publicação, registrar commit, run do candidato,
checksum do manifesto, cinco digests ARM64, destinos e retenção dos arquivos.
Após publicação, conferir os mesmos digests no registry e a leitura pelo host.
Deploy e migrações usam o registro de [FIRST-DEPLOYMENT.md](FIRST-DEPLOYMENT.md).

## Ensaio local

Em 07/09/2026, os cinco targets AMD64 foram construídos do commit
`8fe414a1f2cde4333a4f0b6b53cb839ffcd8a2f7`, integrado pela PR #47, usando
Buildx Desktop 0.36.1 e o mesmo BuildKit fixado. Todos passaram na conferência
dos arquivos e da proveniência. O primeiro ensaio sem tag gerou subject vazio;
o verificador recusou e a exportação com tag explícita foi repetida com sucesso.

Esse ensaio valida o caminho de exportação local. O candidato final deverá ser
gerado pelo workflow integrado à `main`, com origem e CI verificadas. Nenhuma
imagem deste ensaio foi publicada. Testes automatizados cobrem corrupção,
blobs ausentes, caminhos indevidos, links, entradas duplicadas, origem,
arquitetura, target, subject, usuário root e alteração após verificação.
