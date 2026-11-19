import { useEffect, useState } from 'react';
import { api, type WishlistItem,type LibraryItem } from '../api';
import { ConfirmDialog, Notice, PageHeading } from '../components';
import { Cover, itemName,platformName } from './catalog-ui';
import {libraryItems} from './library-sort';

export default function Library({csrf,onRestored,onError}:{csrf:string;onRestored:(item:WishlistItem)=>void;onError:(error:unknown)=>void}) {
  const [items,setItems]=useState<LibraryItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [selected,setSelected]=useState<WishlistItem|null>(null);
  const [busy,setBusy]=useState(false);
  const [system,setSystem]=useState(()=>{try{return localStorage.getItem('keyhunter.library.system')??'all';}catch{return 'all';}});
  const [sort,setSort]=useState<'added'|'name'>(()=>{try{return localStorage.getItem('keyhunter.library.sort')==='name'?'name':'added';}catch{return 'added';}});
  const systems=[...new Set(items.map(item=>item.platform_id))].sort((a,b)=>platformName(a).localeCompare(platformName(b),'de'));
  const activeSystem=system==='all'||systems.some(id=>String(id)===system)?system:'all';
  const visible=libraryItems(items,activeSystem,sort);
  function filter(value:string){setSystem(value);try{localStorage.setItem('keyhunter.library.system',value);}catch{/* Keep in memory. */}}
  function order(value:'added'|'name'){setSort(value);try{localStorage.setItem('keyhunter.library.sort',value);}catch{/* Keep in memory. */}}
  useEffect(()=>{const controller=new AbortController();
    void api<LibraryItem[]>('/library','GET',undefined,undefined,controller.signal).then(rows=>{if(!controller.signal.aborted)setItems(rows);})
      .catch(error=>{if(!controller.signal.aborted){setError(error instanceof Error?error.message:'Bibliothek konnte nicht geladen werden.');onError(error);}})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[onError]);
  async function restore(){
    if(!selected||busy)return;
    setBusy(true);setError('');
    try{await api(`/library/${selected.id}/restore`,'POST',{confirm:true},csrf);setSelected(null);onRestored(selected);}
    catch(error){setError(error instanceof Error?error.message:'Verschieben fehlgeschlagen.');onError(error);}
    finally{setBusy(false);}
  }
  return <section className="library-page">
    <PageHeading title="Meine Bibliothek" />
    <div className="library-controls"><div className="field"><label htmlFor="library-system">System</label><select id="library-system" aria-label="Bibliothek nach System filtern" value={activeSystem} onChange={event=>filter(event.target.value)} disabled={loading}><option value="all">Alle Systeme</option>{systems.map(id=><option key={id} value={id}>{platformName(id)}</option>)}</select></div><div className="field"><label htmlFor="library-sort">Sortieren</label><select id="library-sort" aria-label="Bibliothek sortieren" value={sort} onChange={event=>order(event.target.value as 'added'|'name')}><option value="added">Hinzugefügt am · neueste zuerst</option><option value="name">Alphabetisch · A–Z</option></select></div></div>
    {error&&!selected&&<Notice error>{error}</Notice>}
    {loading?<p role="status">Bibliothek wird geladen …</p>:items.length?<ul className="library-grid" aria-label="Meine Spiele">{visible.map(item=><li key={item.id}><button className="library-game" aria-label={`${itemName(item)} · ${platformName(item.platform_id)}`} onClick={()=>{setError('');setSelected(item);}} title="In die Wunschliste zurücksetzen"><Cover src={item.game?.cover_url??null}/><strong>{itemName(item)}</strong><span className="library-system">{platformName(item.platform_id)}</span></button></li>)}</ul>:!error&&<p className="library-empty">Hier erscheinen deine als gekauft markierten Spiele.</p>}
    <ConfirmDialog open={selected!==null} title="Zurück in die Wunschliste?" confirmLabel="In Wunschliste verschieben" busy={busy} onCancel={()=>setSelected(null)} onConfirm={()=>void restore()}>
      <p>„{selected?itemName(selected):''}“ wird aus der Bibliothek wieder in die Wunschliste verschoben. Der gespeicherte Preisverlauf bleibt erhalten.</p>{error&&<Notice error>{error}</Notice>}
    </ConfirmDialog>
  </section>;
}
