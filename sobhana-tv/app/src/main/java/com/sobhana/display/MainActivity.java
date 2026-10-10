package com.sobhana.display;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Sobhana waiting-room display kiosk.
 *
 * Fullscreen WebView locked to the screen's display URL. Audio autoplay is
 * enabled so the call chime plays with no tap. First run asks for the link
 * (from Admin -> Waiting Room Display) and remembers it; press the remote's
 * MENU button any time to change it.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "sobhana";
    private static final String KEY_URL = "display_url";

    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        String url = prefs.getString(KEY_URL, null);
        if (url == null || url.trim().isEmpty()) {
            showSetup();
        } else {
            showDisplay(url);
        }
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    private void showSetup() {
        LinearLayout ll = new LinearLayout(this);
        ll.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (getResources().getDisplayMetrics().density * 40);
        ll.setPadding(pad, pad, pad, pad);
        ll.setBackgroundColor(0xFF0E1220);

        TextView title = new TextView(this);
        title.setText("Sobhana Display");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(28);

        TextView hint = new TextView(this);
        hint.setText("Paste the display link from Admin → Waiting Room Display");
        hint.setTextColor(0xFFB9C2D6);
        hint.setTextSize(16);

        final EditText input = new EditText(this);
        input.setTextColor(0xFFFFFFFF);
        input.setHintTextColor(0xFF6B7690);
        input.setHint("https://www.sobhanaportal.com/display/chintal/op");
        input.setText(prefs.getString(KEY_URL, "https://www.sobhanaportal.com/display/"));
        input.setSingleLine(true);

        Button save = new Button(this);
        save.setText("Save & start");
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String u = input.getText().toString().trim();
                if (!u.isEmpty()) {
                    prefs.edit().putString(KEY_URL, u).apply();
                    showDisplay(u);
                }
            }
        });

        ll.addView(title);
        ll.addView(hint);
        ll.addView(input);
        ll.addView(save);
        setContentView(ll);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void showDisplay(final String url) {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // The whole point: let the call chime play without a user gesture.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        web.setBackgroundColor(0xFFFFFFFF);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Network blip / backend redeploy — retry the main page shortly.
                if (request != null && request.isForMainFrame()) {
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            view.loadUrl(url);
                        }
                    }, 5000);
                }
            }
        });

        setContentView(web);
        web.loadUrl(url);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Remote MENU button reopens setup to change the link.
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showSetup();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
