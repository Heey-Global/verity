import type { ComponentType } from 'react';

/** One screen of a spec's mockups, rendered from the app's real components. */
export interface MockupScreen {
  /** Shown in the header while the mockup is open. */
  title: string;
  Component: ComponentType;
}

/**
 * The mockups of one spec. Each screen lives in `mockups/<id>/<screen>.tsx`;
 * the key in `screens` is that file's name, so `/mockups/<id>/<screen>` opens it.
 */
export interface MockupSpec {
  id: string;
  title: string;
  screens: Readonly<Record<string, MockupScreen>>;
}
