export function inventoryProofMatches(proof:{confirmedRaw:string;finalizedRaw:string;observedAt:number;finalizedSlot:number},expectedRaw:string,settledAtMs:number,minSlot:number):boolean{
 return proof.observedAt>settledAtMs&&proof.finalizedSlot>=minSlot&&proof.confirmedRaw===proof.finalizedRaw&&proof.finalizedRaw!==expectedRaw;
}
