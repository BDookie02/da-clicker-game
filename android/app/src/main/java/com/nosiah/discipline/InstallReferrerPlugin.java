package com.nosiah.discipline;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DisciplineInstallReferrer")
public class InstallReferrerPlugin extends Plugin {
    @PluginMethod
    public void get(PluginCall call) {
        InstallReferrerClient client = InstallReferrerClient.newBuilder(getContext()).build();
        client.startConnection(new InstallReferrerStateListener() {
            @Override
            public void onInstallReferrerSetupFinished(int responseCode) {
                if (responseCode != InstallReferrerClient.InstallReferrerResponse.OK) {
                    client.endConnection();
                    call.reject("install_referrer_unavailable", String.valueOf(responseCode));
                    return;
                }
                try {
                    ReferrerDetails details = client.getInstallReferrer();
                    JSObject result = new JSObject();
                    result.put("installReferrer", details.getInstallReferrer());
                    result.put("clickTimestamp", details.getReferrerClickTimestampServerSeconds());
                    result.put("installTimestamp", details.getInstallBeginTimestampServerSeconds());
                    result.put("installVersion", details.getInstallVersion());
                    call.resolve(result);
                } catch (Exception error) {
                    call.reject("install_referrer_failed", error);
                } finally {
                    client.endConnection();
                }
            }

            @Override
            public void onInstallReferrerServiceDisconnected() {
                // A later app launch retries the single unclaimed referral.
            }
        });
    }
}
