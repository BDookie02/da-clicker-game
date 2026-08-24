package com.nosiah.discipline;

import android.os.Handler;
import android.os.Looper;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "DisciplineInstallReferrer")
public class InstallReferrerPlugin extends Plugin {
    private static final long CONNECTION_TIMEOUT_MS = 15_000L;

    @PluginMethod
    public void get(PluginCall call) {
        InstallReferrerClient client = InstallReferrerClient.newBuilder(getContext()).build();
        AtomicBoolean settled = new AtomicBoolean(false);
        long requestedTimeoutMs = call.getInt("timeoutMs", (int) CONNECTION_TIMEOUT_MS);
        long timeoutMs = Math.max(250L, Math.min(CONNECTION_TIMEOUT_MS, requestedTimeoutMs));
        Handler handler = new Handler(Looper.getMainLooper());
        Runnable timeout = () -> {
            if (settled.compareAndSet(false, true)) {
                client.endConnection();
                call.reject("install_referrer_timeout", "install_referrer_timeout");
            }
        };
        handler.postDelayed(timeout, timeoutMs);
        client.startConnection(new InstallReferrerStateListener() {
            @Override
            public void onInstallReferrerSetupFinished(int responseCode) {
                if (responseCode != InstallReferrerClient.InstallReferrerResponse.OK) {
                    if (settled.compareAndSet(false, true)) {
                        handler.removeCallbacks(timeout);
                        client.endConnection();
                        call.reject("install_referrer_unavailable", String.valueOf(responseCode));
                    }
                    return;
                }
                try {
                    ReferrerDetails details = client.getInstallReferrer();
                    JSObject result = new JSObject();
                    result.put("installReferrer", details.getInstallReferrer());
                    result.put("clickTimestamp", details.getReferrerClickTimestampServerSeconds());
                    result.put("installTimestamp", details.getInstallBeginTimestampServerSeconds());
                    result.put("installVersion", details.getInstallVersion());
                    if (settled.compareAndSet(false, true)) {
                        handler.removeCallbacks(timeout);
                        call.resolve(result);
                    }
                } catch (Exception error) {
                    if (settled.compareAndSet(false, true)) {
                        handler.removeCallbacks(timeout);
                        call.reject("install_referrer_failed", error);
                    }
                } finally {
                    client.endConnection();
                }
            }

            @Override
            public void onInstallReferrerServiceDisconnected() {
                // A disconnect can race setup completion. Settle exactly once;
                // the bounded TypeScript retry owner may open a fresh client.
                if (settled.compareAndSet(false, true)) {
                    handler.removeCallbacks(timeout);
                    client.endConnection();
                    call.reject("install_referrer_disconnected", "install_referrer_disconnected");
                }
            }
        });
    }
}
