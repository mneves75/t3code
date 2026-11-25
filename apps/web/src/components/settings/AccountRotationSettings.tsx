import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { resolveAccountIdentities } from "@t3tools/client-runtime/account-rotation";
import { useGT } from "gt-react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

interface RotationAccountRow {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
}

export function AccountRotationSettings({
  environmentId,
  instances,
}: {
  environmentId: EnvironmentId;
  instances: ReadonlyArray<RotationAccountRow>;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useClientSettings((current) => ({
    accountRotationEnabled: current.accountRotationEnabled,
    accountRotationInstances: current.accountRotationInstances,
  }));
  const settingsHydrated = useClientSettingsHydrated();

  const marked = settings.accountRotationInstances[environmentId] ?? [];
  const markedSet = new Set(marked);
  const enabledByDriver = new Map<ProviderDriverKind, number>();
  for (const instance of instances) {
    if (instance.enabled) {
      enabledByDriver.set(instance.driver, (enabledByDriver.get(instance.driver) ?? 0) + 1);
    }
  }
  const accounts = instances.filter(
    (instance) =>
      (instance.enabled && (enabledByDriver.get(instance.driver) ?? 0) >= 2) ||
      (settings.accountRotationEnabled && markedSet.has(instance.instanceId)),
  );
  // Stays while rotation is on, so marks left from before can still be switched off.
  if (accounts.length === 0 && !settings.accountRotationEnabled) return null;

  const enabledAccounts = accounts.filter((account) => account.enabled);
  const identities = resolveAccountIdentities(enabledAccounts);
  const identityCounts = new Map<string, number>();
  for (const account of enabledAccounts) {
    const identity = identities.get(account.instanceId);
    if (identity) identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }

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
    <SettingsSection title={gt("Account rotation")}>
      <SettingsRow
        {...searchableSetting("rotate-provider-accounts")}
        description={gt("Start each new thread on the marked account with the most usage left.")}
        control={
          <Switch
            aria-label={gt("Rotate accounts for new threads")}
            checked={settings.accountRotationEnabled}
            disabled={!settingsHydrated}
            onCheckedChange={(accountRotationEnabled) =>
              updateClientSettings({ accountRotationEnabled })
            }
          />
        }
      />
      {settings.accountRotationEnabled
        ? accounts.map((account) => {
            const identity = account.enabled ? identities.get(account.instanceId) : undefined;
            const description = !account.enabled
              ? gt("Disabled")
              : identity && (identityCounts.get(identity) ?? 0) >= 2
                ? account.email
                : undefined;
            return (
              <SettingsRow
                key={account.instanceId}
                title={account.displayName}
                description={description}
                control={
                  <Switch
                    aria-label={gt("Include {name} in account rotation", {
                      name: account.displayName,
                    })}
                    checked={markedSet.has(account.instanceId)}
                    disabled={!settingsHydrated}
                    onCheckedChange={(checked) => setMarked(account.instanceId, checked)}
                  />
                }
              />
            );
          })
        : null}
    </SettingsSection>
  );
}
