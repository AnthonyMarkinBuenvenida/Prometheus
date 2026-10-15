import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchHealth, fetchModels } from "../lib/api";
import type { DemoLimits, HealthStatus, ModelInfo } from "../types";
import { useSettings } from "./settings";

interface ServerContextValue {
  models: ModelInfo[];
  modelsStatus: "loading" | "ready" | "error";
  modelsError: string | null;
  reloadModels: () => void;
  /** The model new messages are sent to: the user's choice, or the server's default model. */
  activeModel: ModelInfo | null;
  modelLabel: (id?: string) => string;
  /** Deployment limits from the server (null until models load). */
  limits: DemoLimits | null;
  health: HealthStatus;
  healthMessage: string;
  recheckHealth: () => void;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [limits, setLimits] = useState<DemoLimits | null>(null);
  const [modelsStatus, setModelsStatus] = useState<ServerContextValue["modelsStatus"]>("loading");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthStatus>("checking");
  const [healthMessage, setHealthMessage] = useState("Checking connection…");

  const reloadModels = useCallback(() => {
    setModelsStatus("loading");
    setModelsError(null);
    fetchModels()
      .then((r) => {
        setModels(r.models);
        setDefaultModel(r.defaultModel);
        setLimits(r.limits ?? null);
        setModelsStatus("ready");
      })
      .catch((err: Error) => {
        setModelsError(err.message);
        setModelsStatus("error");
      });
  }, []);

  const checkHealth = useCallback((fresh: boolean) => {
    setHealth("checking");
    setHealthMessage("Checking connection…");
    fetchHealth(fresh).then((r) => {
      setHealth(r.status);
      setHealthMessage(r.message);
    });
  }, []);

  // User-initiated and error-triggered checks always ask the providers again.
  const recheckHealth = useCallback(() => checkHealth(true), [checkHealth]);

  useEffect(() => {
    reloadModels();
    checkHealth(false);
  }, [reloadModels, checkHealth]);

  // The user's saved choice if it still exists, else the server's default model, else the first one.
  // (A saved "auto" from before automatic selection was removed simply doesn't match a model.)
  const activeModel = models.find((m) => m.id === settings.model) ?? models.find((m) => m.id === defaultModel) ?? models[0] ?? null;

  const modelLabel = useCallback(
    (id?: string) => models.find((m) => m.id === id)?.label ?? id?.split("/").pop()?.replace(/:free$/, "") ?? "Assistant",
    [models],
  );

  const value = useMemo(
    () => ({ models, modelsStatus, modelsError, reloadModels, activeModel, modelLabel, limits, health, healthMessage, recheckHealth }),
    [models, modelsStatus, modelsError, reloadModels, activeModel, modelLabel, limits, health, healthMessage, recheckHealth],
  );
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServer must be used inside ServerProvider");
  return ctx;
}
