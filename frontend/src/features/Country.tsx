import { Icon } from '../components';
const flags=import.meta.glob<string>('/node_modules/flag-icons/flags/4x3/*.svg',{eager:true,query:'?url&no-inline',import:'default'});
export const countryCodes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const de = new Intl.DisplayNames(['de'], { type:'region' });
const en = new Intl.DisplayNames(['en'], { type:'region' });
const key = (name:string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const names = new Map<string,string>();
for (const code of countryCodes) for (const name of [code,de.of(code),en.of(code)]) if (name) names.set(key(name),code);
for (const [name,code] of Object.entries({USA:'US','United States of America':'US',UK:'GB','Great Britain':'GB',Türkiye:'TR',EU:'EU',Europe:'EU',Europa:'EU'})) names.set(key(name),code);
export function countryData(region:string|null|undefined) {
  const raw=region?.trim() || 'Region ungeklärt';
  const normalized=key(raw);
  if (['global','worldwide','weltweit','ww'].includes(normalized)) return { key:'GLOBAL',code:null,name:'Global' };
  if (['na','northamerica','nordamerika'].includes(normalized)) return {key:'REGION_NA',code:null,name:'Nordamerika'};
  if (['row','restofworld','restderwelt'].includes(normalized)) return {key:'REGION_ROW',code:null,name:'Rest der Welt'};
  if (['latam','latinamerica','lateinamerika'].includes(normalized)) return {key:'REGION_LATAM',code:null,name:'Lateinamerika'};
  const code=names.get(normalized);
  return code ? {key:code,code:code.toLowerCase(),name:code==='EU'?'Europa':de.of(code)??raw} : {key:normalized,code:null,name:raw};
}
export function CountryFlag({ region }: { region:string|null|undefined }) {
  const data=countryData(region);
  return <span className="country-flag" role="img" aria-label={data.name} title={data.name}>{data.code ? <img aria-hidden="true" alt="" src={flags[`/node_modules/flag-icons/flags/4x3/${data.code}.svg`]}/> : <Icon name="globe" size={18} />}</span>;
}
