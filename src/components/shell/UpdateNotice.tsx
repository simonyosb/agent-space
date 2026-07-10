import type { AppUpdateState } from "../../hooks/useAppUpdater";

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function UpdateNotice({
  state,
  onDismiss,
  onInstall,
  onRetry,
}: {
  state: AppUpdateState;
  onDismiss: () => void;
  onInstall: () => void;
  onRetry: () => void;
}) {
  if (state.phase === "idle" || state.phase === "checking") return null;

  const busy = state.phase === "downloading" || state.phase === "installing" || state.phase === "restarting";
  const progress = state.totalBytes && state.totalBytes > 0
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : null;
  const title = state.phase === "available"
    ? `AgentSpace ${state.version} is ready`
    : state.phase === "downloading"
      ? "Downloading update"
      : state.phase === "installing"
        ? "Installing update"
        : state.phase === "restarting"
          ? "Restarting AgentSpace"
          : "Update did not finish";
  const description = state.phase === "available"
    ? "Install when you are ready to restart the app. Your workspace state stays on disk."
    : state.phase === "downloading"
      ? progress === null
        ? `${formatBytes(state.downloadedBytes)} downloaded`
        : `${progress}% · ${formatBytes(state.downloadedBytes)} of ${formatBytes(state.totalBytes ?? 0)}`
      : state.phase === "installing"
        ? "The signed package is downloaded. Keep AgentSpace open while it is installed."
        : state.phase === "restarting"
          ? "The update is installed. The app will reopen in a moment."
          : "The current app is unchanged. Check your connection and try again.";

  return (
    <aside
      className={`update-notice is-${state.phase}`}
      role={state.phase === "error" ? "alert" : "status"}
      aria-live={state.phase === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <div className="update-notice-heading">
        <span className="update-status-mark" aria-hidden="true" />
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
      </div>

      {state.phase === "available" && state.body ? (
        <p className="update-release-notes">{state.body}</p>
      ) : null}

      {state.phase === "downloading" ? (
        <progress
          className="update-progress"
          max={state.totalBytes ?? undefined}
          value={state.totalBytes ? state.downloadedBytes : undefined}
          aria-label="Update download progress"
        />
      ) : null}

      {state.phase === "error" && state.error ? (
        <details className="update-error-details">
          <summary>Technical details</summary>
          <code>{state.error}</code>
        </details>
      ) : null}

      {!busy ? (
        <div className="update-notice-actions">
          <button className="btn" type="button" onClick={onDismiss}>
            {state.phase === "error" ? "Dismiss" : "Later"}
          </button>
          <button className="btn primary" type="button" onClick={state.phase === "error" ? onRetry : onInstall}>
            {state.phase === "error" ? "Try again" : "Install and restart"}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
