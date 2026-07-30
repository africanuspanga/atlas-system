import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/lib/auth";
import { color, font } from "@/lib/theme";

/**
 * Route dispatcher for "/": splash-style loading while auth state restores,
 * then a declarative Redirect to the right surface for this user.
 */
export default function Index() {
  const { session, tenant, isGuardian } = useAuth();

  // Session restoring, or signed-in with membership still resolving.
  if (session === undefined || (session && tenant === undefined)) {
    return (
      <View style={styles.loading}>
        <Text style={styles.wordmark}>ATLAS</Text>
        <ActivityIndicator color={color.primary} />
      </View>
    );
  }

  if (!session) return <Redirect href="/login" />;
  if (tenant) return <Redirect href="/dashboard" />;
  if (isGuardian) return <Redirect href="/portal" />;
  return <Redirect href="/no-school" />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: color.canvas,
  },
  wordmark: {
    fontFamily: font.bold,
    fontSize: 28,
    letterSpacing: 2,
    color: color.primary,
  },
});
