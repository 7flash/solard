import { getSolUsdPrice } from "@solard/core";
import { subscribeLaunches, subscribeMigrations } from "./live.ts";
import { createSolard, type Solard } from "./client.ts";

type DefaultSolard = Solard & {
  getSolUsdPrice: typeof getSolUsdPrice;
  subscribeLaunches: typeof subscribeLaunches;
  subscribeMigrations: typeof subscribeMigrations;
};

let instance: Solard | undefined;

function client(): Solard {
  instance ??= createSolard();
  return instance;
}

const operations = {
  getSolUsdPrice,
  subscribeLaunches,
  subscribeMigrations,
} as const;

const slrd = new Proxy({} as DefaultSolard, {
  get(_target, key) {
    if (key === "close") {
      return () => {
        const current = instance;
        instance = undefined;
        current?.close();
      };
    }
    if (typeof key === "string" && key in operations) {
      return operations[key as keyof typeof operations];
    }
    const current = client();
    const value = Reflect.get(current as object, key, current);
    return typeof value === "function" ? value.bind(current) : value;
  },
  set() {
    return false;
  },
});

export default slrd;
