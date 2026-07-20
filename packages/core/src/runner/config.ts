export type SolardScriptEntry =
  | string
  | {
      path: string;
      description?: string;
    };

export type SolardConfig = {
  /** Named executable scripts. Scripts import slrd; the kernel never imports scripts. */
  scripts?: Record<string, SolardScriptEntry>;
};

export function defineSolardConfig(config: SolardConfig): SolardConfig {
  return config;
}
