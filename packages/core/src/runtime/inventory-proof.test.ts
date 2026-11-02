import {test,expect} from 'bun:test';import {inventoryProofMatches} from './inventory-proof.ts';
test('an old confirmed/finalized snapshot cannot undo the bot own newly confirmed fill',()=>{
 const proof={confirmedRaw:'0',finalizedRaw:'0',observedAt:1000,finalizedSlot:100};
 expect(inventoryProofMatches(proof,'100',1100,101)).toBe(false);
 expect(inventoryProofMatches({...proof,observedAt:1200},'100',1100,101)).toBe(false);
 expect(inventoryProofMatches({...proof,observedAt:1200,finalizedSlot:102},'100',1100,101)).toBe(true);
 expect(inventoryProofMatches({...proof,confirmedRaw:'50',observedAt:1200,finalizedSlot:102},'100',1100,101)).toBe(false);
 expect(inventoryProofMatches({...proof,confirmedRaw:'100',finalizedRaw:'100',observedAt:1200,finalizedSlot:102},'100',1100,101)).toBe(false);
});
