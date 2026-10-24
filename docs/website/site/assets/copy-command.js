/* global document, navigator, setTimeout, clearTimeout */
// Reveals the copy buttons next to commands on the homepage. Without
// JavaScript or clipboard access the buttons stay hidden and the command
// remains selectable.
const RESET_AFTER_MS = 2000;

if (navigator.clipboard) {
  for (const button of document.querySelectorAll('button[data-copy]')) {
    const source = document.getElementById(button.dataset.copy);
    if (!source) continue;
    let reset;
    button.hidden = false;
    button.setAttribute('aria-live', 'polite');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      clearTimeout(reset);
      reset = setTimeout(() => {
        button.textContent = 'Copy';
      }, RESET_AFTER_MS);
    });
  }
}
