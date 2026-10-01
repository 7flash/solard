import { createSolard, type Solard } from "./client.ts";

let instance: Solard | undefined;

function client(): Solard {
  instance ??= createSolard();
  return instance;
}

const slrd = new Proxy({} as Solard, {
  get(_target, key) {
    if (key === "close") {
      return () => {
        const current = instance;
        instance = undefined;
        current?.close();
      };
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
