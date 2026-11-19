import { useEffect, useRef, useState } from 'react';
import { countryData } from './Country';
export type HistoryPoint = { observed_at:number; base_cents:number|null; link_id:number|null; region?:string|null; source?:string|null };
export default function PriceHistoryPlot({ history }: { history:HistoryPoint[] }) {
  const box=useRef<HTMLDivElement>(null);const [width,setWidth]=useState(600);
  const populated=history.some(row=>row.base_cents!==null);
  useEffect(()=>{const el=box.current;if(!el)return;const observer=new ResizeObserver(()=>setWidth(Math.max(240,el.clientWidth)));observer.observe(el);return()=>observer.disconnect();},[populated]);
  const rows=[...history].sort((a,b)=>a.observed_at-b.observed_at);
  const valid=rows.filter(row=>row.base_cents!==null);
  if(!valid.length)return null;
  const height=245,left=50,right=width-15,top=18,bottom=height-34;
  const values=valid.map(row=>row.base_cents!);const min=Math.min(...values),max=Math.max(...values);
  const step=Math.max(100,Math.ceil((max-min)/400)*100);const low=Math.max(0,Math.floor((min-step/2)/step)*step),high=Math.ceil((max+step/2)/step)*step;
  const start=rows[0].observed_at,end=rows[rows.length-1].observed_at;
  const x=(at:number)=>start===end?(left+right)/2:left+(at-start)/(end-start)*(right-left);
  const y=(cents:number)=>bottom-(cents-low)/(high-low)*(bottom-top);
  const ticks=[];for(let cents=low;cents<=high;cents+=step)ticks.push(cents);
  let active=false;let previousY=0;const commands:string[]=[];
  for(const row of rows){if(row.base_cents===null){active=false;continue;}const px=x(row.observed_at),py=y(row.base_cents);commands.push(active?`L ${px} ${previousY} L ${px} ${py}`:`M ${px} ${py}`);active=true;previousY=py;}
  const date=(at:number)=>new Date(at*1000).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'});
  return <div className="history-chart" ref={box}><svg className="history-plot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Verbundener Verlauf des günstigsten beobachteten Preises">
    {ticks.map(cents=><g key={cents}><line className="history-grid" x1={left} x2={right} y1={y(cents)} y2={y(cents)}/><text x={left-8} y={y(cents)+4} textAnchor="end">{(cents/100).toLocaleString('de-DE')} €</text></g>)}
    <path className="history-line" d={commands.join(' ')} fill="none"/>
    {valid.map((row,i)=><circle className="history-point" key={`${row.observed_at}-${i}`} cx={x(row.observed_at)} cy={y(row.base_cents!)} r="4"><title>{new Date(row.observed_at*1000).toLocaleString('de-DE')} · {countryData(row.region).name} · {(row.base_cents!/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'})}</title></circle>)}
    <text x={start===end?(left+right)/2:left} y={height-9} textAnchor={start===end?'middle':'start'}>{date(start)}</text>{start!==end&&<text x={right} y={height-9} textAnchor="end">{date(end)}</text>}
  </svg></div>;
}
