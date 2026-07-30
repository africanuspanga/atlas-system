import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { apiFetch } from "./api";

/**
 * Push notification plumbing for ATLAS mobile.
 *
 * IMPORTANT — Expo Go limitation: since SDK 53, REMOTE push notifications do
 * NOT work in Expo Go on Android. Testing real pushes requires a development
 * build (`eas build --profile development`). Local notifications still work
 * in Expo Go, and this module degrades gracefully (returns null) everywhere
 * a token cannot be obtained: simulator, web, permission denied, or no EAS
 * projectId configured yet (`eas init` sets extra.eas.projectId in app.json).
 *
 * Sending is NOT a client concern: the API only stores tokens
 * (public.device_tokens, migration 0028); a future outbox-style worker will
 * do the actual Expo Push API sends.
 */

// Foreground behavior: show incoming notifications as banners and in the
// notification list (SDK 57 shape — shouldShowAlert is deprecated).
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

/** Last token this session successfully registered with the API. */
let registeredToken: string | null = null;

function easProjectId(): string | null {
  // Set by `eas init`; also present in EAS builds via easConfig.
  const fromExtra = (
    Constants.expoConfig?.extra as
      | { eas?: { projectId?: string } }
      | undefined
  )?.eas?.projectId;
  return fromExtra ?? Constants.easConfig?.projectId ?? null;
}

/**
 * Ask for permission, obtain the Expo push token and register it with the
 * ATLAS API (POST /api/v1/devices — AuthGuard only, so parents without a
 * tenant membership can register too; tenantId is optional routing context).
 *
 * Returns the Expo push token, or null when push is unavailable/denied —
 * callers should treat null as "no push on this device" and move on.
 */
export async function registerForPushNotifications(
  tenantId?: string,
): Promise<string | null> {
  // Push tokens only exist on physical iOS/Android devices.
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  if (!Device.isDevice) return null;

  // Android requires a channel before the permission prompt can appear.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: "#0052ff",
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") return null;

  const projectId = easProjectId();
  if (!projectId) {
    // `eas init` has not been run — remote push is not configured yet.
    console.warn("notifications: no EAS projectId, skipping push token");
    return null;
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId,
    });
    const response = await apiFetch("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({
        token,
        platform: Platform.OS,
        ...(tenantId ? { tenantId } : {}),
      }),
    });
    if (!response.ok) {
      console.warn(`notifications: device registration ${response.status}`);
      return null;
    }
    registeredToken = token;
    return token;
  } catch (error) {
    // In Expo Go on Android (SDK 53+) getExpoPushTokenAsync rejects — see
    // the module doc comment. Never let push setup crash the app.
    console.warn("notifications: push registration failed", error);
    return null;
  }
}

/**
 * Remove this device's push token from the ATLAS API (DELETE /api/v1/devices).
 * Call on sign-out so a shared device stops receiving the old user's pushes.
 * No-op when nothing was registered this session and no token is obtainable.
 */
export async function unregisterPushToken(): Promise<void> {
  let token = registeredToken;
  if (!token) {
    const projectId = easProjectId();
    if (!projectId || !Device.isDevice) return;
    try {
      token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch {
      return;
    }
  }
  try {
    await apiFetch("/api/v1/devices", {
      method: "DELETE",
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    console.warn("notifications: device unregister failed", error);
  } finally {
    registeredToken = null;
  }
}
