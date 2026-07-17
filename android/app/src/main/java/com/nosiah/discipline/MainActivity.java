package com.nosiah.discipline;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
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
