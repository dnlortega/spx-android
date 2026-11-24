# SPX Route OS — Aplicativo Android v1.3.3

**Desenvolvido por Daniel Ortega Pereira.**

Aplicativo Android nativo com WebView para roteirização, carga e entregas Shopee Express (SPX). A versão atual funciona primeiro no dispositivo: cadastro, otimização, navegação, transferência e POD não dependem de um servidor próprio.

## Requisitos mínimos e instalação

| Item | Requisito |
| --- | --- |
| Android | Android 5.0 ou superior (`minSdk 21`). O APK é compilado para a API 35 e direcionado ao Android 15. |
| Versão e pacote | `1.3.3`, `versionCode` 11, pacote `br.com.spxroute.app`. |
| WebView | Android System WebView atualizado. Em celulares antigos, atualize o WebView/Chrome pela Play Store antes de abrir o aplicativo. |
| Armazenamento | Espaço livre para instalar o aplicativo, baixar o APK de atualização e guardar rota, fotos e assinaturas do POD. |
| Rede | Wi-Fi ou dados móveis para mapas, geocodificação, Google Routes/OSRM e atualizações. |
| GPS | GPS ativado e localização de alta precisão para navegação integrada, origem da rota e posição do motorista. |
| Aplicativos externos | Google Maps, Waze ou Apple Maps instalados somente se você quiser abrir a navegação nesses aplicativos. |

A compatibilidade mínima é definida pelo projeto, mas cada aparelho, ROM e versão do WebView deve ser validado antes do uso operacional. O aplicativo não exige conta Shopee nem servidor próprio para as funções locais.

### Permissões do Android

| Permissão | Para que serve |
| --- | --- |
| Internet e estado da rede | Carregar mapas, buscar endereços, consultar provedores de rota e verificar Releases. |
| Localização precisa e aproximada | Usar GPS, definir a origem, acompanhar desvios e calcular distância/ETA da navegação. |
| Notificações no Android 13 ou superior | Mostrar avisos locais de andamento, paradas e atualização. Não são notificações ao cliente. |
| Instalar aplicativos desconhecidos | Necessária no Android 8 ou superior para o atualizador abrir o instalador do APK validado. |

Conceda **Localização enquanto usa o aplicativo** e ative **Precisão** nas configurações do sistema. Para uso prolongado, verifique se a economia de bateria do fabricante não está limitando GPS e atualizações em segundo plano. Negar notificações não impede cadastro ou entregas; negar localização limita os recursos que dependem de GPS.

### Instalar o APK

1. Abra as Releases oficiais em `https://github.com/dnlortega/spx-android/releases`.
2. Baixe o APK versionado, por exemplo `SPX-Route-OS-v1.3.3.apk`. O arquivo `SPX-Route-OS.apk` é uma cópia do mesmo build.
3. Toque no arquivo baixado. Se o Android bloquear, autorize o navegador ou gerenciador de arquivos em **Configurações > Aplicativos > Acesso especial > Instalar apps desconhecidos**.
4. Instale e abra o SPX Route OS. Conceda localização e notificações quando solicitado.
5. Cadastre o ponto de partida manualmente ou use **Meu GPS**. A Central da Shopee não é mais uma origem automática.

Use somente APKs assinados pela mesma chave de lançamento. Instalar um APK com assinatura diferente pode exigir desinstalação e apagar os dados locais. Faça exportações antes de trocar de certificado ou limpar os dados.

### Atualizar pelo aplicativo

- O aplicativo consulta as Releases recentes de `dnlortega/spx-android`, inclusive pré-releases, e oferece a versão mais nova compatível com o certificado instalado.
- A versão e o `versionCode` exibidos vêm diretamente do Android; não dependem de um número fixo na interface.
- Os metadados incluem o SHA-256 do APK e do certificado de assinatura. Uma assinatura diferente é bloqueada antes do download.
- O download mostra progresso, pode ser retomado e valida tamanho, SHA-256, pacote, versão e assinatura antes da instalação.
- Use Wi-Fi e mantenha espaço livre. Depois de validado, confirme a instalação na tela do Android.
- Após instalar, toque em **Reiniciar agora**. O aplicativo reabre e carrega os arquivos da nova versão.
- Builds sem keystore estável continuam sendo **pré-release**. Só são oferecidos se o certificado for igual ao da versão instalada.
- Se aparecer **assinatura diferente**, não force a atualização. Publique a próxima versão com o keystore estável correto ou reinstale manualmente após exportar os dados.

