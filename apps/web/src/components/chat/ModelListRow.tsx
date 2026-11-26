import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { serverSuffixOf } from "./ProviderModelPicker.logic";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  serverName?: string | undefined;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  /** In Favorites every row is starred, so the star shows only on hover. */
  favoriteStarOnHover?: boolean;
  isSelected: boolean;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const gt = useGT();
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };
  const displayName = getDisplayModelName(model);
  const serverSuffix = serverSuffixOf(displayName, props.serverName);
  const baseName = serverSuffix === null ? displayName : displayName.slice(0, -serverSuffix.length);
  // A server's models share their organization ("mlx-community/"), so it gives way first.
  const organization =
    serverSuffix === null ? "" : baseName.slice(0, baseName.lastIndexOf("/") + 1);
  // The logo is decorative, so name the provider for screen readers.
  const providerLabel = <span className="sr-only">, {props.providerDisplayName}</span>;

  const row = (
    <ComboboxItem
      hideIndicator
      selectedFill={false}
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      {/* One row shape in every tab: the logo names the provider, so Favorites needs no second line. */}
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        acpRegistryAgentId={props.acpRegistryAgentId}
        acpRegistryIconUrl={props.acpRegistryIconUrl}
        showBadge={props.showInstanceBadge}
        className="size-4"
        iconClassName="size-4"
        indicatorBackground="var(--popover)"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div
          className="flex min-w-0 text-sm font-normal leading-snug"
          // Names the row in full on hover only when part of it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            const parts = Array.from(name.querySelectorAll("span:not(.sr-only)"));
            const cut = parts.some((part) => part.scrollWidth > part.clientWidth);
            name.title = cut ? displayName : "";
          }}
        >
          {serverSuffix === null ? (
            <span className="min-w-0 truncate">
              {displayName}
              {providerLabel}
            </span>
          ) : (
            <>
              {/* Each part shrinks only once the one before it is gone; the server, capped, stays. */}
              {organization ? <span className="min-w-0 truncate">{organization}</span> : null}
              <span className="flex min-w-0 max-w-full shrink-0">
                <span className="min-w-0 truncate">{baseName.slice(organization.length)}</span>
                <span className="max-w-24 shrink-0 overflow-hidden text-ellipsis whitespace-pre">
                  {serverSuffix}
                  {providerLabel}
                </span>
              </span>
            </>
          )}
        </div>
        {props.isSelected ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        {/* A linked server's models carry the gateway's provider id; the server's name replaces it. */}
        {props.subProvider && serverSuffix === null ? (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
            {props.subProvider}
          </span>
        ) : null}
        {props.showNewBadge ? (
          <span
            className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
            aria-label={gt("New model")}
          >
            {gt("New", { $context: "badge on a newly added model" })}
          </span>
        ) : null}
        {props.unavailable ? (
          <Badge variant="outline" size="sm">
            <T context="badge on a model that cannot be selected">Unavailable</T>
          </Badge>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <SharedTooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFavorite(props.instanceId, props.slug);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              disabled={Boolean(props.disabledReason)}
              aria-label={props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
            >
              <StarIcon
                className={cn(
                  "size-3.5 sm:size-3",
                  props.isFavorite && "fill-current text-warning",
                  (!props.isFavorite || props.favoriteStarOnHover) &&
                    "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                )}
              />
            </Button>
          }
          label={props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
          align="center"
        />
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <SharedTooltipTrigger render={row} label={props.disabledReason} side="left" align="center" />
  );
});
