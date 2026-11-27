/**
 * A secret reference (ADR 0031): `NAME` in the project's default Doppler binding,
 * or `project/config/NAME` in the binding of that Doppler project and config. The
 * default may be written in full as well. Names follow Doppler's classic rules and
 * never contain `/`, so the two forms cannot be confused.
 */
export const BROKERED_SECRET_REFERENCE =
  /^(?:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/)?([A-Z][A-Z0-9_]*)$/;