### Rede, GPS e provedores de rota

- Sem internet, cadastro, dados já salvos, Package Finder, POD e transferência por arquivo ou link já recebido continuam locais.
- Mapas, autocomplete, geocodificação e navegação integrada precisam de conexão.
- O Google Routes é opcional. Sem chave válida, o aplicativo usa OSRM ou estimativa local e informa quando não há trânsito em tempo real.
- A estimativa local não substitui condições reais da via. Mantenha o GPS ativado e revise a rota antes de dirigir.

### Problemas comuns

| Sintoma | O que verificar |
| --- | --- |
| Mapa em branco ou endereço não encontrado | Conexão com a internet e localização do navegador/WebView. |
| GPS impreciso ou navegação sem posição | GPS ativado, permissão de localização, precisão e economia de bateria. |
| Atualização não inicia | Conexão, espaço livre, permissão para instalar apps desconhecidos e se existe Release mais nova com o mesmo certificado. |
| Instalou, mas a interface continuou antiga | Toque em **Reiniciar agora** no modal; o processo aberto ainda estava com os arquivos antigos. |
| Erro de assinatura do APK | O build não usa o mesmo keystore da versão instalada; reinstale manualmente somente após exportar os dados. |
| Interface antiga ou travando no Android 5/6 | Atualize o Android System WebView e teste novamente no aparelho. |

## Novidades da versão 1.3.3

- Atualizador consulta as Releases recentes e seleciona a versão mais nova compatível, inclusive pré-releases assinadas pela mesma chave.
- Bloqueio antes do download quando o certificado de assinatura é diferente ou não foi informado nos metadados.
- Versão exibida no cabeçalho e no modal é lida do pacote instalado no Android.
- Botão **Reiniciar agora** após a instalação para carregar imediatamente os novos arquivos.
- Metadados da Release passam a publicar o SHA-256 do certificado de assinatura.

## Novidades da versão 1.3.2

- Marcar uma entrega como concluída atualiza o status imediatamente, sem abrir a tela de POD.
- O POD continua opcional e acessível pelo localizador de pacotes quando o motorista quiser registrar o comprovante.
- Remoção do banner “Entrega, carga e comprovante em um só fluxo” da tela de operações.
- Os atalhos de primeira entrega nos cartões e no mapa desaparecem após a definição; é possível limpar a escolha para selecionar outra.

## Novidades da versão 1.3.1

- Um único botão **Ocultar/Exibir** no cabeçalho controla o resumo, os cards, os filtros, os controles do mapa, as ações extras e os detalhes abertos das paradas.
- A preferência de visibilidade fica salva no dispositivo. Sem preferência salva, o celular inicia compacto e o desktop inicia com os painéis visíveis.
- Reordenamento imediato do roteiro pelas paradas mais próximas ao definir a primeira entrega.
- POD opcional, sem exigir assinatura, foto ou recebedor para concluir a entrega.

O atalho `F` alterna o botão único; `/` reabre os painéis e foca a busca.

## Novidades da versão 1.3.0

- Atualização do APK com seleção da versão correta, progresso, tentativas, permissão de instalação e retomada após interrupções.
- Validação nativa de tamanho, SHA-256, pacote, `versionCode`, `versionName` e assinatura antes de usar o instalador do Android.
- Metadados `release-metadata.json` publicados junto ao APK; o aplicativo não baixa APKs de outros caminhos ou repositórios.
- Otimização por proximidade a partir da primeira entrega, mantendo a última entrega fixa e as prioridades `Urgente`, `Alta` e `Normal`.
- Remoção da Central da Shopee como origem fixa, inclusive de rotas já salvas; o ponto de partida pode ser GPS, local manual ou primeira parada.
- Barra de ações da rota com texto visível e layout responsivo para celular.
## Novidades da versão 1.2.0

