import { Icon } from '../components';
import { countryData } from './regions';
export { countryData, countryCodes, regionCode } from './regions';
const flags=import.meta.glob<string>('/node_modules/flag-icons/flags/4x3/*.svg',{eager:true,query:'?url&no-inline',import:'default'});
export function CountryFlag({ region }: { region:string|null|undefined }) {
  const data=countryData(region);
  return <span className="country-flag" role="img" aria-label={data.name} title={data.name}>{data.code ? <img aria-hidden="true" alt="" src={flags[`/node_modules/flag-icons/flags/4x3/${data.code}.svg`]}/> : <Icon name="globe" size={18} />}</span>;
}
