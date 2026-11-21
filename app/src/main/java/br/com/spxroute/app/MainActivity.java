package br.com.spxroute.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.util.Base64;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import android.widget.Toast;
import android.database.Cursor;
import android.provider.OpenableColumns;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private static final int FILE_CHOOSER = 1001;
    private static final int LOCATION_PERMISSION = 1002;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private String pendingBase64;
    private String pendingMime;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(android.graphics.Color.rgb(248,249,250));
        getWindow().setNavigationBarColor(android.graphics.Color.BLACK);
        webView = new WebView(this);
        setContentView(webView);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setGeolocationEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface public void saveFile(String name, String mime, String base64) {
                runOnUiThread(() -> {
                    pendingBase64 = base64; pendingMime = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
                    Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    create.addCategory(Intent.CATEGORY_OPENABLE); create.setType(pendingMime);
                    create.putExtra(Intent.EXTRA_TITLE, name == null ? "SPX_export.xlsx" : name);
                    try { startActivityForResult(create, 1003); } catch (Exception e) { Toast.makeText(MainActivity.this, "Não foi possível salvar o arquivo", Toast.LENGTH_SHORT).show(); }
                });
            }

            @JavascriptInterface public String getAppVersion() {
                try {
                    return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                } catch (Exception e) {
                    return "1.1.0";
                }
            }

            @JavascriptInterface public void installApk(String downloadUrl) {
                runOnUiThread(() -> {
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

                        BroadcastReceiver onComplete = new BroadcastReceiver() {
                            @Override public void onReceive(Context ctxt, Intent intent) {
                                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                                if (id == enqueueId) {
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
                        if (android.os.Build.VERSION.SDK_INT >= 33) {
                            registerReceiver(onComplete, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_EXPORTED);
                        } else {
                            registerReceiver(onComplete, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
                        }
                    } catch (Exception e) {
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
                runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        startActivity(intent);
                    } catch (Exception ignored) {}
                });
            }
        }, "SPXAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme()) || "https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
                    if ("file".equals(uri.getScheme()) || uri.toString().startsWith("https://")) return false;
                }
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                installBlobDownloadBridge();
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
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void installBlobDownloadBridge() {
        String js = "(function(){if(window.__spxBlobBridge)return;window.__spxBlobBridge=1;document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a||!a.href||!a.href.startsWith('blob:'))return;e.preventDefault();var name=a.download||'SPX_Export.xlsx';fetch(a.href).then(r=>r.blob()).then(b=>{var fr=new FileReader();fr.onload=function(){var data=String(fr.result).split(',')[1];window.SPXAndroid.saveFile(name,b.type||'application/octet-stream',data);};fr.readAsDataURL(b);}).catch(()=>alert('Não foi possível preparar o arquivo.'));},true);})();";
        webView.evaluateJavascript(js, null);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER && fileCallback != null) {
            Uri[] result = (resultCode == RESULT_OK && data != null && data.getData() != null) ? new Uri[]{data.getData()} : null;
            fileCallback.onReceiveValue(result); fileCallback = null;
        } else if (requestCode == 1003) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingBase64 != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    out.write(Base64.decode(pendingBase64, Base64.DEFAULT));
                    Toast.makeText(this, "Arquivo salvo", Toast.LENGTH_SHORT).show();
                } catch (Exception e) { Toast.makeText(this, "Erro ao salvar arquivo", Toast.LENGTH_SHORT).show(); }
            }
            pendingBase64 = null; pendingMime = null;
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

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
}
