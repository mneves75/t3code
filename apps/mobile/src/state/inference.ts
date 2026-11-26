import { createInferenceAtoms } from "@t3tools/client-runtime/state/inference";

import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export const inferenceAtoms = createInferenceAtoms(serverEnvironment, environmentThreadShells);
