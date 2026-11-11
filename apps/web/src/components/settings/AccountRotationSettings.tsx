import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AccountRotationSettings({
  environmentId,
  instances,
}: {
  environmentId: EnvironmentId;
  instances: ReadonlyArray<{
    instanceId: ProviderInstanceId;
    driver: ProviderDriverKind;
    displayName: string;
    enabled: boolean;
  }>;
}) {
  const settings = useClientSettings((current) => ({
    accountRotationEnabled: current.accountRotationEnabled,
    accountRotationInstances: current.accountRotationInstances,
  }));
  const settingsHydrated = useClientSettingsHydrated();

  const enabledByDriver = new Map<ProviderDriverKind, number>();
  for (const instance of instances) {
    if (instance.enabled) {
      enabledByDriver.set(instance.driver, (enabledByDriver.get(instance.driver) ?? 0) + 1);
    }
  }
  const accounts = instances.filter(
    (instance) => instance.enabled && (enabledByDriver.get(instance.driver) ?? 0) >= 2,
  );
  // Stays while rotation is on, so marks left from before can still be switched off.
  if (accounts.length === 0 && !settings.accountRotationEnabled) return null;

  const marked = settings.accountRotationInstances[environmentId] ?? [];
  const setMarked = (instanceId: ProviderInstanceId, value: boolean) => {
    const others = marked.filter((id) => id !== instanceId);
    updateClientSettings({
      accountRotationInstances: {
        ...settings.accountRotationInstances,
        [environmentId]: value ? [...others, instanceId] : others,
      },
    });
  };

  return (
    <SettingsSection title="Account rotation">
      <SettingsRow
        {...searchableSetting("rotate-provider-accounts")}
        description="Start each new thread on the marked account with the most usage left."
        control={
          <Switch
            aria-label="Rotate accounts for new threads"
            checked={settings.accountRotationEnabled}
            disabled={!settingsHydrated}
            onCheckedChange={(accountRotationEnabled) =>
              updateClientSettings({ accountRotationEnabled })
            }
          />
        }
      />
      {settings.accountRotationEnabled
        ? accounts.map((account) => (
            <SettingsRow
              key={account.instanceId}
              title={account.displayName}
              control={
                <Switch
                  aria-label={`Include ${account.displayName} in account rotation`}
                  checked={marked.includes(account.instanceId)}
                  disabled={!settingsHydrated}
                  onCheckedChange={(checked) => setMarked(account.instanceId, checked)}
                />
              }
            />
          ))
        : null}
    </SettingsSection>
  );
}
