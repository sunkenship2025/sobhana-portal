import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary (right-hand, prominent) button. Default "Confirm". */
  confirmText?: string;
  /** Secondary (left-hand) button. Default "Cancel". */
  cancelText?: string;
  /** Style the primary button as destructive (for deletes). */
  destructive?: boolean;
  /** Style the secondary button as destructive (e.g. "Create new anyway"). */
  destructiveCancel?: boolean;
  /** Which button receives initial focus. Default "cancel" (the safe choice). */
  defaultFocus?: "confirm" | "cancel";
}

/**
 * Promise-based confirmation dialog — an in-app replacement for window.confirm().
 *
 *   const { confirm, ConfirmDialog } = useConfirm();
 *   const choice = await confirm({ title, description, confirmText, ... });
 *   // choice: true  = primary clicked
 *   //         false = secondary clicked
 *   //         null  = dismissed (Escape / overlay) — treat as "no decision"
 *
 * Render {ConfirmDialog} once inside the component's tree.
 */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean | null) => void) | undefined>(undefined);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setOpts(options);
    setOpen(true);
    return new Promise<boolean | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean | null) => {
    setOpen(false);
    resolver.current?.(value);
    resolver.current = undefined;
  }, []);

  const ConfirmDialog = (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) settle(null); }}>
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          if (opts?.defaultFocus === "confirm") {
            e.preventDefault();
            confirmBtnRef.current?.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description != null && (
            <AlertDialogDescription asChild>
              <div>{opts.description}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant={opts?.destructiveCancel ? "destructive" : "outline"}
            onClick={() => settle(false)}
          >
            {opts?.cancelText ?? "Cancel"}
          </Button>
          <Button
            ref={confirmBtnRef}
            variant={opts?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {opts?.confirmText ?? "Confirm"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, ConfirmDialog };
}
