import Constants from "expo-constants";

import { supabase } from "./supabase";

/**
 * Resolve the ATLAS API base URL.
 * - EXPO_PUBLIC_API_URL wins when set (staging/production builds).
 * - In Expo Go dev, derive the LAN host from the dev server so a physical
 *   phone reaches the API on the same machine without any configuration
 *   (localhost on a device would point at the phone itself).
 */
export function apiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    return `http://${host}:4000`;
  }
  return "http://localhost:4000";
}

/** Authenticated ATLAS API call with tenant context — mirrors web apiFetch. */
export async function apiFetch(
  path: string,
  options: RequestInit & { tenantId?: string } = {},
): Promise<Response> {
  const { tenantId, ...init } = options;
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(tenantId ? { "x-tenant-id": tenantId } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}
