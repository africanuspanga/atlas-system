import { StyleSheet, TextInput, View } from "react-native";

import { Symbol } from "@/components/symbol";
import { color, font, radius, space } from "@/lib/theme";

/** 12px-radius search input with a leading glyph — 44px tall. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.wrap}>
      <Symbol
        android="search"
        ios="magnifyingglass"
        size={18}
        tint={color.muted}
      />
      <TextInput
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.mutedSoft}
        returnKeyType="search"
        style={styles.input}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    height: 44,
    borderRadius: radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    backgroundColor: color.canvas,
    paddingHorizontal: space(3),
  },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    color: color.ink,
    paddingVertical: 0,
  },
});
