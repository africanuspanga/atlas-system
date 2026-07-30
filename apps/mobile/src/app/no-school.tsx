import { Redirect } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { PillButton } from "@/components/pill-button";
import { Screen } from "@/components/screen";
import { Symbol } from "@/components/symbol";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { color, font, space } from "@/lib/theme";

/** Signed in, but neither a school member nor a linked guardian. */
export default function NoSchool() {
  const t = useT();
  const { session, tenant, isGuardian, signOut } = useAuth();

  if (session === null) return <Redirect href="/login" />;
  if (tenant) return <Redirect href="/dashboard" />;
  if (isGuardian) return <Redirect href="/portal" />;

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.center}>
        <View style={styles.plate}>
          <Symbol
            android="school"
            ios="building.columns"
            size={30}
            tint={color.muted}
          />
        </View>
        <Text style={styles.title}>{t("noSchool.title")}</Text>
        <Text style={styles.desc}>{t("noSchool.desc")}</Text>
        <PillButton
          onPress={() => void signOut()}
          style={styles.action}
          title={t("user.logout")}
          variant="secondary"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space(3),
    paddingHorizontal: space(4),
  },
  plate: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space(2),
  },
  title: {
    fontFamily: font.semibold,
    fontSize: 18,
    lineHeight: 24,
    color: color.ink,
    textAlign: "center",
  },
  desc: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 22,
    color: color.body,
    textAlign: "center",
  },
  action: { marginTop: space(4), minWidth: 180 },
});
