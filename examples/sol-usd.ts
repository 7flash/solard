#!/usr/bin/env bun
import { configure, createMeasure } from "measure-fn";
import slrd from "@solard/sdk";

configure({ silent: false });
const m = createMeasure("slrd:sol-usd-example", { maxResultLength: 1200 });

const forceRefresh = process.argv.includes("--refresh");
const quote = await slrd.getSolUsdPrice({ forceRefresh });

m.sync(
  {
    start: () => "SOL/USD",
    end: (value: typeof quote) => value,
  },
  () => quote,
);
