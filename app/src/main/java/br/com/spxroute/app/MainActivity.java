package br.com.spxroute.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.speech.RecognizerIntent;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 1001;
    private static final int LOCATION_PERMISSION = 1002;
    private static final int SAVE_FILE = 1003;
    private static final int VOICE_INPUT = 1004;
    private static final int NOTIFICATION_PERMISSION = 1005;
    private static final String ROUTES_PREFS = "spx_google_routes";
    private static final String ROUTES_KEY = "api_key";
    private static final String ROUTES_MATRIX_ENDPOINT = "distanceMatrix/v2:computeRouteMatrix";
    private static final String ROUTES_DIRECTIONS_ENDPOINT = "directions/v2:computeRoutes";
    private static final String NOTIFICATION_CHANNEL_ID = "spx_local_notifications";
    private static final int MAX_BASE64_LENGTH = 4 * 1024 * 1024;
    private static final int MAX_SAVE_FILE_BYTES = 3 * 1024 * 1024;
    private static final int MAX_IMAGE_BYTES = 3 * 1024 * 1024;
    private static final int MAX_IMAGE_DIMENSION = 4096;
    private static final int MAX_IMAGE_PIXELS = 8 * 1024 * 1024;
    private static final int MAX_IMAGE_SOURCE_DIMENSION = 16384;
    private static final long MAX_IMAGE_SOURCE_PIXELS = 80_000_000L;
    private static final int MAX_ROUTES_BODY_BYTES = 512 * 1024;
    private static final int MAX_ROUTES_RESPONSE_BYTES = 1024 * 1024;
    private static final int MAX_API_KEY_LENGTH = 4096;
    private static final int MAX_FIELD_MASK_LENGTH = 8192;
    private static final int MAX_EXTERNAL_URL_LENGTH = 16 * 1024;
    private static final int MAX_DEEP_LINK_LENGTH = 64 * 1024;
    private static final int MAX_SHARE_TEXT_LENGTH = 256 * 1024;
    private static final int MAX_NOTIFICATION_TITLE_LENGTH = 200;
    private static final int MAX_NOTIFICATION_TEXT_LENGTH = 4000;
    private static final Pattern CALLBACK_PATTERN = Pattern.compile("^[A-Za-z_$][A-Za-z0-9_$]{0,127}$");
    private static final Pattern REQUEST_ID_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
    private static final String STATE_TRANSFER_LINK = "spx_pending_transfer_link";
    private static final String STATE_SAVE_PATH = "spx_pending_save_path";
    private static final String STATE_SAVE_NAME = "spx_pending_save_name";
    private static final String STATE_SAVE_MIME = "spx_pending_save_mime";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private File pendingSaveFile;
    private String pendingSaveName;
    private String pendingSaveMime;
    private final AtomicBoolean saveInProgress = new AtomicBoolean(false);
    private String voiceCallback;
    private String labelCallback;
    private String barcodeCallback;
    private String pendingTransferLink;
    private boolean pageReady;
    private BroadcastReceiver updateReceiver;
    private TextRecognizer textRecognizer;
    private BarcodeScanner barcodeScanner;
    private int notificationSequence = (int) System.currentTimeMillis();
    private final ExecutorService backgroundExecutor = Executors.newSingleThreadExecutor();
    private final Set<String> pendingRouteRequestIds = new HashSet<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        restorePendingState(state);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(android.graphics.Color.rgb(248,249,250));
        getWindow().setNavigationBarColor(android.graphics.Color.BLACK);
        webView = new WebView(this);
        setContentView(webView);
        if (Build.VERSION.SDK_INT >= 35) {
            webView.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        }
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface public void saveFile(String name, String mime, String base64) {
                if (!saveInProgress.compareAndSet(false, true)) {
                    postUi(() -> Toast.makeText(MainActivity.this, "Aguarde a exportação atual", Toast.LENGTH_SHORT).show());
                    return;
                }
                String safeName = normalizeSaveFileName(name);
                String safeMime = normalizeSaveMime(mime);
                if (base64 == null || base64.length() > MAX_BASE64_LENGTH) {
                    saveInProgress.set(false);
                    postUi(() -> Toast.makeText(MainActivity.this, "Arquivo excede o limite de exportação", Toast.LENGTH_SHORT).show());
                    return;
                }
                try {
                    backgroundExecutor.execute(() -> prepareSaveFileOnBackground(safeName, safeMime, base64));
                } catch (RejectedExecutionException e) {
                    saveInProgress.set(false);
                }
            }

            @JavascriptInterface public String getAppVersion() {
                try {
                    return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                } catch (Exception e) {
                    return "1.2.0";
                }
            }

            @JavascriptInterface public void startVoiceInput(String callbackName) {
                if (!isValidCallback(callbackName)) return;
                postUi(() -> startVoiceInputOnUi(callbackName));
            }

            @JavascriptInterface public void recognizeLabel(String base64, String callbackName) {
                if (!isValidCallback(callbackName)) return;
                postUi(() -> startImageRecognitionOnUi(base64, callbackName, true));
            }

            @JavascriptInterface public void scanBarcode(String base64, String callbackName) {
                if (!isValidCallback(callbackName)) return;
                postUi(() -> startImageRecognitionOnUi(base64, callbackName, false));
            }

            @JavascriptInterface public void googleRoutesRequest(String requestId, String endpoint, String body, String apiKey, String fieldMask) {
                if (!isValidRequestId(requestId)) return;
                postUi(() -> startGoogleRoutesRequestOnUi(requestId, endpoint, body, apiKey, fieldMask));
            }

            @JavascriptInterface public void saveGoogleRoutesKey(String apiKey) {
                if (apiKey == null || apiKey.length() > MAX_API_KEY_LENGTH || containsHeaderLineBreak(apiKey)) return;
                String value = apiKey.trim();
                getSharedPreferences(ROUTES_PREFS, Context.MODE_PRIVATE).edit()
                        .putString(ROUTES_KEY, value)
                        .apply();
            }

            @JavascriptInterface public String getGoogleRoutesKey() {
                return getSharedPreferences(ROUTES_PREFS, Context.MODE_PRIVATE)
                        .getString(ROUTES_KEY, "");
            }

            @JavascriptInterface public void shareText(String texto) {
                if (texto == null || texto.isEmpty() || texto.length() > MAX_SHARE_TEXT_LENGTH) return;
                postUi(() -> {
                    try {
                        Intent share = new Intent(Intent.ACTION_SEND);
                        share.setType("text/plain");
                        share.putExtra(Intent.EXTRA_TEXT, texto);
                        startActivity(Intent.createChooser(share, "Compartilhar"));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "Não foi possível compartilhar o texto", Toast.LENGTH_SHORT).show();
                    }
                });
            }

            @JavascriptInterface public void showLocalNotification(String titulo, String texto) {
                if (titulo == null) titulo = "SPX Route";
                if (texto == null) texto = "";
                if (titulo.length() > MAX_NOTIFICATION_TITLE_LENGTH || texto.length() > MAX_NOTIFICATION_TEXT_LENGTH) return;
                String title = titulo;
                String message = texto;
                postUi(() -> showLocalNotificationOnUi(title, message));
            }

            @JavascriptInterface public void requestNotificationPermission() {
                if (Build.VERSION.SDK_INT < 33) return;
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
                postUi(() -> {
                    if (canUseWebView() && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
                    }
                });
            }

            @JavascriptInterface public void installApk(String downloadUrl) {
                if (!isAllowedApkDownloadUrl(downloadUrl)) {
                    postUi(() -> Toast.makeText(MainActivity.this, "URL de atualização não confiável", Toast.LENGTH_SHORT).show());
                    return;
                }
                postUi(() -> {
                    try {
                        Toast.makeText(MainActivity.this, "Baixando atualização do SPX...", Toast.LENGTH_LONG).show();
                        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                        Uri uri = Uri.parse(downloadUrl);
                        DownloadManager.Request request = new DownloadManager.Request(uri);
                        request.setTitle("SPX Route OS - Atualização");
                        request.setDescription("Baixando nova versão do aplicativo");
                        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "SPX-Route-OS-update.apk");
                        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        request.setMimeType("application/vnd.android.package-archive");
                        long enqueueId = dm.enqueue(request);

                        unregisterUpdateReceiver();
                        BroadcastReceiver onComplete = new BroadcastReceiver() {
                            @Override public void onReceive(Context ctxt, Intent intent) {
                                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                                if (id == enqueueId) {
                                    if (updateReceiver == this) updateReceiver = null;
                                    try {
                                        Uri apkUri = dm.getUriForDownloadedFile(enqueueId);
                                        Intent installIntent = new Intent(Intent.ACTION_VIEW);
                                        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                                        installIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                        startActivity(installIntent);
                                    } catch (Exception ex) {
                                        try {
                                            Intent fallback = new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl));
                                            fallback.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                            startActivity(fallback);
                                        } catch (Exception ignored) {}
                                    }
                                    try { unregisterReceiver(this); } catch (Exception ignored) {}
                                }
                            }
                        };
                        updateReceiver = onComplete;
                        if (android.os.Build.VERSION.SDK_INT >= 33) {
                            registerReceiver(onComplete, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_EXPORTED);
                        } else {
                            registerReceiver(onComplete, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
                        }
                    } catch (Exception e) {
                        unregisterUpdateReceiver();
                        try {
                            Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl));
                            startActivity(browserIntent);
                        } catch (Exception ex) {
                            Toast.makeText(MainActivity.this, "Erro ao iniciar download da atualização", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            }

            @JavascriptInterface public void openExternalUrl(String url) {
                postUi(() -> {
                    if (!isAllowedExternalUrl(url)) return;
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        startActivity(intent);
                    } catch (Exception ignored) {}
                });
            }
        }, "SPXAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleWebViewUrl(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleWebViewUrl(Uri.parse(url));
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                pageReady = false;
            }
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageReady = true;
                installBlobDownloadBridge();
                deliverPendingTransferLink();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                try { startActivityForResult(intent, FILE_CHOOSER); }
                catch (ActivityNotFoundException e) { fileCallback = null; Toast.makeText(MainActivity.this, "Não foi possível abrir os arquivos", Toast.LENGTH_SHORT).show(); return false; }
                return true;
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!"file:///android_asset/index.html".equals(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                geoOrigin = origin; geoCallback = callback;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                        callback.invoke(origin, true, false);
                    } else {
                        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
                    }
                } else {
                    callback.invoke(origin, true, false);
                }
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "SPX_" + System.currentTimeMillis());
                req.setMimeType(mimeType);
                req.addRequestHeader("User-Agent", userAgent);
                ((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "Download iniciado", Toast.LENGTH_SHORT).show();
            } catch (Exception e) { Toast.makeText(this, "Falha ao iniciar download", Toast.LENGTH_SHORT).show(); }
        });
        handleDeepLinkIntent(getIntent());
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLinkIntent(intent);
        deliverPendingTransferLink();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override protected void onPause() {
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    private void installBlobDownloadBridge() {
        if (!canUseWebView()) return;
        String js = "(function(){if(window.__spxBlobBridge)return;window.__spxBlobBridge=1;document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a||!a.href||!a.href.startsWith('blob:'))return;e.preventDefault();var name=a.download||'SPX_Export.xlsx';fetch(a.href).then(r=>r.blob()).then(b=>{var fr=new FileReader();fr.onload=function(){var data=String(fr.result).split(',')[1];window.SPXAndroid.saveFile(name,b.type||'application/octet-stream',data);};fr.readAsDataURL(b);}).catch(()=>alert('Não foi possível preparar o arquivo.'));},true);})();";
        evaluateJavascriptSafely(js);
    }

    private void prepareSaveFileOnBackground(String name, String mime, String base64) {
        File file = null;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (bytes.length == 0 || bytes.length > MAX_SAVE_FILE_BYTES) throw new IOException("Arquivo excede o limite");
            file = File.createTempFile("spx-export-", ".tmp", getCacheDir());
            try (OutputStream output = new FileOutputStream(file)) {
                output.write(bytes);
            }
            File preparedFile = file;
            postUi(() -> openSaveDocumentPicker(preparedFile, name, mime));
        } catch (Exception e) {
            if (file != null) file.delete();
            saveInProgress.set(false);
            postUi(() -> Toast.makeText(MainActivity.this, "Não foi possível preparar o arquivo", Toast.LENGTH_SHORT).show());
        }
    }

    private void openSaveDocumentPicker(File file, String name, String mime) {
        if (!canUseWebView()) {
            clearPendingSave();
            return;
        }
        pendingSaveFile = file;
        pendingSaveName = name;
        pendingSaveMime = mime;
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        create.addCategory(Intent.CATEGORY_OPENABLE);
        create.setType(mime);
        create.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(create, SAVE_FILE);
        } catch (Exception e) {
            clearPendingSave();
            Toast.makeText(this, "Não foi possível salvar o arquivo", Toast.LENGTH_SHORT).show();
        }
    }

    private void copyPendingSaveOnBackground(Uri destination) {
        File source = pendingSaveFile;
        if (source == null || !source.isFile()) {
            postUi(this::clearPendingSave);
            return;
        }
        try {
            backgroundExecutor.execute(() -> {
                boolean saved = false;
                try (InputStream input = new FileInputStream(source);
                     OutputStream output = getContentResolver().openOutputStream(destination)) {
                    if (output == null) throw new IOException("Destino indisponível");
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
                        output.write(buffer, 0, read);
                    }
                    output.flush();
                    saved = true;
                } catch (Exception ignored) {}
                final boolean success = saved;
                postUi(() -> {
                    Toast.makeText(MainActivity.this, success ? "Arquivo salvo" : "Erro ao salvar arquivo", Toast.LENGTH_SHORT).show();
                    clearPendingSave();
                });
            });
        } catch (RejectedExecutionException e) {
            clearPendingSave();
        }
    }

    private void clearPendingSave() {
        if (pendingSaveFile != null) pendingSaveFile.delete();
        pendingSaveFile = null;
        pendingSaveName = null;
        pendingSaveMime = null;
        saveInProgress.set(false);
    }

    private String normalizeSaveFileName(String name) {
        String source = name == null ? "" : name.trim();
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < source.length(); i++) {
            char value = source.charAt(i);
            clean.append(value == '/' || value == '\\' || Character.isISOControl(value) ? '_' : value);
        }
        String result = clean.toString().trim();
        if (result.isEmpty()) result = "SPX_export.xlsx";
        if (result.length() > 128) result = result.substring(0, 128);
        return result;
    }

    private String normalizeSaveMime(String mime) {
        String value = mime == null ? "" : mime.trim();
        if ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".equalsIgnoreCase(value) ||
                "text/csv".equalsIgnoreCase(value) || "application/json".equalsIgnoreCase(value) ||
                "text/plain".equalsIgnoreCase(value)) {
            return value;
        }
        return "application/octet-stream";
    }

    private boolean handleWebViewUrl(Uri uri) {
        if (uri == null) return true;
        if (isTransferDeepLink(uri)) {
            queueTransferLink(uri.toString());
            return true;
        }
        if ("file:///android_asset/index.html".equals(uri.toString())) return false;
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) && isSafeExternalNavigationUrl(uri.toString())) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
        }
        return true;
    }

    private boolean isTransferDeepLink(Uri uri) {
        if (uri == null || !"spxroute".equalsIgnoreCase(uri.getScheme()) || !"transfer".equalsIgnoreCase(uri.getHost())) return false;
        try {
            String data = uri.getQueryParameter("data");
            return uri.isHierarchical() && data != null && !data.isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null || !isTransferDeepLink(intent.getData())) return;
        queueTransferLink(intent.getDataString());
    }

    private void queueTransferLink(String link) {
        if (link == null || link.length() > MAX_DEEP_LINK_LENGTH || containsControlCharacters(link)) return;
        pendingTransferLink = link;
        deliverPendingTransferLink();
    }

    private void deliverPendingTransferLink() {
        if (!canUseWebView() || !pageReady || pendingTransferLink == null) return;
        String link = pendingTransferLink;
        pendingTransferLink = null;
        evaluateJavascriptSafely("(function(){if(window.SPXTransfer&&typeof window.SPXTransfer.importLink==='function'){try{window.SPXTransfer.importLink(" + jsQuote(link) + ");}catch(_){}}})();");
    }

    private void postUi(Runnable action) {
        if (isFinishing() || isDestroyed()) return;
        runOnUiThread(action);
    }

    private boolean canUseWebView() {
        return webView != null && !isFinishing() && !isDestroyed();
    }

    private void evaluateJavascriptSafely(String script) {
        if (!canUseWebView()) return;
        try {
            webView.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {}
    }

    private String jsQuote(String value) {
        String quoted = JSONObject.quote(value == null ? "" : value);
        return quoted.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    private void dispatchCallback(String callbackName, String value) {
        if (!isValidCallback(callbackName) || !canUseWebView()) return;
        evaluateJavascriptSafely("(function(){if(typeof window[" + jsQuote(callbackName) + "]==='function'){try{window[" + jsQuote(callbackName) + "](" + jsQuote(value) + ");}catch(_){}}})();");
    }

    private void dispatchGoogleRoutes(String requestId, boolean success, String payload) {
        if (!isValidRequestId(requestId) || !canUseWebView()) return;
        String method = success ? "onResult" : "onError";
        evaluateJavascriptSafely("(function(){if(window.SPXGoogleRoutes&&typeof window.SPXGoogleRoutes." + method + "==='function'){try{window.SPXGoogleRoutes." + method + "(" + jsQuote(requestId) + "," + jsQuote(payload) + ");}catch(_){}}})();");
    }

    private void startVoiceInputOnUi(String callbackName) {
        if (!canUseWebView()) return;
        if (voiceCallback != null) {
            dispatchCallback(callbackName, "");
            return;
        }
        voiceCallback = callbackName;
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Fale agora");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            startActivityForResult(intent, VOICE_INPUT);
        } catch (Exception e) {
            voiceCallback = null;
            dispatchCallback(callbackName, "");
        }
    }

    private void startImageRecognitionOnUi(String base64, String callbackName, boolean label) {
        if (!canUseWebView()) return;
        if ((label && labelCallback != null) || (!label && barcodeCallback != null)) {
            dispatchCallback(callbackName, "");
            return;
        }
        if (base64 == null || base64.length() > MAX_BASE64_LENGTH) {
            dispatchCallback(callbackName, "");
            return;
        }

        TextRecognizer recognizer = null;
        BarcodeScanner scanner = null;
        try {
            if (label) {
                if (textRecognizer == null) {
                    textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                }
                recognizer = textRecognizer;
            } else {
                if (barcodeScanner == null) {
                    barcodeScanner = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder().build());
                }
                scanner = barcodeScanner;
            }
        } catch (Exception e) {
            dispatchCallback(callbackName, "");
            return;
        }

        if (label) labelCallback = callbackName;
        else barcodeCallback = callbackName;
        final TextRecognizer selectedRecognizer = recognizer;
        final BarcodeScanner selectedScanner = scanner;
        try {
            backgroundExecutor.execute(() -> processImageInBackground(base64, callbackName, label, selectedRecognizer, selectedScanner));
        } catch (RejectedExecutionException e) {
            if (label) labelCallback = null;
            else barcodeCallback = null;
            dispatchCallback(callbackName, "");
        }
    }

    private void processImageInBackground(String base64, String callbackName, boolean label, TextRecognizer recognizer, BarcodeScanner scanner) {
        Bitmap bitmap = null;
        try {
            bitmap = decodeLimitedBitmap(base64);
            Bitmap selectedBitmap = bitmap;
            InputImage image = InputImage.fromBitmap(selectedBitmap, 0);
            if (label) {
                recognizer.process(image)
                        .addOnSuccessListener(MainActivity.this, text -> finishLabelCallback(callbackName, text == null ? "" : text.getText()))
                        .addOnFailureListener(MainActivity.this, error -> finishLabelCallback(callbackName, ""))
                        .addOnCompleteListener(MainActivity.this, task -> selectedBitmap.recycle());
            } else {
                scanner.process(image)
                        .addOnSuccessListener(MainActivity.this, barcodes -> {
                            String value = "";
                            if (barcodes != null && !barcodes.isEmpty() && barcodes.get(0).getRawValue() != null) {
                                value = barcodes.get(0).getRawValue();
                            }
                            finishBarcodeCallback(callbackName, value);
                        })
                        .addOnFailureListener(MainActivity.this, error -> finishBarcodeCallback(callbackName, ""))
                        .addOnCompleteListener(MainActivity.this, task -> selectedBitmap.recycle());
            }
        } catch (Exception e) {
            if (bitmap != null) bitmap.recycle();
            if (label) postUi(() -> finishLabelCallback(callbackName, ""));
            else postUi(() -> finishBarcodeCallback(callbackName, ""));
        } catch (OutOfMemoryError e) {
            if (bitmap != null) bitmap.recycle();
            if (label) postUi(() -> finishLabelCallback(callbackName, ""));
            else postUi(() -> finishBarcodeCallback(callbackName, ""));
        }
    }

    private Bitmap decodeLimitedBitmap(String base64) throws IOException {
        if (base64 == null || base64.length() > MAX_BASE64_LENGTH) throw new IOException("Imagem excede o limite");
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new IOException("Base64 inválido", e);
        }
        if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) throw new IOException("Imagem excede o limite");

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("Imagem inválida");
        if (options.outWidth > MAX_IMAGE_SOURCE_DIMENSION || options.outHeight > MAX_IMAGE_SOURCE_DIMENSION
                || (long) options.outWidth * options.outHeight > MAX_IMAGE_SOURCE_PIXELS) {
            throw new IOException("Dimensões da imagem excedem o limite");
        }

        int sampleSize = 1;
        while (options.outWidth / sampleSize > MAX_IMAGE_DIMENSION
                || options.outHeight / sampleSize > MAX_IMAGE_DIMENSION
                || (long) (options.outWidth / sampleSize) * (options.outHeight / sampleSize) > MAX_IMAGE_PIXELS) {
            sampleSize *= 2;
        }
        options.inJustDecodeBounds = false;
        options.inSampleSize = sampleSize;
        Bitmap bitmap = null;
        try {
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        } catch (OutOfMemoryError e) {
            throw new IOException("Memória insuficiente para decodificar a imagem", e);
        }
        if (bitmap == null || bitmap.getWidth() <= 0 || bitmap.getHeight() <= 0
                || bitmap.getWidth() > MAX_IMAGE_DIMENSION || bitmap.getHeight() > MAX_IMAGE_DIMENSION
                || (long) bitmap.getWidth() * bitmap.getHeight() > MAX_IMAGE_PIXELS) {
            if (bitmap != null) bitmap.recycle();
            throw new IOException("Imagem decodificada excede o limite");
        }
        return bitmap;
    }

    private void finishLabelCallback(String callbackName, String text) {
        postUi(() -> {
            if (!callbackName.equals(labelCallback)) return;
            labelCallback = null;
            dispatchCallback(callbackName, text == null ? "" : text);
        });
    }

    private void finishBarcodeCallback(String callbackName, String value) {
        postUi(() -> {
            if (!callbackName.equals(barcodeCallback)) return;
            barcodeCallback = null;
            dispatchCallback(callbackName, value == null ? "" : value);
        });
    }

    private void startGoogleRoutesRequestOnUi(String requestId, String endpoint, String body, String apiKey, String fieldMask) {
        if (!canUseWebView()) return;
        if (!ROUTES_MATRIX_ENDPOINT.equals(endpoint) && !ROUTES_DIRECTIONS_ENDPOINT.equals(endpoint)) {
            dispatchGoogleRoutes(requestId, false, "Endpoint não permitido");
            return;
        }
        if (body == null || body.length() > MAX_ROUTES_BODY_BYTES) {
            dispatchGoogleRoutes(requestId, false, "Payload da requisição inválido");
            return;
        }
        if (apiKey == null || apiKey.length() > MAX_API_KEY_LENGTH || containsHeaderLineBreak(apiKey) || apiKey.trim().isEmpty()) {
            dispatchGoogleRoutes(requestId, false, "Chave da API inválida");
            return;
        }
        if (fieldMask != null && (fieldMask.length() > MAX_FIELD_MASK_LENGTH || containsHeaderLineBreak(fieldMask))) {
            dispatchGoogleRoutes(requestId, false, "Máscara de campos inválida");
            return;
        }
        if (!pendingRouteRequestIds.add(requestId)) {
            dispatchGoogleRoutes(requestId, false, "Requisição já em andamento");
            return;
        }
        String selectedApiKey = apiKey.trim();
        String selectedFieldMask = fieldMask == null ? "" : fieldMask.trim();
        try {
            backgroundExecutor.execute(() -> executeGoogleRoutesRequest(requestId, endpoint, body, selectedApiKey, selectedFieldMask));
        } catch (RejectedExecutionException e) {
            pendingRouteRequestIds.remove(requestId);
            dispatchGoogleRoutes(requestId, false, "Requisição cancelada");
        }
    }

    private void executeGoogleRoutesRequest(String requestId, String endpoint, String body, String apiKey, String fieldMask) {
        HttpURLConnection connection = null;
        try {
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            if (payload.length > MAX_ROUTES_BODY_BYTES) throw new IOException("Payload excede o limite");
            URL url = new URL("https://routes.googleapis.com/" + endpoint);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(payload.length);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("X-Goog-Api-Key", apiKey);
            connection.setRequestProperty("X-Goog-FieldMask", fieldMask);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }

            int status = connection.getResponseCode();
            InputStream responseStream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String response = readLimitedResponse(responseStream, MAX_ROUTES_RESPONSE_BYTES);
            if (status >= 200 && status < 300) {
                finishGoogleRoutesRequest(requestId, response, null);
            } else {
                String message = "Falha no Google Routes (HTTP " + status + ")";
                if (!response.isEmpty()) message += ": " + response;
                finishGoogleRoutesRequest(requestId, null, message);
            }
        } catch (Exception e) {
            String message = Thread.currentThread().isInterrupted() ? "Requisição cancelada" : "Falha de comunicação com o Google Routes";
            finishGoogleRoutesRequest(requestId, null, message);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readLimitedResponse(InputStream input, int maxBytes) throws IOException {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
                total += read;
                if (total > maxBytes) throw new IOException("Resposta excede o limite");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void finishGoogleRoutesRequest(String requestId, String json, String error) {
        postUi(() -> {
            pendingRouteRequestIds.remove(requestId);
            if (error == null) dispatchGoogleRoutes(requestId, true, json);
            else dispatchGoogleRoutes(requestId, false, error);
        });
    }

    private void showLocalNotificationOnUi(String title, String message) {
        if (!canUseWebView()) return;
        if (title.isEmpty()) title = "SPX Route";
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Permita notificações para continuar", Toast.LENGTH_SHORT).show();
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null || (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled())) {
            Toast.makeText(this, "Notificações desativadas", Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                    NOTIFICATION_CHANNEL_ID, "Notificações SPX", NotificationManager.IMPORTANCE_DEFAULT);
            manager.createNotificationChannel(channel);
        }
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent contentIntent = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, contentIntent, pendingFlags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = builder
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_DEFAULT)
                .build();
        try {
            manager.notify(notificationSequence++, notification);
        } catch (RuntimeException e) {
            Toast.makeText(this, "Não foi possível exibir a notificação", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean isSafeExternalNavigationUrl(String value) {
        if (value == null || value.length() > MAX_EXTERNAL_URL_LENGTH || containsControlCharacters(value)) return false;
        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (Exception e) {
            return false;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) return false;
        int port = uri.getPort();
        return port == -1 || port == 443;
    }

    private boolean isAllowedApkDownloadUrl(String value) {
        if (!isSafeExternalNavigationUrl(value)) return false;
        Uri uri = Uri.parse(value);
        String path = uri.getPath();
        return "github.com".equalsIgnoreCase(uri.getHost()) && uri.getQuery() == null && uri.getFragment() == null &&
                path != null && path.startsWith("/dnlortega/spx-android/releases/download/") &&
                path.length() > 4 && path.regionMatches(true, path.length() - 4, ".apk", 0, 4);
    }

    private boolean isAllowedExternalUrl(String value) {
        if (value == null || value.length() > MAX_EXTERNAL_URL_LENGTH || containsControlCharacters(value)) return false;
        Uri uri;
        try {
            uri = Uri.parse(value);
        } catch (Exception e) {
            return false;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) return false;
        int port = uri.getPort();
        if (port != -1 && port != 443) return false;
        String host = uri.getHost();
        if ("google.com".equalsIgnoreCase(host) || "www.google.com".equalsIgnoreCase(host)) {
            String path = uri.getPath();
            return path != null && (path.equals("/maps") || path.startsWith("/maps/"));
        }
        if ("waze.com".equalsIgnoreCase(host) || "www.waze.com".equalsIgnoreCase(host)) return true;
        return "maps.apple.com".equalsIgnoreCase(host);
    }

    private void unregisterUpdateReceiver() {
        BroadcastReceiver receiver = updateReceiver;
        updateReceiver = null;
        if (receiver != null) {
            try { unregisterReceiver(receiver); } catch (Exception ignored) {}
        }
    }

    private boolean isValidCallback(String callbackName) {
        return callbackName != null && callbackName.length() <= 128 && CALLBACK_PATTERN.matcher(callbackName).matches();
    }

    private boolean isValidRequestId(String requestId) {
        return requestId != null && requestId.length() <= 128 && REQUEST_ID_PATTERN.matcher(requestId).matches();
    }

    private boolean containsHeaderLineBreak(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return true;
        }
        return false;
    }

    private boolean containsControlCharacters(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return true;
        }
        return false;
    }

    @Override protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (pendingTransferLink != null) outState.putString(STATE_TRANSFER_LINK, pendingTransferLink);
        if (pendingSaveFile != null && pendingSaveFile.isFile()) {
            outState.putString(STATE_SAVE_PATH, pendingSaveFile.getAbsolutePath());
            outState.putString(STATE_SAVE_NAME, pendingSaveName);
            outState.putString(STATE_SAVE_MIME, pendingSaveMime);
        }
    }

    private void restorePendingState(Bundle state) {
        if (state == null) return;
        String transferLink = state.getString(STATE_TRANSFER_LINK);
        if (transferLink != null && transferLink.length() <= MAX_DEEP_LINK_LENGTH && !containsControlCharacters(transferLink)) {
            queueTransferLink(transferLink);
        }
        String savePath = state.getString(STATE_SAVE_PATH);
        if (savePath == null) return;
        try {
            File candidate = new File(savePath);
            if (candidate.isFile() && candidate.getParentFile().getCanonicalPath().equals(getCacheDir().getCanonicalPath())) {
                pendingSaveFile = candidate;
                pendingSaveName = normalizeSaveFileName(state.getString(STATE_SAVE_NAME));
                pendingSaveMime = normalizeSaveMime(state.getString(STATE_SAVE_MIME));
                saveInProgress.set(true);
            }
        } catch (Exception ignored) {}
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == VOICE_INPUT) {
            String callbackName = voiceCallback;
            voiceCallback = null;
            String recognizedText = "";
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<String> results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (results != null) {
                    for (String result : results) {
                        if (result != null && !result.trim().isEmpty()) {
                            recognizedText = result.trim();
                            break;
                        }
                    }
                }
            }
            if (callbackName != null) dispatchCallback(callbackName, recognizedText);
        } else if (requestCode == FILE_CHOOSER && fileCallback != null) {
            Uri[] result = (resultCode == RESULT_OK && data != null && data.getData() != null) ? new Uri[]{data.getData()} : null;
            fileCallback.onReceiveValue(result); fileCallback = null;
        } else if (requestCode == SAVE_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                copyPendingSaveOnBackground(data.getData());
            } else {
                clearPendingSave();
            }
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == LOCATION_PERMISSION && geoCallback != null) {
            boolean granted = false;
            for (int r : results) if (r == PackageManager.PERMISSION_GRANTED) granted = true;
            geoCallback.invoke(geoOrigin, granted, false); geoCallback = null; geoOrigin = null;
        }
    }

    @Override protected void onDestroy() {
        voiceCallback = null;
        labelCallback = null;
        barcodeCallback = null;
        pendingTransferLink = null;
        pendingRouteRequestIds.clear();
        if (isFinishing()) clearPendingSave();
        pageReady = false;
        if (fileCallback != null) {
            try { fileCallback.onReceiveValue(null); } catch (Exception ignored) {}
            fileCallback = null;
        }
        if (geoCallback != null) {
            try { geoCallback.invoke(geoOrigin, false, false); } catch (Exception ignored) {}
            geoCallback = null;
            geoOrigin = null;
        }
        unregisterUpdateReceiver();
        backgroundExecutor.shutdownNow();
        if (textRecognizer != null) {
            try { textRecognizer.close(); } catch (Exception ignored) {}
            textRecognizer = null;
        }
        if (barcodeScanner != null) {
            try { barcodeScanner.close(); } catch (Exception ignored) {}
            barcodeScanner = null;
        }
        if (webView != null) {
            try { webView.stopLoading(); } catch (Exception ignored) {}
            try { webView.removeJavascriptInterface("SPXAndroid"); } catch (Exception ignored) {}
            webView.removeAllViews();
            if (webView.getParent() instanceof ViewGroup) {
                ((ViewGroup) webView.getParent()).removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
}
