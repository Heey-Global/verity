import { measureFirstChildLayout as upstreamMeasure } from '@shopify/flash-list/dist/recyclerview/utils/measureLayout.web';
export * from '@shopify/flash-list/dist/recyclerview/utils/measureLayout.web';

/** FlashList needs layout coordinates; bounding rectangles include our chat's flip. */
export function measureFirstChildLayout(child: Element, parent: Element) {
  const layout = upstreamMeasure(child, parent);
  const transform = getComputedStyle(parent).transform;
  if (!transform || transform === 'none') return layout;
  const matrix = new DOMMatrixReadOnly(transform);
  if (matrix.m22 === -1 && matrix.m12 === 0 && matrix.m21 === 0) {
    const childRect = child.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    // Keep upstream's accumulated scroll offset, but measure from the visual
    // bottom (layout top). Otherwise the virtualizer treats content height as
    // leading padding and leaves unrendered space until a viewport resize.
    layout.y += parentRect.bottom - childRect.bottom - (childRect.top - parentRect.top);
  }
  return layout;
}
