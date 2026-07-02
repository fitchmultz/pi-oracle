// Purpose: Keep pi project-trust probing behind one typed extension-side helper.

export function isOracleProjectTrusted(ctx: { isProjectTrusted?: () => boolean }): boolean {
  return ctx.isProjectTrusted?.() ?? true;
}
