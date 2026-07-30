import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Symbol } from "@/components/symbol";
import { color, font, space } from "@/lib/theme";

/**
 * In-app screen header: modest weight per design.md (no bold display),
 * optional back chevron and right accessory.
 */
export function Header({
  title,
  subtitle,
  back = false,
  right,
}: {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: ReactNode;
}) {
  const router = useRouter();
  return (
    <View style={styles.bar}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        >
          <Symbol
            android="arrow_back"
            ios="chevron.left"
            size={20}
            tint={color.ink}
          />
        </Pressable>
      ) : null}
      <View style={styles.titles}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingVertical: space(3),
    minHeight: 56,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: color.hairline },
  titles: { flex: 1, gap: 1 },
  title: {
    fontFamily: font.medium,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.4,
    color: color.ink,
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 18,
    color: color.body,
  },
  right: { alignItems: "flex-end" },
});
