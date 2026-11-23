# SPX Route OS — Aplicativo Android v1.2.0

**Desenvolvido por Daniel Ortega Pereira.**

Aplicativo Android nativo com WebView para roteirização, carga e entregas Shopee Express (SPX). A versão atual funciona primeiro no dispositivo: cadastro, otimização, navegação, transferência e POD não dependem de um servidor próprio.

## Novidades da versão 1.2.0

- Otimização rodoviária com Google Routes, OSRM e estimativa local de reserva.
- Escolha manual da primeira e da última entrega, com ambas fixas durante a reotimização.
- Prioridade `Urgente`, `Alta` e `Normal`, janelas de chegada ou conclusão, tempo de serviço e ETA por parada.
- Janelas que atravessam a meia-noite e importação de horários em texto ou células numéricas do Excel.
- Cadastro manual com autocomplete, entrada por voz, OCR de etiquetas e leitura de código de barras no Android.
- Importação XLS/XLSX/CSV com coordenadas válidas, UTF-8, fallback Windows-1252 e remoção de BOM.
- Package Finder por código, destinatário, endereço ou posição no veículo.
- Posição física do volume com zona, slot e posição unificadas.
- POD de entrega ou insucesso com recebedor, assinatura digital, fotos e observações.
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

A navegação integrada limita o plano a 25 paradas e informa quantas paradas ficaram fora. A otimização respeita a primeira e a última paradas fixas, ordena as demais por prioridade e usa algoritmos diferentes para rotas pequenas e grandes. As escolhas ficam salvas no dispositivo e podem ser limpas para voltar à ordem automática.

## Endereços, planilhas e carga

- Digite o endereço manualmente ou selecione uma sugestão do autocomplete; a coordenada selecionada prevalece sobre a geocodificação posterior.
- No Android, use voz, OCR de etiqueta ou leitor de código de barras.
- Importe arquivos `.xls`, `.xlsx` ou `.csv`. Arquivos CSV são decodificados primeiro como UTF-8 e, se inválidos, como Windows-1252.
- Horários como `22:00` e frações numéricas do Excel são normalizados para `HH:MM`.
- Use o Package Finder para localizar cada volume e editar zona, slot e posição no veículo.
- O módulo de organização existente por rua e as ferramentas de geocodificação continuam disponíveis.

## POD

O status de entrega ou insucesso só muda depois de salvar o comprovante.

- Entrega exige recebedor e assinatura.
- Insucesso exige motivo válido; recebedor e assinatura também podem ser registrados.
- Fotos são comprimidas antes de persistir no dispositivo.
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
2. O workflow `.github/workflows/build-apk.yml` compila com Java 17, Android SDK 35 e Gradle 8.7.
3. A execução salva o artefato `SPX-Route-OS-APK` por 30 dias.
4. No branch `main` ou em tags `v*`, o APK é publicado no Release `SPX-Route-OS-v1.2.0`.

O arquivo distribuído é `SPX-Route-OS.apk`. A versão atual é de depuração; distribuição pública requer assinatura de lançamento. O verificador do aplicativo aceita apenas Releases de `dnlortega/spx-android`. Para atualizar sem desinstalar, configure um keystore estável; sem ele, o Android pode exigir a desinstalação do APK anterior.

## Gerar o APK localmente

1. Abra a pasta `spx-android` no Android Studio.
2. Use JDK 17 e instale Android SDK Platform 35 e Build Tools 35.0.0.
3. Sincronize o Gradle e execute **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
4. O APK ficará em `app/build/outputs/apk/debug/app-debug.apk`.

Requisitos do aplicativo: Android 5.0 (API 21) ou superior.

## Manter o CSS

O aplicativo usa `app/src/main/assets/app.css`, gerado estaticamente para não executar o compilador Tailwind no celular. Ao alterar classes HTML ou JavaScript, regenere o arquivo:

```bash
npx --yes tailwindcss@3.4.17 -c tools/tailwind.config.js -i tools/tailwind-input.css -o app/src/main/assets/app.css --minify
```

## Validação

```bash
node --test tests/*.test.js
node --check app/src/main/assets/js/route-engine.js
node --check app/src/main/assets/js/logistics-ui.js
node --check app/src/main/assets/js/transfer.js
node --check app/src/main/assets/js/store.js
```

Os testes cobrem fallback rodoviário, prioridades, janelas, ETA, primeira e última paradas fixas, rotas grandes, Google Routes, OSRM, decodificação de polilinhas e transferência offline. A compilação Android deve ser validada no GitHub Actions ou em uma máquina com JDK e SDK configurados.
