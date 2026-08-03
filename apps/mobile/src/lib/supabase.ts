import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing — copy apps/mobile/.env.example to .env",
  );
}
if (!__DEV__ && !url.startsWith("https://")) {
  throw new Error("EXPO_PUBLIC_SUPABASE_URL must use HTTPS in production");
}

// SecureStore can reject large values on some iOS versions. Supabase sessions
// contain JWTs, so split values into conservative chunks and write metadata
// last. The one-time AsyncStorage fallback migrates existing installations.
const CHUNK_SIZE = 1800;
async function secureRemoveItem(key: string) {
  const count = Number(
    (await SecureStore.getItemAsync(`${key}.chunks`)) ?? "0",
  );
  await Promise.all([
    ...Array.from({ length: count }, (_, index) =>
      SecureStore.deleteItemAsync(`${key}.${index}`),
    ),
    SecureStore.deleteItemAsync(`${key}.chunks`),
    AsyncStorage.removeItem(key),
  ]);
}

async function secureSetItem(key: string, value: string) {
  await secureRemoveItem(key);
  const chunks = value.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "gs")) ?? [""];
  await Promise.all(
    chunks.map((chunk, index) =>
      SecureStore.setItemAsync(`${key}.${index}`, chunk, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    ),
  );
  await SecureStore.setItemAsync(`${key}.chunks`, String(chunks.length), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

const secureStorage = {
  async getItem(key: string) {
    const countRaw = await SecureStore.getItemAsync(`${key}.chunks`);
    if (countRaw) {
      const count = Number(countRaw);
      const chunks = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          SecureStore.getItemAsync(`${key}.${index}`),
        ),
      );
      if (chunks.every((chunk): chunk is string => chunk !== null)) {
        return chunks.join("");
      }
    }
    const legacy = await AsyncStorage.getItem(key);
    if (legacy) {
      await secureSetItem(key, legacy);
      await AsyncStorage.removeItem(key);
    }
    return legacy;
  },
  setItem: secureSetItem,
  removeItem: secureRemoveItem,
};

export const supabase = createClient(url, anonKey, {
  auth: {
    storage:
      Platform.OS === "web"
        ? typeof window === "undefined"
          ? undefined
          : AsyncStorage
        : secureStorage,
    autoRefreshToken: true,
    persistSession: Platform.OS !== "web" || typeof window !== "undefined",
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
