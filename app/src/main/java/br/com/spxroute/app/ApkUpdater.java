package br.com.spxroute.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

final class ApkUpdater {
    static final String STATUS_ACTION = "io.github.dnlortega.spxandroid.APK_UPDATE_STATUS";
    static final String EXTRA_UPDATE_TOKEN = "io.github.dnlortega.spxandroid.APK_UPDATE_TOKEN";
    static final String EXTRA_UPDATE_NONCE = "io.github.dnlortega.spxandroid.APK_UPDATE_NONCE";
    private static final String PREFS = "spx_apk_updater";
    private static final String PACKAGE_NAME = "io.github.dnlortega.spxandroid";
    private static final String REPOSITORY_PATH = "/dnlortega/spx-android/releases/download/";
    private static final long MAX_APK_BYTES = 150L * 1024 * 1024;
    private static final int MAX_RELEASE_METADATA_BYTES = 64 * 1024;
    private static final int METADATA_TIMEOUT_MS = 12000;
    private static final String METADATA_NAME = "release-metadata.json";
    private static final long POLL_INTERVAL_MS = 900;
    private static final int INSTALL_REQUEST_CODE = 4101;
    private static final int STORAGE_PERMISSION_REQUEST_CODE = 4102;
    private static final int UNINSTALL_REQUEST_CODE = 4103;
    private static final int MAX_MISSING_DOWNLOAD_POLLS = 3;

    interface Listener {
        void onUpdateEvent(String stage, int percent, String message);
    }

    private final Activity activity;
    private final Listener listener;
    private final DownloadManager downloadManager;
    private final SharedPreferences preferences;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Runnable pollTask = this::pollDownload;
    private final Object stateLock = new Object();
    private final AtomicLong generation = new AtomicLong();
    private final AtomicBoolean verifying = new AtomicBoolean(false);
    private final AtomicBoolean installing = new AtomicBoolean(false);
    private final AtomicBoolean confirmingReinstall = new AtomicBoolean(false);
    private boolean destroyed;
    private boolean polling;
    private boolean permissionPromptPending;
    private boolean handlingInstallResult;
    private int missingDownloadPolls;

    ApkUpdater(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        this.downloadManager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        this.preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        generation.set(preferences.getLong("generation", preferences.getLong("lastGeneration", 0)));
    }

    void start(String url, String sha256, int versionCode, String versionName, long expectedSize) {
        start(url, sha256, versionCode, versionName, expectedSize, false);
    }

    void startReinstall(String url, String sha256, int versionCode, String versionName, long expectedSize) {
        start(url, sha256, versionCode, versionName, expectedSize, true);
    }

    private void start(String url, String sha256, int versionCode, String versionName, long expectedSize,
                       boolean reinstall) {
        if (destroyed || !isAllowedApkDownloadUrl(url)) {
            emitError("URL de atualização não confiável.");
            return;
        }
        if (!isValidSha256(sha256) || versionCode < 0 || !isValidVersionName(versionName)
                || expectedSize < 1 || expectedSize > MAX_APK_BYTES) {
            emitError("Os dados de verificação da atualização são inválidos.");
            return;
        }
        synchronized (stateLock) {
            if (verifying.get() || installing.get() || confirmingReinstall.get()) {
                emitError("Aguarde a validação ou instalação da atualização atual.");
                return;
            }
            String stage = preferences.getString("stage", "");
            String normalizedHash = sha256.toLowerCase(Locale.ROOT);
            boolean sameCandidate = !stage.isEmpty()
                    && versionCode == preferences.getInt("versionCode", -1)
                    && versionName.equals(preferences.getString("versionName", ""))
                    && normalizedHash.equals(preferences.getString("sha256", ""))
                    && url.equals(preferences.getString("url", ""))
                    && reinstall == preferences.getBoolean("reinstall", false);
            if (sameCandidate) {
                permissionPromptPending = false;
                long token = preferences.getLong("generation", 0);
                if (reinstall && stage.equals("reinstall_ready")) {
                    emitForToken(token, "reinstall_ready", 100, reinstallReadyMessage());
                } else if (stage.equals("permission_required")) {
                    ensureInstallPermission(token, true);
                } else {
                    resume();
                }
                return;
            }
            if ("installing".equals(stage)) {
                emitError("Conclua ou aguarde a instalação atual antes de escolher outra versão.");
                return;
            }
            if ("reinstall_ready".equals(stage) || "reinstall_opened".equals(stage)) {
                emitError("Conclua a reinstalação preparada antes de escolher outra versão. O APK validado continua salvo em Downloads.");
                return;
            }
            long token = nextGeneration();
            int requestCode = nextRequestCode();
            String nonce = randomNonce();
            cancelPendingDownload();
            deleteCachedApks();
            deleteSavedReinstallApk();
            confirmingReinstall.set(false);
            missingDownloadPolls = 0;
            preferences.edit().clear()
                    .putLong("lastGeneration", token)
                    .putLong("generation", token)
                    .putInt("lastRequestCode", requestCode)
                    .putInt("installRequestCode", requestCode)
                    .putString("statusNonce", nonce)
                    .putString("url", url)
                    .putString("sha256", normalizedHash)
                    .putInt("versionCode", versionCode)
                    .putString("versionName", versionName)
                    .putBoolean("reinstall", reinstall)
                    .putLong("expectedSize", expectedSize)
                    .putLong("downloadId", -1)
                    .putString("stage", "permission_required")
                    .apply();
            permissionPromptPending = false;
            ensureInstallPermission(token, true);
        }
    }

    String getInstalledSignerSha256() {
        try {
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo installed = activity.getPackageManager().getPackageInfo(PACKAGE_NAME, flags);
            if (Build.VERSION.SDK_INT >= 28) {
                SigningInfo signingInfo = installed.signingInfo;
                Signature[] signatures = signingInfo == null ? null : signingInfo.getApkContentsSigners();
                if (signatures != null && signatures.length > 0) {
                    return bytesToHex(sha256(signatures[0].toByteArray()));
                }
            } else if (installed.signatures != null && installed.signatures.length > 0) {
                return bytesToHex(sha256(installed.signatures[0].toByteArray()));
            }
        } catch (Exception ignored) {}
        return "";
    }

