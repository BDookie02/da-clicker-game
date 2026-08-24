package com.nosiah.discipline;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.StandardIntegrityException;
import com.google.android.play.core.integrity.StandardIntegrityManager;
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest;
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider;
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest;
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode;

/** Android adapter for the provider-neutral platform-proof contract used by
 * referral claims. The server, not this client, decides whether the decoded
 * verdict is trustworthy. */
@CapacitorPlugin(name = "DisciplinePlatformProof")
public class PlatformProofPlugin extends Plugin {
    private StandardIntegrityManager integrityManager;
    private Task<StandardIntegrityTokenProvider> preparingProvider;

    @Override
    public void load() {
        integrityManager = IntegrityManagerFactory.createStandard(
                getContext().getApplicationContext());
    }

    @PluginMethod
    public void get(PluginCall call) {
        String requestHash = call.getString("requestHash");
        if (requestHash == null || !requestHash.matches("^[A-Za-z0-9_-]{43}$")) {
            call.reject("invalid_request_hash", "invalid_request_hash");
            return;
        }

        long cloudProjectNumber;
        try {
            cloudProjectNumber = Long.parseLong(
                    getContext().getString(R.string.play_integrity_cloud_project_number));
        } catch (Exception error) {
            call.reject("play_integrity_unconfigured", "play_integrity_unconfigured");
            return;
        }
        if (cloudProjectNumber <= 0L) {
            call.reject("play_integrity_unconfigured", "play_integrity_unconfigured");
            return;
        }

        requestToken(call, cloudProjectNumber, requestHash);
    }

    private void requestToken(
            PluginCall call, long cloudProjectNumber, String requestHash) {
        Task<StandardIntegrityTokenProvider> providerTask = provider(cloudProjectNumber);
        providerTask
                .addOnSuccessListener(tokenProvider -> tokenProvider.request(
                        StandardIntegrityTokenRequest.builder()
                                .setRequestHash(requestHash)
                                .build())
                        .addOnSuccessListener(response -> {
                            JSObject result = new JSObject();
                            result.put("provider", "google_play_integrity");
                            result.put("token", response.token());
                            call.resolve(result);
                        })
                        .addOnFailureListener(error -> {
                            // A prepared provider can expire. Never leave a failed provider
                            // cached: a retry (or the next claim) must prepare a fresh one.
                            invalidateProvider(providerTask);
                            int errorCode = integrityErrorCode(error);
                            if (errorCode == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID
                                    || isTransient(errorCode)) {
                                call.reject("play_integrity_transient",
                                        "play_integrity_transient", error);
                            } else {
                                call.reject("play_integrity_token_failed",
                                        "play_integrity_token_failed", error);
                            }
                        }))
                .addOnFailureListener(error -> {
                    invalidateProvider(providerTask);
                    if (isTransient(integrityErrorCode(error))) {
                        call.reject("play_integrity_transient",
                                "play_integrity_transient", error);
                    } else {
                        call.reject("play_integrity_prepare_failed",
                                "play_integrity_prepare_failed", error);
                    }
                });
    }

    private synchronized Task<StandardIntegrityTokenProvider> provider(long cloudProjectNumber) {
        if (preparingProvider == null) {
            preparingProvider = integrityManager.prepareIntegrityToken(
                    PrepareIntegrityTokenRequest.builder()
                            .setCloudProjectNumber(cloudProjectNumber)
                            .build());
        }
        return preparingProvider;
    }

    private synchronized void invalidateProvider(
            Task<StandardIntegrityTokenProvider> failedProviderTask) {
        // Identity-check so an old asynchronous failure cannot clear a newer task.
        if (preparingProvider == failedProviderTask) preparingProvider = null;
    }

    private static int integrityErrorCode(Throwable error) {
        Throwable current = error;
        for (int depth = 0; current != null && depth < 4; depth++) {
            if (current instanceof StandardIntegrityException)
                return ((StandardIntegrityException) current).getErrorCode();
            current = current.getCause();
        }
        return Integer.MIN_VALUE;
    }

    private static boolean isTransient(int errorCode) {
        return errorCode == StandardIntegrityErrorCode.NETWORK_ERROR
                || errorCode == StandardIntegrityErrorCode.TOO_MANY_REQUESTS
                || errorCode == StandardIntegrityErrorCode.CANNOT_BIND_TO_SERVICE
                || errorCode == StandardIntegrityErrorCode.GOOGLE_SERVER_UNAVAILABLE
                || errorCode == StandardIntegrityErrorCode.CLIENT_TRANSIENT_ERROR
                || errorCode == StandardIntegrityErrorCode.INTERNAL_ERROR;
    }
}
