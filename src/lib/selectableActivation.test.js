import assert from "node:assert/strict";
import test from "node:test";

import { selectableActivationProps as handlers } from "./selectableActivation.js";

function fixture({ selected = true, intersects = true } = {}) {
  const range = { collapsed: false, intersectsNode: (node) => intersects && node === element };
  const selection = { isCollapsed: !selected, rangeCount: 1, getRangeAt: () => range };
  const element = {
    ownerDocument: { getSelection: () => selection },
    contains: (node) => node === element || node === nestedControl,
  };
  const nestedControl = {};
  const event = (overrides = {}) => ({
    currentTarget: element,
    target: { closest: () => element },
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 10,
    clientY: 10,
    detail: 1,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  });
  return { event, selection, nestedControl };
}

test("a title selection drag prevents activation and preserves the selection", () => {
  const { event, selection } = fixture();
  handlers.onPointerDownCapture(event());
  handlers.onPointerMoveCapture(event({ clientX: 60 }));
  const click = event({ clientX: 60 });
  handlers.onClickCapture(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.propagationStopped, true);
  assert.equal(selection.isCollapsed, false);
});

test("movement outside the item is recognized from the final click coordinates", () => {
  const { event } = fixture();
  handlers.onPointerDownCapture(event());
  const click = event({ clientY: 50 });
  handlers.onClickCapture(click);
  assert.equal(click.defaultPrevented, true);
});

test("a fresh stationary click still activates with an existing selection", () => {
  const { event } = fixture();
  handlers.onPointerDownCapture(event());
  handlers.onClickCapture(event({ clientX: 60 }));
  handlers.onPointerDownCapture(event());
  const click = event();
  handlers.onClickCapture(click);
  assert.equal(click.defaultPrevented, false);
});

for (const [name, options] of [
  ["a drag without selected text", { selected: false }],
  ["selected text in another item", { intersects: false }],
]) {
  test(`${name} does not block activation`, () => {
    const { event } = fixture(options);
    handlers.onPointerDownCapture(event());
    const click = event({ clientX: 60 });
    handlers.onClickCapture(click);
    assert.equal(click.defaultPrevented, false);
  });
}

test("keyboard and assistive activation bypass the pointer guard", () => {
  const { event } = fixture();
  handlers.onPointerDownCapture(event());
  handlers.onPointerMoveCapture(event({ clientX: 60 }));
  const click = event({ detail: 0, clientX: 0, clientY: 0 });
  handlers.onClickCapture(click);
  assert.equal(click.defaultPrevented, false);
});

test("nested action controls work independently of selected card text", () => {
  const { event, nestedControl } = fixture();
  handlers.onPointerDownCapture(event());
  const click = event({ clientX: 60, target: { closest: () => nestedControl } });
  handlers.onClickCapture(click);
  assert.equal(click.defaultPrevented, false);

  const target = { closest: () => nestedControl };
  handlers.onPointerDownCapture(event({ target }));
  handlers.onPointerMoveCapture(event({ target, clientX: 60 }));
  const nestedClick = event({ target, clientX: 60 });
  handlers.onClickCapture(nestedClick);
  assert.equal(nestedClick.defaultPrevented, false);
});

test("gestures are isolated per item", () => {
  const first = fixture();
  const second = fixture();
  handlers.onPointerDownCapture(first.event());
  handlers.onPointerDownCapture(second.event());
  const selectedClick = first.event({ clientX: 60 });
  const ordinaryClick = second.event();
  handlers.onClickCapture(selectedClick);
  handlers.onClickCapture(ordinaryClick);
  assert.equal(selectedClick.defaultPrevented, true);
  assert.equal(ordinaryClick.defaultPrevented, false);
});

test("cancelled, secondary, and non-primary gestures do not suppress later clicks", () => {
  const { event } = fixture();
  handlers.onPointerDownCapture(event());
  handlers.onPointerCancelCapture(event());
  const cancelledClick = event({ clientX: 60 });
  handlers.onClickCapture(cancelledClick);
  assert.equal(cancelledClick.defaultPrevented, false);

  for (const overrides of [{ button: 2 }, { isPrimary: false }]) {
    handlers.onPointerDownCapture(event(overrides));
    const click = event({ clientX: 60 });
    handlers.onClickCapture(click);
    assert.equal(click.defaultPrevented, false);
  }
});
