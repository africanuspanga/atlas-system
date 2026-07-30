import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { StyleSheet, View, type ColorValue } from "react-native";

type SymbolName = ComponentProps<typeof SymbolView>["name"];
type PlatformNames = Extract<SymbolName, object>;
type IosName = NonNullable<PlatformNames["ios"]>;
type AndroidName = NonNullable<PlatformNames["android"]>;

/**
 * Cross-platform glyph: SF Symbols on iOS, Material Symbols on Android/web,
 * with a neutral dot fallback so a missing glyph never crashes a row.
 */
export function Symbol({
  ios,
  android,
  size = 22,
  tint,
}: {
  ios: IosName;
  android: AndroidName;
  size?: number;
  tint: ColorValue;
}) {
  return (
    <SymbolView
      fallback={
        <View
          style={[
            styles.fallback,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: tint,
            },
          ]}
        />
      }
      name={{ ios, android, web: android }}
      size={size}
      tintColor={tint}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { opacity: 0.35 },
});
