import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, HttpError } from '../api';
import type {PriceBadgeData} from '../api';
import {money,dateTime} from './price-format';
export {money,dateTime} from './price-format';
import { Button, CardHeading, Icon, Notice } from '../components';
import { AlertEditor } from './PriceAlerts';
import PriceHistoryPlot from './PriceHistoryPlot';
import type { HistoryPoint, HistorySeries } from './PriceHistoryPlot';
import { CountryFlag, countryData } from './Country';
import { whenVisible } from '../poll';

export const shopNames:Record<string,string>={eneba:'Eneba',driffle:'Driffle',igdb:'IGDB'};
const sourceErrors:Record<string,string>={network:'Verbindung fehlgeschlagen',rate_limited:'Abruflimit erreicht',access_denied:'Abruf abgelehnt',invalid_response:'Antwort konnte nicht gelesen werden'};
const activationNames:Record<string,string>={confirmed:'Aktivierung bestätigt',blocked:'Aktivierung im Zielland gesperrt',unknown:'Aktivierung ungeklärt'};
type Quote={id:string;seller:string|null;base_cents:number;estimated_total_cents:number|null};
type Link={id:number;source:string;url:string;review:string;can_confirm:boolean;eligible:boolean;queued:boolean;enabled:boolean;stale:boolean;observed_at:number|null;attempted_at:number|null;last_error:string|null;retry_at:number;reasons?:string[];product:{name:string;region:string|null;market:string|null;activation:string;availability:string}|null;quotes:Quote[]};
type View={price_badge?:PriceBadgeData;links:Link[];history:HistoryPoint[];histories?:{preferred:HistoryPoint[];all:HistoryPoint[]};best_base:number|null;best_estimate:number|null;last_known?:{cents:number;observed_at:number}|null;target_country:string;discovery_running:boolean;sources:{source:string;status:{enabled:boolean;state:string;last_error:string|null}}[];searches:{source:string;status:string;checked_at:number|null;last_error:string|null;result_count:number|null}[]};
type Priced={link:Link;quote:Quote};
// First reason why a confirmed offer does not count as a current price in the target country.
const reasonLabels:[string,string][]=[['activation_blocked','In {c} nicht aktivierbar'],['activation_unknown','Aktivierung in {c} ungeklärt'],['purchase_context_mismatch','Anderer Kaufkontext'],['sold_out','Ausverkauft'],['availability_unknown','Verfügbarkeit unbekannt'],['source_error','Abruffehler'],['stale','Veraltet'],['no_target_country','Kein Zielland gewählt']];
const ineligibleLabel=(link:Link,country:string)=>{const hit=reasonLabels.find(([reason])=>link.reasons?.includes(reason));return hit?hit[1].replace('{c}',country||'Zielland'):null;};
type RegionGroup={region:ReturnType<typeof countryData>;links:Link[];quotes:Priced[]};

