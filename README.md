# SPX Route OS — Aplicativo Android

Projeto Android nativo com WebView, mantendo o sistema web original dentro do aplicativo.

## O que já está preparado
- Aplicativo com nome **SPX Route OS** e abertura em tela cheia.
- Importação de arquivos XLS/XLSX/CSV pelo seletor de arquivos do Android.
- Permissão de localização para o recurso de GPS, solicitada pelo Android quando necessária.
- Exportações geradas pelo sistema encaminhadas ao seletor nativo para salvar no aparelho.
- Armazenamento local do navegador (localStorage) para manter o estado do sistema no aparelho.
- Mapa corrigido para usar OpenStreetMap no modo padrão e no modo escuro, sem a camada CARTO que retornava `API KEY REQUIRED`; satélite usa Esri.

## Requisitos para gerar o APK
- Android Studio recente (ou Gradle 8.7+ instalado).
- JDK 17.
- Android SDK Platform 35 e Build Tools correspondentes.
- Para instalar pelo computador: Depuração USB ativada e `adb` disponível.

## Gerar o APK no Android Studio
1. Extraia o ZIP.
2. Abra a pasta `spx-android` no Android Studio.
3. Aguarde a sincronização do Gradle e a instalação dos componentes do Android SDK solicitados.
4. Selecione **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
5. O APK de depuração será criado em `app/build/outputs/apk/debug/app-debug.apk`.

## Observações importantes
- Este projeto está configurado para Android 6.0 (API 23) ou superior. Não é compatível com Android 4.4.4.
- O mapa, geocodificação e cálculo de rotas dependem de internet. O mapa base padrão usa tiles públicos do OpenStreetMap; respeite a política de uso dos serviços.
- O sistema ainda carrega algumas bibliotecas por CDN (Leaflet, SheetJS, Tailwind e ícones). Portanto, a primeira abertura e essas funções dependem de conexão.
- O serviço público OSRM é usado para traçar a rota rodoviária e o Nominatim para geocodificação; não exigem chave de API, mas têm limites e disponibilidade próprios.
- A geração do APK assinado para distribuição exige configurar uma chave de assinatura própria no Android Studio.
