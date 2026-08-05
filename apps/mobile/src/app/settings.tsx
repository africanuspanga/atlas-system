import Constants from "expo-constants";
import { Redirect } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "@/components/card";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { PillButton } from "@/components/pill-button";
import { Screen } from "@/components/screen";
import { Symbol } from "@/components/symbol";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { color, font, radius, space } from "@/lib/theme";

export default function Settings() {
  const t = useT();
  const { session, tenant, signOut } = useAuth();

  if (session === null) return <Redirect href="/login" />;

  const email = session?.user.email ?? "—";
  const fullName =
    (session?.user.user_metadata as { full_name?: string } | undefined)
      ?.full_name ?? email;
  const version = Constants.expoConfig?.version ?? "1.0.0";

  return (
    <Screen edges={["top", "bottom"]}>
      <Header back title={t("settings.title")} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Card>
          {tenant ? (
            <ListRow
              icon={
                <Symbol
                  android="school"
                  ios="building.columns"
                  size={16}
                  tint={color.ink}
                />
              }
              subtitle={t("portal.school")}
              title={tenant.name}
            />
          ) : null}
          <ListRow
            icon={
              <Symbol android="person" ios="person.fill" size={16} tint={color.ink} />
            }
            last
            subtitle={`${t("settings.signedInAs")} ${email}`}
            title={fullName}
          />
        </Card>

        <PillButton
          onPress={() => void signOut()}
          title={t("user.logout")}
          variant="destructive-text"
        />

        <Text style={styles.version}>
          {t("settings.appVersion")} <Text style={styles.versionNo}>{version}</Text>
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: space(4), paddingBottom: space(8) },
  version: {
    fontFamily: font.regular,
    fontSize: 12,
    color: color.muted,
    textAlign: "center",
  },
  versionNo: { fontFamily: font.mono },
});
