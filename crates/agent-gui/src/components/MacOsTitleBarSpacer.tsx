import { useState } from "react";
import { cn } from "../lib/shared/utils";
import { PanelLeft, PanelLeftClose, Settings } from "./icons";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

export function isMacOsTauri(): boolean {
  if (typeof window === "undefined") return false;
  const hasTauri = !!(window as TauriWindow).__TAURI_INTERNALS__;
  return hasTauri && /Mac/i.test(navigator.platform);
}

/** Vertical spacer at the top of a sidebar column — clears the macOS traffic lights. */
export function MacOsTitleBarSpacer({ className }: { className?: string }) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return (
    <div
      data-tauri-drag-region
      className={cn("h-[38px] shrink-0", className)}
    />
  );
}

/**
 * Fixed-position sidebar toggle for macOS overlay titlebar.
 * Always appears at the same x position (right of traffic lights), regardless of sidebar state.
 */
export function MacOsTitleBarToggle({
  sidebarOpen,
  onToggle,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  onToggle: () => void;
  onOpenSettings?: () => void;
}) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return (
    <div className="fixed left-[82px] top-[4px] z-49 flex h-[32px] items-center gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex cursor-pointer size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        {sidebarOpen ? (
          <PanelLeftClose className="h-3.5 w-3.5" />
        ) : (
          <PanelLeft className="h-3.5 w-3.5" />
        )}
      </button>
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex cursor-pointer size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Horizontal spacer on the left of a header row — used in ChatHeader when sidebar is
 * closed on macOS to clear the traffic lights + fixed toggle button zone.
 */
export function MacOsTitleBarLeadingInset({ className }: { className?: string }) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return (
    <div
      data-tauri-drag-region
      className={cn("w-[88px] shrink-0", className)}
    />
  );
}
