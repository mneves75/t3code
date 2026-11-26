import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
  isImplicitTextGenerationSelection,
  localTextGenerationModelSelection,
  withLowReasoningOption,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { orderProviderSnapshots } from "../provider/providerStatusCache.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as TextGenerators from "./TextGenerators.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateTranscriptionPostProcessing";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    requested: ModelSelection,
    projectId: ProjectId | null | undefined,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const textGenerator = yield* textGenerators.runner(requested.instanceId);
    // A review guide reaches a text generator only through a fallback; it needs an agent instead.
    const textGeneratorId = requested.instanceId;
    const textGeneratorCannotRun =
      textGenerator !== undefined && operation === "generateReviewGuide";
    if (textGenerator !== undefined && !textGeneratorCannotRun) {
      return yield* invoke(
        TextGenerationOperations.fromRunner("TextGenerator", textGenerator),
        requested,
      );
    }
    const snapshots = orderProviderSnapshots(
      yield* registry.listInstances.pipe(
        Effect.flatMap((instances) =>
          Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
        ),
      ),
    );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not read text generation settings.",
            cause,
          }),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const canRun = (provider: ServerProvider, model: string) =>
      provider.enabled &&
      resolveProjectProviderInstanceEnabled(settings, projectId ?? null, provider.instanceId) &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      provider.status !== "error" &&
      isProviderAvailable(provider) &&
      isProviderTextGenerationCapable(provider) &&
      (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(provider.driver)) &&
      !exhaustedUsageWindow(provider, now, model);
    // "Local models only" holds even before any instance is marked local.
    const localPolicy = settings.textGenerationFallback !== "any";
    const noLocalModel = new TextGenerationError({
      operation,
      detail:
        operation === "generateReviewGuide"
          ? "Review guides need a Codex or Claude instance, and no local one is ready. Link one to a model server, or allow any provider in Settings, Models."
          : "No local model is ready for background writing. Set up a local model, or allow any provider in Settings, Models.",
    });

    let selection = requested;
    let substituted = false;
    if (isImplicitTextGenerationSelection(settings, selection)) {
      const local = localTextGenerationModelSelection(snapshots, (provider) =>
        canRun(provider, ""),
      );
      if (local !== null) {
        selection = local;
        substituted = true;
      } else if (localPolicy) return yield* noLocalModel;
    }

    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    const selectedDisabled = selected?.enabled === false;
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      textGeneratorCannotRun ||
      selectedDisabled ||
      (selected?.enabled === true &&
        (!isProviderTextGenerationCapable(selected) ||
          selected.models.find((model) => model.slug === selection.model)
            ?.supportsTextGeneration === false ||
          (selected.status === "error" &&
            (!selected.installed || selected.auth.status === "unauthenticated")))) ||
      (operation === "generateReviewGuide" &&
        selected !== undefined &&
        !INVESTIGATING_DRIVERS.has(selected.driver));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
      const rejected = selection;
      const usableCandidate = (provider: ServerProvider, model: string) =>
        canRun(provider, model) &&
        (model === "" ||
          provider.models.find((candidate) => candidate.slug === model)?.supportsTextGeneration !==
            false);
      const fallbackWhere = (sameInstance: boolean) =>
        fallbackTextGenerationModelSelection(
          settings.providerInstances,
          (instanceId, driver, model) => {
            const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
            const targetModel = model || defaultTextGenerationModel(driver);
            return (
              provider !== undefined &&
              (sameInstance
                ? targetModel !== rejected.model
                : instanceId !== rejected.instanceId) &&
              usableCandidate(provider, targetModel)
            );
          },
          {
            includeConfiguredInstances: true,
            defaultModelSelection: settings.defaultModelSelection,
            policy: settings.textGenerationFallback,
            inferenceServers: settings.inferenceServers,
          },
        );
      // Local instance first, then another instance, then the rejected instance's other models.
      const fallback =
        settings.textGenerationFallback === "none"
          ? null
          : (localTextGenerationModelSelection(
              snapshots,
              (provider) =>
                provider.instanceId !== rejected.instanceId && usableCandidate(provider, ""),
            ) ??
            fallbackWhere(false) ??
            fallbackWhere(true));
      if (fallback !== null) {
        selection = fallback;
        substituted = true;
      } else if (localPolicy) return yield* noLocalModel;
    }
    // Only a selection T3 chose; one the user picked keeps the options they gave it.
    if (substituted) {
      const provider = snapshots.find((candidate) => candidate.instanceId === selection.instanceId);
      if (provider?.inference === "local") selection = withLowReasoningOption(selection, provider);
    }
    if (textGeneratorCannotRun && selection.instanceId === textGeneratorId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control & issues.",
      });
    }
    if (selectedDisabled && selection.instanceId === selected.instanceId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "No text generation provider is available. Enable a provider that can generate text in Settings → Providers.",
      });
    }
    return yield* installationGate.execute(
      selection.instanceId,
      resolveInstance(registry, operation, selection.instanceId).pipe(
        Effect.flatMap((service) => invoke(service, selection)),
      ),
    );
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        null,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(
  Layer.provideMerge(TextGenerators.layer),
);
