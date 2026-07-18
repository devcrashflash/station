import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function Modal({ title, children, onClose, onEscapeKeyDown, contentClassName, headerClassName }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={contentClassName} onEscapeKeyDown={onEscapeKeyDown}>
        <DialogHeader className={headerClassName}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
