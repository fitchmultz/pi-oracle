import type { GetCookiesOptions, GetCookiesResult } from "@steipete/sweet-cookie";

export function getCookiesFromNativeLinuxChromium(
  options: GetCookiesOptions,
  readCookies: typeof import("@steipete/sweet-cookie").getCookies,
): Promise<GetCookiesResult>;
