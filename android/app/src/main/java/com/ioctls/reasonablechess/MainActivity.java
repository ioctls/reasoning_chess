package com.ioctls.reasonablechess;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * Hosts the Reasonable Chess web app in a WebView, fully offline.
 *
 * Privacy / security model:
 *  - The app has no INTERNET permission, so Android blocks every network request.
 *  - All files (web app, Stockfish, Maia-3 model) ship inside the APK and are served
 *    from https://appassets.androidplatform.net/ by WebViewAssetLoader, never from the network.
 *  - A strict Content-Security-Policy only allows the app's own files.
 *  - No file:// or content:// browsing, no JavaScript bridge to native code,
 *    and navigation outside the app is handed to the user's browser instead.
 *  - Safe Browsing and WebView metrics are switched off in the manifest.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final String TAG = "ReasonableChess";
    private static final int PICK_FILE = 42;

    // Only this app's own files; wasm needs 'wasm-unsafe-eval'; workers may start from blob: URLs.
    private static final String CSP =
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
            + "connect-src 'self' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
            + "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    private WebView web;
    private ValueCallback<Uri[]> pendingFile;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        final boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", path -> {
                    try {
                        String p = path.isEmpty() ? "index.html" : path;
                        Map<String, String> headers = new HashMap<>();
                        headers.put("Content-Security-Policy", CSP);
                        headers.put("X-Content-Type-Options", "nosniff");
                        headers.put("Cache-Control", "no-store");
                        return new WebResourceResponse(mimeFor(p), null, 200, "OK", headers, getAssets().open(p));
                    } catch (IOException e) {
                        return null;
                    }
                })
                .build();

        // Edge-to-edge (required from Android 15): pad the content so it never hides
        // under the status bar, navigation bar or camera cutout.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#15171C"));
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#15171C"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // your stats & drills, kept on this device only
        s.setAllowFileAccess(false);           // no file:// access
        s.setAllowContentAccess(false);        // no content:// browsing
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(debuggable);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;     // our own pages: fine
                // Anything else (e.g. the source-code link) opens in the user's browser,
                // only when they tap it. The app itself never goes online.
                if (req.hasGesture()) {
                    try {
                        if ("https".equals(u.getScheme())) startActivity(new Intent(Intent.ACTION_VIEW, u));
                        else if ("mailto".equals(u.getScheme())) startActivity(new Intent(Intent.ACTION_SENDTO, u));
                    } catch (Exception ignored) { }
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*"); // .onnx has no registered MIME type
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose model file"), PICK_FILE);
                    return true;
                } catch (Exception e) {
                    pendingFile = null;
                    return false;
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                // Self-test results go to logcat so the CI emulator test can read them.
                if (m.message() != null && m.message().startsWith("SELFTEST")) Log.i(TAG, m.message());
                return !debuggable; // keep page logs out of logcat in release builds
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Debug builds only: `--ez selftest true` runs the offline self-test used in CI.
        boolean selftest = debuggable && getIntent() != null && getIntent().getBooleanExtra("selftest", false);
        web.loadUrl(selftest ? HOME + "#selftest" : HOME);
    }

    private static String mimeFor(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".wasm")) return "application/wasm";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_FILE && pendingFile != null) {
            pendingFile.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingFile = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
