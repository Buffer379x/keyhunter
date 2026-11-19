import type { WishlistItem } from '../api.ts';
export type SortMode='added'|'price'|'name';
export function sortWishlist(items:WishlistItem[],prices:Record<string,number|null>,mode:SortMode):WishlistItem[]{
  const position=new Map(items.map((item,i)=>[item.id,i]));
  const name=(item:WishlistItem)=>item.game?.name??item.manual_title??'Unbenannter Titel';
  return [...items].sort((a,b)=>{
    if(mode==='added')return b.created_at-a.created_at||position.get(a.id)!-position.get(b.id)!;
    if(mode==='price'){
      const first=prices[a.id]??Infinity,second=prices[b.id]??Infinity;
      if(first!==second)return first-second;
    }
    return name(a).localeCompare(name(b),'de',{numeric:true,sensitivity:'base'})||b.created_at-a.created_at||position.get(a.id)!-position.get(b.id)!;
  });
}
