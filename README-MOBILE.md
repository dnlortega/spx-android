# Gerar o APK usando somente o celular Android

Este projeto inclui GitHub Actions para compilar o APK na nuvem, sem Android Studio ou computador.

## Etapas pelo navegador do celular

1. Entre em https://github.com e crie uma conta ou faça login.
2. Crie um repositório novo (New repository), por exemplo `spx-route-os`, marque como **Private** e crie.
3. Extraia o ZIP no celular usando o gerenciador de arquivos. Entre na pasta `spx-android`.
4. No repositório GitHub, use **Add file > Upload files** e envie o conteúdo da pasta `spx-android` (incluindo a pasta oculta `.github`). Se o seletor do Android não mostrar arquivos ocultos, habilite “Mostrar arquivos ocultos” no gerenciador. A estrutura na raiz do repositório deve conter `app`, `.github`, `build.gradle`, `settings.gradle` e `gradle.properties`.
5. Toque em **Commit changes**.
6. Abra a aba **Actions** do repositório. O fluxo “Gerar APK e Publicar Release” será iniciado automaticamente. Aguarde ficar verde (concluído).
7. Abra a execução concluída, role até **Artifacts** e toque em `SPX-Route-OS-APK` para baixar o ZIP do APK.
8. Extraia esse ZIP. Toque em `SPX-Route-OS.apk` e autorize o navegador/gerenciador a instalar apps desconhecidos, se o Android solicitar.

## Se não aparecer a pasta .github

O Android pode ocultar pastas iniciadas por ponto. Ative “Mostrar arquivos ocultos” no gerenciador de arquivos antes de selecionar o conteúdo. Sem `.github/workflows/build-apk.yml`, a compilação automática não será iniciada.

## Requisitos e observações

- Android 5.0 (API 21) ou superior.
- Versão atual: 1.3.3 (`versionCode` 11).
- A compilação acontece nos servidores do GitHub Actions; não exige SDK no telefone.
- O código pode ficar privado, mas a Release e seus assets precisam estar públicos para o atualizador nativo conseguir baixá-los.
- O workflow executa os testes JavaScript e gera `app-release.apk`, o APK versionado e `release-metadata.json` com tamanho e SHA-256.
- O verificador do aplicativo aceita apenas Releases do repositório `dnlortega/spx-android`, valida o arquivo e a assinatura antes da instalação. Em uma cópia publicada em outro repositório, baixe e instale o artefato manualmente.
- Para atualizar sem desinstalar, configure no repositório os secrets `SPX_KEYSTORE_BASE64`, `SPX_KEYSTORE_PASSWORD`, `SPX_KEY_ALIAS` e `SPX_KEY_PASSWORD`. Não envie o keystore junto ao código.
- Sem os secrets, o build usa a chave de depuração apenas para testes e é publicado como pré-release. O atualizador só oferece a pré-release se o certificado for igual ao da versão instalada; caso contrário, avisa antes do download. Para atualizações automáticas sem desinstalar, configure e conserve o mesmo keystore estável.
- Depois de instalar uma atualização pelo aplicativo, toque em **Reiniciar agora** para carregar a nova versão.
