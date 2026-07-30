import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { AppState } from "react-native";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing — copy apps/mobile/.env.example to .env",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // On native, `window` exists (RN global); in expo-router's Node SSR
    // pass (used only for the incidental web target) AsyncStorage's web
    // shim would touch `window` — fall back to in-memory there.
    storage: typeof window === "undefined" ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: typeof window !== "undefined",
    detectSessionInUrl: false,
  },
});

// Refresh tokens only while the app is foregrounded (Supabase RN guidance).
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    void supabase.auth.startAutoRefresh();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
});
