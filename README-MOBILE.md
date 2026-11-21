# Gerar o APK usando somente o celular Android

Este projeto inclui GitHub Actions para compilar o APK na nuvem, sem Android Studio ou computador.

## Etapas pelo navegador do celular

1. Entre em https://github.com e crie uma conta ou faça login.
2. Crie um repositório novo (New repository), por exemplo `spx-route-os`, marque como **Private** e crie.
3. Extraia o ZIP no celular usando o gerenciador de arquivos. Entre na pasta `spx-android`.
4. No repositório GitHub, use **Add file > Upload files** e envie o conteúdo da pasta `spx-android` (incluindo a pasta oculta `.github`). Se o seletor do Android não mostrar arquivos ocultos, habilite “Mostrar arquivos ocultos” no gerenciador. A estrutura na raiz do repositório deve conter `app`, `.github`, `build.gradle`, `settings.gradle` e `gradle.properties`.
5. Toque em **Commit changes**.
6. Abra a aba **Actions** do repositório. O fluxo “Gerar APK SPX Route OS” será iniciado automaticamente. Aguarde ficar verde (concluído).
7. Abra a execução concluída, role até **Artifacts** e toque em `SPX-Route-OS-APK` para baixar o ZIP do APK.
8. Extraia esse ZIP. Toque em `app-debug.apk` e autorize o navegador/gerenciador a instalar apps desconhecidos, se o Android solicitar.

## Se não aparecer a pasta .github

O Android pode ocultar pastas iniciadas por ponto. Ative “Mostrar arquivos ocultos” no gerenciador de arquivos antes de selecionar o conteúdo. Sem `.github/workflows/android-apk.yml`, a compilação automática não será iniciada.

## Requisitos e observações

- Android 6.0 (API 23) ou superior; não compatível com Android 4.4.4.
- A compilação acontece nos servidores do GitHub Actions; não exige SDK no telefone.
- O repositório é recomendado como privado porque o código contém o sistema de entregas.
- O APK gerado é de depuração (`debug`), adequado para instalação e testes pessoais. Para distribuição pública, será necessária uma versão assinada de lançamento.
