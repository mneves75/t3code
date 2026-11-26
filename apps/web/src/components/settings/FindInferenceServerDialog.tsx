import type {
  EnvironmentId,
  InferenceDiscoveredServer,
  InferenceServerConfig,
  InferenceServerId,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT, Var } from "gt-react";
import { useContext, useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { repairCandidates } from "./localModelSetup.logic";

type Search =
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly servers: ReadonlyArray<InferenceDiscoveredServer> }
  | { readonly status: "failed"; readonly message: string };

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Looks on a registered server's host for where it went, and moves the server there. The id stays,
 * so linked agents and their `t3-<server>/<model>` models keep working; the saved key goes along.
 */
export function FindInferenceServerDialog({
  environmentId,
  id,
  name,
  config,
  knownModelIds,
  onChangeAddress,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: InferenceServerId;
  readonly name: string;
  readonly config: InferenceServerConfig;
  /** Models it served before, to point out a candidate that serves them too. */
  readonly knownModelIds: ReadonlySet<string>;
  readonly onChangeAddress: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refresh = useAtomCommand(serverEnvironment.refreshInferenceServers, {
    reportFailure: false,
  });
  const [search, setSearch] = useState<Search>({ status: "searching" });
  const [moving, setMoving] = useState<string | null>(null);
  const host = hostOf(config.baseUrl);
  const hostLabel = host ?? gt("its host");

  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- searches the server's host once when the dialog opens
  useEffect(() => {
    let active = true;
    void runAtomCommand(
      registry,
      serverEnvironment.discoverInferenceServers,
      { environmentId, input: host === undefined ? {} : { host } },
      { label: "find inference server", reportFailure: false, reportDefect: true },
    ).then((result) => {
      if (!active) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setSearch({
          status: "failed",
          message: error instanceof Error ? error.message : gt("The search failed."),
        });
        return;
      }
      setSearch({ status: "done", servers: result.value.servers });
    });
    return () => {
      active = false;
    };
  }, [environmentId, gt, registry, host]);

  const candidates =
    search.status === "done"
      ? repairCandidates(search.servers, id, config.baseUrl, knownModelIds)
      : [];

  const move = async (baseUrl: string) => {
    setMoving(baseUrl);
    const saved = await saveSettings({
      environmentId,
      input: { patch: { inferenceServers: { [id]: { ...config, baseUrl } } } },
    });
    if (saved._tag === "Failure") {
      setMoving(null);
      const error = squashAtomCommandFailure(saved);
      toastManager.add({
        type: "error",
        title: gt("{name} was not moved", { name }),
        description: error instanceof Error ? error.message : gt("The settings update failed."),
      });
      return;
    }
    const checked = await refresh({ environmentId, input: { id } });
    const snapshot =
      checked._tag === "Success"
        ? checked.value.inferenceServers.find((server) => server.id === id)
        : undefined;
    toastManager.add({
      type: snapshot?.status === "ready" ? "success" : "warning",
      title:
        snapshot?.status === "ready"
          ? gt("{name} now uses {baseUrl}", { name, baseUrl })
          : gt("{name} moved to {baseUrl}, but is not ready", { name, baseUrl }),
      description:
        snapshot?.status === "ready"
          ? gt("Threads already running keep the old address until their agent session restarts.")
          : (snapshot?.message ?? gt("Check its address in Settings, Inference.")),
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && moving === null) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>
              Find <Var>{name}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>
              <Var>{name}</Var> does not answer at <Var>{config.baseUrl}</Var>. Looking for model
              servers on <Var>{hostLabel}</Var> that it may have moved to.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {search.status === "searching" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-4" />
              <T>
                Searching <Var>{hostLabel}</Var>…
              </T>
            </p>
          ) : search.status === "failed" ? (
            <p className="text-sm text-destructive">{search.message}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>
                Nothing else answered on <Var>{hostLabel}</Var>. If you know where it moved, change
                its address.
              </T>
            </p>
          ) : (
            <ul className="grid gap-2">
              {candidates.map(({ server, sameModel }) => (
                <li
                  key={server.baseUrl}
                  className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                      {server.baseUrl}
                      {sameModel ? (
                        <Badge variant="success">
                          <T>Same model</T>
                        </Badge>
                      ) : null}
                      {server.status === "needs-key" ? (
                        <Badge variant="outline">
                          <T>
                            Uses <Var>{name}</Var>&apos;s key
                          </T>
                        </Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[server.engine, ...server.models.map((model) => model.id)]
                        .filter(Boolean)
                        .join(" · ") || gt("Lists its models only with a key")}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant={sameModel ? "default" : "outline"}
                    disabled={moving !== null}
                    onClick={() => void move(server.baseUrl)}
                  >
                    {moving === server.baseUrl ? <Spinner className="size-3.5" /> : null}
                    <T>Use this address</T>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={moving !== null} onClick={onChangeAddress}>
            <T>Change address</T>
          </Button>
          <Button variant="ghost" disabled={moving !== null} onClick={onClose}>
            <T>Cancel</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
