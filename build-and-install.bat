@echo off
setlocal
cd /d "%~dp0"
where gradle >nul 2>nul
if errorlevel 1 (
  echo ERRO: Gradle nao encontrado. Instale o Android Studio ou Gradle 8.7+ e configure o PATH.
  pause
  exit /b 1
)
gradle assembleDebug
if errorlevel 1 (
  echo Falha ao gerar o APK. Confira o Android SDK Platform 35 e o JDK 17.
  pause
  exit /b 1
)
echo APK gerado em: app\build\outputs\apk\debug\app-debug.apk
where adb >nul 2>nul
if not errorlevel 1 (
  set /p INSTALL=Deseja instalar agora no Android conectado via USB? (S/N):
  if /I "%INSTALL%"=="S" adb install -r app\build\outputs\apk\debug\app-debug.apk
)
pause
