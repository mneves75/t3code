import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function UsageLimitFallbackSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["usageLimitFallbackModelSelection"]);
  const { environment, target } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target?.projectId ?? null,
    ),
  );
  const enabled = settings.usageLimitFallbackModelSelection !== null;
  const selection = resolveDefaultProviderModelSelection(
    providers,
    settings.usageLimitFallbackModelSelection,
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const disabledReason = useScopedModelDisabledReason(settings, entries);

  const setFallback = (value: ModelSelection | null) => {
    const reason = value ? disabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Fallback model not saved", description: reason });
      return;
    }
    updateSettings({ usageLimitFallbackModelSelection: value });
  };

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("usage-limit-fallback")}
      description="When a thread stops on a usage limit, continue it at once on this model, which receives the thread's history. Threads already on this model wait for the reset."
      settingKeys={["usageLimitFallbackModelSelection"]}
      mixed={mixed}
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(enabled || mixed) && selection ? (
            <ProviderModelPicker
              environmentId={environment?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Usage-limit fallback model"
              {...(mixed ? { triggerLabel: "Mixed" } : {})}
              getModelDisabledReason={disabledReason}
              onInstanceModelChange={(instanceId, model) =>
                setFallback(createModelSelection(instanceId, model))
              }
            />
          ) : null}
          <Switch
            mixed={mixed}
            checked={mixed ? false : enabled}
            disabled={!enabled && selection === null}
            onCheckedChange={(checked) => setFallback(checked ? selection : null)}
            aria-label="Continue limited threads on another model"
          />
        </div>
      }
    />
  );
}
