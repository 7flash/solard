/** Retry only unsent preparation whose freshness lease expired. Never retries execution. */
export async function freshPreparation<T>(prepare:()=>Promise<T>,onRetry:(attempt:number)=>void=()=>{}):Promise<T>{
  for(let attempt=1;;attempt++)try{return await prepare();}catch(error){
    if(attempt>=3||!(error instanceof Error)||error.message!=="Background preparation exceeded freshness lease")throw error;
    onRetry(attempt+1);
  }
}
