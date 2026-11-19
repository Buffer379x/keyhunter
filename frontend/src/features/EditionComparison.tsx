import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';
import type { CatalogGame } from '../api';
import { CardHeading, Icon, Notice } from '../components';
type Content={igdb_id:number;status:string;source_url:string|null;observed_at:number;items:{id:string;name:string}[];description:string|null};
export default function EditionComparison({gameId,platformId,games,savedId}:{gameId:number;platformId:number;games:CatalogGame[];savedId:number}) {
  const [data,setData]=useState<Content[]|null>(null);const [error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setData(null);setError('');void api<{editions:Content[]}>(`/catalog/games/${gameId}/edition-comparison?platform=${platformId}`,'GET',undefined,undefined,controller.signal).then(result=>{if(!controller.signal.aborted)setData(result.editions);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Editionsinhalte konnten nicht geladen werden.');});return()=>controller.abort();},[gameId,platformId]);
  const features=new Map<string,string>();for(const entry of data??[])for(const item of entry.items)features.set(item.id,item.name);
  return <section className="dashboard-card edition-comparison"><CardHeading icon="layers" title="Editionsinhalte" />{error&&<Notice error>{error}</Notice>}{!data&&!error&&<p role="status">Editionsinhalte werden geladen …</p>}
    <div className="edition-matrix-scroll" tabIndex={0} role="region" aria-label="Editionsvergleich"><table className="edition-matrix" aria-label="Editionsinhalte" style={{'--edition-count':games.length} as CSSProperties}><thead><tr><th>Enthaltener Inhalt</th>{games.map(game=><th key={game.igdb_id}>{game.edition_name??(game.kind==='base_game'?'Standard Edition':game.name)}{game.igdb_id===savedId&&<small>Auf deiner Wunschliste</small>}</th>)}</tr></thead><tbody>
      {[...features].map(([id,name])=><tr key={id}><td>{name}</td>{games.map(game=>{const entry=data?.find(e=>e.igdb_id===game.igdb_id);const known=entry?.status==='verified';const included=entry?.items.some(item=>item.id===id);return <td key={game.igdb_id} className={known&&included?'included':''}><span aria-label={known?included?'Enthalten':'Nicht in der belegten Inhaltsliste':'Nicht belegt'}>{known?included?'✓':'—':'?'}</span></td>;})}</tr>)}
      {features.size===0&&<tr><td>Strukturierte Inhaltsliste</td>{games.map(game=><td key={game.igdb_id}>{data?'Nicht belegt':'…'}</td>)}</tr>}
      <tr className="edition-description-row"><td>Beschreibung der Edition</td>{games.map(game=><td key={game.igdb_id}><details><summary>Beschreibung anzeigen</summary><p>{data?.find(entry=>entry.igdb_id===game.igdb_id)?.description??game.summary??'Keine Beschreibung verfügbar.'}</p></details></td>)}</tr>
      <tr><td>Quelle & Stand</td>{games.map(game=>{const entry=data?.find(entry=>entry.igdb_id===game.igdb_id);return <td key={game.igdb_id}>{entry?.source_url?<a className="source-link" href={entry.source_url} target="_blank" rel="noopener noreferrer">Microsoft / Xbox <Icon name="external" size={13}/></a>:<span>Keine bestätigte Store-Zuordnung</span>}{entry&&<small>{new Date(entry.observed_at*1000).toLocaleString('de-DE')}</small>}</td>;})}</tr>
    </tbody></table></div><p className="card-footnote">✓ In der offiziellen Bundle-Liste enthalten · — dort nicht enthalten · ? nicht belegt. Individuelle Händlerpakete können abweichen.</p>
  </section>;
}
