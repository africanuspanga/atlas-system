import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { Symbol } from "@/components/symbol";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { color, font } from "@/lib/theme";

export default function TabsLayout() {
  const t = useT();
  const { session, tenant, isGuardian } = useAuth();

  // Restoring session / resolving membership — keep a quiet loading floor.
  if (session === undefined || (session && tenant === undefined)) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={color.primary} />
      </View>
    );
  }
  if (!session) return <Redirect href="/login" />;
  if (!tenant) return <Redirect href={isGuardian ? "/portal" : "/no-school"} />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.primary,
        tabBarInactiveTintColor: color.muted,
        tabBarLabelStyle: styles.tabLabel,
        tabBarStyle: styles.tabBar,
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: t("nav.overview"),
          tabBarIcon: ({ color: tint }) => (
            <Symbol android="home" ios="house.fill" size={24} tint={tint} />
          ),
        }}
      />
      <Tabs.Screen
        name="students"
        options={{
          title: t("nav.students"),
          tabBarIcon: ({ color: tint }) => (
            <Symbol android="group" ios="person.2.fill" size={24} tint={tint} />
          ),
        }}
      />
      <Tabs.Screen
        name="attendance"
        options={{
          title: t("nav.attendance"),
          tabBarIcon: ({ color: tint }) => (
            <Symbol
              android="fact_check"
              ios="checkmark.circle.fill"
              size={24}
              tint={tint}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="finance"
        options={{
          title: t("nav.finance"),
          tabBarIcon: ({ color: tint }) => (
            <Symbol
              android="payments"
              ios="creditcard.fill"
              size={24}
              tint={tint}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="assistant"
        options={{
          title: t("nav.assistant"),
          tabBarIcon: ({ color: tint }) => (
            <Symbol android="auto_awesome" ios="sparkles" size={24} tint={tint} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.canvas,
  },
  tabLabel: { fontFamily: font.medium, fontSize: 11 },
  tabBar: {
    backgroundColor: color.canvas,
    borderTopColor: color.hairline,
  },
});
