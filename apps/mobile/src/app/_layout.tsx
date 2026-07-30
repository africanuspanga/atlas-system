import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AuthProvider, useAuth } from "@/lib/auth";
import { LangProvider } from "@/lib/i18n";
import { color } from "@/lib/theme";

// Keep the native splash up until fonts are ready and the session restored.
void SplashScreen.preventAutoHideAsync();

/** Hides the splash once session restore settles (fonts gate rendering). */
function SplashGate() {
  const { session } = useAuth();
  useEffect(() => {
    if (session !== undefined) void SplashScreen.hideAsync();
  }, [session]);
  return null;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_500Medium,
  });

  if (!fontsLoaded) return null; // native splash stays visible

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <LangProvider>
        <AuthProvider>
          <SplashGate />
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: color.canvas },
            }}
          />
        </AuthProvider>
      </LangProvider>
    </GestureHandlerRootView>
  );
}