    boolean canInstallWithSigner(String signerSha256) {
        if (!isValidSha256(signerSha256)) return false;
        try {
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo installed = activity.getPackageManager().getPackageInfo(PACKAGE_NAME, flags);
            return signerHashes(installed).contains(signerSha256.toLowerCase(Locale.ROOT));
        } catch (Exception ignored) {
            return false;
        }
    }

    String fetchReleaseMetadata(String value) {
        if (destroyed || !isAllowedReleaseMetadataUrl(value)) return "";
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(value).openConnection();
            connection.setConnectTimeout(METADATA_TIMEOUT_MS);
            connection.setReadTimeout(METADATA_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "SPX-Route-OS");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return "";
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int total = 0;
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_RELEASE_METADATA_BYTES) return "";
                    output.write(buffer, 0, read);
                }
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            }
        } catch (Exception ignored) {
            return "";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    void onStoragePermissionResult(int requestCode, int[] results) {
        if (requestCode != STORAGE_PERMISSION_REQUEST_CODE) return;
        permissionPromptPending = false;
        long token = preferences.getLong("generation", 0);
        if (!isCurrent(token) || !preferences.getBoolean("reinstall", false)) return;
        boolean granted = false;
        for (int result : results) if (result == PackageManager.PERMISSION_GRANTED) granted = true;
        if (granted) {
            resume();
        } else {
            saveStage(token, "permission_required");
            emitForToken(token, "permission_required", 0,
                    "Autorize o armazenamento para salvar o APK da reinstalação.");
        }
    }

    void handleUninstallResult(int requestCode, int resultCode) {
        if (requestCode != UNINSTALL_REQUEST_CODE) return;
        confirmingReinstall.set(false);
        long token = preferences.getLong("generation", 0);
        if (!isCurrent(token) || !preferences.getBoolean("reinstall", false)
                || !"reinstall_opened".equals(preferences.getString("stage", ""))) return;
        if (resultCode != Activity.RESULT_OK) {
            saveStage(token, "reinstall_ready");
            String fileName = preferences.getString("reinstallFileName", "");
            String location = fileName.isEmpty() ? "Downloads" : "Downloads (" + fileName + ")";
            emitForToken(token, "reinstall_ready", 100,
                    "Desinstalação cancelada. O APK continua salvo em " + location + ".");
        }
    }

    void confirmReinstall() {
        if (!confirmingReinstall.compareAndSet(false, true)) return;
        long token = preferences.getLong("generation", 0);
        if (!isCurrent(token) || !preferences.getBoolean("reinstall", false)
                || !"reinstall_ready".equals(preferences.getString("stage", ""))) {
            confirmingReinstall.set(false);
            emitError("A nova versão ainda não está pronta para reinstalação.");
            return;
        }
        try {
            executor.execute(() -> {
                try {
                    if (!isCurrent(token)) {
                        confirmingReinstall.set(false);
                        return;
                    }
                    if (!"reinstall_ready".equals(preferences.getString("stage", ""))) {
                        confirmingReinstall.set(false);
                        return;
                    }
                    if (!verifySavedReinstallApk()) {
                        failForToken(token,
                                "O APK salvo em Downloads foi alterado ou removido. Baixe a atualização novamente.",
                                true);
                        return;
                    }
                    if (!isCurrent(token)) return;
                    saveStage(token, "reinstall_opened");
                    emitForToken(token, "reinstall_opened", 100, reinstallOpenedMessage());
                    handler.post(() -> openUninstall(token));
                } catch (Exception e) {
                    failForToken(token,
                            "Não foi possível verificar o APK salvo em Downloads. Baixe a atualização novamente.",
                            true);
                }
            });
        } catch (Exception e) {
            confirmingReinstall.set(false);
            emitError("Não foi possível iniciar a verificação do APK salvo.");
        }
    }

    private void openUninstall(long token) {
        if (!isCurrent(token) || !"reinstall_opened".equals(preferences.getString("stage", ""))) {
            confirmingReinstall.set(false);
            return;
        }
        try {
            Intent uninstall = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + PACKAGE_NAME));
            uninstall.putExtra(Intent.EXTRA_RETURN_RESULT, true);
            activity.startActivityForResult(uninstall, UNINSTALL_REQUEST_CODE);
        } catch (Exception e) {
            confirmingReinstall.set(false);
            saveStage(token, "reinstall_ready");
            emitForToken(token, "reinstall_ready", 100, reinstallReadyMessage());
        }
    }

    private String reinstallReadyMessage() {
        String fileName = preferences.getString("reinstallFileName", "");
        return fileName.isEmpty()
                ? "APK validado e salvo em Downloads. Confirme para desinstalar a versão atual."
                : "APK validado e salvo em Downloads como " + fileName
                        + ". Confirme para desinstalar a versão atual.";
    }

    private String reinstallOpenedMessage() {
        String fileName = preferences.getString("reinstallFileName", "");
        String instruction = fileName.isEmpty()
                ? "toque no APK baixado"
                : "abra Downloads e toque em " + fileName;
        return "Confirme a desinstalação no Android. Depois " + instruction + " para instalar.";
    }

    void resume() {
        if (destroyed) return;
        permissionPromptPending = false;
        long token = preferences.getLong("generation", 0);
        if (token <= 0) return;
        String stage = preferences.getString("stage", "");
        if (stage.equals("permission_required")) {
            ensureInstallPermission(token, false);
        } else if (stage.equals("downloading")) {
            beginPoll();
        } else if (stage.equals("validating")) {
            startVerification(preferences.getLong("downloadId", -1), token);
        } else if (stage.equals("reinstall_ready")) {
            emitForToken(token, "reinstall_ready", 100, reinstallReadyMessage());
        } else if (stage.equals("reinstall_opened")) {
            if (installedVersionCode() > 0) {
                confirmingReinstall.set(false);
                saveStage(token, "reinstall_ready");
                emitForToken(token, "reinstall_ready", 100, reinstallReadyMessage());
            } else {
                emitForToken(token, "reinstall_opened", 100, reinstallOpenedMessage());
            }
        } else if (stage.equals("installing")) {
            int expectedCode = preferences.getInt("verifiedVersionCode", preferences.getInt("versionCode", -1));
            if (expectedCode > 0 && installedVersionCode() >= expectedCode) {
                completeInstallation(token);
                return;
            }
            if (installing.get()) return;
            scheduleInstallRecovery(token);
        }
    }

    private void startVerification(long downloadId, long token) {
        synchronized (stateLock) {
            if (destroyed || downloadId < 0 || !isCurrent(token) || installing.get()
                    || !"validating".equals(preferences.getString("stage", ""))
                    || !verifying.compareAndSet(false, true)) return;
        }
        deleteCachedApks();
        String expectedHash = preferences.getString("sha256", "");
        long expectedSize = preferences.getLong("expectedSize", 0);
        int expectedCode = preferences.getInt("versionCode", 0);
        String expectedVersion = preferences.getString("versionName", "");
        boolean reinstall = preferences.getBoolean("reinstall", false);
        try {
            executor.execute(() -> {
                try {
                    verifyDownload(downloadId, token, expectedHash, expectedSize, expectedCode, expectedVersion, reinstall);
                } finally {
                    verifying.set(false);
                }
            });
        } catch (Exception e) {
            verifying.set(false);
        }
    }

    void onDownloadNotification(long downloadId) {
        long token = preferences.getLong("generation", 0);
        if (downloadId >= 0 && downloadId == preferences.getLong("downloadId", -1)
                && "downloading".equals(preferences.getString("stage", "")) && isCurrent(token)) {
            beginPoll();
        }
    }

    void handleInstallResult(Intent intent) {
        if (intent == null || !STATUS_ACTION.equals(intent.getAction())) return;
        long token = intent.getLongExtra(EXTRA_UPDATE_TOKEN, -1);
        int callbackSessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        String receivedNonce = intent.getStringExtra(EXTRA_UPDATE_NONCE);
        synchronized (stateLock) {
            if (!isCurrent(token) || handlingInstallResult
                    || !"installing".equals(preferences.getString("stage", ""))) return;
            if (callbackSessionId <= 0 || callbackSessionId != preferences.getLong("sessionId", -1)) return;
            String expectedNonce = preferences.getString("statusNonce", "");
            if (!secureEquals(expectedNonce, receivedNonce)) return;
            handlingInstallResult = true;
        }
        try {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            String packageName = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME);
            String detail = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirmation == null) {
                    failForToken(token, "O Android não apresentou a confirmação de instalação.", false);
                    return;
                }
                saveStage(token, "installing");
                emitForToken(token, "installing", 95, "Confirme a instalação no Android.");
                try {
                    activity.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) {
                    failForToken(token, "Não foi possível abrir a confirmação de instalação.", false);
                }
                return;
            }
            if (packageName != null && !PACKAGE_NAME.equals(packageName)) {
                failForToken(token, "O pacote instalado não corresponde ao SPX Route OS.", false);
                return;
            }
            if (status == PackageInstaller.STATUS_SUCCESS) {
                int expectedCode = preferences.getInt("verifiedVersionCode", preferences.getInt("versionCode", -1));
                if ((packageName != null && !PACKAGE_NAME.equals(packageName))
                        || expectedCode < 1 || installedVersionCode() < expectedCode) {
                    failForToken(token, "O Android não confirmou a instalação da versão esperada.", false);
                } else {
                    completeInstallation(token);
                }
                return;
            }
            if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
                failForToken(token, detail == null || detail.isEmpty() ? "Instalação cancelada." : detail, false);
                return;
            }
            failForToken(token, detail == null || detail.isEmpty() ? "O Android não concluiu a instalação." : detail, false);
        } finally {
            synchronized (stateLock) {
                handlingInstallResult = false;
            }
        }
    }

    String consumePendingEvent() {
        String stage = preferences.getString("lastStage", "");
        String event = stage.isEmpty() ? null : stage + "|" + preferences.getInt("lastPercent", 0)
                + "|" + preferences.getString("lastMessage", "");
        preferences.edit().remove("lastStage").remove("lastPercent").remove("lastMessage").apply();
        return event;
    }

    void shutdown() {
        synchronized (stateLock) {
            destroyed = true;
            generation.incrementAndGet();
        }
        handler.removeCallbacks(pollTask);
        executor.shutdownNow();
    }

    private void ensureInstallPermission(long token, boolean allowPrompt) {
        if (!isCurrent(token)) return;
        if (preferences.getBoolean("reinstall", false)) {
            if (!ensureReinstallStoragePermission(token, allowPrompt)) return;
            enqueueDownload(token);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            saveStage(token, "permission_required");
            emitForToken(token, "permission_required", 0, "Autorize o SPX Route OS a instalar aplicativos.");
            if (allowPrompt && !permissionPromptPending) {
                permissionPromptPending = true;
                try {
                    activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + activity.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) {
                    permissionPromptPending = false;
                    emitForToken(token, "error", 0, "Abra Configurações > Aplicativos > SPX Route OS > Instalar apps desconhecidos.");
                }
            }
            return;
        }
        File cached = cachedApk();
        if (cached != null) {
            saveStage(token, "installing");
            emitForToken(token, "installing", 95, "Preparando instalação...");
            scheduleInstall(cached, token);
        } else {
            enqueueDownload(token);
        }
    }

    private boolean ensureReinstallStoragePermission(long token, boolean allowPrompt) {
        if (Build.VERSION.SDK_INT < 23 || Build.VERSION.SDK_INT > 28
                || activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED) return true;
        saveStage(token, "permission_required");
        emitForToken(token, "permission_required", 0,
                "Autorize o armazenamento para salvar o APK da reinstalação.");
        if (allowPrompt && !permissionPromptPending) {
            permissionPromptPending = true;
            try {
                activity.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        STORAGE_PERMISSION_REQUEST_CODE);
            } catch (Exception e) {
                permissionPromptPending = false;
                emitForToken(token, "error", 0,
                        "Autorize o armazenamento nas configurações do aplicativo.");
            }
        }
        return false;
    }

    private void enqueueDownload(long token) {
        if (!isCurrent(token)) return;
        if (downloadManager == null) {
            failForToken(token, "O serviço de download não está disponível.", false);
            return;
        }
        boolean reinstall = preferences.getBoolean("reinstall", false);
        File directory = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null || (!directory.exists() && !directory.mkdirs())) {
            failForToken(token, "Não foi possível preparar o armazenamento da atualização.", false);
            return;
        }
        String versionName = preferences.getString("versionName", "0.0.0");
        String fileName = reinstall
                ? "SPX-Route-OS-v" + versionName + "-reinstall-" + System.currentTimeMillis() + ".apk"
                : "SPX-update-" + versionName + "-" + System.currentTimeMillis() + ".apk";
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(preferences.getString("url", "")))
                    .setTitle("SPX Route OS - Atualização")
                    .setDescription(reinstall
                            ? "Baixando APK independente para reinstalar a versão " + versionName
                            : "Baixando e verificando a versão " + versionName)
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(reinstall
                            ? DownloadManager.Request.VISIBILITY_HIDDEN
                            : DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, fileName);
            request.addRequestHeader("Accept", "application/vnd.android.package-archive");
            long id = downloadManager.enqueue(request);
            synchronized (stateLock) {
                if (!isCurrent(token)) {
                    downloadManager.remove(id);
                    return;
                }
                preferences.edit().putLong("downloadId", id).apply();
            }
            missingDownloadPolls = 0;
            saveStage(token, "downloading");
            emitForToken(token, "downloading", 1, "Baixando atualização...");
            beginPoll();
        } catch (Exception e) {
            failForToken(token, "Não foi possível iniciar o download da atualização.", true);
        }
    }

    private void beginPoll() {
        long token = preferences.getLong("generation", 0);
        if (destroyed || polling || !isCurrent(token) || !"downloading".equals(preferences.getString("stage", ""))) return;
        polling = true;
        handler.post(pollTask);
    }

    private void pollDownload() {
        polling = false;
        long token = preferences.getLong("generation", 0);
        if (destroyed || !isCurrent(token) || !"downloading".equals(preferences.getString("stage", ""))) return;
        long id = preferences.getLong("downloadId", -1);
        if (id < 0) {
            failForToken(token, "O download da atualização foi interrompido.", false);
            return;
        }
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (android.database.Cursor cursor = downloadManager.query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                missingDownloadPolls += 1;
                if (missingDownloadPolls >= MAX_MISSING_DOWNLOAD_POLLS) {
                    failForToken(token, "O download da atualização não está mais disponível.", true);
                } else {
                    handler.postDelayed(pollTask, POLL_INTERVAL_MS);
                    polling = true;
                }
                return;
            }
            missingDownloadPolls = 0;
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                saveStage(token, "validating");
                emitForToken(token, "validating", 88, "Verificando integridade e assinatura do APK...");
                startVerification(id, token);
                return;
            }
            if (status == DownloadManager.STATUS_FAILED) {
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                failForToken(token, "Falha no download: " + downloadFailureReason(reason), true);
                return;
            }
            long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            long expected = preferences.getLong("expectedSize", 0);
            if (total <= 0) total = expected;
            int percent = total > 0 ? (int) Math.max(1, Math.min(87, downloaded * 100 / total)) : 1;
            emitForToken(token, "downloading", percent, total > 0
                    ? String.format(Locale.getDefault(), "Baixando atualização: %.1f de %.1f MB", downloaded / 1048576.0, total / 1048576.0)
                    : "Baixando atualização...");
        } catch (Exception e) {
            failForToken(token, "Não foi possível acompanhar o download da atualização.", true);
            return;
        }
        handler.postDelayed(pollTask, POLL_INTERVAL_MS);
        polling = true;
    }

    private void verifyDownload(long id, long token, String expectedHash, long expectedSize,
                                int expectedCode, String expectedVersion, boolean reinstall) {
        if (!isCurrent(token)) return;
        Uri uri = downloadManager == null ? null : downloadManager.getUriForDownloadedFile(id);
        if (uri == null) {
            failForToken(token, "O APK baixado não está acessível.", true);
            return;
        }
        File apk = null;
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            failForToken(token, "A verificação SHA-256 não está disponível neste Android.", true);
            return;
        }
        long copied = 0;
        try {
            apk = File.createTempFile("spx-update-", ".apk", activity.getCacheDir());
            try (InputStream input = activity.getContentResolver().openInputStream(uri);
                 OutputStream output = new FileOutputStream(apk)) {
                if (input == null) throw new IOException("Arquivo indisponível");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (!isCurrent(token) || Thread.currentThread().isInterrupted()) {
                        apk.delete();
                        return;
                    }
                    copied += read;
                    if (copied > MAX_APK_BYTES) throw new IOException("APK excede o limite");
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                }
            }
        } catch (Exception e) {
            if (apk != null) apk.delete();
            failForToken(token, "Não foi possível ler o APK baixado. Tente novamente.", true);
            return;
        }
        if (!isCurrent(token)) {
            apk.delete();
            return;
        }
        if (copied != expectedSize) {
            apk.delete();
            failForToken(token, "O tamanho do APK não corresponde à atualização publicada.", true);
            return;
        }
        if (!bytesToHex(digest.digest()).equals(expectedHash)) {
            apk.delete();
            failForToken(token, "O checksum do APK não confere. O arquivo pode estar incompleto ou alterado.", true);
            return;
        }
        try {
            int verifiedCode = validateApk(apk, expectedCode, expectedVersion, reinstall);
            if (reinstall) {
                ReinstallFile saved = preserveReinstallApk(apk, token, expectedHash, expectedSize);
                apk.delete();
                synchronized (stateLock) {
                    if (!isCurrent(token)) {
                        deleteSavedReinstallApk(saved);
                        return;
                    }
                    preferences.edit()
                            .remove("cachedApk")
                            .putInt("verifiedVersionCode", verifiedCode)
                            .putBoolean("sessionCommitted", false)
                            .putString("reinstallUri", saved.uri)
                            .putString("reinstallPath", saved.path)
                            .putString("reinstallFileName", saved.name)
                            .putLong("downloadId", -1)
                            .putString("stage", "reinstall_ready")
                            .apply();
                }
                if (downloadManager != null) {
                    try { downloadManager.remove(id); } catch (Exception ignored) {}
                }
                emitForToken(token, "reinstall_ready", 100, reinstallReadyMessage());
                return;
            }
            synchronized (stateLock) {
                if (!isCurrent(token)) {
                    apk.delete();
                    return;
                }
                preferences.edit()
                        .putString("cachedApk", apk.getAbsolutePath())
                        .putInt("verifiedVersionCode", verifiedCode)
                        .putBoolean("sessionCommitted", false)
                        .putString("stage", "installing")
                        .apply();
            }
            emitForToken(token, "installing", 95, "Preparando instalação...");
            scheduleInstall(apk, token);
        } catch (Exception e) {
            apk.delete();
            failForToken(token, e.getMessage() == null ? "O APK não é uma atualização válida." : e.getMessage(), true);
        }
    }

    private ReinstallFile preserveReinstallApk(File apk, long token, String expectedHash,
                                                long expectedSize) throws Exception {
        if (!isCurrent(token)) throw new IOException("Atualização cancelada");
        String versionName = preferences.getString("versionName", "0.0.0");
        String fileName = "SPX-Route-OS-v" + versionName + "-instalar-" + System.currentTimeMillis() + ".apk";
        if (Build.VERSION.SDK_INT >= 29) {
            return saveReinstallApkToMediaStore(apk, token, fileName, expectedHash, expectedSize);
        }
        return saveReinstallApkToFile(apk, token, fileName, expectedHash, expectedSize);
    }

    private ReinstallFile saveReinstallApkToMediaStore(File apk, long token, String fileName,
                                                        String expectedHash, long expectedSize) throws Exception {
        android.content.ContentResolver resolver = activity.getContentResolver();
        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/vnd.android.package-archive");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(collection, values);
        if (uri == null) throw new IOException("Downloads indisponível");
        boolean completed = false;
        try {
            try (InputStream input = new FileInputStream(apk);
                 OutputStream output = resolver.openOutputStream(uri, "w")) {
                if (output == null) throw new IOException("Não foi possível salvar em Downloads");
                copyReinstallApk(input, output, token, expectedHash, expectedSize);
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            if (resolver.update(uri, values, null, null) != 1) {
                throw new IOException("Não foi possível concluir a cópia em Downloads");
            }
            String actualName = fileName;
            try (android.database.Cursor cursor = resolver.query(uri,
                    new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null && !name.isEmpty()) actualName = name;
                }
            }
            completed = true;
            return new ReinstallFile(uri.toString(), "", actualName);
        } finally {
            if (!completed) {
                try {
                    resolver.delete(uri, null, null);
                } catch (Exception ignored) {}
            }
        }
    }

    private ReinstallFile saveReinstallApkToFile(File apk, long token, String fileName,
                                                  String expectedHash, long expectedSize) throws Exception {
        File directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!directory.exists() && !directory.mkdirs()) throw new IOException("Downloads indisponível");
        File temporary = new File(directory, fileName + ".part");
        File destination = new File(directory, fileName);
        boolean completed = false;
        try {
            try (InputStream input = new FileInputStream(apk);
                 OutputStream output = new FileOutputStream(temporary)) {
                copyReinstallApk(input, output, token, expectedHash, expectedSize);
            }
            if (!temporary.renameTo(destination)) {
                throw new IOException("Não foi possível salvar o APK em Downloads");
            }
            completed = true;
            try {
                MediaScannerConnection.scanFile(activity, new String[]{destination.getAbsolutePath()},
                        new String[]{"application/vnd.android.package-archive"}, null);
            } catch (Exception ignored) {}
            return new ReinstallFile("", destination.getAbsolutePath(), fileName);
        } finally {
            if (!completed) {
                temporary.delete();
                destination.delete();
            }
        }
    }

    private void copyReinstallApk(InputStream input, OutputStream output, long token,
                                  String expectedHash, long expectedSize) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long copied = 0;
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (!isCurrent(token) || Thread.currentThread().isInterrupted()) {
                throw new IOException("Atualização cancelada");
            }
            copied += read;
            if (copied > MAX_APK_BYTES) throw new IOException("APK excede o limite");
            digest.update(buffer, 0, read);
            output.write(buffer, 0, read);
        }
        output.flush();
        if (copied != expectedSize || !bytesToHex(digest.digest()).equals(expectedHash)) {
            throw new IOException("A cópia do APK em Downloads não confere");
        }
    }

    private boolean verifySavedReinstallApk() {
        String uriValue = preferences.getString("reinstallUri", "");
        String path = preferences.getString("reinstallPath", "");
        if (uriValue.isEmpty() && path.isEmpty()) return false;
        String expectedHash = preferences.getString("sha256", "");
        long expectedSize = preferences.getLong("expectedSize", 0);
        if (!isValidSha256(expectedHash) || expectedSize < 1 || expectedSize > MAX_APK_BYTES) return false;
        long copied = 0;
        try (InputStream input = uriValue.isEmpty()
                ? new FileInputStream(path)
                : activity.getContentResolver().openInputStream(Uri.parse(uriValue))) {
            if (input == null) return false;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                copied += read;
                if (copied > MAX_APK_BYTES) return false;
                digest.update(buffer, 0, read);
            }
            return copied == expectedSize && bytesToHex(digest.digest()).equals(expectedHash);
        } catch (Exception e) {
            return false;
        }
    }

    private void deleteSavedReinstallApk() {
        deleteReinstallUri(preferences.getString("reinstallUri", ""));
        deleteReinstallPath(preferences.getString("reinstallPath", ""));
    }

    private void deleteSavedReinstallApk(ReinstallFile saved) {
        deleteReinstallUri(saved.uri);
        deleteReinstallPath(saved.path);
    }

    private void deleteReinstallUri(String value) {
        if (value.isEmpty()) return;
        try {
            Uri uri = Uri.parse(value);
            List<String> segments = uri.getPathSegments();
            if ("content".equals(uri.getScheme()) && MediaStore.AUTHORITY.equals(uri.getAuthority())
                    && segments.contains("downloads")) {
                activity.getContentResolver().delete(uri, null, null);
            }
        } catch (Exception ignored) {}
    }

    private void deleteReinstallPath(String value) {
        if (value.isEmpty()) return;
        try {
            File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    .getCanonicalFile();
            File apk = new File(value).getCanonicalFile();
            if (downloads.equals(apk.getParentFile()) && apk.getName().startsWith("SPX-Route-OS-v")
                    && apk.getName().endsWith(".apk")) {
                apk.delete();
            }
        } catch (Exception ignored) {}
    }

    private static final class ReinstallFile {
        final String uri;
        final String path;
        final String name;

        ReinstallFile(String uri, String path, String name) {
            this.uri = uri;
            this.path = path;
            this.name = name;
        }
    }

    private int validateApk(File apk, int expectedCode, String expectedVersion,
                            boolean allowDifferentSigner) throws Exception {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageManager packageManager = activity.getPackageManager();
        PackageInfo archive = packageManager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (archive == null || !PACKAGE_NAME.equals(archive.packageName)) {
            throw new Exception("O APK baixado não pertence ao SPX Route OS.");
        }
        if (archive.versionCode <= packageManager.getPackageInfo(PACKAGE_NAME, 0).versionCode) {
            throw new Exception("O APK não possui um código de versão mais recente.");
        }
        if (expectedCode > 0 && archive.versionCode != expectedCode) {
            throw new Exception("O código de versão do APK não corresponde à Release.");
        }
        if (!expectedVersion.equals(archive.versionName)) {
            throw new Exception("A versão do APK não corresponde à Release.");
        }
        List<String> candidateSigners = signerHashes(archive);
        if (candidateSigners.isEmpty()) {
            throw new Exception("O APK não possui um certificado de assinatura válido.");
        }
        if (!allowDifferentSigner) {
            PackageInfo installed = packageManager.getPackageInfo(PACKAGE_NAME, flags);
            List<String> installedSigners = signerHashes(installed);
            if (installedSigners.isEmpty() || Collections.disjoint(candidateSigners, installedSigners)) {
                throw new Exception("A assinatura do APK é diferente da versão instalada. Para atualizar sem desinstalar, publique os builds com o mesmo keystore de lançamento.");
            }
        }
        return archive.versionCode;
    }

    private List<String> signerHashes(PackageInfo info) throws Exception {
        List<String> hashes = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 28) {
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo == null) return hashes;
            Signature[] signatures;
            if (signingInfo.hasMultipleSigners()) {
                signatures = signingInfo.getApkContentsSigners();
            } else {
                signatures = signingInfo.getSigningCertificateHistory();
                if (signatures == null || signatures.length == 0) signatures = signingInfo.getApkContentsSigners();
            }
            if (signatures != null) {
                for (Signature signature : signatures) hashes.add(bytesToHex(sha256(signature.toByteArray())));
            }
        } else if (info.signatures != null) {
            for (Signature signature : info.signatures) hashes.add(bytesToHex(sha256(signature.toByteArray())));
        }
        if (!hashes.isEmpty()) {
            String[] values = hashes.toArray(new String[0]);
            Arrays.sort(values);
            hashes = new ArrayList<>(Arrays.asList(values));
        }
        return hashes;
    }

    private void scheduleInstall(File apk, long token) {
        synchronized (stateLock) {
            if (!isCurrent(token) || !"installing".equals(preferences.getString("stage", ""))
                    || !installing.compareAndSet(false, true)) return;
        }
        try {
            executor.execute(() -> install(apk, token));
        } catch (Exception e) {
            installing.set(false);
            failForToken(token, "Não foi possível iniciar a preparação da instalação.", false);
        }
    }

    private void scheduleInstallRecovery(long token) {
        synchronized (stateLock) {
            if (!isCurrent(token) || !"installing".equals(preferences.getString("stage", ""))
                    || !installing.compareAndSet(false, true)) return;
        }
        try {
            executor.execute(() -> {
                try {
                    if (!isCurrent(token)) {
                        installing.set(false);
                        return;
                    }
                    long sessionId;
                    synchronized (stateLock) {
                        if (!isCurrent(token)) {
                            installing.set(false);
                            return;
                        }
                        sessionId = preferences.getLong("sessionId", -1);
                    }
                    if (sessionId > 0 && !recoverInstallSession(token, sessionId)) return;
                    File cached = cachedApk();
                    if (cached == null) {
                        failForToken(token, "O APK validado não está mais disponível.", true);
                        return;
                    }
                    saveStage(token, "installing");
                    emitForToken(token, "installing", 95, "Retomando preparação da instalação...");
                    install(cached, token);
                } catch (Exception e) {
                    failForToken(token, "Não foi possível retomar a instalação da atualização.", false);
                } finally {
                    installing.set(false);
                }
            });
        } catch (Exception e) {
            installing.set(false);
            failForToken(token, "Não foi possível iniciar a recuperação da instalação.", false);
        }
    }

    private boolean recoverInstallSession(long token, long sessionId) {
        synchronized (stateLock) {
            if (!isCurrent(token) || handlingInstallResult) return false;
        }
        if (sessionId <= 0 || sessionId > Integer.MAX_VALUE) {
            clearInstallSession(token);
            return true;
        }
        int recoveredSessionId = (int) sessionId;
        PackageInstaller installer;
        PackageInstaller.SessionInfo matching = null;
        boolean committed = false;
        boolean sealed = false;
        try {
            installer = activity.getPackageManager().getPackageInstaller();
            for (PackageInstaller.SessionInfo info : installer.getMySessions()) {
                if (info != null && info.getSessionId() == recoveredSessionId) {
                    matching = info;
                    break;
                }
            }
            if (matching != null) {
                committed = Build.VERSION.SDK_INT >= 29 && matching.isCommitted();
                sealed = Build.VERSION.SDK_INT >= 26 && matching.isSealed();
            }
        } catch (Exception e) {
            emitForToken(token, "installing", 95, "Aguardando a confirmação do Android.");
            return false;
        }
        if (matching == null) {
            int expectedCode = preferences.getInt("verifiedVersionCode", preferences.getInt("versionCode", -1));
            if (expectedCode > 0 && installedVersionCode() >= expectedCode) {
                completeInstallation(token);
                return false;
            }
            clearInstallSession(token);
            return true;
        }
        boolean sessionCommitted;
        synchronized (stateLock) {
            if (!isCurrent(token)) return false;
            sessionCommitted = preferences.getBoolean("sessionCommitted", false);
        }
        if (committed || sealed || sessionCommitted) return false;
        synchronized (stateLock) {
            if (!isCurrent(token) || handlingInstallResult) return false;
        }
        PackageInstaller.Session session = null;
        try {
            session = installer.openSession(recoveredSessionId);
            synchronized (stateLock) {
                if (!isCurrent(token) || handlingInstallResult) return false;
            }
            if (Build.VERSION.SDK_INT < 26 && isLegacySessionSealed(session)) return false;
            session.abandon();
            clearInstallSession(token);
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (session != null) {
                try { session.close(); } catch (Exception ignored) {}
            }
        }
    }

    private boolean isLegacySessionSealed(PackageInstaller.Session session) throws IOException {
        try {
            session.getNames();
            return false;
        } catch (SecurityException e) {
            return true;
        }
    }

    private void clearInstallSession(long token) {
        synchronized (stateLock) {
            if (isCurrent(token) && !handlingInstallResult) {
                preferences.edit().remove("sessionId")
                        .putBoolean("sessionCommitted", false)
                        .putBoolean("commitAttempted", false)
                        .apply();
            }
        }
    }

    private void install(File apk, long token) {
        synchronized (stateLock) {
            if (!isCurrent(token) || handlingInstallResult) {
                installing.set(false);
                return;
            }
        }
        if (!apk.isFile()) {
            if (apk.exists()) apk.delete();
            failForToken(token, "O APK validado não está mais disponível.", true);
            return;
        }
        final String statusNonce;
        final int requestCode;
        synchronized (stateLock) {
            if (!isCurrent(token) || handlingInstallResult) {
                installing.set(false);
                return;
            }
            statusNonce = preferences.getString("statusNonce", "");
            requestCode = preferences.getInt("installRequestCode", INSTALL_REQUEST_CODE);
        }
        PackageInstaller.Session session = null;
        int sessionId = -1;
        boolean committed = false;
        boolean commitAttempted = false;
        try {
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(PACKAGE_NAME);
            if (Build.VERSION.SDK_INT >= 23) params.setSize(apk.length());
            sessionId = installer.createSession(params);
            session = installer.openSession(sessionId);
            synchronized (stateLock) {
                if (!isCurrent(token) || handlingInstallResult) throw new IOException("Atualização substituída.");
                if (!preferences.edit().putLong("sessionId", sessionId)
                        .putBoolean("sessionCommitted", false)
                        .putBoolean("commitAttempted", false)
                        .commit()) {
                    throw new IOException("Não foi possível salvar a sessão de instalação.");
                }
            }
            try (OutputStream output = session.openWrite("base.apk", 0, apk.length());
                 InputStream input = new FileInputStream(apk)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (!isCurrent(token)) throw new IOException("Atualização substituída.");
                    output.write(buffer, 0, read);
                }
                session.fsync(output);
            }
            if (!isCurrent(token)) throw new IOException("Atualização substituída.");
            Intent statusIntent = new Intent(activity, MainActivity.class)
                    .setAction(STATUS_ACTION)
                    .putExtra(EXTRA_UPDATE_TOKEN, token)
                    .putExtra(EXTRA_UPDATE_NONCE, statusNonce);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent callback = PendingIntent.getActivity(activity, requestCode, statusIntent, flags);
            emitForToken(token, "installing", 95, "Aguardando confirmação de instalação...");
            synchronized (stateLock) {
                if (!isCurrent(token) || handlingInstallResult) throw new IOException("Atualização substituída.");
                if (!preferences.edit().putBoolean("commitAttempted", true).commit()) {
                    throw new IOException("Não foi possível preparar a confirmação da instalação.");
                }
                commitAttempted = true;
            }
            session.commit(callback.getIntentSender());
            committed = true;
            synchronized (stateLock) {
                if (isCurrent(token) && "installing".equals(preferences.getString("stage", ""))) {
                    preferences.edit().putBoolean("sessionCommitted", true).apply();
                }
            }
        } catch (Exception e) {
            boolean callbackHandling;
            synchronized (stateLock) {
                callbackHandling = handlingInstallResult;
            }
            if (callbackHandling) {
                if (session != null && !committed && !commitAttempted) {
                    try { session.abandon(); } catch (Exception ignored) {}
                }
                return;
            }
            boolean mayAbandon = canAbandonAfterCommitAttempt(sessionId, session, commitAttempted);
            if (session != null && !committed && mayAbandon) {
                try { session.abandon(); } catch (Exception ignored) {}
            }
            if (mayAbandon) {
                clearInstallSession(token);
                if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls() && isCurrent(token)) {
                    installing.set(false);
                    saveStage(token, "permission_required");
                    emitForToken(token, "permission_required", 0, "Autorize novamente a instalação de aplicativos.");
                } else {
                    failForToken(token, "Não foi possível preparar a instalação da atualização.", false);
                }
            } else {
                emitForToken(token, "installing", 95, "Aguardando a confirmação do Android.");
            }
        } finally {
            installing.set(false);
            if (session != null) {
                try { session.close(); } catch (Exception ignored) {}
            }
        }
    }

    private boolean canAbandonAfterCommitAttempt(int sessionId, PackageInstaller.Session session,
                                                  boolean commitAttempted) {
        if (!commitAttempted) return true;
        try {
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            for (PackageInstaller.SessionInfo info : installer.getMySessions()) {
                if (info == null || info.getSessionId() != sessionId) continue;
                if (Build.VERSION.SDK_INT < 26) {
                    return session != null && !isLegacySessionSealed(session);
                }
                if (Build.VERSION.SDK_INT >= 29 && info.isCommitted()) return false;
                return !info.isSealed();
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void completeInstallation(long token) {
        if (!isCurrent(token)) return;
        int expectedCode = preferences.getInt("verifiedVersionCode", preferences.getInt("versionCode", -1));
        if (expectedCode < 1 || installedVersionCode() < expectedCode) {
            failForToken(token, "O Android não confirmou a versão instalada.", false);
            return;
        }
        synchronized (stateLock) {
            if (!isCurrent(token)) return;
            installing.set(false);
            int requestCode = preferences.getInt("installRequestCode", INSTALL_REQUEST_CODE);
            deleteCachedApks();
            preferences.edit().clear()
                    .putLong("lastGeneration", token)
                    .putInt("lastRequestCode", requestCode)
                    .apply();
            generation.set(0);
        }
        emit("installed", 100, "Atualização instalada com sucesso.");
    }

    private void failForToken(long token, String message, boolean retryDownload) {
        handler.removeCallbacks(pollTask);
        polling = false;
        synchronized (stateLock) {
            if (!isCurrent(token)) return;
            installing.set(false);
            confirmingReinstall.set(false);
            if (retryDownload) {
                deleteSavedReinstallApk();
                long id = preferences.getLong("downloadId", -1);
                if (id >= 0 && downloadManager != null) {
                    try { downloadManager.remove(id); } catch (Exception ignored) {}
                }
                preferences.edit()
                        .putLong("downloadId", -1)
                        .remove("cachedApk")
                        .remove("verifiedVersionCode")
                        .remove("reinstallUri")
                        .remove("reinstallPath")
                        .remove("reinstallFileName")
                        .remove("sessionId")
                        .putBoolean("sessionCommitted", false)
                        .putBoolean("commitAttempted", false)
                        .putString("stage", "permission_required")
                        .apply();
            } else {
                int requestCode = preferences.getInt("installRequestCode", INSTALL_REQUEST_CODE);
                deleteCachedApks();
                preferences.edit().clear()
                        .putLong("lastGeneration", token)
                        .putInt("lastRequestCode", requestCode)
                        .apply();
                generation.set(0);
            }
        }
        if (retryDownload) {
            emitForToken(token, "error", 0, message);
        } else {
            emit("error", 0, message);
        }
    }

    private void cancelPendingDownload() {
        handler.removeCallbacks(pollTask);
        polling = false;
        long id = preferences.getLong("downloadId", -1);
        if (id >= 0 && downloadManager != null) {
            try { downloadManager.remove(id); } catch (Exception ignored) {}
        }
    }

    private File cachedApk() {
        String path = preferences.getString("cachedApk", "");
        if (path.isEmpty()) return null;
        File file = new File(path);
        File cache = activity.getCacheDir();
        if (!file.isFile() || file.length() < 1 || file.length() > MAX_APK_BYTES
                || !file.getParentFile().equals(cache)) return null;
        return file;
    }

    private void deleteCachedApks() {
        File[] files = activity.getCacheDir().listFiles((dir, name) -> name.equals("spx-update.apk")
                || (name.startsWith("spx-update-") && name.endsWith(".apk")));
        if (files != null) {
            for (File file : files) file.delete();
        }
    }

    private long nextGeneration() {
        long token = Math.max(System.currentTimeMillis(), preferences.getLong("lastGeneration", 0) + 1);
        preferences.edit().putLong("lastGeneration", token).apply();
        generation.set(token);
        return token;
    }

    private int nextRequestCode() {
        int previous = preferences.getInt("lastRequestCode", INSTALL_REQUEST_CODE);
        int next = previous == Integer.MAX_VALUE ? INSTALL_REQUEST_CODE + 1 : previous + 1;
        preferences.edit().putInt("lastRequestCode", next).apply();
        return next;
    }

    private String randomNonce() {
        byte[] value = new byte[32];
        new SecureRandom().nextBytes(value);
        return bytesToHex(value);
    }

    private boolean secureEquals(String expected, String received) {
        if (expected == null || expected.isEmpty() || received == null) return false;
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), received.getBytes(StandardCharsets.UTF_8));
    }

    private boolean isCurrent(long token) {
        synchronized (stateLock) {
            return !destroyed && token > 0 && generation.get() == token
                    && preferences.getLong("generation", 0) == token;
        }
    }

    private void saveStage(long token, String stage) {
        synchronized (stateLock) {
            if (isCurrent(token)) preferences.edit().putString("stage", stage).apply();
        }
    }

    private void emit(String stage, int percent, String message) {
        preferences.edit().putString("lastStage", stage).putInt("lastPercent", percent)
                .putString("lastMessage", message).apply();
        postToUi(() -> listener.onUpdateEvent(stage, percent, message));
    }

    private void emitForToken(long token, String stage, int percent, String message) {
        synchronized (stateLock) {
            if (!isCurrent(token)) return;
            preferences.edit().putString("lastStage", stage).putInt("lastPercent", percent)
                    .putString("lastMessage", message).apply();
        }
        postToUi(() -> {
            if (isCurrent(token)) listener.onUpdateEvent(stage, percent, message);
        });
    }

    private void emitError(String message) {
        emit("error", 0, message);
    }

    private void postToUi(Runnable action) {
        handler.post(() -> {
            if (!destroyed) action.run();
        });
    }

    private int installedVersionCode() {
        try {
            return activity.getPackageManager().getPackageInfo(PACKAGE_NAME, 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String downloadFailureReason(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: return "espaço insuficiente no dispositivo";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "falha de rede ou servidor";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "excesso de redirecionamentos";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE: return "resposta HTTP inesperada";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS: return "arquivo de atualização já existente";
            case DownloadManager.ERROR_FILE_ERROR: return "não foi possível gravar o arquivo";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "armazenamento indisponível";
            case DownloadManager.ERROR_CANNOT_RESUME: return "o download não pode ser retomado";
            default: return "erro desconhecido (" + reason + ")";
        }
    }

    private boolean isValidVersionName(String value) {
        return value != null && value.matches("\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?");
    }

    private boolean isValidSha256(String value) {
        return value != null && value.matches("(?i)[a-f0-9]{64}");
    }

    private boolean isAllowedReleaseMetadataUrl(String value) {
        if (value == null || value.length() > 16384) return false;
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return false;
        }
        Uri uri = Uri.parse(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost())
                || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 6 || !parts.get(0).equals("dnlortega") || !parts.get(1).equals("spx-android")
                || !parts.get(2).equals("releases") || !parts.get(3).equals("download")
                || parts.get(4).isEmpty() || !METADATA_NAME.equals(parts.get(5))) return false;
        String encodedPath = uri.getEncodedPath();
        if (encodedPath == null || !encodedPath.startsWith(REPOSITORY_PATH) || encodedPath.contains("\\")
                || encodedPath.toLowerCase(Locale.ROOT).contains("%2f")
                || encodedPath.toLowerCase(Locale.ROOT).contains("%5c")) return false;
        for (String part : parts) {
            if (part.isEmpty() || part.contains("/") || part.contains("\\") || part.indexOf('\0') >= 0) return false;
        }
        return true;
    }

    private boolean isAllowedApkDownloadUrl(String value) {
        if (value == null || value.length() > 16384) return false;
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return false;
        }
        Uri uri = Uri.parse(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost())
                || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 6 || !parts.get(0).equals("dnlortega") || !parts.get(1).equals("spx-android")
                || !parts.get(2).equals("releases") || !parts.get(3).equals("download")
                || parts.get(4).isEmpty() || !parts.get(5).toLowerCase(Locale.ROOT).endsWith(".apk")) return false;
        String encodedPath = uri.getEncodedPath();
        if (encodedPath == null || !encodedPath.startsWith(REPOSITORY_PATH) || encodedPath.contains("\\")
                || encodedPath.toLowerCase(Locale.ROOT).contains("%2f")
                || encodedPath.toLowerCase(Locale.ROOT).contains("%5c")) return false;
        for (String part : parts) {
            if (part.isEmpty() || part.contains("/") || part.contains("\\") || part.indexOf('\0') >= 0) return false;
        }
        return true;
    }

    private byte[] sha256(byte[] value) throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-256").digest(value);
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }
}
