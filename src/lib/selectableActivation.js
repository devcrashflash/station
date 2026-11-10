const gestures = new WeakMap();

function isSeparateControl(event) {
  const control = event.target.closest?.("button, a, [role='button'], [role='link']");
  return control && control !== event.currentTarget && event.currentTarget.contains(control);
}

function hasSelectionWithin(element) {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!range.collapsed && range.intersectsNode(element)) return true;
  }
  return false;
}

// Capture the gesture before a card's own click handler runs. State is per DOM
// element, so these props can be shared without hooks or cross-card interference.
export const selectableActivationProps = {
  onPointerDownCapture(event) {
    gestures.delete(event.currentTarget);
    if (event.button !== 0 || event.isPrimary === false || isSeparateControl(event)) return;
    gestures.set(event.currentTarget, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    });
  },
  onPointerMoveCapture(event) {
    const gesture = gestures.get(event.currentTarget);
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.x !== event.clientX || gesture.y !== event.clientY) gesture.moved = true;
  },
  onPointerCancelCapture(event) {
    gestures.delete(event.currentTarget);
  },
  onClickCapture(event) {
    const gesture = gestures.get(event.currentTarget);
    gestures.delete(event.currentTarget);
    // Keyboard and assistive activation have no pointer click count. A fresh
    // stationary click must also work while an older selection still exists.
    if (!gesture || event.detail === 0 || isSeparateControl(event)) return;
    const moved = gesture.moved || gesture.x !== event.clientX || gesture.y !== event.clientY;
    if (!moved || !hasSelectionWithin(event.currentTarget)) return;
    event.preventDefault();
    event.stopPropagation();
  },
};
