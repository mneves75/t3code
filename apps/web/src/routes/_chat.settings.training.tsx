import { createFileRoute } from "@tanstack/react-router";

import { TrainingSettingsPanel } from "../components/settings/TrainingSettings";

export const Route = createFileRoute("/_chat/settings/training")({
  component: TrainingSettingsPanel,
});
