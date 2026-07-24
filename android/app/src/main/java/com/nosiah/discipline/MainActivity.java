package com.nosiah.discipline;

import android.os.Bundle;
import android.content.pm.ApplicationInfo;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Required by the AndroidX splash-screen compat API. The same approved
        // launcher artwork and background are used on Android 7 through 12+.
        SplashScreen.installSplashScreen(this);

        // Expose the debug APK's WebView to local visual-regression tooling.
        // Release builds remain non-debuggable and do not expose this socket.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        super.onCreate(savedInstanceState);

        // A hardware-keyboard Escape/Back event used to invoke Android's
        // default moveTaskToBack(), which looked exactly like an app crash.
        // Keep the activity foregrounded and let the web UI close its own
        // current panel/garage safely instead.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(
                    "window.dispatchEvent(new Event('disciplineAndroidBack'))", null
                ));
            }
        });
    }
}
