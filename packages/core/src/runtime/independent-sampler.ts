/** Sampling owns its own schedule; callers must not await trade work here. */
export async function runIndependentSampler(options: {
 intervalMs: number; signal: AbortSignal;
 sample: () => Promise<void>; onError: (error: unknown) => void;
}) {
 while (!options.signal.aborted) {
  const start=Date.now();
  try { await options.sample(); } catch(error) { options.onError(error); }
  if (!options.signal.aborted) await new Promise<void>(resolve=>{
   const done=()=>{clearTimeout(timer);options.signal.removeEventListener('abort',done);resolve();};
   const timer=setTimeout(done,Math.max(1,options.intervalMs-(Date.now()-start)));
   options.signal.addEventListener('abort',done,{once:true});
  });
 }
}
