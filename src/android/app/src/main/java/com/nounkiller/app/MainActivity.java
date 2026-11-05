package com.nounkiller.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import java.util.ArrayList;

/**
 * 单 Activity 原生壳：WebView 加载 file:///android_asset/www/index.html。
 * 业务逻辑与网页完全一致；这里只补三件事：
 *  1. 本地状态持久化（SharedPreferences，供 JS 的 NounKillerNative 桥使用）
 *  2. <input type="file"> 的系统文件选择器
 *  3. 系统返回键先关闭网页内的弹层
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final String PREFS = "nounkiller";
    private static final String LEGACY_PREFS = "mingjiezhan";
    private static final String STATE_KEY = "state";
    private static final int BG = Color.parseColor("#f3f0e8");

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            window.getDecorView().setSystemUiVisibility(flags);
        }

        webView = new WebView(this);
        webView.setBackgroundColor(BG);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                String[] accept = params.getAcceptTypes();
                if (accept != null) {
                    ArrayList<String> types = new ArrayList<>();
                    for (String type : accept) {
                        if (type != null && !type.trim().isEmpty()) types.add(type.trim());
                    }
                    if (!types.isEmpty()) {
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                    }
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择题库文件"), REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    pendingFileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        webView.addJavascriptInterface(new NativeBridge(this), "NounKillerNative");

        // Android 15+ 强制 edge-to-edge：用父容器内边距把网页让到状态栏/导航栏之内。
        // 这样 WebView 的视口本身就是安全区域，position: fixed 的评级栏不会钻到导航栏底下；
        // IME 弹出时也缩到键盘上方。
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                top = bars.top;
                bottom = bars.bottom;
                left = bars.left;
                right = bars.right;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft();
                right = insets.getSystemWindowInsetRight();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });
        setContentView(root);
        root.requestApplyInsets();

        if (savedInstanceState == null) {
            webView.loadUrl("file:///android_asset/www/index.html");
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
                pendingFileCallback.onReceiveValue(result);
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("NounKillerNative");
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript("(window.nkBack && window.nkBack()) ? true : false",
                value -> {
                    if (!"true".equals(value)) {
                        finish();
                    }
                });
    }

    /** 暴露给网页的持久化桥：与 localStorage 双写，原生端优先读这里。 */
    public static class NativeBridge {
        private final Activity activity;

        NativeBridge(Activity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String loadState() {
            String cur = activity.getSharedPreferences(PREFS, MODE_PRIVATE).getString(STATE_KEY, "");
            if (cur != null && !cur.isEmpty()) return cur;
            // 兼容更名前保存的进度
            return activity.getSharedPreferences(LEGACY_PREFS, MODE_PRIVATE).getString(STATE_KEY, "");
        }

        @JavascriptInterface
        public void saveState(String json) {
            if (json == null) return;
            activity.getSharedPreferences(PREFS, MODE_PRIVATE)
                    .edit()
                    .putString(STATE_KEY, json)
                    .apply();
        }
    }
}
