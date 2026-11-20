import { useEffect, useRef, useState } from 'react';
import { countryData } from './Country';
export type HistoryPoint = { observed_at:number; base_cents:number|null; link_id:number|null; region?:string|null; source?:string|null };
export type HistorySeries = { key:string; label:string; history:HistoryPoint[] };
// Step lines of the observed minima; several series share one time and price axis.
export default function PriceHistoryPlot({ series }: { series:HistorySeries[] }) {
  const box=useRef<HTMLDivElement>(null);const [width,setWidth]=useState(600);
  const all=series.flatMap(s=>s.history);
  const populated=all.some(row=>row.base_cents!==null);
  useEffect(()=>{const el=box.current;if(!el)return;const observer=new ResizeObserver(()=>setWidth(Math.max(240,el.clientWidth)));observer.observe(el);return()=>observer.disconnect();},[populated]);
  const valid=all.filter(row=>row.base_cents!==null);
  if(!valid.length)return null;
  const height=245,left=50,right=width-15,top=18,bottom=height-34;
  const values=valid.map(row=>row.base_cents!);const min=Math.min(...values),max=Math.max(...values);
  const step=Math.max(100,Math.ceil((max-min)/400)*100);const low=Math.max(0,Math.floor((min-step/2)/step)*step),high=Math.ceil((max+step/2)/step)*step;
  const times=all.map(row=>row.observed_at);const start=Math.min(...times),end=Math.max(...times);
  const x=(at:number)=>start===end?(left+right)/2:left+(at-start)/(end-start)*(right-left);
  const y=(cents:number)=>bottom-(cents-low)/(high-low)*(bottom-top);
  const ticks=[];for(let cents=low;cents<=high;cents+=step)ticks.push(cents);
  const path=(history:HistoryPoint[])=>{const rows=[...history].sort((a,b)=>a.observed_at-b.observed_at);let active=false;let previousY=0;const commands:string[]=[];
    for(const row of rows){if(row.base_cents===null){active=false;continue;}const px=x(row.observed_at),py=y(row.base_cents);commands.push(active?`L ${px} ${previousY} L ${px} ${py}`:`M ${px} ${py}`);active=true;previousY=py;}return commands.join(' ');};
  const date=(at:number)=>new Date(at*1000).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'});
  return <div className="history-chart" ref={box}>
    {series.length>1&&<ul className="history-legend">{series.map(s=><li key={s.key} className={`series-${s.key}`}><span aria-hidden="true"/>{s.label}</li>)}</ul>}
    <svg className="history-plot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Verlauf des günstigsten beobachteten Preises: ${series.map(s=>s.label).join(' und ')}`}>
    {ticks.map(cents=><g key={cents}><line className="history-grid" x1={left} x2={right} y1={y(cents)} y2={y(cents)}/><text x={left-8} y={y(cents)+4} textAnchor="end">{(cents/100).toLocaleString('de-DE')} €</text></g>)}
    {series.map(s=><g key={s.key} className={`history-series series-${s.key}`}><path className="history-line" d={path(s.history)} fill="none"/>
      {s.history.filter(row=>row.base_cents!==null).map((row,i)=><circle className="history-point" key={`${row.observed_at}-${i}`} cx={x(row.observed_at)} cy={y(row.base_cents!)} r="4"><title>{s.label} · {new Date(row.observed_at*1000).toLocaleString('de-DE')} · {countryData(row.region).name} · {(row.base_cents!/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'})}</title></circle>)}</g>)}
    <text x={start===end?(left+right)/2:left} y={height-9} textAnchor={start===end?'middle':'start'}>{date(start)}</text>{start!==end&&<text x={right} y={height-9} textAnchor="end">{date(end)}</text>}
  </svg></div>;
}
