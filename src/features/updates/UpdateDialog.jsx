import { LoaderCircle } from "lucide-react";

import { Modal } from "@/components/common/Modal";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";

function downloadedLabel(progress) {
  if (!progress.downloaded) return "Preparing download…";
  const downloaded = (progress.downloaded / 1_048_576).toFixed(1);
  if (!progress.total) return `${downloaded} MB downloaded`;
  return `${downloaded} of ${(progress.total / 1_048_576).toFixed(1)} MB downloaded`;
}

export function UpdateDialog({ updater }) {
  if (!updater.promptOpen || !updater.update) return null;

  const installing = updater.phase === "installing";
  const failed = updater.phase === "error";

  return (
    <Modal
      title={`Station ${updater.update.version} is available`}
      onClose={() => {
        if (!installing) updater.dismiss();
      }}
      onEscapeKeyDown={(event) => {
        if (installing) event.preventDefault();
      }}
      showCloseButton={!installing}
    >
      <DialogDescription>
        {installing
          ? "Station is downloading and installing the signed update. It will restart when finished."
          : "Install the update now, or choose Later to be reminded after Station restarts."}
      </DialogDescription>

      {updater.update.body && !installing && (
        <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
          {updater.update.body}
        </div>
      )}

      {installing && (
        <div className="grid gap-2" aria-live="polite">
          <div className="flex items-center gap-2 text-sm">
            <LoaderCircle className="animate-spin" />
            {downloadedLabel(updater.progress)}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${updater.progress.percent ?? 15}%` }}
            />
          </div>
        </div>
      )}

      {failed && <p className="text-sm text-destructive">{updater.message}</p>}

      <DialogFooter>
        {!installing && (
          <Button type="button" variant="outline" onClick={updater.dismiss}>
            Later
          </Button>
        )}
        <Button type="button" disabled={installing} onClick={updater.install}>
          {installing ? "Installing…" : failed ? "Retry" : "Install & Restart"}
        </Button>
      </DialogFooter>
    </Modal>
  );
}
