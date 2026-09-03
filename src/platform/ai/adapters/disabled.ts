/**
 * H28 — the default adapter: fails closed. No key, no network, no model.
 */
import { AdapterError, type AiAdapter } from "./types";

export const disabledAdapter: AiAdapter = {
  key: "disabled",
  complete: async () => {
    throw new AdapterError("disabled", "no AI provider is configured", { retryable: false });
  },
};
