/** CSS inversion flips wheel motion too; compensate at the browser scroll node. */
export function attachInvertedWheel(node: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.defaultPrevented || event.deltaY === 0) return;

    // Code blocks and other nested scroll panes retain their own wheel behavior.
    let target = event.target instanceof Element ? event.target : null;
    while (target && target !== node) {
      const overflow = getComputedStyle(target).overflowY;
      if (
        /^(auto|scroll)$/.test(overflow) &&
        target.scrollHeight > target.clientHeight &&
        (event.deltaY < 0
          ? target.scrollTop > 0
          : target.scrollTop + target.clientHeight < target.scrollHeight)
      ) {
        return;
      }
      target = target.parentElement;
    }

    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
    node.scrollTop -= event.deltaY * unit;
  };
  node.addEventListener('wheel', onWheel, { passive: false });
  return () => node.removeEventListener('wheel', onWheel);
}
