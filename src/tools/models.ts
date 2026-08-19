import { z } from "zod";
import { HarnessEnum } from "../types.js";
import { listHarnessModels } from "../hcom.js";
import { E_INTERNAL, internalError } from "../errors.js";

const MODEL_RESOURCE_URIS = {
  all: "hcom://models",
  claude: "hcom://models/claude",
  opencode: "hcom://models/opencode",
  codex: "hcom://models/codex",
  antigravity: "hcom://models/antigravity",
  gemini: "hcom://models/gemini",
  kilo: "hcom://models/kilo",
  pi: "hcom://models/pi",
  omp: "hcom://models/omp",
  cursor: "hcom://models/cursor",
  kimi: "hcom://models/kimi",
  copilot: "hcom://models/copilot",
} as const;

function jsonResource(uri: string, payload: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerListModelsTool(server: any) {
  server.tool(
    "list_models",
    "List available models for harness(es). Supports live discovery where the harness CLI exposes a catalog and bundled catalogs where the harness model set is intentionally curated. Returns { results, total }; each result carries harness, status (live/bundled/error), models, count, source, notes. For claude, full model IDs (e.g. claude-opus-4-8) are accepted pass-through in addition to the bundled aliases. antigravity returns an empty catalog (no --model selection). Read-only; no sender identity required. Related: launch (model validation), hcom://models resources.",
    {
      harness: HarnessEnum.optional().describe("Specific harness to query (claude, opencode, codex, antigravity, gemini, kilo, pi, omp, cursor, kimi, copilot). Omit to query all harnesses."),
    },
    async ({ harness }: { harness?: z.infer<typeof HarnessEnum> }) => {
      try {
        const results = await listHarnessModels(harness);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ results, total: results.length }, null, 2),
          }],
        };
      } catch (err: any) {
        return internalError(err);
      }
    }
  );
}

export function registerModelResources(server: any) {
  server.registerResource(
    "models",
    MODEL_RESOURCE_URIS.all,
    {
      title: "Harness model catalogs",
      description: "Model catalog summary for all supported hcom harnesses",
      mimeType: "application/json",
    },
    async () => {
      const results = await listHarnessModels();
      return jsonResource(MODEL_RESOURCE_URIS.all, { results, total: results.length });
    }
  );

  for (const harness of HarnessEnum.options) {
    const uri = MODEL_RESOURCE_URIS[harness];
    server.registerResource(
      `models-${harness}`,
      uri,
      {
        title: `${harness} model catalog`,
        description: `Model catalog for the ${harness} harness`,
        mimeType: "application/json",
      },
      async () => {
        const [result] = await listHarnessModels(harness);
        return jsonResource(uri, result);
      }
    );
  }
}
