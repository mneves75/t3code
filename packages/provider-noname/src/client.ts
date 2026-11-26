/**
 * NoName's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-noname/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { NoNameSettings } from "./settings.ts";

const TILE = "M5 0H19A5 5 0 0 1 24 5V19A5 5 0 0 1 19 24H5A5 5 0 0 1 0 19V5A5 5 0 0 1 5 0Z";
const LETTER = "M6.5 18V6H9L15 14.2V6H17.5V18H15L9 9.8V18Z";

export const noNameClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("noname"),
  label: "NoName",
  featured: false,
  settingsSchema: NoNameSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#1F6F5C", dark: "#3FB58F" },
    // The letter is a hole in the tile, so a monochrome icon still shows it.
    paths: [{ d: `${TILE}${LETTER}`, fillRule: "evenodd" }],
  },
});
