import{test,expect}from'bun:test';import{VenueRegistry}from'./route-resolver.ts';
test('explicit Jupiter route bypasses unrelated discovery failures',async()=>{
 const registry=new VenueRegistry();let nativeCalls=0;
 registry.register({id:'native',resolveMarket:async()=>{nativeCalls++;throw Error('provider indexed query unavailable');}} as any);
 registry.register({id:'jupiter',resolveMarket:async()=>({venue:'jupiter'})} as any);
 const route=await registry.resolve({}as any,{venueHint:'jupiter',mint:'external'}as any,{}as any);
 expect(route.market.venue).toBe('jupiter');expect(nativeCalls).toBe(0);
 await expect(registry.resolve({}as any,{venueHint:'unknown',mint:'native'}as any,{}as any)).rejects.toThrow('provider');
});
