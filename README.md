# SPX Route OS — Aplicativo Android v1.1.0

Projeto Android nativo com WebView de alta performance para roteirização e entregas Shopee Express (SPX).

## 🚀 Novidades da Versão 1.1.0
- **Releases Automáticos no GitHub**: O GitHub Actions compila e publica automaticamente o APK nos *Releases* do repositório a cada atualização no branch `main`.
- **Verificador de Atualizações no App**: O aplicativo verifica se há versões novas no GitHub Releases, avisa o motorista com as novidades e permite atualizar automaticamente com um toque.
- **Geocodificação por Endereço e CEP**: Os pontos são traçados seguindo estritamente `Destination Address`, `Bairro`, `City` e `Zipcode/Postal code`, ignorando as colunas de Latitude e Longitude da planilha da Shopee (que frequentemente vêm imprecisas).
- **Rua Atual em Tempo Real**: Rastreamento GPS ativo com indicador do nome da rua onde você está tanto no painel quanto no mapa.
- **Exibir ou Ocultar Cards de Resumo**: Botão para recolher ou expandir os cards de métricas (Paradas, Pacotes, Distância e Progresso), economizando espaço de tela.
- **Logomarca e Ícone Oficial do App**: Identidade visual completa no cabeçalho e novo ícone de aplicativo Android (adaptive icon + mipmaps em alta definição).
- **Assistente IA Integrado**: Copiloto com suporte à API do Google Gemini para tirar dúvidas de rotas, verificar anomalias em endereços e leitura inteligente de etiquetas com a câmera do celular.

## 📱 O que já está preparado
- Aplicativo nativo com nome **SPX Route OS** e abertura em tela cheia.
- Importação de arquivos XLS/XLSX/CSV pelo seletor nativo do Android.
- Permissão de localização solicitada em tempo de execução para GPS em tempo real.
- Exportações de planilhas geradas pelo sistema encaminhadas ao seletor nativo de arquivos.
- Persistência com `localStorage` para manter o progresso mesmo após fechar o app.
- Camadas de mapa OpenStreetMap (Claro e Escuro) e Satélite (Esri).
- Cálculo rodoviário via OSRM e geocodificação inteligente com cache.

## 📦 Como Gerar o APK Automaticamente (Nuvem)
1. Faça o commit e envie as alterações para o repositório no GitHub:
   ```bash
   git push origin main
   ```
2. O GitHub Actions iniciará automaticamente o workflow **Gerar APK e Publicar Release**.
3. O APK compilado estará imediatamente disponível na aba **Releases** do repositório com o nome `SPX-Route-OS.apk`.

## 🛠️ Gerar o APK Localmente no Android Studio
1. Abra a pasta `spx-android` no Android Studio.
2. Aguarde a sincronização do Gradle e JDK 17.
3. Vá em **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
4. O APK gerado estará em `app/build/outputs/apk/debug/app-debug.apk`.
