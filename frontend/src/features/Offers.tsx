import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, HttpError } from '../api';
import type {PriceBadgeData} from '../api';
import {money,dateTime} from './price-format';
export {money,dateTime} from './price-format';
import { Button, CardHeading, Icon, Notice } from '../components';
import { AlertEditor } from './PriceAlerts';
import PriceHistoryPlot from './PriceHistoryPlot';
import type { HistoryPoint } from './PriceHistoryPlot';
import { CountryFlag, countryData } from './Country';

export const shopNames:Record<string,string>={eneba:'Eneba',driffle:'Driffle',igdb:'IGDB'};
const sourceErrors:Record<string,string>={network:'Verbindung fehlgeschlagen',rate_limited:'Abruflimit erreicht',access_denied:'Abruf abgelehnt',invalid_response:'Antwort konnte nicht gelesen werden'};
const activationNames:Record<string,string>={confirmed:'Aktivierung bestätigt',blocked:'Aktivierung im Zielland gesperrt',unknown:'Aktivierung ungeklärt'};
type Quote={id:string;seller:string|null;base_cents:number;estimated_total_cents:number|null};
type Link={id:number;source:string;url:string;review:string;can_confirm:boolean;eligible:boolean;queued:boolean;enabled:boolean;stale:boolean;observed_at:number|null;attempted_at:number|null;last_error:string|null;retry_at:number;product:{name:string;region:string|null;market:string|null;activation:string;availability:string}|null;quotes:Quote[]};
type View={price_badge?:PriceBadgeData;links:Link[];history:HistoryPoint[];histories?:{preferred:HistoryPoint[];all:HistoryPoint[]};best_base:number|null;best_estimate:number|null;target_country:string;discovery_running:boolean;sources:{source:string;status:{enabled:boolean;state:string;last_error:string|null}}[];searches:{source:string;status:string;checked_at:number|null;last_error:string|null;result_count:number|null}[]};
type Priced={link:Link;quote:Quote};
type RegionGroup={region:ReturnType<typeof countryData>;links:Link[];quotes:Priced[]};

