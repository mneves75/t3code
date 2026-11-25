import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { render } from "../../../test/render";
import { AccountRotationSettings } from "./AccountRotationSettings";

const environmentId = EnvironmentId.make("env-1");
const codexA = ProviderInstanceId.make("codex");
const codexB = ProviderInstanceId.make("codex_alias");
const codexOff = ProviderInstanceId.make("codex_disabled");

describe("AccountRotationSettings", () => {
  it("shows duplicate logins even when one alias omits workspaceId, and surfaces disabled marked accounts", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      accountRotationEnabled: true,
      accountRotationInstances: { [environmentId]: [codexA, codexB, codexOff] },
    });

    await using _screen = await render(
      <AccountRotationSettings
        environmentId={environmentId}
        instances={[
          {
            instanceId: codexA,
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex A",
            enabled: true,
            email: "dev@example.com",
            workspaceId: "ws-berlin",
          },
          {
            instanceId: codexB,
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex B",
            enabled: true,
            email: "dev@example.com",
          },
          {
            instanceId: codexOff,
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Old",
            enabled: false,
          },
        ]}
      />,
    );

    await expect.element(page.getByText("Codex A")).toBeVisible();
    await expect.element(page.getByText("dev@example.com").first()).toBeVisible();
    await expect.element(page.getByText("Codex Old")).toBeVisible();
    await expect.element(page.getByText("Disabled")).toBeVisible();
  });
});
