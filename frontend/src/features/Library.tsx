import { useEffect, useState } from 'react';
import { api, type WishlistItem } from '../api';
import { ConfirmDialog, Notice } from '../components';
import { Cover, itemName } from './catalog-ui';

export default function Library({csrf,onRestored,onError}:{csrf:string;onRestored:(item:WishlistItem)=>void;onError:(error:unknown)=>void}) {
  const [items,setItems]=useState<WishlistItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [selected,setSelected]=useState<WishlistItem|null>(null);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{const controller=new AbortController();
    void api<WishlistItem[]>('/library','GET',undefined,undefined,controller.signal).then(rows=>{if(!controller.signal.aborted)setItems(rows);})
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
    <div className="page-heading"><div><h1>Meine Bibliothek<span className="accent-dot">.</span></h1><p>Deine vorhandenen Spiele.</p></div></div>
    {error&&!selected&&<Notice error>{error}</Notice>}
    {loading?<p role="status">Bibliothek wird geladen …</p>:items.length?<ul className="library-grid" aria-label="Meine Spiele">{items.map(item=><li key={item.id}><button className="library-game" onClick={()=>{setError('');setSelected(item);}} title="In die Wunschliste zurücksetzen"><Cover src={item.game?.cover_url??null}/><strong>{itemName(item)}</strong></button></li>)}</ul>:!error&&<p className="library-empty">Hier erscheinen deine als gekauft markierten Spiele.</p>}
    <ConfirmDialog open={selected!==null} title="Zurück in die Wunschliste?" confirmLabel="In Wunschliste verschieben" busy={busy} onCancel={()=>setSelected(null)} onConfirm={()=>void restore()}>
      <p>„{selected?itemName(selected):''}“ wird aus der Bibliothek wieder in die Wunschliste verschoben. Der gespeicherte Preisverlauf bleibt erhalten.</p>{error&&<Notice error>{error}</Notice>}
    </ConfirmDialog>
  </section>;
}