export default function Offers({id,csrf,targetLabel,onError,onBadge,tab,editionPanel,comparisonPanel,infoPanel}:{id:string;csrf:string;targetLabel:string;onError:(error:unknown)=>void;onBadge?:(id:string,badge:PriceBadgeData)=>void;tab:string;editionPanel:ReactNode;comparisonPanel:ReactNode;infoPanel:ReactNode}) {
  const path=`/wishlist/${encodeURIComponent(id)}/offers`;
  const [view,setView]=useState<View|null>(null);const [error,setError]=useState('');const [message,setMessage]=useState('');
  const [url,setUrl]=useState('');const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);const [basis,setBasis]=useState('base');
  const [scope,setScope]=useState<'preferred'|'all'>(()=>{try{return localStorage.getItem('keyhunter.history.scope')==='all'?'all':'preferred';}catch{return 'preferred';}});
  const [openCountry,setOpenCountry]=useState<string|null>(null);const dialog=useRef<HTMLDialogElement>(null);const latest=useRef(0);
  useEffect(()=>{if(openCountry)dialog.current?.showModal();else dialog.current?.close();},[openCountry]);
  useEffect(()=>{
    const controller=new AbortController();const generation=++latest.current;let timer:number;
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
        timer = window.setTimeout(() => void load(), pending ? 3000 : 60000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401) {
          onError(error);
          return;
        }
        setError(error instanceof Error ? error.message : 'Angebote konnten nicht geladen werden.');
        timer = window.setTimeout(() => void load(), 10000);
      }
    }
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[path,reload,onError,onBadge,id]);
  async function write(endpoint:string,method:string,body:unknown,success=''){
    setBusy(true);setError('');setMessage('');try{await api(path+endpoint,method,body,csrf);setMessage(success);setReload(n=>n+1);return true;}
    catch(error){setError(error instanceof Error?error.message:'Angebotsänderung fehlgeschlagen.');if(error instanceof HttpError && error.status === 401) onError(error);return false;}finally{setBusy(false);}
  }
  async function add(event:FormEvent){event.preventDefault();if(await write('','POST',{url},'Produktlink zur Prüfung vorgemerkt.'))setUrl('');}
  function changeScope(value:'preferred'|'all'){setScope(value);try{localStorage.setItem('keyhunter.history.scope',value);}catch{/* Keep the selection for this page if storage is unavailable. */}}
  const visibleLinks=view?.links.filter(l=>l.review!=='rejected'&&l.enabled)??[];
  const searches=view?.searches??[];const searching=searches.some(s=>['queued','searching'].includes(s.status));
  const groups=new Map<string,RegionGroup>();
  const price=(row:Priced)=>basis==='estimate'?(row.quote.estimated_total_cents??Infinity):row.quote.base_cents;
  for(const link of visibleLinks){if(!link.product)continue;const region=countryData(link.product.region);const group=groups.get(region.key)??{region,links:[],quotes:[]};group.links.push(link);group.quotes.push(...(link.can_confirm?link.quotes:[]).map(quote=>({link,quote})));groups.set(region.key,group);}
  for(const group of groups.values())group.quotes.sort((a,b)=>price(a)-price(b)||a.link.id-b.link.id);
  const regions=[...groups.values()].sort((a,b)=>(a.quotes[0]?price(a.quotes[0]):Infinity)-(b.quotes[0]?price(b.quotes[0]):Infinity)||a.region.name.localeCompare(b.region.name,'de'));
  const selectedGroup=openCountry?groups.get(openCountry):undefined;
  const history=view?.histories?.[scope]??view?.history??[];const measured=history.filter(p=>p.base_cents!==null);
  const pending=visibleLinks.filter(l=>!l.product).length;
  const statusNames:Record<string,string>={queued:'Suche eingeplant',searching:'Angebote werden gesucht',complete:'Suche abgeschlossen',no_match:'Keine passenden Produkte gefunden',error:'Suche fehlgeschlagen',disabled:'Deaktiviert',paused:'Abrufe pausiert'};
  const historyPanel=<section className="dashboard-card history-card" aria-labelledby="history-title"><CardHeading icon="chart" title="Preisverlauf" id="history-title" />
    <div className="history-controls"><div className="history-scope" role="group" aria-label="Region für Preisverlauf"><button type="button" className="icon-action" aria-label="Preisverlauf für mein Land" aria-pressed={scope==='preferred'} title={`Mein Land · ${targetLabel}`} onClick={()=>changeScope('preferred')}><Icon name="home"/></button><button type="button" className="icon-action" aria-label="Preisverlauf für alle Länder" aria-pressed={scope==='all'} title="Alle Länder · jeweils günstigster Preis" onClick={()=>changeScope('all')}><Icon name="globe"/></button></div><span>{scope==='all'?'Alle Länder':`Mein Land · ${targetLabel}`}</span></div>
    <PriceHistoryPlot history={history}/>
    {measured.length?<><div className="history-caption"><strong>{money(Math.min(...measured.map(p=>p.base_cents!)))}</strong><span>{scope==='all'?'Günstigster beobachteter Grundpreis über alle Länder':'Günstigster passender Grundpreis im Zielland'}</span></div>{measured.length===1&&<p className="field-help">Bisher eine Messung. Weitere Abfragen ergänzen die Verlaufslinie.</p>}<details open={tab==='history'}><summary>Messungen anzeigen</summary><div className="price-table-wrap"><table className="price-table" aria-label="Preismessungen"><thead><tr><th>Abfrage</th><th>Land / Region</th><th>Grundpreis</th></tr></thead><tbody>{[...history].reverse().map((row,i)=><tr key={`${row.observed_at}-${i}`}><td>{dateTime(row.observed_at)}</td><td><CountryFlag region={row.region}/> {countryData(row.region).name}</td><td>{row.base_cents===null?'Kein verfügbarer Preis':money(row.base_cents)}</td></tr>)}</tbody></table></div></details></>:<div className="card-empty"><Icon name="chart" size={30}/><p>Noch keine Preismessung vorhanden.</p></div>}
    {measured.length > 0 && <p className="card-footnote">Messwerte gelten bis zur nächsten Abfrage, höchstens 24 Stunden.</p>}
  </section>;
  const regionsPanel=<section className="dashboard-card region-card" aria-labelledby="regions-title"><CardHeading icon="globe" title="Preise nach Land & Region" id="regions-title"><span>{regions.length} Regionen</span><button className="icon-action" aria-label="Preise prüfen" disabled={busy||searching} onClick={()=>void write('/refresh','POST',undefined,'Angebotssuche angefragt.')}><Icon name="refresh" size={16}/></button></CardHeading>
    <div className="region-controls"><label>Preisgrundlage<select aria-label="Preisgrundlage" value={basis} onChange={event=>setBasis(event.target.value)}><option value="base">Grundpreis</option><option value="estimate">Gesamtpreis geschätzt</option></select></label></div>
    {view?.best_base!==null&&view?.best_base!==undefined&&<div className="comparison-summary"><span>Niedrigster passender Grundpreis <strong>{money(view.best_base)}</strong></span>{view.best_estimate!==null&&<span>Gesamtpreis geschätzt <strong>{money(view.best_estimate)}</strong></span>}</div>}
    <div className="country-price-list">{regions.map(group=>{const best=group.quotes[0];const at=best?.link.observed_at??Math.max(0,...group.links.map(l=>l.observed_at??0));const preferred=group.region.key===view?.target_country;
      return <button type="button" key={group.region.key} aria-label={`Angebote für ${group.region.name} anzeigen`} className={`region-row ${preferred?'preferred-region':''}`} onClick={()=>setOpenCountry(group.region.key)}><CountryFlag region={group.region.name}/><span className="region-name">{group.region.name}{preferred&&<small className="preference-badge">Deine Präferenz</small>}{best?.link.product?.activation==='confirmed'&&<small className="good-label">Für {view?.target_country}</small>}<small>{group.quotes.length} {group.quotes.length===1?'Angebot':'Angebote'}</small>{best?.link.review!=='confirmed'&&best&&<small>Zuordnung prüfen</small>}</span><span className="region-price"><strong>{best?(Number.isFinite(price(best))?money(price(best)):'Gebühren unbekannt'):'Kein Preis'}</strong><small>Stand: {at?dateTime(at):'noch keine Abfrage'}</small>{best?.link.last_error?<small>Abruffehler</small>:best?.link.stale&&<small>Veraltet</small>}</span><Icon name="arrow" size={16}/></button>;
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
