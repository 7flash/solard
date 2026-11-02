import { isDefinitivePreSubmissionError } from "../core/errors.ts";
import { tradeErrorCode } from "./trade-result.ts";
/** Only a proven pre-submission slippage failure may safely rebuild here. */
export async function retryPreflightSlippage<T>(maxAttempts: number, task: () => Promise<T>, refresh: () => void): Promise<T> {
 for(let n=0;;n++) {
  try{return await task();}
  catch(error){
   if(n+1>=maxAttempts || !isDefinitivePreSubmissionError(error) || tradeErrorCode(error)!=="SLIPPAGE")throw error;
   refresh();
  }
 }
}
