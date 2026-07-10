import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";

export type AppUpdateState = {
  phase: AppUpdatePhase;
  currentVersion: string | null;
  version: string | null;
  body: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
};

const idleState: AppUpdateState = {
  phase: "idle",
  currentVersion: null,
  version: null,
  body: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

const initialCheckDelayMs = 3_500;
const foregroundRecheckAgeMs = 60 * 60 * 1_000;
const periodicCheckIntervalMs = 6 * 60 * 60 * 1_000;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const closeUpdate = (update: Update) => {
  void update.close().catch((error) => {
    console.warn("Failed to release AgentSpace updater resources:", error);
  });
};

export function useAppUpdater(enabled: boolean) {
  const [state, setState] = useState<AppUpdateState>(idleState);
  const updateRef = useRef<Update | null>(null);
  const mountedRef = useRef(false);
  const checkingRef = useRef(false);
  const dismissedVersionRef = useRef<string | null>(null);
  const lastCheckAtRef = useRef(0);
  const operationRef = useRef(0);

  const checkNow = useCallback(async (showError = false) => {
    if (!enabled || checkingRef.current || updateRef.current) return;

    const operation = ++operationRef.current;
    checkingRef.current = true;
    lastCheckAtRef.current = Date.now();
    setState((current) => ({ ...current, phase: "checking", error: null }));

    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 15_000 });

      if (!mountedRef.current || operation !== operationRef.current) {
        await update?.close();
        return;
      }

      updateRef.current = update;

      if (!update) {
        setState(idleState);
        return;
      }

      if (update.version === dismissedVersionRef.current) {
        updateRef.current = null;
        await update.close();
        setState(idleState);
        return;
      }

      setState({
        phase: "available",
        currentVersion: update.currentVersion,
        version: update.version,
        body: update.body?.trim() || null,
        downloadedBytes: 0,
        totalBytes: null,
        error: null,
      });
    } catch (error) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      console.error("Failed to check for AgentSpace updates:", error);
      setState(showError
        ? { ...idleState, phase: "error", error: errorText(error) }
        : idleState);
    } finally {
      if (operation === operationRef.current) checkingRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return () => {
      mountedRef.current = false;
    };

    const initialTimer = window.setTimeout(() => {
      void checkNow();
    }, initialCheckDelayMs);
    const periodicTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkNow();
    }, periodicCheckIntervalMs);
    const onVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastCheckAtRef.current >= foregroundRecheckAgeMs
      ) {
        void checkNow();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      checkingRef.current = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const update = updateRef.current;
      updateRef.current = null;
      if (update) closeUpdate(update);
    };
  }, [checkNow, enabled]);

  const dismiss = useCallback(() => {
    operationRef.current += 1;
    const update = updateRef.current;
    dismissedVersionRef.current = update?.version ?? null;
    updateRef.current = null;
    setState(idleState);
    if (update) closeUpdate(update);
  }, []);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      await checkNow(true);
      return;
    }

    setState((current) => ({
      ...current,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    }));

    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (!mountedRef.current) return;
        if (event.event === "Started") {
          setState((current) => ({
            ...current,
            phase: "downloading",
            downloadedBytes: 0,
            totalBytes: event.data.contentLength ?? null,
          }));
        } else if (event.event === "Progress") {
          setState((current) => ({
            ...current,
            downloadedBytes: current.downloadedBytes + event.data.chunkLength,
          }));
        } else {
          setState((current) => ({
            ...current,
            phase: "installing",
            downloadedBytes: current.totalBytes ?? current.downloadedBytes,
          }));
        }
      }, { timeout: 300_000 });

      if (!mountedRef.current) return;
      setState((current) => ({ ...current, phase: "restarting" }));
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      if (!mountedRef.current) return;
      console.error("Failed to install AgentSpace update:", error);
      setState((current) => ({
        ...current,
        phase: "error",
        error: errorText(error),
      }));
    }
  }, [checkNow]);

  const retry = useCallback(() => {
    if (updateRef.current) {
      void install();
    } else {
      void checkNow(true);
    }
  }, [checkNow, install]);

  return { state, dismiss, install, retry };
}
