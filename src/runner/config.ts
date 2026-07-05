export type SowlScriptEntry = string | {
  path: string;
  description?: string;
};

export type SowlConfig = {
  /** Named executable scripts. Scripts import sowl; the kernel never imports scripts. */
  scripts?: Record<string, SowlScriptEntry>;
};

export function defineSowlConfig(config: SowlConfig): SowlConfig {
  return config;
}
