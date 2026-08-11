export function validateSupplierReturn(input:{quantity:number;currentQuantity:number;purchasedQuantity:number;returnedQuantity:number}){
  const {quantity,currentQuantity,purchasedQuantity,returnedQuantity}=input;
  if(!Number.isInteger(quantity)||quantity<1)throw new Error("Return quantity must be a positive whole number");
  const remainingPurchased=Math.max(0,purchasedQuantity-returnedQuantity);
  if(quantity>currentQuantity)throw new Error("Return quantity exceeds current batch stock");
  if(quantity>remainingPurchased)throw new Error("Return quantity exceeds unreturned purchased stock");
  return {remainingPurchased,remainingAfter:remainingPurchased-quantity};
}

export function nextRiderAction(status:string){
  if(status==="assigned")return "picked_up";
  if(status==="picked_up")return "out_for_delivery";
  if(status==="out_for_delivery")return "delivered";
  return "";
}
