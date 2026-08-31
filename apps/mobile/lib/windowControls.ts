// iPadOS 26 parks the window controls — the red/yellow/green dots — inside the
// window's top-left corner and draws them OVER app content. Unlike the notch or
// the home indicator they contribute nothing to `safeAreaInsets`, so nothing in
// the RN layout knows they are there and the header's leftmost buttons end up
// underneath them.
//
// The one public source for the space they claim is iOS 26's corner-adapted
// layout margins (`UIView.LayoutRegion.margins(cornerAdaptation:)`), reported by
// native/VerityWindowControls.swift. That module deliberately sends the raw
// numbers rather than a finished padding, because turning them into one rests on
// an assumption Apple has not documented — that the adapted margins are the
// window's ordinary layout margins, widened where a corner intrudes. If that
// turns out to be wrong on a device, the arithmetic below is a JS change that
// ships as an OTA update; a rule baked into Swift would need a native build.

/** Raw margins reported by the native module, in points. */
export interface WindowControlMargins {
  /** Corner-adapted leading margin of the window (includes `baseLeft`). */
  left: number;
  /** Corner-adapted trailing margin of the window (includes `baseRight`). */
  right: number;
  /** The window's plain layout margin, i.e. the same value with no corner intruding. */
  baseLeft: number;
  baseRight: number;
}

/** Extra horizontal space the window's corners claim, on top of normal margins. */
export interface WindowControlsInset {
  left: number;
  right: number;
}

// Frozen: it is handed out as the "nothing to avoid" answer, and a caller that
// mutated what it received would move every header in the app.
export const NO_WINDOW_CONTROLS_INSET: WindowControlsInset = Object.freeze({ left: 0, right: 0 });

/**
 * What a row of three window-control dots can plausibly claim. Both bounds mean
 * the same thing — this margin is not the controls — and both answer it the same
 * way, with the padding the header had before any of this.
 *
 * Below `MIN`: corner adaptation also clears plain rounded corners, a window's
 * own radius or a display's, which take a few points off an edge that carries
 * nothing to avoid. Above `MAX`: a number we do not understand, and pushing the
 * header a third of the way across a narrow window is a worse failure than
 * leaving two buttons partly covered — so an unexplained margin is dropped
 * rather than clamped into a plausible-looking one.
 */
const MIN_INSET = 24;
const MAX_INSET = 120;

function extra(adapted: number, base: number): number {
  if (!Number.isFinite(adapted) || !Number.isFinite(base)) return 0;
  const claimed = adapted - base;
  return claimed >= MIN_INSET && claimed <= MAX_INSET ? claimed : 0;
}

/**
 * The padding a top-of-window row needs so the system's window controls stay off
 * its content. Zero wherever nothing claims that corner — a full-screen iPad,
 * any iOS before 26 — because the adapted margins come back equal to the plain
 * ones. Both are read from the same window, so a shared safe area (a landscape
 * notch, say) sits in both and cancels; and if the assumption behind the
 * subtraction is ever wrong, it goes wrong toward zero, which is the padding the
 * header had before any of this.
 */
export function windowControlsInset(
  margins: WindowControlMargins | null | undefined,
): WindowControlsInset {
  if (!margins) return NO_WINDOW_CONTROLS_INSET;
  const left = extra(margins.left, margins.baseLeft);
  const right = extra(margins.right, margins.baseRight);
  // `MAX_INSET` again, now against the pair: the controls sit in one corner, so
  // two sides that each stay under the bound but together exceed it are not them
  // — and the header pays for both at once out of the same window width.
  if (left + right > MAX_INSET) return NO_WINDOW_CONTROLS_INSET;
  return Object.freeze({ left, right });
}