export default function Offers({id,csrf,targetLabel,onError,onBadge,tab,editionPanel,comparisonPanel,infoPanel}:{id:string;csrf:string;targetLabel:string;onError:(error:unknown)=>void;onBadge?:(id:string,badge:PriceBadgeData)=>void;tab:string;editionPanel:ReactNode;comparisonPanel:ReactNode;infoPanel:ReactNode}) {
  const path=`/wishlist/${encodeURIComponent(id)}/offers`;
  const [view,setView]=useState<View|null>(null);const [error,setError]=useState('');const [message,setMessage]=useState('');
  const [url,setUrl]=useState('');const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);const [basis,setBasis]=useState('base');
  const [openCountry,setOpenCountry]=useState<string|null>(null);const dialog=useRef<HTMLDialogElement>(null);const latest=useRef(0);
  useEffect(()=>{if(openCountry)dialog.current?.showModal();else dialog.current?.close();},[openCountry]);
  useEffect(()=>{
    const controller=new AbortController();const generation=++latest.current;let cancel=()=>{};
    async function load() {
      try {
        const data = await api<View>(path, 'GET', undefined, undefined, controller.signal);
        if (controller.signal.aborted || generation !== latest.current) return;
        setView(data);
        if (data.price_badge) onBadge?.(id, data.price_badge);
        setError('');
        const pending =
          data.searches?.some(search => ['queued', 'searching'].includes(search.status)) ||
          data.discovery_running || data.links.some(link => link.queued && link.review !== 'rejected');
        cancel = whenVisible(() => void load(), pending ? 3000 : 60000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401) {
          onError(error);
          return;
        }
        setError(error instanceof Error ? error.message : 'Angebote konnten nicht geladen werden.');
        cancel = whenVisible(() => void load(), 10000);
      }
    }
    void load();return()=>{controller.abort();cancel();};
  },[path,reload,onError,onBadge,id]);
  async function write(endpoint:string,method:string,body:unknown,success=''){
    setBusy(true);setError('');setMessage('');try{await api(path+endpoint,method,body,csrf);setMessage(success);setReload(n=>n+1);return true;}
    catch(error){setError(error instanceof Error?error.message:'Angebotsänderung fehlgeschlagen.');if(error instanceof HttpError && error.status === 401) onError(error);return false;}finally{setBusy(false);}
  }
  async function add(event:FormEvent){event.preventDefault();if(await write('','POST',{url},'Produktlink zur Prüfung vorgemerkt.'))setUrl('');}
  const visibleLinks=view?.links.filter(l=>l.review!=='rejected'&&l.enabled)??[];
  const searches=view?.searches??[];const searching=searches.some(s=>['queued','searching'].includes(s.status));
  const groups=new Map<string,RegionGroup>();
  const price=(row:Priced)=>basis==='estimate'?(row.quote.estimated_total_cents??Infinity):row.quote.base_cents;
  for(const link of visibleLinks){if(!link.product)continue;const region=countryData(link.product.region);const group=groups.get(region.key)??{region,links:[],quotes:[]};group.links.push(link);group.quotes.push(...(link.review==='confirmed'?link.quotes:[]).map(quote=>({link,quote})));groups.set(region.key,group);}
  // Rows are ordered by price only: the cheapest region comes first, wherever it is.
  for(const group of groups.values())group.quotes.sort((a,b)=>price(a)-price(b)||Number(b.link.eligible)-Number(a.link.eligible)||a.link.id-b.link.id);
  const regions=[...groups.values()].sort((a,b)=>(a.quotes[0]?price(a.quotes[0]):Infinity)-(b.quotes[0]?price(b.quotes[0]):Infinity)||a.region.name.localeCompare(b.region.name,'de'));
  // Cheapest current offer of any region against the best offer that counts in the target country.
  const current=(row:Priced)=>!row.link.stale&&!row.link.reasons?.some(r=>r==='stale'||r==='source_error')&&Number.isFinite(price(row));
  const world=regions.flatMap(g=>g.quotes.filter(current).map(q=>({...q,region:g.region}))).sort((a,b)=>price(a)-price(b))[0];
  const targetCents=basis==='estimate'?view?.best_estimate??null:view?.best_base??null;
  const targetOffer=targetCents===null?undefined:regions.flatMap(g=>g.quotes.filter(q=>q.link.eligible&&price(q)===targetCents).map(q=>({...q,region:g.region})))[0];
  const saving=world&&targetCents!==null&&price(world)<targetCents?targetCents-price(world):0;
  const selectedGroup=openCountry?groups.get(openCountry):undefined;
  // Both histories are always shown: the target country against the cheapest region anywhere.
  const preferredHistory=view?.histories?.preferred??view?.history??[];const allHistory=view?.histories?.all??[];
  const series:HistorySeries[]=[{key:'all',label:'Alle Länder',history:allHistory},{key:'preferred',label:`In ${targetLabel} aktivierbar`,history:preferredHistory}];
  const lowest=(rows:HistoryPoint[])=>rows.filter(p=>p.base_cents!==null).reduce<HistoryPoint|null>((best,p)=>!best||p.base_cents!<best.base_cents!?p:best,null);
  const lowestTarget=lowest(preferredHistory),lowestAll=lowest(allHistory);
  const measuredAll=[...preferredHistory,...allHistory].filter(p=>p.base_cents!==null);
  const byTime=new Map<number,{at:number;preferred?:HistoryPoint;all?:HistoryPoint}>();
  for(const [key,rows] of [['preferred',preferredHistory],['all',allHistory]] as const)for(const row of rows){const entry=byTime.get(row.observed_at)??{at:row.observed_at};entry[key]=row;byTime.set(row.observed_at,entry);}
  const measurements=[...byTime.values()].sort((a,b)=>b.at-a.at);
  const pending=visibleLinks.filter(l=>!l.product).length;
  const statusNames:Record<string,string>={queued:'Suche eingeplant',searching:'Angebote werden gesucht',complete:'Suche abgeschlossen',no_match:'Keine passenden Produkte gefunden',error:'Suche fehlgeschlagen',disabled:'Deaktiviert',paused:'Abrufe pausiert'};
  const historyPanel=<section className="dashboard-card history-card" aria-labelledby="history-title"><CardHeading icon="chart" title="Preisverlauf" id="history-title" />
    <PriceHistoryPlot series={series}/>
    {measuredAll.length?<><div className="history-caption">{lowestTarget?<div className="series-preferred"><span>Tiefstwert · in {targetLabel} aktivierbar</span><strong>{money(lowestTarget.base_cents!)}</strong><small>{countryData(lowestTarget.region).name} · {dateTime(lowestTarget.observed_at)}</small></div>:<div className="series-preferred"><span>In {targetLabel} aktivierbar</span><strong>–</strong><small>Noch keine passende Messung</small></div>}{lowestAll&&<div className="series-all"><span>Tiefstwert · alle Länder</span><strong>{money(lowestAll.base_cents!)}</strong><small>{countryData(lowestAll.region).name} · {dateTime(lowestAll.observed_at)}</small></div>}</div>{measuredAll.length===1&&<p className="field-help">Bisher eine Messung. Weitere Abfragen ergänzen die Verlaufslinie.</p>}<details open={tab==='history'}><summary>Messungen anzeigen</summary><div className="price-table-wrap"><table className="price-table" aria-label="Preismessungen"><thead><tr><th>Abfrage</th><th>In {targetLabel} aktivierbar</th><th>Günstigste Region</th></tr></thead><tbody>{measurements.map(row=><tr key={row.at}><td>{dateTime(row.at)}</td><td>{row.preferred?.base_cents==null?'–':money(row.preferred.base_cents)}</td><td>{row.all?.base_cents==null?'–':<><CountryFlag region={row.all.region}/> {countryData(row.all.region).name} · {money(row.all.base_cents)}</>}</td></tr>)}</tbody></table></div></details></>:<div className="card-empty"><Icon name="chart" size={30}/><p>Noch keine Preismessung vorhanden.</p></div>}
    {measuredAll.length > 0 && <p className="card-footnote">Messwerte gelten bis zur nächsten Abfrage, höchstens 24 Stunden.</p>}
  </section>;
  const regionsPanel=<section className="dashboard-card region-card" aria-labelledby="regions-title"><CardHeading icon="globe" title="Preise nach Land & Region" id="regions-title"><span>{regions.length} {regions.length===1?'Region':'Regionen'}</span><button className="icon-action" aria-label="Preise prüfen" disabled={busy||searching} onClick={()=>void write('/refresh','POST',undefined,'Angebotssuche angefragt.')}><Icon name="refresh" size={16}/></button></CardHeading>
    <div className="region-controls"><label>Preisgrundlage<select aria-label="Preisgrundlage" value={basis} onChange={event=>setBasis(event.target.value)}><option value="base">Grundpreis</option><option value="estimate">Gesamtpreis geschätzt</option></select></label></div>
    {(world||targetCents!==null||view?.last_known)&&<div className="price-compare" aria-label="Preisvergleich">
      <div className="compare-tile target"><span>Bester Preis · in {targetLabel} aktivierbar</span>{targetCents!==null?<><strong>{money(targetCents)}</strong><small>{targetOffer?`${targetOffer.region.name} · ${shopNames[targetOffer.link.source]}`:'Gültiges Angebot'}</small></>:view?.last_known?<><strong className="stale-price">{money(view.last_known.cents)}</strong><small>Kein aktueller Preis · zuletzt am {dateTime(view.last_known.observed_at)}</small></>:<><strong>–</strong><small>Derzeit kein gültiges Angebot</small></>}</div>
      {world&&<div className="compare-tile world"><span>Günstigste Region · alle Länder</span><strong>{money(price(world))}</strong><small>{world.region.name} · {shopNames[world.link.source]}{!world.link.eligible&&` · ${ineligibleLabel(world.link,view?.target_country??'')??'nicht für '+targetLabel}`}</small></div>}
      <p className="compare-delta">{saving>0?<><strong>{money(saving)} günstiger</strong> ({Math.round(saving/targetCents!*100)} %) in {world!.region.name} als dein bester Preis für {targetLabel}.</>:world&&targetCents!==null?<>Dein Angebot für {targetLabel} ist auch weltweit am günstigsten.</>:world&&!world.link.eligible?<>Für {targetLabel} gibt es derzeit kein gültiges Angebot zum Vergleich.</>:null}</p>
    </div>}
    <div className="country-price-list">{regions.map(group=>{const best=group.quotes[0];const at=best?.link.observed_at??Math.max(0,...group.links.map(l=>l.observed_at??0));const preferred=group.region.key===view?.target_country;const why=best&&!best.link.eligible?ineligibleLabel(best.link,view?.target_country??''):null;const soldOut=!best&&group.links.some(l=>l.product?.availability==='sold_out');const unreviewed=!best&&group.links.some(l=>l.can_confirm&&l.review!=='confirmed');
      return <button type="button" key={group.region.key} aria-label={`Angebote für ${group.region.name} anzeigen`} className={`region-row ${preferred?'preferred-region':''}`} onClick={()=>setOpenCountry(group.region.key)}><CountryFlag region={group.region.name}/><span className="region-name">{group.region.name}{preferred&&<small className="preference-badge">Deine Präferenz</small>}{best?.link.eligible&&<small className="good-label">Für {view?.target_country}</small>}{why&&<small className="reason-label">{why}</small>}<small>{group.quotes.length} {group.quotes.length===1?'Angebot':'Angebote'}</small>{unreviewed&&<small>Zuordnung prüfen</small>}</span><span className={`region-price ${best&&!best.link.eligible?'ineligible':''}`}><strong>{best?(Number.isFinite(price(best))?money(price(best)):'Gebühren unbekannt'):soldOut?'Ausverkauft':'Kein Preis'}</strong><small>Stand: {at?dateTime(at):'noch keine Abfrage'}</small></span><Icon name="arrow" size={16}/></button>;
    })}</div>
    {!regions.length&&<div className="card-empty"><Icon name="search" size={30}/><p>{!view?'Angebote werden geladen …':searching?'KeyHunter sucht regionale Produkte für diese Edition.':'Noch keine regionalen Preise verfügbar.'}</p>{view&&!searching&&<Button secondary disabled={busy} onClick={()=>void write('/refresh','POST',undefined)}>Angebote automatisch suchen</Button>}</div>}
    {pending > 0 && <div className="card-footnote">{pending} Produktabrufe ausstehend</div>}
    {searches.map(search=><div className="source-search-state" key={search.source}><span className={`status-dot ${['queued','searching'].includes(search.status)?'searching':''}`}/><strong>{shopNames[search.source]}</strong><span>{statusNames[search.status]??search.status}</span>{search.last_error&&<span>{sourceErrors[search.last_error]??'Quelle vorübergehend nicht erreichbar'}</span>}</div>)}
    {view?.sources?.filter(source=>!source.status.enabled||source.status.last_error).map(source=><div className="source-search-state" key={source.source}><strong>{shopNames[source.source]}</strong><span>{!source.status.enabled?'Deaktiviert':sourceErrors[source.status.last_error??'']??'Quelle pausiert'}</span></div>)}
    <details className="product-review"><summary>Produktzuordnungen prüfen ({visibleLinks.filter(l=>l.review!=='confirmed').length})</summary>{visibleLinks.map(link=><div className="review-row" key={link.id}><strong>{shopNames[link.source]} · {link.product?.name??'Produktdaten ausstehend'}</strong><p>{link.review==='confirmed'?'Zuordnung bestätigt':link.can_confirm?'Zuordnung prüfen':'Produktart, Titel oder Plattform nicht bestätigt'}</p>{link.last_error&&<p>{sourceErrors[link.last_error]??'Abruf fehlgeschlagen'}</p>}<div className="offer-actions">{link.can_confirm&&link.review!=='confirmed'&&<Button type="button" secondary disabled={busy} onClick={()=>void write(`/${link.id}`,'PUT',{decision:'confirmed'})}>Zuordnung bestätigen</Button>}<Button type="button" secondary disabled={busy} onClick={()=>void write(`/${link.id}`,'PUT',{decision:'rejected'})}>Verwerfen</Button><a href={link.url} target="_blank" rel="noopener noreferrer">Produktseite <Icon name="external" size={13}/></a></div></div>)}{view?.links.filter(link=>link.review==='rejected'&&link.enabled).map(link=><div className="review-row" key={link.id}><span>{link.product?.name??'Verworfenes Produkt'}</span><Button type="button" secondary disabled={busy} onClick={()=>void write(`/${link.id}`,'PUT',{decision:'pending'})}>Erneut prüfen</Button></div>)}</details>
    <details className="manual-link"><summary>Produktlink ergänzen</summary><p className="field-help">Falls die automatische Suche diese Edition noch nicht abdeckt.</p><form className="offer-link-form" onSubmit={add}><div className="field"><label htmlFor="shop-product-url">Produktlink von Eneba oder Driffle</label><input id="shop-product-url" type="url" required maxLength={300} value={url} onChange={e=>setUrl(e.target.value)}/></div><Button secondary type="submit" disabled={busy}>Link prüfen</Button></form></details>
  </section>;
  return <div className={`detail-content tab-${tab}`}>
    {error&&<Notice error>{error}<Button secondary onClick={()=>setReload(n=>n+1)}>Erneut laden</Button></Notice>}{message&&<Notice>{message}</Notice>}
    {!view && !error && (tab === 'offers' || tab === 'history') && <p role="status">Preisdaten werden geladen …</p>}
    {tab==='info'?infoPanel:tab==='alert'?<AlertEditor id={id} csrf={csrf} targetLabel={targetLabel} onError={onError}/>:<>{editionPanel}{tab==='editions'?comparisonPanel:tab==='history'?(view && historyPanel):(view && <div className="detail-grid price-overview">{regionsPanel}{historyPanel}</div>)}</>}
    <dialog ref={dialog} className="country-offers-dialog" aria-labelledby="country-offers-title" onCancel={()=>setOpenCountry(null)}><div className="dialog-heading"><h2 id="country-offers-title"><CountryFlag region={selectedGroup?.region.name}/>Angebote · {selectedGroup?.region.name}</h2><Button type="button" secondary aria-label="Angebote schließen" onClick={()=>setOpenCountry(null)}>×</Button></div><p>Grundpreise für diese Edition und Region. Gebühren und Aktivierungseignung gelten je Angebot.</p>
      <div className="offer-table"><div className="offer-table-head"><span>Händler / Verkäufer</span><span>Preis</span><span>Letzte Abfrage</span><span/></div>{selectedGroup?.quotes.map(({link,quote},i)=><div className={`offer-table-row ${link.eligible&&quote.base_cents===view?.best_base?'best':''}`} key={`${link.id}-${quote.id}`}><div className="seller-cell"><span className={`shop-logo ${link.source}`}>{shopNames[link.source]?.[0]}</span><div><strong>{shopNames[link.source]}</strong><small>{quote.seller??'Verkäufer nicht angegeben'}</small><small>{activationNames[link.product?.activation??'unknown']}</small></div></div><div className="quote-price"><strong>{money(quote.base_cents)}</strong><small>{quote.estimated_total_cents===null?'Gebühren unbekannt':`${money(quote.estimated_total_cents)} geschätzt`}</small></div><div className="quote-observed"><time>{link.observed_at?dateTime(link.observed_at):'Noch keine Abfrage'}</time><small>{link.last_error?'Abruffehler':link.stale?'Veraltet':link.review!=='confirmed'?'Zuordnung prüfen':'Beobachteter Preis'}</small></div><a className="offer-open" aria-label={`Angebot bei ${shopNames[link.source]} öffnen ${i+1}`} href={link.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16}/></a></div>)}</div>
      {selectedGroup?.quotes.length===0&&<p>Für diese Region wurde noch kein verfügbarer Preis beobachtet.</p>}
    </dialog>
  </div>;
}
