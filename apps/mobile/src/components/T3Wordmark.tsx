import type { ColorValue } from "react-native";
import Svg, { Text as SvgText } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedText = withUniwind(SvgText);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 132 / 58;
  return (
    <Svg
      accessibilityLabel="mn3"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 132 58"
    >
      <ThemedText
        x="0"
        y="48"
        fontSize="52"
        fontWeight="800"
        letterSpacing="-2"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      >
        mn3
      </ThemedText>
    </Svg>
  );
}
