import { configure, createMeasure } from "measure-fn";

configure({
  summarize: true,
  maxResultLength: 4_000,
  sensitiveKeyPattern:
    /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key/i,
});

export const measure = createMeasure("robinhood-sqd");