- Otimização rodoviária com Google Routes, OSRM e estimativa local de reserva.
- Escolha manual da primeira e da última entrega, com ambas fixas durante a reotimização.
- Prioridade `Urgente`, `Alta` e `Normal`, janelas de chegada ou conclusão, tempo de serviço e ETA por parada.
- Janelas que atravessam a meia-noite e importação de horários em texto ou células numéricas do Excel.
- Cadastro manual com autocomplete, entrada por voz, OCR de etiquetas e leitura de código de barras no Android.
- Importação XLS/XLSX/CSV com coordenadas válidas, UTF-8, fallback Windows-1252 e remoção de BOM.
- Package Finder por código, destinatário, endereço ou posição no veículo.
- Posição física do volume com zona, slot e posição unificadas.
- POD opcional de entrega ou insucesso com recebedor, assinatura digital, fotos e observações.
- Navegação integrada com GPS, manobras, ETA e recálculo após desvio, além de abertura no Google Maps, Waze ou Apple Maps.
- Transferência offline de paradas por link, QR Code ou arquivo, com validação e deduplicação por SPX TN.
- Exportação assíncrona de planilhas, preservação de transferências pendentes e ajustes para Android 15.
- WebView isolado na página local, sem carregamento de scripts remotos no Android e sem tráfego HTTP liberado.
- Atualização do APK somente pelo caminho de Releases do repositório confiável.
- Interface mais enxuta, CSS estático e carregamento da biblioteca Excel somente ao importar ou exportar.

## Recursos locais

- Persistência da rota e do progresso em `localStorage`.
- Assinaturas e fotos do POD em IndexedDB, sem envio para servidor.
- Mapas OpenStreetMap, alternância de tema e camada satélite Esri.
- Geocodificação com cache e uso de coordenadas importadas quando válidas.
- Notificações locais no dispositivo; não são notificações ao cliente.
- Identidade local de motorista e equipe usada para organizar e transferir dados.

Ao limpar os dados do aplicativo, desinstalar ou usar um APK com assinatura diferente, os dados locais e as evidências do POD podem ser perdidos. Faça exportações e sincronização autorizada quando a infraestrutura de equipes estiver disponível.

## Otimização e provedores de rota

Abra **Central logística > Configurações** para informar a chave do Google Routes e escolher o provedor.

1. No console do Google Cloud, ative **Routes API** e configure o faturamento do projeto.
2. Crie uma chave com acesso somente à Routes API.
3. Para o APK, restrinja a chave ao aplicativo Android usando o pacote `br.com.spxroute.app` e a impressão digital do certificado de assinatura.
4. Para testes no navegador, use uma chave separada e restrinja os referenciadores HTTP necessários.
5. Informe a chave no aplicativo. No Android, ela fica nas preferências privadas; no navegador, fica no `localStorage` da origem.

O Google Routes usa `computeRouteMatrix` e `computeRoutes`, com preferência `TRAFFIC_AWARE`, horário de partida, português do Brasil e unidades métricas. A disponibilidade de trânsito depende da região, do horário e da resposta da API. Consulte as referências oficiais:

- https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix
- https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes
- https://developers.google.com/maps/documentation/routes/usage-and-billing
- https://developers.google.com/maps/documentation/routes/config_trade_offs

Comportamento de reserva:

- Sem chave válida, o aplicativo não inventa trânsito em tempo real.
- O OSRM é usado como provedor secundário e não oferece previsão de trânsito.
- Rotas com mais de 25 pontos usam OSRM para evitar exceder o limite conservador da matriz Google.
- Se os provedores de rede falharem, a estimativa local usa Haversine, fator rodoviário `1,28` e velocidade média de `28 km/h`.
- O cartão da rota identifica quando o resultado não tem trânsito.

A navegação integrada limita o plano a 25 paradas e informa quantas paradas ficaram fora. O botão **Otimizar** usa a estratégia de vizinho mais próximo: parte da primeira parada fixa, escolhe as próximas por proximidade dentro de cada prioridade e mantém a última parada fixa no final. Ao definir a primeira entrega, o roteiro é reordenado imediatamente pela proximidade e depois refinado com o provedor disponível. As escolhas ficam salvas no dispositivo e podem ser limpas para voltar à ordem automática.

