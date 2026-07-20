import type { Connection, PublicKey } from "@solana/web3.js";
import { UnsupportedTokenError } from "../core/errors.ts";
import type { TokenRow } from "../db/schema.ts";
import type { TradeVenuePlugin, VenueMarket } from "./venue-plugin.ts";

/** Selects one executable trade venue. It never resolves fee claims or script-level strategy behavior. */
export class VenueRegistry {
  private readonly plugins: TradeVenuePlugin[] = [];

  register(plugin: TradeVenuePlugin): this {
    const existing = this.plugins.findIndex((item) => item.id === plugin.id);
    if (existing >= 0) this.plugins.splice(existing, 1, plugin);
    else this.plugins.push(plugin);
    return this;
  }

  list(): readonly TradeVenuePlugin[] {
    return this.plugins;
  }

  async inspect(
    connection: Connection,
    mint: PublicKey,
  ): Promise<Partial<TokenRow> | null> {
    for (const plugin of this.plugins) {
      const result = await plugin.inspectToken?.(connection, mint);
      if (result) return result;
    }
    return null;
  }

  async resolve(
    connection: Connection,
    token: TokenRow,
    user: PublicKey,
  ): Promise<{ plugin: TradeVenuePlugin; market: VenueMarket }> {
    for (const plugin of this.plugins) {
      const market = await plugin.resolveMarket({ connection, token, user });
      if (market) return { plugin, market };
    }
    throw new UnsupportedTokenError(token.mint);
  }
}

/** @deprecated Prefer VenueRegistry. */
export class RouteResolver extends VenueRegistry {}