A Central da Shopee não é mais um endereço padrão. A origem usa o GPS ou o ponto de partida definido; na ausência deles, usa a primeira parada válida. Referências antigas à Central são removidas ao restaurar os dados salvos.

## Endereços, planilhas e carga

- Digite o endereço manualmente ou selecione uma sugestão do autocomplete; a coordenada selecionada prevalece sobre a geocodificação posterior.
- No Android, use voz, OCR de etiqueta ou leitor de código de barras.
- Importe arquivos `.xls`, `.xlsx` ou `.csv`. Arquivos CSV são decodificados primeiro como UTF-8 e, se inválidos, como Windows-1252.
- Horários como `22:00` e frações numéricas do Excel são normalizados para `HH:MM`.
- Use o Package Finder para localizar cada volume e editar zona, slot e posição no veículo.
- O módulo de organização existente por rua e as ferramentas de geocodificação continuam disponíveis.

## POD

O comprovante de entrega (POD) é opcional. A entrega pode ser concluída sem recebedor, assinatura, foto ou observação. Para registrar um comprovante, abra **Operações de entrega > Localizador de pacotes > POD**; o status só é alterado ao salvar.

- Insucesso exige apenas um motivo válido; demais campos do POD são opcionais.
- Fotos são comprimidas antes de persistir no dispositivo.
- Sem evidências, a conclusão não depende do IndexedDB.
- Falhas de gravação desfazem evidências parciais e não concluem o pacote.
- Reabrir um pacote concluído para correção remove o POD anterior, mas preserva a posição no veículo.
- A limpeza seletiva não apaga evidências ainda referenciadas por outro pacote.

## Transferência offline

A transferência usa o formato JSON versionado e o link `spxroute://transfer?data=...`.

- Até 500 paradas e 5.000 pacotes por arquivo.
- Link com limite de 64 KiB; QR Code prático até 2.900 caracteres.
- Para volumes maiores, gere e compartilhe o arquivo de transferência.
- SPX TN, coordenadas, grupos, posição no veículo, prioridade e janelas são validados na importação; somente pacotes pendentes são aceitos.
- Duplicidades são detectadas sem diferenciar maiúsculas de minúsculas.
- O arquivo e o link contêm dados operacionais; compartilhe apenas com motoristas autorizados.

Não há sincronização remota nessa transferência. A importação altera somente a base local do destinatário.

## Navegação

- **Integrada:** GPS ao vivo, linha da rota, instruções, distância, ETA e recálculo após desvio sustentado.
- **Google Maps, Waze e Apple Maps:** abertos externamente pelo aplicativo.
- Encerrar a navegação não apaga o plano otimizado.

A navegação integrada é uma ajuda operacional e não substitui a sinalização, as condições da via ou o julgamento do motorista.

## Contrato futuro da versão Equipes

A interface informa explicitamente que Equipes ainda não está operacional. Não há rastreamento remoto, notificação ao cliente, painel remoto ou reatribuição simulados nesta versão.

O backend futuro deverá implementar login por equipe com sessão temporária e os seguintes contratos:

| Operação | Método e caminho previsto | Finalidade |
| --- | --- | --- |
| Criar sessão | `POST /v1/team-sessions` | Autentica equipe e motorista |
| Consultar painel | `GET /v1/team/snapshot` | Retorna motoristas, progresso e paradas |
| Enviar localização | `POST /v1/locations` | Recebe posição, precisão e horário |
| Reatribuir parada | `POST /v1/stops/{stopId}/reassign` | Move uma parada entre motoristas |
| Despachar notificação | `POST /v1/notifications/dispatch` | Envia aviso autorizado ao cliente |

Envelope mínimo de eventos:

```json
{
  "schemaVersion": 1,
  "teamId": "equipe-local",
  "driverId": "motorista-local",
  "stopId": "parada-exemplo",
  "sentAt": "2026-11-23T20:00:00.000Z"
}
```

Localização deve incluir `lat`, `lng`, `accuracyMeters` e `recordedAt`. Reatribuição deve incluir `fromDriverId`, `toDriverId`, `reason` e `expectedVersion`. O servidor futuro precisa autorizar cada operação por equipe, registrar auditoria, controlar concorrência, limitar retenção e minimizar dados pessoais. Credenciais e tokens não devem ser incluídos em links ou arquivos de transferência.

## Gerar o APK pelo GitHub Actions

1. Envie o projeto ao repositório GitHub.
2. O workflow `.github/workflows/build-apk.yml` executa os testes JavaScript e compila com Java 17, Android SDK 35 e Gradle 8.7.
3. A execução salva o artefato `SPX-Route-OS-APK` por 30 dias.
4. No branch `main` ou em tags `v*`, são publicados o APK genérico, o APK versionado e `release-metadata.json` no Release correspondente. Sem assinatura estável, a publicação é marcada como pré-release de teste e não é oferecida pelo atualizador.

### Assinatura estável para atualizar sem desinstalar

Configure estes secrets nas configurações do repositório GitHub, em **Settings > Secrets and variables > Actions**:

| Secret | Conteúdo |
| --- | --- |
| `SPX_KEYSTORE_BASE64` | Keystore de lançamento codificado em Base64 |
| `SPX_KEYSTORE_PASSWORD` | Senha do keystore |
| `SPX_KEY_ALIAS` | Alias da chave |
| `SPX_KEY_PASSWORD` | Senha da chave |

Não versione o keystore nem as senhas. O workflow decodifica a chave somente em `RUNNER_TEMP`, usa `assembleRelease` e não imprime os secrets. Sem os quatro secrets, o build usa a chave de depuração somente para testes e é publicado como pré-release; essa chave pode mudar entre execuções do GitHub Actions. O APK continua disponível no artefato para instalação manual, mas não deve ser usado como atualização automática.

O aplicativo aceita apenas Releases de `dnlortega/spx-android` e exige o mesmo certificado de assinatura da versão instalada. Um APK antigo de depuração assinado por outra chave não pode ser atualizado diretamente: reinstale uma vez uma versão assinada pela chave estável e conserve essa chave nos próximos lançamentos. O aplicativo compara o certificado informado nos metadados com o instalado e informa essa divergência antes do download; a validação nativa repete a checagem antes de abrir o instalador.

## Gerar o APK localmente

1. Abra a pasta `spx-android` no Android Studio.
2. Use JDK 17 e instale Android SDK Platform 35 e Build Tools 35.0.0.
3. Sincronize o Gradle e execute **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
4. O APK ficará em `app/build/outputs/apk/debug/app-debug.apk`.

Para compilar uma versão `release` assinada localmente, configure as variáveis de ambiente `SPX_KEYSTORE_FILE`, `SPX_KEYSTORE_PASSWORD`, `SPX_KEY_ALIAS` e `SPX_KEY_PASSWORD` e execute `gradle assembleRelease`. Sem as quatro variáveis, o build de release usa a chave de depuração e serve apenas para teste. O APK ficará em `app/build/outputs/apk/release/app-release.apk`.

Requisitos do aplicativo: Android 5.0 (API 21) ou superior.

## Manter o CSS

O aplicativo usa `app/src/main/assets/app.css`, gerado estaticamente para não executar o compilador Tailwind no celular. Ao alterar classes HTML ou JavaScript, regenere o arquivo:

```bash
npx --yes tailwindcss@3.4.17 -c tools/tailwind.config.js -i tools/tailwind-input.css -o app/src/main/assets/app.css --minify
```

## Validação

```bash
node --test tests/*.test.js
node --check app/src/main/assets/js/app-update.js
node --check app/src/main/assets/js/route-engine.js
node --check app/src/main/assets/js/logistics-ui.js
node --check app/src/main/assets/js/transfer.js
node --check app/src/main/assets/js/store.js
```

Os testes cobrem fallback rodoviário, prioridades, janelas, ETA, primeira e última paradas fixas, otimização por proximidade, rotas grandes, Google Routes, OSRM, decodificação de polilinhas, transferência offline e validação das Releases/APKs. A compilação Android deve ser validada no GitHub Actions ou em uma máquina com JDK e SDK configurados.
